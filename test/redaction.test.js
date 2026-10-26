import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/engine.js';
import { readJson, readText, atomicJson, acquireLock } from '../src/storage.js';
import { validateInput, validateState, spansFor, redact, sourceHash, requestFor, validateConfig, hash, iso } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const manifest = await readJson(new URL('../examples/review.json', import.meta.url), 16384);
const example = {...manifest, source: await readText(new URL('../examples/document.txt', import.meta.url),65536)};
const simple = () => ({ ...structuredClone(example), spans: [structuredClone(example.spans[0])] });
const twoSpans = () => ({ ...structuredClone(example), spans: structuredClone(example.spans.slice(0, 2)) });
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-document-redaction-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.decisions.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later spans; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoSpans()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'mask'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options[0].primary = true; }, (q) => { q.options[0].destructive = true; }, (q) => { q.options.reverse(); },
    (q) => { q.data.span_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('wrong, missing, typed or unsupported answers never resolve a span decision', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'mask'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'mask'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.output, null);
    await s.run(); assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across spans', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoSpans()); await s.run(); s.api.answer(id(1), 'mask'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).status, 'incomplete'); assert.equal((await localReport(s.directory, s.options.input)).output, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'mask');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'mask'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'mask'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing resolver before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'mask');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'complete'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'mask'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).output, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});


const fixtureInput = (source, ranges) => ({ documentId: 'fixture', title: 'Document fixture', sourceSha256: sourceHash(source), source,
  spans: ranges.map(([start, end], index) => ({ id: `s${index}`, start, end, quote: source.slice(start, end) })) });

test('exact source slicing masks only selected occurrences and preserves all Keep spans and outside characters', () => {
  const input = fixtureInput('same same\r\n🦉 e\u0301 café العربية', [[0, 4], [5, 9], [11, 13], [14, 16]]), before = structuredClone(input);
  assert.equal(redact(input, input.spans.map((s, i) => ({ spanId: s.id, choice: i % 2 ? 'keep' : 'mask' }))), '[REDACTED] same\r\n[REDACTED] e\u0301 café العربية');
  assert.deepEqual(input, before);
  assert.equal(redact(input, input.spans.map(s => ({ spanId: s.id, choice: 'keep' }))), input.source);
});

test('overlapping, nested, duplicate, reversed, out-of-range and stale spans fail before any network', async t => {
  for (const mutate of [
    p => { p.spans[1].start = p.spans[0].start; }, p => { p.spans[1] = structuredClone(p.spans[0]); },
    p => { p.spans[0].end = p.spans[1].end; p.spans[0].quote = p.source.slice(p.spans[0].start, p.spans[0].end); },
    p => { p.spans.reverse(); }, p => { p.spans[0].start = -1; }, p => { p.spans[0].end = p.spans[0].start; },
    p => { p.spans[0].end = p.source.length + 1; }, p => { p.spans[0].start += 0.5; }, p => { p.spans[0].start = '0'; },
    p => { p.spans[1].id = p.spans[0].id; }, p => { p.spans[0].id = 'constructor'; }, p => { p.spans[0].quote = 'different'; },
    p => { p.source += 'changed'; }, p => { p.sourceSha256 = '0'.repeat(64); }, p => { p.path = '/tmp/untrusted'; },
    p => { p.spans = []; }, p => { p.spans = Array(13).fill(p.spans[0]); }, p => { p.spans[0].command = 'anything'; },
  ]) {
    const input = twoSpans(); mutate(input); const s = await setup(t, input);
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, 0);
  }
});

test('UTF-16 offsets reject split surrogate pairs and unpaired source surrogates without normalizing Unicode', async t => {
  for (const ranges of [[[1, 2]], [[2, 3]], [[0, 2]], [[2, 4]]]) {
    const input = fixtureInput('A🦉B', ranges); const s = await setup(t, input);
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, 0);
  }
  for (const source of ['A\uD800B', 'A\uDC00B', 'bad\0text']) {
    const input = fixtureInput(source, [[0, 1]]); assert.throws(() => validateInput(input));
  }
  const input = fixtureInput('\uFEFF🦉e\u0301\r\n', [[1, 3]]);
  assert.equal(redact(input, [{ spanId: 's0', choice: 'mask' }]), '\uFEFF[REDACTED]e\u0301\r\n');
  assert.notEqual(sourceHash('e\u0301'), sourceHash('é'));
});

test('raw source reader preserves BOM and CRLF so SHA-256 binds the exact UTF-8 bytes', async t => {
  const s = await setup(t), path = join(s.directory, 'source.txt'), source = '\uFEFFLine 🦉\r\n';
  await writeFile(path, source, 'utf8'); assert.equal(await readText(path), source);
  assert.equal(sourceHash(await readText(path)), sourceHash(source));
});

test('missing, duplicate, reordered, uncertain and fabricated decisions cannot produce output', () => {
  const input = twoSpans();
  for (const decisions of [[], [{ spanId: 'contact', choice: 'mask' }], [{ spanId: 'contact', choice: 'mask' }, { spanId: 'contact', choice: 'keep' }],
    [{ spanId: 'meeting', choice: 'keep' }, { spanId: 'contact', choice: 'mask' }], [{ spanId: 'contact', choice: 'mask' }, { spanId: 'meeting', choice: 'unknown' }],
    [{ spanId: 'contact', choice: 'mask' }, { spanId: 'meeting', choice: 'MASK' }]]) assert.throws(() => redact(input, decisions));
});

test('attributed Mask/Keep decisions export only plain masked text and leave source bytes unchanged', async t => {
  const s = await setup(t, twoSpans()), source = s.options.input.source;
  const original = join(s.directory, 'original.txt'); await writeFile(original, source);
  const result = await decide(s, ['mask', 'keep']); assert.equal(result.status, 'complete');
  assert.equal(result.decisions[0].responderId, CONFIG.participant.id); assert.equal(result.decisions[0].askerId, ASKER);
  await assert.rejects(readFile(join(s.directory, 'redacted.txt')), { code: 'ENOENT' });
  const calls = s.api.calls.length, exported = await localReport(s.directory, s.options.input, { save: true });
  assert.equal(exported.artifactFile, 'redacted.txt'); const text = await readFile(join(s.directory, 'redacted.txt'), 'utf8');
  assert.equal(text, source.replace('robin@example.test', '[REDACTED]')); assert.equal(text.includes('sourceSha256'), false);
  assert.equal(sourceHash(text), exported.output.sha256); assert.equal(Buffer.byteLength(text), exported.output.bytes);
  assert.equal(await readFile(original, 'utf8'), source); assert.equal(s.options.input.source, source);
  assert.equal((await stat(join(s.directory, 'redacted.txt'))).mode & 0o777, 0o600);
  assert.equal((await s.run()).status, 'complete'); assert.equal(s.api.calls.length, calls);
});

test('Unknown remains an explicit decision; later reviews can finish but no redacted artifact is created', async t => {
  const s = await setup(t, twoSpans()); let result = await decide(s, ['unknown']);
  assert.equal(result.status, 'ready'); assert.deepEqual(result.unknownSpanIds, ['contact']); assert.equal(result.output, null);
  result = await decide(s, ['mask']); assert.equal(result.status, 'incomplete'); assert.equal(result.output, null);
  assert.deepEqual(result.unansweredSpans, []); await localReport(s.directory, s.options.input, { save: true });
  await assert.rejects(readFile(join(s.directory, 'redacted.txt')), { code: 'ENOENT' });
  await s.run(); assert.equal(sends(s.api), 2);
});

test('pending, expired, cancelled and invalid answers cannot export and are never silently treated as Keep', async t => {
  for (const terminal of ['pending', 'expired', 'cancelled', 'invalid']) {
    const s = await setup(t); await s.run();
    if (terminal === 'expired') s.clock.value = '2026-01-01T09:16:00.000Z';
    if (['expired', 'cancelled'].includes(terminal)) s.api.terminal(id(1), terminal);
    if (terminal === 'invalid') { s.api.answer(id(1), 'keep'); s.api.questions.get(id(1)).answer.responder.id = OTHER; }
    const result = await s.run(); assert.equal(result.output, null); assert.deepEqual(result.unknownSpanIds, []);
    await localReport(s.directory, s.options.input, { save: true });
    await assert.rejects(readFile(join(s.directory, 'redacted.txt')), { code: 'ENOENT' }); assert.equal(sends(s.api), 1);
  }
});

test('changed source with a recomputed hash, valid changed spans, title, reviewer or credential cannot reuse decisions', async t => {
  const s = await setup(t, twoSpans()); await s.run();
  for (const mutate of [p => { p.documentId = 'different'; }, p => { p.title = 'Changed'; },
    p => { p.source += 'x'; p.sourceSha256 = sourceHash(p.source); }, p => { p.spans[0].end--; p.spans[0].quote = p.spans[0].quote.slice(0, -1); }]) {
    const input = structuredClone(s.options.input); mutate(input); await assert.rejects(s.run({ input }), /changed source/);
  }
  await assert.rejects(s.run({ config: { participant: { id: OTHER, label: 'Other' } } }), /another connection/);
  await assert.rejects(s.run({ token: 'other' }), /another connection/); assert.equal(sends(s.api), 1);
});

test('maximum allowed source and twelve maximum quote spans fit every Question and private record budget', async t => {
  const source = 'a'.repeat(16384), ranges = Array.from({ length: 12 }, (_, i) => [14464 + i * 160, 14464 + (i + 1) * 160]);
  const input = fixtureInput(source, ranges); input.title = 't'.repeat(60); input.documentId = 'd'.repeat(40);
  input.spans.forEach((s, i) => { s.id = `s${String(i).padStart(2, '0')}${'x'.repeat(21)}`; });
  for (const span of input.spans) assert.ok(requestFor(input, CONFIG, span.id, id(99)).prompt.length <= 500);
  const s = await setup(t, input), result = await decide(s, Array(12).fill('mask'));
  assert.equal(result.status, 'complete'); assert.equal(sends(s.api), 12);
  assert.ok(Buffer.byteLength(JSON.stringify(await s.saved(), null, 2)) + 4096 < 1024 * 1024);
  const longQuote = fixtureInput('x'.repeat(161), [[0,161]]); assert.throws(() => validateInput(longQuote));
  const longSource = fixtureInput('x'.repeat(16385), [[0,1]]); assert.throws(() => validateInput(longSource));
});

test('report save failure after text export is recoverable offline without changing output or replaying Questions', async t => {
  const s = await setup(t); await decide(s, ['mask']); const calls = s.api.calls.length;
  await assert.rejects(localReport(s.directory, s.options.input, { save: true, writeReport: async () => { throw new Error('disk full'); } }), /disk full/);
  const first = await readFile(join(s.directory, 'redacted.txt'), 'utf8');
  const result = await localReport(s.directory, s.options.input, { save: true });
  assert.equal(await readFile(join(s.directory, 'redacted.txt'), 'utf8'), first); assert.equal(result.output.sha256, sourceHash(first));
  assert.equal(s.api.calls.length, calls);
});

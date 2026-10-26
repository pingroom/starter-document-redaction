import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, readText } from './storage.js';
import { step, localReport } from './engine.js';
import { mockApi, CONFIG, ROOM_CODE, id } from './mock.js';

const manifest = await readJson(new URL('../examples/review.json', import.meta.url), 16384);
const input = { ...manifest, source: await readText(new URL('../examples/document.txt', import.meta.url), 65536) };
for (const [name, choices] of [['Mask contact, keep meeting point', ['mask', 'keep']], ['Unknown blocks export', ['mask', 'unknown']]]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-redaction-demo-'));
  const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
  const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
  try {
    for (const [index, choice] of choices.entries()) { assert.equal((await step(options)).output, null); api.answer(id(index + 1), choice); await step(options); }
    const result = await localReport(directory, input, { save: true });
    let exportedText = null;
    if (result.output) { exportedText = await readFile(join(directory, 'redacted.txt'), 'utf8'); assert.ok(!exportedText.includes('robin@example.test')); }
    else await assert.rejects(readFile(join(directory, 'redacted.txt')), { code: 'ENOENT' });
    console.log(JSON.stringify({ demo: name, transport: 'real SDK with local mock; no network', status: result.status, output: result.output, exportedText }, null, 2));
    const calls = api.calls.length; await step(options); assert.equal(api.calls.length, calls);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

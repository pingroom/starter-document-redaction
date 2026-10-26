import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');


export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const sourceHash = (source) => createHash('sha256').update(source, 'utf8').digest('hex');
export const MASK = '[REDACTED]';
const boundary = (source, offset) => !(offset > 0 && offset < source.length && /[\uD800-\uDBFF]/.test(source[offset - 1]) && /[\uDC00-\uDFFF]/.test(source[offset]));

export function validateInput(input) {
  if (!keys(input, ['documentId', 'title', 'sourceSha256', 'source', 'spans']) || !word(input.documentId) || !line(input.title, 60)
    || typeof input.source !== 'string' || !input.source.length || input.source.length > 16384 || !input.source.isWellFormed()
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.source) || Buffer.byteLength(input.source, 'utf8') > 65536
    || typeof input.sourceSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.sourceSha256) || input.sourceSha256 !== sourceHash(input.source)
    || !Array.isArray(input.spans) || input.spans.length < 1 || input.spans.length > 12) throw new Error('Provide a document ID, title, exact UTF-8 source SHA-256, valid bounded plain text, and one to twelve spans.');
  const ids = new Set(); let previousEnd = 0;
  for (const span of input.spans) {
    if (!keys(span, ['id', 'start', 'end', 'quote']) || !word(span.id) || span.id.length > 24 || ids.has(span.id)
      || ['constructor', 'prototype', '__proto__'].includes(span.id) || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
      || span.start < previousEnd || span.end <= span.start || span.end > input.source.length
      || !boundary(input.source, span.start) || !boundary(input.source, span.end)
      || typeof span.quote !== 'string' || span.quote.length < 1 || span.quote.length > 160 || !span.quote.isWellFormed()
      || span.quote !== input.source.slice(span.start, span.end)) throw new Error('Spans need unique IDs, sorted non-overlapping UTF-16 ranges, whole Unicode characters, and exact quotes of at most 160 UTF-16 units.');
    ids.add(span.id); previousEnd = span.end;
  }
  return structuredClone(input);
}

export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id)
    || !line(config.participant.label, 60)) throw new Error('Config requires an exact reviewer UUID and label.');
  return structuredClone(config);
}

export const spansFor = (input) => validateInput(input).spans;

export function requestFor(input, config, spanId, attemptId) {
  const span = spansFor(input).find((item) => item.id === spanId);
  if (!span || !isId(attemptId)) throw new Error('Invalid span or attempt.');
  const key = `redact-${attemptId}`;
  const prompt = `${input.title}\nSpan ${span.id}, UTF-16 [${span.start}, ${span.end}):\n${span.quote}\nEnd of quoted span.\nMask removes only this exact span from the exported copy. Keep leaves it unchanged. Choose Unknown if unsure. Review the original document separately for context and omitted sensitive content.`;
  if (prompt.length > 500) throw new Error('Span prompt exceeds 500 characters.');
  return { prompt, context: `Source ${input.sourceSha256.slice(0, 20)}`,
    options: [['mask', 'Mask'], ['keep', 'Keep'], ['unknown', 'Unknown']].map(([value, label]) => ({ value, label, style: 'default' })),
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), source_sha256: input.sourceSha256, span_id: spanId, attempt_id: attemptId }, idempotencyKey: key };
}

export function validateState(state, input) {
  validateInput(input); const spans = spansFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > spans.length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed source/manifest. Restore the original input and configuration.');
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'spanId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.spanId !== spans[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.spanId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved span review request.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last span may have an active Question.');
  }
  return state;
}

/** Exact source slicing. No search/replace, normalization, remote filenames or inferred spans. */
export function redact(rawInput, decisions) {
  const input = validateInput(rawInput);
  if (!Array.isArray(decisions) || decisions.length !== input.spans.length) throw new Error('Every supplied span needs a Mask or Keep decision before export.');
  let end = 0, output = '';
  for (const [index, span] of input.spans.entries()) {
    const item = decisions[index];
    if (!keys(item, ['spanId', 'choice']) || item.spanId !== span.id || !['mask', 'keep'].includes(item.choice)) throw new Error('Invalid, missing, reordered or uncertain redaction decision.');
    output += input.source.slice(end, span.start) + (item.choice === 'mask' ? MASK : input.source.slice(span.start, span.end));
    end = span.end;
  }
  return output + input.source.slice(end);
}

export function report(state, input) {
  validateState(state, input);
  const decisions = spansFor(input).map((span) => {
    const attempt = state.attempts.find((item) => item.spanId === span.id), answer = attempt?.observation?.answer;
    return { spanId: span.id, start: span.start, end: span.end, status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const active = decisions.find((item) => ['create_unknown', 'pending'].includes(item.status));
  const complete = decisions.every((item) => item.status === 'answered' && ['mask', 'keep'].includes(item.choice));
  const status = active?.status ?? (decisions.some((item) => item.status === 'unasked') ? 'ready' : complete ? 'complete' : 'incomplete');
  const text = complete ? redact(input, decisions.map(({ spanId, choice }) => ({ spanId, choice }))) : null;
  return { documentId: input.documentId, title: input.title, inputHash: hash(input), sourceSha256: input.sourceSha256,
    status, participant: state.config.participant, decisions,
    unknownSpanIds: decisions.filter((item) => item.choice === 'unknown').map((item) => item.spanId),
    unansweredSpans: decisions.filter((item) => item.status !== 'answered').map(({ spanId, status }) => ({ spanId, status })),
    output: text === null ? null : { sha256: sourceHash(text), bytes: Buffer.byteLength(text, 'utf8') } };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved review evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered spans must not contain review evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || option?.primary !== false || option?.destructive !== false)) throw new Error('Question does not match the saved span request, room, or participant.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}


export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSEParser, mapEvent, normalize, pipeInteraction, textFromInteraction, embedRequests, buildInteractionBody } from '../lib/gemini.js';
import { getConfig } from '../lib/config.js';

const EVENTS = [
  { event_type: 'interaction.created', interaction: { id: 'x' } },
  { event_type: 'step.start', index: 0, step: { type: 'thought' } },
  { event_type: 'step.delta', delta: { type: 'thought_summary', content: { type: 'text', text: 'Looking at ' } } },
  { event_type: 'step.delta', delta: { type: 'thought_summary', text: 'passage 1.' } },
  { event_type: 'step.delta', delta: { type: 'thought_signature', signature: 'abc' } },
  { event_type: 'step.stop', index: 0 },
  { event_type: 'step.start', index: 1, step: { type: 'model_output' } },
  { event_type: 'step.delta', delta: { type: 'text', text: 'You have 30 days ' } },
  { event_type: 'step.delta', delta: { type: 'text', text: '[1].' } },
  { event_type: 'interaction.status_update', status: 'in_progress' },
  { event_type: 'interaction.completed', interaction: { status: 'completed', usage: { total_input_tokens: 10, total_output_tokens: 5, total_thought_tokens: 3, total_tokens: 18 } } }
];
const EXPECTED = [
  { step: 'thought' }, { th: 'Looking at ' }, { th: 'passage 1.' },
  { step: 'model_output' }, { t: 'You have 30 days ' }, { t: '[1].' },
  { usage: { total_input_tokens: 10, total_output_tokens: 5, total_thought_tokens: 3, total_tokens: 18 } }
];
const wire = (sep = '\n') => EVENTS.map(e => `event: message${sep}data: ${JSON.stringify(e)}${sep}${sep}`).join('') + `data: [DONE]${sep}${sep}`;

function parseAll(pieces) {
  const out = []; const p = createSSEParser(e => out.push(e));
  for (const s of pieces) p.push(s); p.end(); return out;
}

test('parses the section 7.3 example stream', () => {
  assert.deepEqual(parseAll([wire()]), EXPECTED);
});

test('handles events split across network chunks at every offset', () => {
  const s = wire();
  for (const size of [1, 3, 7, 64]) {
    const pieces = []; for (let i = 0; i < s.length; i += size) pieces.push(s.slice(i, i + size));
    assert.deepEqual(parseAll(pieces), EXPECTED, `chunk size ${size}`);
  }
});

test('handles \\r\\n line endings, including split between \\r and \\n', () => {
  const s = wire('\r\n');
  assert.deepEqual(parseAll([s]), EXPECTED);
  const pieces = []; for (let i = 0; i < s.length; i += 2) pieces.push(s.slice(i, i + 2));
  assert.deepEqual(parseAll(pieces), EXPECTED);
});

test('ignores [DONE], comments and malformed JSON', () => {
  assert.deepEqual(parseAll([': keep-alive\n\ndata: {oops\n\ndata: [DONE]\n\n']), []);
});

test('maps error events and non-completed status', () => {
  assert.deepEqual(mapEvent({ event_type: 'error', error: { code: 'X', message: 'boom' } }), [{ error: 'boom' }]);
  assert.deepEqual(mapEvent({ event_type: 'interaction.completed', interaction: { status: 'failed' } }), [{ error: 'Generation ended with status "failed"' }]);
});

test('pipeInteraction emits done after a clean stream and stops after an error', async () => {
  const mk = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
  const a = []; await pipeInteraction(mk(wire()), e => a.push(e));
  assert.deepEqual(a, [...EXPECTED, { done: true }]);
  const b = [];
  const failed = await pipeInteraction(mk('data: {"event_type":"step.delta","delta":{"type":"text","text":"Hi"}}\n\ndata: {"event_type":"error","error":{"message":"bad"}}\n\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"later"}}\n\n'), e => b.push(e));
  assert.equal(failed, true);
  assert.deepEqual(b, [{ t: 'Hi' }, { error: 'bad' }]);
});

test('non-streamed JSON fallback joins model_output text', async () => {
  const j = { status: 'completed', steps: [{ type: 'thought', content: [{ type: 'text', text: 'no' }] }, { type: 'model_output', content: [{ type: 'text', text: 'A ' }, { type: 'text', text: 'B' }] }] };
  assert.equal(textFromInteraction(j), 'A B');
  const out = []; await pipeInteraction(new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } }), e => out.push(e));
  assert.deepEqual(out, [{ t: 'A B' }, { done: true }]);
});

test('normalize returns unit vectors and leaves zero vectors finite', () => {
  const v = normalize([3, 4]);
  assert.deepEqual(v, [0.6, 0.8]);
  assert.deepEqual(normalize([0, 0]), [0, 0]);
  const big = normalize(Array.from({ length: 768 }, (_, i) => i - 300));
  assert.ok(Math.abs(Math.hypot(...big) - 1) < 1e-9);
});

test('embed requests use taskType for gemini-embedding-001 and prefixes for gemini-embedding-2', () => {
  const c1 = getConfig({});
  assert.deepEqual(embedRequests(['hi'], 'query', c1)[0], { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'hi' }] }, outputDimensionality: 768, taskType: 'RETRIEVAL_QUERY' });
  assert.equal(embedRequests(['hi'], 'document', c1)[0].taskType, 'RETRIEVAL_DOCUMENT');
  const c2 = getConfig({ GEMINI_EMBED_MODEL: 'gemini-embedding-2' });
  const [q] = embedRequests(['hi'], 'query', c2); const [d] = embedRequests(['hi'], 'document', c2);
  assert.equal(q.taskType, undefined);
  assert.equal(q.content.parts[0].text, 'task: search result | query: hi');
  assert.equal(d.content.parts[0].text, 'title: none | text: hi');
});

test('interaction body matches section 7.3', () => {
  const b = buildInteractionBody({ question: 'Q', context: [], history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], thinking: 'high' }, getConfig({}));
  assert.equal(b.model, 'gemini-3.8-flash');
  assert.equal(b.stream, true); assert.equal(b.store, false);
  assert.deepEqual(b.generation_config, { thinking_level: 'high', thinking_summaries: 'auto' });
  assert.deepEqual(b.input.map(i => i.type), ['user_input', 'model_output', 'user_input']);
  assert.match(b.system_instruction, /\(no matching passages were found\)$/);
});

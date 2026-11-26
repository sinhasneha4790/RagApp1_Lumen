import test from 'node:test';
import assert from 'node:assert/strict';
import { createSSEParser } from '../lib/sse.js';
import { buildChatBody, createChunkMapper, mapUsage, pipeChat, groqError } from '../lib/groq.js';
import { normalize, embedRequests, geminiError } from '../lib/gemini.js';
import { redact } from '../lib/http.js';
import { getConfig } from '../lib/config.js';

// Groq (OpenAI-compatible) streamed chunks, as documented: choices[0].delta.{reasoning,content},
// terminated by data: [DONE]; usage on the final chunk.
const CHUNKS = [
  { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
  { id: 'c', choices: [{ index: 0, delta: { reasoning: 'Looking at ' } }] },
  { id: 'c', choices: [{ index: 0, delta: { reasoning: 'passage 1.' } }] },
  { id: 'c', choices: [{ index: 0, delta: { content: 'You have 30 days ' } }] },
  { id: 'c', choices: [{ index: 0, delta: { content: '[1].' } }] },
  { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], x_groq: { id: 'req_1', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 3 } } } }
];
const USAGE = { total_input_tokens: 10, total_output_tokens: 5, total_tokens: 15, total_thought_tokens: 3 };
const EXPECTED = [{ step: 'thought' }, { th: 'Looking at ' }, { th: 'passage 1.' }, { step: 'model_output' }, { t: 'You have 30 days ' }, { t: '[1].' }];
const wire = (sep = '\n') => CHUNKS.map(e => `data: ${JSON.stringify(e)}${sep}${sep}`).join('') + `data: [DONE]${sep}${sep}`;

function parseAll(pieces) {
  const out = []; const m = createChunkMapper();
  const p = createSSEParser(ev => out.push(...m.map(ev)));
  for (const s of pieces) p.push(s); p.end();
  return { events: out, usage: m.usage() };
}

test('parses a Groq chat stream into th/t events and usage', () => {
  const r = parseAll([wire()]);
  assert.deepEqual(r.events, EXPECTED);
  assert.deepEqual(r.usage, USAGE);
});

test('handles chunks split across network reads at every offset', () => {
  const s = wire();
  for (const size of [1, 3, 7, 64]) {
    const pieces = []; for (let i = 0; i < s.length; i += size) pieces.push(s.slice(i, i + size));
    assert.deepEqual(parseAll(pieces).events, EXPECTED, `chunk size ${size}`);
  }
});

test('handles \\r\\n line endings, including split between \\r and \\n', () => {
  const s = wire('\r\n');
  assert.deepEqual(parseAll([s]).events, EXPECTED);
  const pieces = []; for (let i = 0; i < s.length; i += 2) pieces.push(s.slice(i, i + 2));
  assert.deepEqual(parseAll(pieces).events, EXPECTED);
});

test('ignores [DONE], comments and malformed JSON', () => {
  assert.deepEqual(parseAll([': keep-alive\n\ndata: {oops\n\ndata: [DONE]\n\n']).events, []);
});

test('usage is read from `usage` or `x_groq.usage`', () => {
  const m = createChunkMapper();
  m.map({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
  assert.deepEqual(m.usage(), { total_input_tokens: 1, total_output_tokens: 2, total_tokens: 3 });
  assert.equal(mapUsage(null), null);
});

test('mid-stream error chunks become {error}', () => {
  assert.deepEqual(createChunkMapper().map({ error: { message: 'boom', type: 'server_error' } }), [{ error: 'boom' }]);
});

test('pipeChat emits usage then done, and stops after an error', async () => {
  const mk = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
  const a = []; await pipeChat(mk(wire()), e => a.push(e));
  assert.deepEqual(a, [...EXPECTED, { usage: USAGE }, { done: true }]);
  const b = [];
  const failed = await pipeChat(mk('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"error":{"message":"bad"}}\n\ndata: {"choices":[{"delta":{"content":"later"}}]}\n\n'), e => b.push(e));
  assert.equal(failed, true);
  assert.deepEqual(b, [{ step: 'model_output' }, { t: 'Hi' }, { error: 'bad' }]);
});

test('non-streamed JSON fallback', async () => {
  const j = { choices: [{ message: { role: 'assistant', content: 'A B', reasoning: 'think' } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
  const out = []; await pipeChat(new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } }), e => out.push(e));
  assert.deepEqual(out, [{ th: 'think' }, { t: 'A B' }, { usage: { total_input_tokens: 1, total_output_tokens: 2, total_tokens: 3 } }, { done: true }]);
});

test('chat body: system prompt, history, reasoning effort', () => {
  const b = buildChatBody({ question: 'Q', context: [], history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }], thinking: 'high' }, getConfig({}));
  assert.equal(b.model, 'openai/gpt-oss-120b');
  assert.equal(b.stream, true);
  assert.equal(b.reasoning_effort, 'high');
  assert.equal(b.include_reasoning, true);
  assert.equal(b.max_completion_tokens, 4096);
  assert.deepEqual(b.messages.map(m => m.role), ['system', 'user', 'assistant', 'user']);
  assert.match(b.messages[0].content, /\(no matching passages were found\)$/);
  assert.equal(b.messages[3].content, 'Q');
});

test('groqError maps statuses, logs Groq text with keys redacted', async () => {
  const logs = []; const orig = console.warn; console.warn = m => logs.push(m);
  process.env.GROQ_API_KEY = 'gsk_secretsecretsecretsecret12';
  try {
    const e503 = await groqError(new Response(JSON.stringify({ error: { message: 'over capacity', type: 'server_error' } }), { status: 503 }));
    assert.equal(e503.status, 502); assert.equal(e503.message, 'Groq is unavailable, try again');
    const e401 = await groqError(new Response(JSON.stringify({ error: { message: 'Invalid API Key gsk_secretsecretsecretsecret12', type: 'invalid_request_error' } }), { status: 401 }));
    assert.equal(e401.status, 502); assert.match(e401.message, /check that GROQ_API_KEY is a valid Groq API key/);
    const e429 = await groqError(new Response(JSON.stringify({ error: { message: 'Rate limit' } }), { status: 429, headers: { 'retry-after': '7' } }));
    assert.equal(e429.status, 429); assert.equal(e429.retryAfter, 7);
    const e400 = await groqError(new Response(JSON.stringify({ error: { message: 'bad model' } }), { status: 400 }));
    assert.equal(e400.status, 502); assert.equal(e400.message, 'bad model');
    assert.match(logs[0], /^groq upstream 503: server_error: over capacity/);
    assert.ok(logs.every(l => !l.includes('gsk_secret')));
  } finally { console.warn = orig; delete process.env.GROQ_API_KEY; }
});

test('redact removes Gemini and Groq style keys', () => {
  assert.equal(redact('a AIzaSyA1234567890abcdefghijklmn b gsk_abcdefghijklmnopqrstuvwx c', []), 'a [redacted] b [redacted] c');
});

test('normalize returns unit vectors and leaves zero vectors finite', () => {
  assert.deepEqual(normalize([3, 4]), [0.6, 0.8]);
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

test('geminiError logs Gemini\'s message, truncated and with keys redacted', async () => {
  const logs = []; const orig = console.warn; console.warn = m => logs.push(m);
  process.env.GEMINI_API_KEY = 'secret-key-12345';
  try {
    const body = { error: { code: 503, status: 'UNAVAILABLE', message: 'Model busy for key secret-key-12345 and AIzaSyA1234567890abcdefghijklmn ' + 'x'.repeat(400) } };
    const e = await geminiError(new Response(JSON.stringify(body), { status: 503 }));
    assert.equal(e.status, 502); assert.equal(e.message, 'Gemini is unavailable, try again');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^gemini upstream 503: UNAVAILABLE: Model busy for key \[redacted\] and \[redacted\]/);
    assert.ok(logs[0].length <= 'gemini upstream 503: '.length + 300);
  } finally { console.warn = orig; delete process.env.GEMINI_API_KEY; }
});

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-gemini.js';
import { createDevServer } from '../scripts/dev-server.js';
import { rateLimited, resetRateLimits } from '../lib/http.js';

let mock, app, base;
const KEY = 'test-key-123';

before(async () => {
  mock = await startMock({ port: 0, delay: 1, quiet: true });
  app = createDevServer();
  await new Promise(r => app.listen(0, r));
  base = `http://localhost:${app.address().port}`;
});
after(async () => { await mock.close(); await new Promise(r => app.close(r)); });
beforeEach(async () => {
  Object.assign(process.env, { GEMINI_BASE_URL: `http://localhost:${mock.port}`, GEMINI_API_KEY: KEY, GOOGLE_API_KEY: '' });
  for (const k of ['GEMINI_API_REVISION', 'GEMINI_MODEL', 'GEMINI_EMBED_MODEL', 'GEMINI_EMBED_DIM', 'GEMINI_THINKING_LEVEL', 'ALLOW_ORIGIN']) delete process.env[k];
  resetRateLimits();
  await fetch(`http://localhost:${mock.port}/__reset`, { method: 'POST' });
});

const post = (path, body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(base + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
const mockReqs = async () => (await fetch(`http://localhost:${mock.port}/__requests`)).json();
const failNext = (status, message, count = 1) => fetch(`http://localhost:${mock.port}/__fail`, { method: 'POST', body: JSON.stringify({ status, message, count }) });
async function readSSE(r) {
  const text = await r.text();
  return text.split('\n\n').filter(Boolean).map(b => JSON.parse(b.replace(/^data: /, '')));
}

/* ---------- health ---------- */
test('health reports models and never echoes the key', async () => {
  const r = await fetch(base + '/api/health'); const text = await r.text(); const j = JSON.parse(text);
  assert.equal(r.status, 200);
  assert.deepEqual(j, { ok: true, chatModel: 'gemini-3.8-flash', embedModel: 'gemini-embedding-001', dim: 768, apiVersion: 'v1beta', thinking: 'low' });
  assert.ok(!text.includes(KEY));
});
test('health without a key', async () => {
  process.env.GEMINI_API_KEY = '';
  const j = await (await fetch(base + '/api/health')).json();
  assert.equal(j.ok, false); assert.equal(j.error, 'GEMINI_API_KEY is not set on the server');
});
test('GOOGLE_API_KEY takes precedence', async () => {
  process.env.GOOGLE_API_KEY = 'google-key';
  await post('/api/embed', { texts: ['hello'] });
  assert.equal((await mockReqs())[0].headers['x-goog-api-key'], 'google-key');
});

/* ---------- embed ---------- */
test('embed returns normalised 768-d vectors with RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY', async () => {
  const r = await post('/api/embed', { texts: ['refunds within 30 days', 'warranty'], kind: 'document' });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.dim, 768); assert.equal(j.model, 'gemini-embedding-001'); assert.equal(j.vectors.length, 2);
  for (const v of j.vectors) { assert.equal(v.length, 768); assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9); }
  await post('/api/embed', { texts: ['how long?'], kind: 'query' });
  const reqs = await mockReqs();
  assert.equal(reqs[0].path, '/v1beta/models/gemini-embedding-001:batchEmbedContents');
  assert.equal(reqs[0].headers['x-goog-api-key'], KEY);
  assert.equal(reqs[0].body.requests[0].taskType, 'RETRIEVAL_DOCUMENT');
  assert.equal(reqs[0].body.requests[0].outputDimensionality, 768);
  assert.equal(reqs[1].body.requests[0].taskType, 'RETRIEVAL_QUERY');
});
test('embed trims each text to 20,000 characters', async () => {
  await post('/api/embed', { texts: ['x'.repeat(25_000)] });
  assert.equal((await mockReqs())[0].body.requests[0].content.parts[0].text.length, 20_000);
});
test('embed validation errors are 400', async () => {
  for (const body of [{}, { texts: [] }, { texts: 'a' }, { texts: Array(101).fill('a') }, { texts: ['a'], kind: 'other' }, { texts: [''] }]) {
    const r = await post('/api/embed', body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.ok((await r.json()).error);
  }
  assert.equal((await post('/api/embed', 'texts=a', { 'Content-Type': 'text/plain' })).status, 400);
  assert.equal((await post('/api/embed', '{bad json')).status, 400);
  assert.equal((await fetch(base + '/api/embed')).status, 405);
  assert.equal((await mockReqs()).length, 0);
});
test('embed body over 4 MB is 413', async () => {
  const r = await post('/api/embed', { texts: ['a'.repeat(4.2 * 1024 * 1024)] });
  assert.equal(r.status, 413);
});
test('embed without a key is 500 with a clear message', async () => {
  process.env.GEMINI_API_KEY = '';
  const r = await post('/api/embed', { texts: ['a'] });
  assert.equal(r.status, 500); assert.equal((await r.json()).error, 'GEMINI_API_KEY is not set on the server');
});

/* ---------- error mapping (spec 7.4) ---------- */
test('upstream 400 → 502 with Gemini message', async () => {
  await failNext(400, 'Invalid argument X');
  const r = await post('/api/embed', { texts: ['a'] });
  assert.equal(r.status, 502); assert.equal((await r.json()).error, 'Invalid argument X');
});
test('upstream 401/403 → 502 with key hint', async () => {
  for (const s of [401, 403]) {
    await failNext(s, 'API key not valid');
    const r = await post('/api/embed', { texts: ['a'] });
    assert.equal(r.status, 502);
    assert.match((await r.json()).error, /API key not valid — check that your API key is valid and restricted to the Gemini API/);
  }
});
test('upstream 429 → 429 after one retry', async () => {
  await failNext(429, 'Quota exceeded', 2);
  const r = await post('/api/embed', { texts: ['a'] });
  assert.equal(r.status, 429); assert.match((await r.json()).error, /rate limit reached, try again shortly/);
  assert.equal((await mockReqs()).length, 2);
});
test('upstream 5xx → 502 "Gemini is unavailable"', async () => {
  await failNext(503, 'overloaded', 2);
  const r = await post('/api/embed', { texts: ['a'] });
  assert.equal(r.status, 502); assert.equal((await r.json()).error, 'Gemini is unavailable, try again');
});
test('embed retries once and succeeds', async () => {
  await failNext(500, 'blip', 1);
  const r = await post('/api/embed', { texts: ['a'] });
  assert.equal(r.status, 200); assert.equal((await mockReqs()).length, 2);
});
test('network failure → 502', async () => {
  process.env.GEMINI_BASE_URL = 'http://127.0.0.1:1';
  const r = await post('/api/embed', { texts: ['a'] });
  assert.equal(r.status, 502); assert.equal((await r.json()).error, 'Gemini is unavailable, try again');
});

/* ---------- chat ---------- */
const CTX = [{ n: 1, doc: 'policy.txt', page: null, text: 'Unused items can be returned within 30 days.' }];
test('chat streams thought, text, usage and done; sends the right headers and config', async () => {
  const r = await post('/api/chat', { question: 'How long to return?', context: CTX, history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], thinking: 'high' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/event-stream/);
  assert.equal(r.headers.get('cache-control'), 'no-cache, no-transform');
  const evs = await readSSE(r);
  assert.deepEqual(evs.filter(e => e.step).map(e => e.step), ['thought', 'model_output']);
  assert.equal(evs.filter(e => e.th).map(e => e.th).join(''), 'Reading the retrieved passages. Passage 1 looks most relevant.');
  assert.match(evs.filter(e => e.t).map(e => e.t).join(''), /\[1\]/);
  assert.equal(evs.find(e => e.usage).usage.total_thought_tokens, 17);
  assert.deepEqual(evs.at(-1), { done: true });

  const [q] = await mockReqs();
  assert.equal(q.path, '/v1beta/interactions'); assert.equal(q.query, '?alt=sse');
  assert.equal(q.headers['x-goog-api-key'], KEY);
  assert.equal(q.headers['api-revision'], '2026-05-20');
  assert.deepEqual(q.body.generation_config, { thinking_level: 'high', thinking_summaries: 'auto' });
  assert.equal(q.body.model, 'gemini-3.8-flash'); assert.equal(q.body.stream, true); assert.equal(q.body.store, false);
  assert.match(q.body.system_instruction, /\[1\] \(policy\.txt\)\nUnused items/);
  assert.deepEqual(q.body.input.map(i => i.type), ['user_input', 'model_output', 'user_input']);
});
test('chat: invalid thinking level falls back to the server default; empty revision omits header', async () => {
  process.env.GEMINI_THINKING_LEVEL = 'medium'; process.env.GEMINI_API_REVISION = '';
  await readSSE(await post('/api/chat', { question: 'Q', context: CTX, thinking: 'extreme' }));
  const [q] = await mockReqs();
  assert.equal(q.body.generation_config.thinking_level, 'medium');
  assert.equal(q.headers['api-revision'], undefined);
});
test('chat keeps only the last 8 history items', async () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }));
  await readSSE(await post('/api/chat', { question: 'Q', context: CTX, history }));
  const [q] = await mockReqs();
  assert.equal(q.body.input.length, 9); assert.equal(q.body.input[0].content[0].text, 'm4');
});
test('chat validation errors are 400', async () => {
  for (const body of [{}, { question: '  ' }, { question: 'x'.repeat(4001) }, { question: 'q', context: Array(13).fill(CTX[0]) }, { question: 'q', context: [{ n: 1, text: 'x'.repeat(20_001) }] }, { question: 'q', context: 'nope' }]) {
    const r = await post('/api/chat', body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await mockReqs()).length, 0);
});
test('chat upstream errors before the stream are JSON and not retried', async () => {
  await failNext(503, 'down', 1);
  const r = await post('/api/chat', { question: 'q', context: CTX });
  assert.equal(r.status, 502); assert.equal((await r.json()).error, 'Gemini is unavailable, try again');
  assert.equal((await mockReqs()).length, 1);
  await failNext(429, 'slow down', 1);
  assert.equal((await post('/api/chat', { question: 'q', context: CTX })).status, 429);
});
test('chat without a key is 500', async () => {
  process.env.GEMINI_API_KEY = '';
  assert.equal((await post('/api/chat', { question: 'q' })).status, 500);
});

/* ---------- misc ---------- */
test('CORS headers only when ALLOW_ORIGIN is set', async () => {
  assert.equal((await fetch(base + '/api/health')).headers.get('access-control-allow-origin'), null);
  process.env.ALLOW_ORIGIN = 'https://example.com';
  assert.equal((await fetch(base + '/api/health')).headers.get('access-control-allow-origin'), 'https://example.com');
});
test('rate limiter allows N per minute per IP', () => {
  resetRateLimits();
  const req = { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: {} };
  const other = { headers: { 'x-forwarded-for': '5.6.7.8' }, socket: {} };
  for (let i = 0; i < 60; i++) assert.equal(rateLimited(req, 'chat', 60, 1000), false);
  assert.equal(rateLimited(req, 'chat', 60, 1000), true);
  assert.equal(rateLimited(other, 'chat', 60, 1000), false);
  assert.equal(rateLimited(req, 'chat', 60, 61_001), false);
});
test('static files are served from public/ only', async () => {
  const r = await fetch(base + '/'); assert.equal(r.status, 200); assert.match(await r.text(), /<title>Lumen/);
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
});

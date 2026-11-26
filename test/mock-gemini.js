// Local mock of the upstream APIs Lumen uses: Gemini embeddings and Groq chat. No real keys needed.
//   node test/mock-gemini.js          → listens on :4999 (MOCK_PORT to change)
// Test hooks (mock only):
//   GET  /__requests                  → requests received so far (headers + body)
//   POST /__reset                     → clear recorded requests and queued failures
//   POST /__fail {status,message,count} → fail the next `count` Gemini calls

import http from 'node:http';
import { pathToFileURL } from 'node:url';

function hash(w) { let h = 2166136261; for (const c of w) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Deterministic vector: each word is hashed into one dimension. */
export function mockVector(text, dim = 768) {
  const v = new Array(dim).fill(0);
  v[0] = 0.01; // never a zero vector
  for (const w of String(text).toLowerCase().match(/[a-z0-9]+/g) || []) v[hash(w) % dim] += 1;
  return v;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function startMock({ port = 4999, delay = 15, quiet = false } = {}) {
  const requests = [];
  let failures = [];
  const log = (...a) => { if (!quiet) console.log('[mock-gemini]', ...a); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = []; for await (const c of req) parts.push(c);
    const raw = Buffer.concat(parts).toString('utf8');
    let body = null; try { body = raw ? JSON.parse(raw) : null; } catch {}
    const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

    if (url.pathname === '/__requests') return json(200, requests);
    if (url.pathname === '/__reset') { requests.length = 0; failures = []; return json(200, { ok: true }); }
    if (url.pathname === '/__fail') {
      const { status = 500, message = 'Mock failure', count = 1 } = body || {};
      for (let i = 0; i < count; i++) failures.push({ status, message });
      return json(200, { ok: true });
    }

    requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });
    // Log what was received, with the key redacted.
    log(req.method, url.pathname + url.search, {
      key: req.headers['x-goog-api-key'] || req.headers.authorization ? '(present)' : '(missing)',
      model: body?.model,
      reasoning_effort: body?.reasoning_effort,
      taskType: body?.requests?.[0]?.taskType
    });

    const isGroq = url.pathname.startsWith('/openai/');
    if (isGroq ? !/^Bearer \S+/.test(req.headers.authorization || '') : !req.headers['x-goog-api-key'])
      return json(401, { error: { message: 'Invalid API Key', type: 'invalid_request_error' } });
    if (failures.length) { const f = failures.shift(); return json(f.status, { error: { code: f.status, message: f.message } }); }

    const m = url.pathname.match(/^\/v1beta\/models\/([^/:]+):batchEmbedContents$/);
    if (req.method === 'POST' && m) {
      const reqs = body?.requests || [];
      return json(200, { embeddings: reqs.map(r => ({ values: mockVector(r.content?.parts?.map(p => p.text).join(' '), r.outputDimensionality || 3072) })) });
    }

    if (req.method === 'POST' && url.pathname === '/openai/v1/chat/completions') {
      // Groq / OpenAI-compatible streamed chat completion.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const id = 'chatcmpl-mock';
      const chunk = async (delta, extra = {}) => { res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body?.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`); await sleep(delay); };
      const sys = String(body?.messages?.[0]?.content || '');
      const has = /\n\[1\] \(/.test(sys);
      await chunk({ role: 'assistant', content: '' });
      await chunk({ reasoning: 'Reading the retrieved passages. ' });
      await chunk({ reasoning: 'Passage 1 looks most relevant.' });
      const pieces = has
        ? ['This is a **mock** answer ', 'from the local Groq stub. ', 'It is based on passage ', '[1].', '\n- Reasoning effort: ' + (body?.reasoning_effort || 'none')]
        : ['The uploaded documents don\'t cover this ', '(mock answer, no passages were sent).'];
      for (const content of pieces) await chunk({ content });
      const prompt = Math.ceil(sys.length / 4);
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model: body?.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], x_groq: { id: 'req_mock', usage: { prompt_tokens: prompt, completion_tokens: 59, total_tokens: prompt + 59, completion_tokens_details: { reasoning_tokens: 17 } } } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    json(404, { error: { code: 404, message: 'Not found in mock' } });
  });

  return new Promise(resolve => server.listen(port, () => resolve({ server, port: server.address().port, requests, close: () => new Promise(r => server.close(r)) })));
}

// Run directly (but not when the test runner loads this file).
if (!process.env.NODE_TEST_CONTEXT && import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.MOCK_PORT || 4999);
  startMock({ port }).then(() => console.log(`[mock-gemini] listening on http://localhost:${port}`));
}

// Local mock of the Gemini endpoints Lumen uses (spec 12.2). No real key needed.
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
      'x-goog-api-key': req.headers['x-goog-api-key'] ? '(present)' : '(missing)',
      'api-revision': req.headers['api-revision'] ?? '(none)',
      thinking_level: body?.generation_config?.thinking_level,
      thinking_summaries: body?.generation_config?.thinking_summaries,
      taskType: body?.requests?.[0]?.taskType
    });

    if (!req.headers['x-goog-api-key']) return json(403, { error: { code: 403, message: 'Method doesn\'t allow unregistered callers.' } });
    if (failures.length) { const f = failures.shift(); return json(f.status, { error: { code: f.status, message: f.message } }); }

    const m = url.pathname.match(/^\/v1beta\/models\/([^/:]+):batchEmbedContents$/);
    if (req.method === 'POST' && m) {
      const reqs = body?.requests || [];
      return json(200, { embeddings: reqs.map(r => ({ values: mockVector(r.content?.parts?.map(p => p.text).join(' '), r.outputDimensionality || 3072) })) });
    }

    if (req.method === 'POST' && /^\/v1(beta)?\/interactions$/.test(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const send = async ev => { res.write(`event: ${ev.event_type}\ndata: ${JSON.stringify(ev)}\n\n`); await sleep(delay); };
      const sys = String(body?.system_instruction || '');
      const has = /\n\[1\] \(/.test(sys);
      await send({ event_type: 'interaction.created', interaction: { id: 'mock-1', status: 'in_progress' } });
      await send({ event_type: 'step.start', index: 0, step: { type: 'thought' } });
      await send({ event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'Reading the retrieved passages. ' } } });
      await send({ event_type: 'step.delta', index: 0, delta: { type: 'thought_summary', content: { type: 'text', text: 'Passage 1 looks most relevant.' } } });
      await send({ event_type: 'step.stop', index: 0 });
      await send({ event_type: 'step.start', index: 1, step: { type: 'model_output' } });
      const pieces = has
        ? ['This is a **mock** answer ', 'from the local Gemini stub. ', 'It is based on passage ', '[1].', '\n- Thinking level: ' + (body?.generation_config?.thinking_level || 'none')]
        : ['The uploaded documents don\'t cover this ', '(mock answer, no passages were sent).'];
      for (const text of pieces) await send({ event_type: 'step.delta', index: 1, delta: { type: 'text', text } });
      await send({ event_type: 'step.stop', index: 1 });
      await send({ event_type: 'interaction.completed', interaction: { id: 'mock-1', status: 'completed', usage: { total_input_tokens: Math.ceil(sys.length / 4), total_output_tokens: 42, total_thought_tokens: 17, total_tokens: Math.ceil(sys.length / 4) + 59 } } });
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

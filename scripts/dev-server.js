// Local dev server: serves public/ and routes /api/* to the same handlers Vercel runs.
// Usage: npm run dev   (reads .env.local, then .env; real environment variables win)

import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'public');

export function loadEnvFiles(files = ['.env.local', '.env']) {
  for (const f of files) {
    const p = path.join(root, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };

const ROUTES = {
  '/api/health': () => import('../api/health.js'),
  '/api/embed': () => import('../api/embed.js'),
  '/api/chat': () => import('../api/chat.js')
};

// Vercel-style helpers so handlers may use res.status().json() if they want to.
function shim(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = obj => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); return res; };
  return res;
}

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.statusCode = 400; return res.end('Bad request'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(pub, path.normalize(rel));
  if (!file.startsWith(pub + path.sep)) { res.statusCode = 403; return res.end('Forbidden'); }
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
  } catch { res.statusCode = 404; res.end('Not found'); }
}

export function createDevServer() {
  return http.createServer(async (req, res) => {
    shim(res);
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (ROUTES[pathname]) {
        res.setHeader('Cache-Control', 'no-store');
        const { default: handler } = await ROUTES[pathname]();
        return await handler(req, res);
      }
      if (pathname.startsWith('/api/')) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); return res.end('{"error":"Not found"}'); }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
      return await serveStatic(req, res, pathname);
    } catch (e) {
      console.error('dev server error:', e?.name);
      if (!res.headersSent) { res.statusCode = 500; res.end('{"error":"Server error"}'); } else res.end();
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  loadEnvFiles();
  const port = Number(process.env.PORT || 3000);
  createDevServer().listen(port, () => {
    const hasKey = !!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY);
    console.log(`Lumen running at http://localhost:${port}`);
    if (process.env.GEMINI_BASE_URL) console.log(`Gemini base URL: ${process.env.GEMINI_BASE_URL}`);
    if (!hasKey) console.warn('GEMINI_API_KEY is not set. Add it to .env.local and restart.');
  });
}

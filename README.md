# Lumen: chat with your documents (Gemini RAG)

Upload PDF, Word, text, Markdown, CSV, JSON, HTML or code files (up to **10 MB each**) and ask questions about them. Lumen splits each file into chunks in your browser and embeds them with Gemini. For each question it finds the closest passages and has Gemini answer **only from those passages**, with numbered sources you can open.

The front end is a single static page (`public/index.html`). The API key stays in three small Vercel Functions (`api/`). There are no runtime npm dependencies.

```
Browser (public/)                               Vercel Functions (api/)            Gemini
read → chunk → batches of ≤50 ──────────────▶  POST /api/embed ──────────────▶  :batchEmbedContents
in-memory index (vectors + TF-IDF)  ◀─vectors─                                     gemini-embedding-001
question → embed → hybrid rank → top-k ─────▶  POST /api/chat  ──────────────▶  /v1beta/interactions?alt=sse
render streamed thoughts, answer, [n] ◀──SSE──                                     gemini-3.8-flash
```

## Quick start (local)

Requires **Node.js 22+**. There is nothing to `npm install`.

1. Get a key at <https://aistudio.google.com/apikey>.
2. Copy `.env.example` to `.env.local` and paste the key after `GEMINI_API_KEY=`.
3. Run `npm run dev`, which also works as `npm start`.
4. Open <http://localhost:3000>.

The dev server reads `.env.local`, then `.env`. Real environment variables take precedence over both. Both files are git-ignored.

### Without a key: the mock

```bash
npm run dev:mock
```

This starts a local Gemini stand-in on port 4999 (`test/mock-gemini.js`) and runs the app against it, with deterministic embeddings and a streamed answer that cites `[1]`. It uses `&` to start two processes, so run it from a POSIX shell (macOS, Linux, WSL or Git Bash).

### Tests

```bash
npm test
```

The tests use Node's built-in test runner: chunker, retrieval, SSE parsing and the HTTP API against the mock.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `GEMINI_API_KEY` | — | **Required.** `GOOGLE_API_KEY` is also accepted and takes precedence if both are set. |
| `GEMINI_MODEL` | `gemini-3.8-flash` | Chat model |
| `GEMINI_API_VERSION` | `v1beta` | Path segment for the Interactions endpoint |
| `GEMINI_API_REVISION` | `2026-05-20` | Sent as the `Api-Revision` header. Set it to an empty value to omit the header. |
| `GEMINI_THINKING_LEVEL` | `low` | Server default: `minimal`, `low`, `medium` or `high` |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-001` | Or `gemini-embedding-2`. The vectors aren't comparable, so reload the page and re-upload after switching. |
| `GEMINI_EMBED_DIM` | `768` | 128–3072 |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Tests point this at the mock |
| `ALLOW_ORIGIN` | *(empty)* | Set only if the UI is served from another origin (enables CORS) |
| `PORT` | `3000` | Local dev server only |

## Deploy to Vercel (dashboard)

1. Push this repository to GitHub.
2. In Vercel, go to **Add New… → Project → Import Git Repository** and pick this repo. Name the project `lumen`.
3. Set **Framework Preset: Other**, leave **Build Command** empty, and set **Output Directory** to `public`. `vercel.json` also sets the output directory.
4. Under **Environment Variables**, add `GEMINI_API_KEY` for **Production** and **Preview**. Type it into Vercel; never commit it.
5. Click **Deploy**.
6. Open `https://<your-domain>/api/health`. It should return `"ok": true`.

From then on, every push to `main` deploys to production, and every other branch gets a preview URL.

Function settings are in `vercel.json`: `maxDuration` is 60 s for chat and embed and 10 s for health, API responses use `Cache-Control: no-store`, and the security headers are set there too.

## API

| Endpoint | Body | Returns |
|---|---|---|
| `GET /api/health` | — | `{ ok, chatModel, embedModel, dim, apiVersion, thinking }`, plus `error` if the key is missing |
| `POST /api/embed` | `{ texts: string[1..100], kind: "document" \| "query" }` | `{ vectors, dim, model }`. Vectors are L2-normalised. |
| `POST /api/chat` | `{ question, context: [{n, doc, page, text}] (≤12), history (last 8), thinking }` | Server-Sent Events: `{step}` `{th}` `{t}` `{usage}` `{error}` `{done}` |

Errors are JSON, `{ "error": "…" }`. Upstream 429 is passed through as 429, and other Gemini failures become 502. `/api/embed` retries once after 800 ms on a 429 or 5xx.

## Security

- The key is read only from server environment variables. It is never sent to the browser, put in an error, or logged. Logs hold the method, path, status, duration and upstream status. When a Gemini call fails, the log also gets Gemini's own error message, capped at 300 characters with anything that looks like an API key removed. Request bodies, documents and answers are never logged.
- **Restrict your key** to the Gemini API in Google AI Studio, and **set billing alerts** in Google Cloud.
- Input sizes are validated on every endpoint, and request bodies are capped at 4 MB, under Vercel's 4.5 MB limit. Files are parsed in the browser, so only chunk text is sent.
- All document and model text is HTML-escaped before it's rendered.

## Known limits

- **The index is in memory.** Documents and vectors live in the browser tab and are lost on reload. Nothing is stored on the server.
- **Memory.** Vectors are stored as `Float32Array`, but each chunk also keeps its text and keyword index. The library warns above 20,000 chunks. A 10 MB text file is about 14,000 chunks at the default size, so several large files can exhaust the tab. Raising the chunk size reduces this.
- **No OCR.** Scanned PDFs have no text layer and show "No readable text (scanned PDFs need OCR)".
- **Rate limiting is best-effort.** Per-IP limits of 60 chat and 120 embed requests a minute are kept in each function instance's memory. They are not shared between instances and reset on cold starts.
- **Large files take minutes.** A 10 MB file needs about 280 embed requests, more than the 120-a-minute limit. Every 429 carries `Retry-After`. The browser pauses document embedding until then and retries each batch up to 10 times, so a 10 MB file takes about 2–3 minutes. Gemini's own quota 429s are handled the same way. Question embeddings never wait: on a 429 they fall back to keyword search.

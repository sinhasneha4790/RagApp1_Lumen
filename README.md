# Lumen: chat with your documents (Groq + Gemini RAG)

Upload PDF, Word, text, Markdown, CSV, JSON, HTML or code files (up to **10 MB each**) and ask questions about them. Lumen splits each file into chunks in your browser and embeds them with Gemini. For each question it finds the closest passages and has **Groq** answer **only from those passages**, with numbered sources you can open.

> **Why two providers?** Answers originally came from Gemini, but Gemini kept refusing chat requests from a free-tier key with "high demand" (HTTP 503) while its embeddings kept working. Chat now goes to Groq (`openai/gpt-oss-120b`). Groq has no embeddings API, so embeddings stay on Gemini. `TECHNICAL_SPEC.md` (version 1.1) describes the current design; its section 17 lists every change from the original Gemini-only spec.

The front end is a single static page (`public/index.html`). The API keys stay in three small Vercel Functions (`api/`). There are no runtime npm dependencies.

```
Browser (public/)                               Vercel Functions (api/)            Upstream
read → chunk → batches of ≤50 ──────────────▶  POST /api/embed ──────────────▶  Gemini :batchEmbedContents
in-memory index (vectors + TF-IDF)  ◀─vectors─                                     gemini-embedding-001
question → embed → hybrid rank → top-k ─────▶  POST /api/chat  ──────────────▶  Groq /chat/completions (stream)
render streamed reasoning, answer, [n] ◀─SSE──                                     openai/gpt-oss-120b
```

## Quick start (local)

Requires **Node.js 22+**. There is nothing to `npm install`.

1. Get a Groq key at <https://console.groq.com/keys> and a Gemini key at <https://aistudio.google.com/apikey>.
2. Copy `.env.example` to `.env.local` and paste them after `GROQ_API_KEY=` and `GEMINI_API_KEY=`.
3. Run `npm run dev`, which also works as `npm start`.
4. Open <http://localhost:3000>.

The dev server reads `.env.local`, then `.env`. Real environment variables take precedence over both. Both files are git-ignored.

### Without keys: the mock

```bash
npm run dev:mock
```

This starts a local stand-in for both APIs on port 4999 (`test/mock-gemini.js`) and runs the app against it, with deterministic Gemini embeddings and a streamed Groq-style answer, with reasoning, that cites `[1]`. It uses `&` to start two processes, so run it from a POSIX shell (macOS, Linux, WSL or Git Bash).

### Tests

```bash
npm test
```

The tests use Node's built-in test runner: chunker, retrieval, SSE parsing and the HTTP API against the mock.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `GROQ_API_KEY` | — | **Required** for answers. |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Chat model. `openai/gpt-oss-20b` is faster. Thinking levels assume a GPT-OSS model. |
| `GROQ_REASONING_EFFORT` | `low` | Server default thinking level: `low`, `medium` or `high` |
| `GROQ_MAX_TOKENS` | `4096` | `max_completion_tokens` per answer, reasoning included |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Tests point this at the mock |
| `GEMINI_API_KEY` | — | **Required** for embeddings. `GOOGLE_API_KEY` is also accepted and takes precedence if both are set. Without it, search falls back to keywords. |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-001` | Or `gemini-embedding-2`. The vectors aren't comparable, so reload the page and re-upload after switching. |
| `GEMINI_EMBED_DIM` | `768` | 128–3072 |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Tests point this at the mock |
| `ALLOW_ORIGIN` | *(empty)* | Set only if the UI is served from another origin (enables CORS) |
| `PORT` | `3000` | Local dev server only |

## Deploy to Vercel (dashboard)

1. Push this repository to GitHub.
2. In Vercel, go to **Add New… → Project → Import Git Repository** and pick this repo. Name the project `lumen`.
3. Set **Framework Preset: Other**, leave **Build Command** empty, and set **Output Directory** to `public`. `vercel.json` also sets the output directory.
4. Under **Environment Variables**, add `GROQ_API_KEY` and `GEMINI_API_KEY` for **Production** and **Preview**. Type them into Vercel; never commit them.
5. Click **Deploy**.
6. Open `https://<your-domain>/api/health`. It should return `"ok": true`.

From then on, every push to `main` deploys to production, and every other branch gets a preview URL.

Function settings are in `vercel.json`: `maxDuration` is 60 s for chat and embed and 10 s for health, API responses use `Cache-Control: no-store`, and the security headers are set there too.

## API

| Endpoint | Body | Returns |
|---|---|---|
| `GET /api/health` | — | `{ ok, chatProvider, chatModel, embedProvider, embedModel, dim, thinking, thinkingLevels, chatReady, embedReady }`, plus `error` naming any missing key. `ok` is true only when both keys are set. |
| `POST /api/embed` | `{ texts: string[1..100], kind: "document" \| "query" }` | `{ vectors, dim, model }`. Vectors are L2-normalised. |
| `POST /api/chat` | `{ question, context: [{n, doc, page, text}] (≤12), history (last 8), thinking: "low" \| "medium" \| "high" }` | Server-Sent Events: `{step}` `{th}` (reasoning) `{t}` (answer) `{usage}` `{error}` `{done}` |

Errors are JSON, `{ "error": "…" }`. Upstream 429 is passed through as 429 with `Retry-After`, and other Groq or Gemini failures become 502. `/api/embed` retries once after 800 ms on a 429 or 5xx.

## Security

- The keys are read only from server environment variables. It is never sent to the browser, put in an error, or logged. Logs hold the method, path, status, duration and upstream status. When a Groq or Gemini call fails, the log also gets the provider's own error message (`groq upstream …` / `gemini upstream …`), capped at 300 characters with anything that looks like an API key removed. Request bodies, documents and answers are never logged.
- **Restrict your Gemini key** to the Gemini API in Google AI Studio, and **set billing alerts** in Google Cloud and Groq.
- Input sizes are validated on every endpoint, and request bodies are capped at 4 MB, under Vercel's 4.5 MB limit. Files are parsed in the browser, so only chunk text is sent.
- All document and model text is HTML-escaped before it's rendered.

## Known limits

- **The index is in memory.** Documents and vectors live in the browser tab and are lost on reload. Nothing is stored on the server.
- **Memory.** Vectors are stored as `Float32Array`, but each chunk also keeps its text and keyword index. The library warns above 20,000 chunks. A 10 MB text file is about 14,000 chunks at the default size, so several large files can exhaust the tab. Raising the chunk size reduces this.
- **No OCR.** Scanned PDFs have no text layer and show "No readable text (scanned PDFs need OCR)".
- **Rate limiting is best-effort.** Per-IP limits of 60 chat and 120 embed requests a minute are kept in each function instance's memory. They are not shared between instances and reset on cold starts.
- **Groq rate limits.** Groq's rate-limits page lists 30 requests and 8K tokens a minute (1K requests a day) for `openai/gpt-oss-120b`; its models page lists higher limits for the Developer plan. Your account's actual limits are at <https://console.groq.com/settings/limits>. Each question sends the top passages plus recent history, so with the lower limits a few quick questions in a row can hit the per-minute token limit. The answer then shows a rate-limit message; wait a moment and ask again.
- **Large files take minutes.** A 10 MB file needs about 280 embed requests, more than the 120-a-minute limit. Every 429 carries `Retry-After`. The browser pauses document embedding until then and retries each batch up to 10 times, so a 10 MB file takes about 2–3 minutes. Gemini's own quota 429s are handled the same way. Question embeddings never wait: on a 429 they fall back to keyword search.

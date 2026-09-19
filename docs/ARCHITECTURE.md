# Tesla architecture

## Core loop

```
user input
  -> skills/loader.ts matches SKILL.md triggers, injects matched bodies
  -> tools/index.ts builds OpenAI tool schema (native tools + all MCP tools)
  -> agent/loop.ts streams OpenAI chat.completions with tools
  -> emits AgentEvents (token / tool_call_started / tool_call_finished / …)
  -> model emits tool_calls -> dispatched to native handler or mcp/registry.ts
  -> results fed back -> loop until model returns plain text
```

Reasoning model: ChatGPT API (OpenAI), not Claude. Claude's ecosystem
conventions (MCP, SKILL.md) are reused because they're the best-documented
open pattern for pluggable tools/instructions, not because Claude is calling
anything at runtime.

## Client/core split (the AgentEvent seam)

Tesla Core is deliberately client-agnostic. Every front end — the CLI
(`src/index.ts`), the Web UI (`src/server/`), and future Telegram / Discord /
VS Code / desktop clients — drives the same core through one seam and consumes
the same event stream. Adding a client means writing an event consumer, never
touching the loop.

```
 CLI ─────────┐
 Web UI (WS) ─┤→ bootstrap() ─→ AgentLoop.send(msg, { onEvent, signal })
 future … ────┘        │              │
                       │              └─ emits AgentEvent stream:
                       │                 run_started · token · tool_call_started ·
                       │                 tool_call_finished · assistant_message ·
                       │                 run_cancelled · error
                       └─ shared: McpRegistry (tools) + Skills + ToolBox
```

- **`src/bootstrap.ts`** — boots the shared singletons once (connect MCP
  servers, load skills, build the ToolBox) and hands back a `TeslaCore` with
  a `createAgent()` factory. The CLI makes one agent; the web server makes one
  per session.
- **`src/agent/events.ts`** — the `AgentEvent` union and `SendOptions`
  (`onEvent`, `signal`). This is the contract.
- **`AgentLoop.send(msg, opts)`** streams via `stream: true`, emitting `token`
  deltas for visible text and `tool_call_*` events around each tool. An
  `AbortSignal` in `opts` cancels mid-run (checked at round/tool boundaries and
  after each streamed completion — the OpenAI SDK returns partial content on
  abort rather than throwing, so both paths are handled).

## Model router (`src/agent/router.ts` + `src/agent/brains.ts`)

Tesla is model-independent: each turn is routed to a **brain** rather than
hardcoding OpenAI.

- **`brains.ts`** — builds the available brains as OpenAI-compatible clients:
  `gpt` (always) and `grok` (only when `GROK_API_KEY` is set; xAI is
  OpenAI-compatible, so it's the same SDK with `baseURL: https://api.x.ai/v1`
  and model `grok-4.3` by default).
- **`router.ts`** — `classify(message)` returns which brain to use and why. v1
  is a fast keyword heuristic: social-sentiment / trends / public-opinion /
  "what are people saying" / X-Twitter queries → **Grok** (its real-time human
  data is genuinely better there); everything else (coding, reasoning, writing,
  research) → **GPT**. Structured so an LLM classifier can replace the
  heuristic later without touching the loop.
- **Fallback** — in `AgentLoop.send`, if the chosen brain's completion call
  fails (rate-limit, auth, network), the run switches to the other brain once
  and retries the round. Emits `model_selected` and `model_fallback` events so
  clients can show which brain answered.

When no `GROK_API_KEY` is present, routing is a no-op (everything is GPT) and
there's no fallback — Tesla behaves exactly as before.

## Web server layer (`src/server/`)

`npm run web` starts a loopback-only (`127.0.0.1:3131` by default) server that
is purely a **client** of the core:

| File | Role |
|---|---|
| `index.ts` | `node:http` server + `ws` WebSocketServer; SIGINT closes MCP |
| `http.ts` | static file serving from `public/` (path-traversal-guarded) + `POST /api/transcribe` |
| `ws.ts` | one WebSocket per browser; forwards AgentEvents; enforces one active run per session |
| `sessions.ts` | `Map<sessionId, {agent, transcript, activeRun}>` — survives reconnect/refresh |
| `transcribe.ts` | buffers raw audio (25 MB cap), runs the STT waterfall |
| `stt.ts` | STT provider chain (see below) |
| `public/` | no-build vanilla UI: `index.html` + `app.js` + `styles.css` |

**WebSocket protocol** (JSON):

| Direction | Message |
|---|---|
| client→server | `{type:"user_message", text}` · `{type:"cancel"}` |
| server→client | `{type:"history", messages}` (on connect) · every `AgentEvent` · `{type:"error", message:"busy"}` if a run is already active |

**Sessions:** the browser generates a UUID once (`localStorage`) and passes it
as `?session=<id>` on the WS URL. Refreshing replays the transcript; history is
in-memory only (not persisted — see WhatsNext).

**Front end:** `app.js` renders assistant text as Markdown via
marked → DOMPurify (sanitize) → highlight.js + mermaid (`securityLevel:
"strict"`), streaming incrementally on `token` and doing a final highlight/
mermaid pass on `assistant_message`. Tool activity shows as collapsible chips.

## Speech-to-text (`src/server/stt.ts`)

Voice is just another input channel (no TTS yet). The browser records with
`MediaRecorder` (webm/opus), POSTs the raw blob to `/api/transcribe`, and
**auto-sends** the returned transcript as a normal user message. Transcription
runs through the same `runWaterfall` orchestration as web search:

| Order | Provider | Status |
|---|---|---|
| 1 | Deepgram Nova-3 (REST, no SDK) | Live **iff** `DEEPGRAM_API_KEY` is set; skipped otherwise |
| 2 | OpenAI (`config.transcribeModel`, default `gpt-4o-mini-transcribe`) | **Live** — always available via `OPENAI_API_KEY` |
| 3 | Local (Parakeet TDT / faster-whisper) | Stub, throws `NotImplemented` — see WhatsNext |

Adding Deepgram is zero-code: drop the key in `.env`. Going local-first later
is a class swap, not a redesign.

## Retrieval design (target: "Carter" RAG waterfall)

This is the full design the `src/retrieval/` modules are scaffolded around.
**Status column shows what's actually live today vs. stubbed.**

### 1. Caching layer (`src/retrieval/cache/types.ts`)

| Tier | Purpose | Status |
|---|---|---|
| Tier 1: Exact-match cache | Same query within 24h -> return cached context, zero compute | **Live** — in-memory `ExactMatchCache` (not yet wired into the search tool call path; add before hitting a real API budget) |
| Tier 2: Semantic cache (Qdrant, cosine > 0.92) | Near-duplicate queries -> return cached context | Stub, throws `NotImplemented` — needs a Qdrant instance |

### 2. Web search fallback waterfall (`src/retrieval/waterfall.ts`)

| Order | Provider | Status |
|---|---|---|
| 1 (primary) | Self-hosted SearXNG, 2.5s timeout | Not wired — needs a SearXNG instance |
| 2 (fallback) | DuckDuckGo (direct POST to `html.duckduckgo.com/html/`, no API key) | **Live** — only registered provider right now |
| 3 (fallback) | Brave Search API | Not wired — needs a Brave API key |

The `runWaterfall()` orchestration logic itself (try-in-order, per-provider
timeout, skip on empty result) is real and provider-agnostic — adding
SearXNG/Brave later is just registering another `SearchProvider` in
`src/tools/index.ts`, no loop rewrite needed.

### 3. Scraping resilience (`src/retrieval/scrape.ts`)

| Stage | Tool | Status |
|---|---|---|
| Fast path | Readability + JSDOM extraction from raw HTML | **Live** |
| Heavy path | Crawl4AI / Playwright headless render for JS-heavy/Cloudflare pages | Stub, throws `NotImplemented` |

Staging logic (fall through to heavy path when fast-path text is under
~200 chars) is real; only the heavy-path implementation is missing.

### 4. Reranking (`src/retrieval/rerank.ts`)

| Impl | Status |
|---|---|
| `NoOpReranker` — truncate to topN in retrieval order | **Live** (v1 default) |
| `bge-reranker-v2-m3` locally-run cross-encoder rerank before truncation | Not implemented — needs the model + a local inference path |

Target pipeline once all four are live: retrieve top ~20 (Qdrant) + top ~10
(web/waterfall) -> scrape -> pool ~40 chunks -> rerank -> keep top 5 -> feed
to the model. This keeps context small and avoids "lost in the middle"
degradation, and keeps token cost down since only 5 chunks reach the LLM.

See `docs/WhatsNext.md` for the concrete infra to stand up each stubbed
piece.

## The HUD (`src/server/public/`)

The web UI is no longer a chat box — it's a floating-window HUD whose components
the **agent writes at runtime** (Component Factory), which repair themselves when
they crash and get suspended when idle. That subsystem has its own doc:
**`docs/HUD.md`** (how it works, the two component tiers, TokenJuice patches,
self-healing, the maintenance loop, and the limitations).

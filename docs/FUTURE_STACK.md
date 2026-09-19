# Future Stack — Goldmine Items Needing Infrastructure

These are high-value components that are architecturally sound but require
external services, Docker, or significant setup before they're usable.
Each entry documents what it does, what needs to be set up first, and
how Tesla is already designed to absorb it.

---

## 1. LiteLLM — Unified Provider Proxy

**What it is:** An open-source Python proxy that normalizes OpenAI, Anthropic,
Gemini, Mistral, Ollama, vLLM, and 100+ other providers into a single
OpenAI-compatible API. Handles retries, fallbacks, and cost tracking via YAML.

**Why it's a goldmine:** Tesla's `brains.ts` currently hand-codes GPT + Grok +
llama.cpp. LiteLLM would replace all of that with a single `baseURL` pointing
at the proxy — adding any new model becomes a one-line YAML change, not code.

**What needs to happen first:**
1. `pip install litellm[proxy]`
2. Write `litellm_config.yaml` with provider definitions and fallback chains
3. Run `litellm --config litellm_config.yaml --port 4000`
4. In `brains.ts`: replace all three brain clients with one pointing at `http://127.0.0.1:4000/v1`

**Tesla integration point:** `src/agent/brains.ts` — swap `buildLocalClient()` and
the OpenAI/Grok clients for a single LiteLLM client. The router stays identical.

---

## 2. LangGraph — Deterministic State-Machine Council

**What it is:** A Python library (from LangChain) for building explicit execution
graphs with typed state, conditional edges, and loop-back paths.

**Why it's a goldmine:** The current `council.ts` runs roles in parallel with no
control flow. LangGraph would let you build: `Planner → Researcher → Critic →
IF critical flaws: back to Researcher ELSE → Synthesizer`. Prevents wasted
compute and produces better answers on complex multi-step tasks.

**What needs to happen first:**
1. `pip install langgraph langchain-openai`
2. Build a `council_graph.py` with typed state and conditional edges
3. Expose it as an MCP server or HTTP endpoint
4. Call from `src/agent/council.ts` instead of the parallel approach

**Tesla integration point:** `src/agent/council.ts` — replace `runCouncil()` with
an HTTP call to the LangGraph service. The tool interface stays the same.

---

## 3. Qdrant — Production Vector Store

**What it is:** A high-performance vector database that runs as a single binary
or Docker container. Supports cosine similarity, filtering, and payloads.

**Why it's a goldmine:** The current `vectorSearch.ts` stores embeddings as JSON
blobs in SQLite and computes cosine similarity in JS. This works fine up to
~10,000 documents. Beyond that, Qdrant is 100x faster and supports
approximate nearest-neighbour search, filtering by namespace, and persistence.

**What needs to happen first:**
1. `docker run -p 6333:6333 qdrant/qdrant`
2. `npm install @qdrant/js-client-rest`
3. Replace `vectorSearch.ts` SQL storage with Qdrant collection calls
4. The `hybrid_search`, `index_item` tools stay unchanged from the agent's perspective

**Tesla integration point:** `src/retrieval/vectorSearch.ts` — the public API
(`hybridSearch`, `indexItem`, `deleteItem`) stays the same; only the storage
backend changes. The `SemanticCache` stub in `cache/types.ts` would also
finally become live.

---

## 4. Playwright + browser-use — Full Browser Automation

**What it is:** `browser-use` is a Python library wrapping Playwright with
LLM-driven action planning. Given a goal ("log into X and download Y"),
it navigates, clicks, fills forms, and handles CAPTCHAs.

**Why it's a goldmine:** Tesla can currently only scrape static HTML. Playwright
with profile persistence (using your existing browser sessions/cookies) would
let Tesla: log into university portals, submit forms, interact with SPAs,
automate repetitive web tasks.

**What needs to happen first:**
1. `pip install browser-use playwright`
2. `playwright install chromium`
3. Configure profile path to point at your Chrome/Edge user data dir
   (inherits active sessions — no re-login needed)
4. Write a `browser_agent.py` script that accepts a goal string and
   returns a result JSON (same subprocess pattern as `document_parse.py`)
5. Add `browser_automate` tool to `src/tools/index.ts`

**Stealth note:** Pair with `playwright-stealth` to avoid bot detection on
sites that check for automation fingerprints.

**Tesla integration point:** `src/retrieval/scrape.ts` `heavyScrape()` stub —
this is the exact slot designed for Playwright. Also a new `browser_automate`
tool for agentic tasks beyond scraping.

---

## 5. Crawl4AI (Self-Hosted) — Clean Web Content for LLMs

**What it is:** An open-source Python service that converts any URL into
clean, BM25-indexed Markdown optimised for LLM context. Strips navbars,
ads, cookie banners. Handles JS-heavy pages via headless Chromium.

**Why it's a goldmine:** The current Jina Reader fallback is a remote API
with rate limits. Crawl4AI runs locally, handles Cloudflare-gated pages,
and produces better Markdown structure (headers, tables preserved).

**What needs to happen first:**
1. `pip install crawl4ai` then `crawl4ai-setup` (installs Playwright)
2. Run the async API: `crawl4ai-api --port 8181`
3. Add a `CRAWL4AI_URL=http://127.0.0.1:8181` env var
4. In `scrape.ts`, add Crawl4AI as Tier 2 (before Jina) when the env var is set

**Tesla integration point:** `src/retrieval/scrape.ts` — the `heavyScrape()`
stub becomes a real implementation using the local Crawl4AI HTTP API.

---

## 6. APScheduler / node-cron — Recurring Background Tasks

**What it is:** A scheduler for running tasks on a recurring schedule
(cron expressions, intervals). `node-cron` is the Node.js equivalent
of Python's APScheduler, with zero external deps.

**Why it's a goldmine:** Tesla's `backgroundRunner.ts` handles one-shot tasks.
Adding cron-style scheduling enables: morning briefings, hourly email checks,
daily library reservation scans, periodic web monitoring.

**What needs to happen first:**
1. `npm install node-cron @types/node-cron`
2. Add a `schedule_task` tool: `{ goal, cron_expression, instructions }`
3. Store scheduled tasks in SQLite (via `taskQueue.ts`)
4. On Tesla startup, reload and resume any persisted schedules

**Tesla integration point:** `src/agent/backgroundRunner.ts` — add a
`scheduleRecurringTask()` function alongside `startBackgroundTask()`.
The `transactional_task_queue` SQLite DB already handles persistence.

---

## 7. @xenova/transformers — Local Embedding Model for Smart Skill Injection

**What it is:** A JavaScript port of HuggingFace Transformers that runs
ONNX models in Node.js. A 22MB all-MiniLM-L6-v2 model can embed text
and do semantic similarity entirely locally, no API calls.

**Why it's a goldmine:** Tesla currently sends ALL skills and ALL tool
descriptions to the LLM on every turn (~8,000 tokens of overhead). With
local embeddings, we can rank skills and tools by semantic relevance to
the user's message and inject only the top-K, saving significant tokens
and reducing context noise.

**What needs to happen first:**
1. `npm install @xenova/transformers`
2. First run downloads the ONNX model (~22MB, cached after that)
3. Replace `matchSkills()` keyword matching with cosine similarity ranking
4. Add tool relevance scoring to `getOpenAiTools()` — return only top-20
   tools instead of all 40+

**Tesla integration point:**
- `src/skills/loader.ts` `matchSkills()` — replace with semantic search
- `src/tools/index.ts` `ToolBox.getOpenAiTools()` — add relevance filtering
- The `hybrid_search` tool already does this for documents; same approach here

---

## Priority Order

When you're ready to set these up:
1. **node-cron** — easiest, pure Node, immediate value (scheduled briefings)
2. **@xenova/transformers** — self-contained, reduces token cost every turn
3. **Qdrant** — when corpus exceeds ~5,000 indexed items
4. **Crawl4AI** — when Jina rate limits become a problem
5. **LiteLLM** — when you want to add Anthropic/Gemini/local models easily
6. **Playwright + browser-use** — when you need to automate web interactions
7. **LangGraph** — when council mode needs deterministic retry loops
8. **Wasm execution sandbox** — when `run_script` security needs hardening
9. **CodeGraphContext MCP** — when codebase navigation becomes complex

---

## 8. Wasm Execution Sandbox (Extism) — Hardened `run_script`

**What it is:** Extism is a WebAssembly plugin system. Instead of running agent-generated
scripts via `execFile` (which has full OS access), you run them inside a Wasm sandbox
that literally cannot access the network or filesystem unless you explicitly grant
individual capabilities.

**Why it's a goldmine:** The current `run_script` whitelist is good but not hermetic.
A clever prompt could still cause side effects. Wasm isolation makes it impossible —
the sandbox boots in <5ms (vs ~500ms Docker) and enforces capability-based security
at the hardware level.

**What needs to happen first:**
1. `npm install @extism/extism`
2. Build or find a Python-in-Wasm runtime (pyodide compiled to a plugin)
3. Replace `execFile` in `scriptRunner.ts` with `extism.Plugin.call()`
4. Map explicit capabilities: `allow_write: [WORKSPACE_DIR]`, `allow_network: []`

**Tesla integration point:** `src/tools/native/scriptRunner.ts` — `runScriptFile()`
becomes a Wasm call instead of `execFile`. Public API unchanged.

---

## 9. CodeGraphContext MCP — Semantic Codebase Navigation

**What it is:** An MCP server that indexes an entire project into a graph database,
mapping function calls, class inheritance, imports, and file relationships. The agent
can ask "what calls this function?" or "what does this module depend on?" instead of
reading files blindly.

**Why it's a goldmine:** When Tesla works on a large codebase (like itself), it
currently reads files one by one. CodeGraphContext gives it a semantic map upfront —
the agent understands structure before touching code, preventing broken refactors.

**What needs to happen first:**
1. Find/build an MCP server that wraps tree-sitter + a graph DB (SQLite CTEs work)
2. Register it in `mcp_servers.json` pointing at the target repo
3. The agent gets tools: `get_callers(fn)`, `get_dependencies(module)`,
   `find_symbol(name)`, `get_inheritance_chain(class)`

**Interim approach (available now):** The `code_structure_analysis` design in the
architecture notes describes using `tree-sitter` directly. This can be built as a
native tool wrapping the `tree-sitter` npm package without a full graph DB.

**Tesla integration point:** New MCP server entry in `mcp_servers.json`. No core changes.

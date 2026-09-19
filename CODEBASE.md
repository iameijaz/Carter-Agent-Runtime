# Carter — codebase map

Fast tool-execution agent **forked from Tesla (2026-07-14)**. Same
client-agnostic core, same MCP-client + Skills ecosystem, same HUD web UI —
plus three capabilities Tesla lacked and a speed pass. Carter shares ~90% of
Tesla's source; **read [Tesla/CODEBASE.md](../Tesla/CODEBASE.md) for the shared
core** — this file documents only the deltas.

## Run

```
npm install
npm run web    # fluid HUD at http://127.0.0.1:3132  (Tesla keeps 3131)
npm run dev    # terminal REPL
```

`.env` is copied from Tesla — same keys work. `CARTER_PORT`/`CARTER_HOST`
override `TESLA_PORT`/`TESLA_HOST`. Shared SQLite DB: `tesla.db` (adds a
`mistakes` table).

## What Carter adds over Tesla

### 1. Self-installing MCPs
Capability gap detected → `search_extensions` (npm registry) →
`install_mcp_server` (operator-approved) → tools live the **same turn**,
persisted to `mcp_servers.json` as lazy for next boot. Declined installs are
remembered and never re-proposed.

### 2. Mistake memory — `src/memory/mistakes.ts`
Every failed tool call is recorded (`mistakes` table). A later retry that
succeeds becomes the recorded fix; user corrections via `record_lesson`
supersede older lessons. Lessons are injected into the system prompt every
turn and attached to repeat failures — the same mistake is never made twice.

### 3. Multi-agent dispatch — `dispatch_agents`
Fans a task with independent parts out to 2–5 parallel in-process sub-agents
and merges their results.

### Speed
- Tool calls **within a round run in parallel** (Tesla ran them serially).
- MCP tool schemas are **cached against a registry version** instead of being
  re-listed from every server every turn.

### Carter-specific tools
| Tool | Does |
|---|---|
| `search_extensions` | search npm for MCP servers matching a missing capability |
| `install_mcp_server` | hot-install + connect an MCP server (operator approval) |
| `create_skill` | write a `SKILL.md` and load it live |
| `record_lesson` | persist a mistake + fix into the never-repeat prompt block |
| `dispatch_agents` | run 2–5 parallel sub-agents and merge results |

## Structure delta vs Tesla
Same tree as Tesla with these differences:
- **Added:** `src/memory/mistakes.ts`.
- **Dropped** (present in Tesla, absent here): `agent/modelRegistry.ts`,
  `personas.ts`, `promptOverride.ts`, `critique.ts`, `missingFeatures.ts`,
  and their `.test.ts` files; `retrieval/cache/types.ts` retained,
  `testing/` harness and a few native tools (`crawl`, `apiSearch`, `weather`
  variants, `webFetch` extras) trimmed. Treat Tesla's module table as the
  superset and this list as the diff.

Everything else — HUD component factory, memory vault, background tasks,
trains/weather/email/library tools, Telegram client — is inherited unchanged.
## Deeper docs
`docs/ARCHITECTURE.md` · `HUD.md` · `LOCAL_LLM.md` · `FUTURE_STACK.md`.
`ARCHITECTURE.md` is the one to start with.

## Known debt (inherited from Tesla, unchanged)
- `src/agent/council.ts`, `src/clients/telegram.ts`,
  `src/tools/native/osVision.ts` have pre-existing type errors (tsx runs,
  `npm run build` doesn't).
- Web UI is loopback-only; background-task broadcasts go to all open tabs.

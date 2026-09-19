# The HUD & the Component Factory

How Tesla's web UI works, and where it breaks.

`npm run web` → `http://127.0.0.1:3131`. The HUD is a floating-window desktop
that the **agent can extend at runtime**: it writes UI components, registers them
through a tool, and they hot-mount over the WebSocket with no page refresh.

---

## 1. Layout: windows, not a page

The frontend (`src/server/public/`) is deliberately **no-build vanilla ESM** — no
React, no bundler. Files are served straight off disk, so editing them and hitting
refresh is the whole dev loop.

| File | Role |
|---|---|
| `app.js` | entry: collects DOM refs, boots `Hud` |
| `hud.js` | controller — WebSocket, central `route(ev)` event switch, shared state, workspaces |
| `windowManager.js` | the `HUD-Window` wrapper: drag, resize, close, z-order, suspend/wake, health badge |
| `widgetRegistry.js` | built-in widgets (transcript, glass_box, tool_timeline, task_monitor, net_status, render_engine) |
| `componentLoader.js` | loads **agent-generated** components (both tiers), error shim, in-place reload |
| `markdown.js` | marked → DOMPurify (the single sanitisation path) |

Everything on screen — built-in widget or agent-built component — lives in a
`HUD-Window`. The window owns the chrome; **components never implement their own
drag/resize/close**. Geometry (`x/y/w/h/z`, suspended) is persisted to
`workspace/workspace_state.json` (debounced 400 ms) and restored on refresh.

**Workspaces** (DEV / RESEARCH / PUBLISH / FOCUS) are named seed arrangements in
`SEED_WORKSPACES` (`hud.js`). Switching closes all windows and re-mounts the set.
The agent can compose one itself with `set_workspace`.

**Focus mode** hides the "chrome" windows (`DEBUG_ONLY` in `hud.js`) so only
visual output remains; **Debug** (`Ctrl+D`) reveals them again.

---

## 2. The Component Factory

This is the load-bearing idea: **the agent builds its own interface.** It is the
UI twin of `dynamicTools.ts` (which does the same thing for *tools*).

### Tools (in `src/tools/index.ts`)

| Tool | Purpose |
|---|---|
| `register_component` | new component (or full rewrite, if you pass an existing `id`) |
| `update_component` | **patch** it — exact find/replace edits ("TokenJuice") |
| `read_component` | read current source before patching |
| `mount_component` / `unmount_component` / `list_components` | manage what's on screen |
| `set_workspace` | recompose the whole layout |

### Two tiers

- **`sandboxed`** (default) — a complete HTML document rendered in
  `<iframe sandbox="allow-scripts">`. Opaque origin: it **cannot** touch the host
  DOM, `localStorage`, or cookies. It **can** `fetch()` any CORS-open API (this is
  how live weather/trains widgets get their numbers). Auto-mounts, no approval.
- **`trusted`** — an ES module (`export default (body, data, HUD) => ({render, update, onResize?, dispose?})`)
  blob-imported into the **main app context**. Full access. Therefore it **requires
  operator approval**: `register_component` blocks on `requestApproval()`
  (`hudBus.ts`), the HIL overlay shows you the code, and you can edit it before it runs.

### Persistence

- Code → `workspace/components/<id>.html` or `.js`
- Manifest → `workspace/.components.json` (`ComponentMeta`: tier, rev, health, lastActive, suspended)
- Reloaded on startup, so components survive restarts.

### TokenJuice (UI diff patches)

Regenerating a whole file to change one colour is wasteful. `update_component`
takes `patches: [{find, replace}]`, applied in order, **atomically** — if any
`find` string isn't present, *nothing* is written and the error hands the agent
the surrounding source lines so it can retry. It bumps `rev` and broadcasts
`component_updated`; the frontend swaps `iframe.srcdoc` **on the same iframe
element**, so the window keeps its exact position and size (verified: geometry
identical before/after, no duplicate window).

---

## 3. Self-healing ("Durable Synthesis")

Agent-written code crashes. Rather than showing you a broken box, the component
repairs itself.

1. `componentLoader.js` **prepends a shim** to every sandboxed document:
   `window.onerror` + `unhandledrejection` → `postMessage` to the host; `load` → `component_ready`.
2. The host relays those over the WS (`component_error` / `component_ready`).
3. `src/agent/componentHealer.ts` runs a state machine:

```
mounted --ready--> probation --15s quiet--> healthy   (repairs reset to 0)
   |                   |
   +---- error --------+--> repairs < 2 ? repairing --> (patched) --> probation
                                        : failed  (✕ badge, stops trying)
healthy + error  -->  logged only, NOT repaired
```

4. `repairing` spawns a **dedicated `AgentLoop`** with the error, stack and current
   source, told to fix itself with `update_component` and not to talk to you.
   Capped at `REPAIR_ROUNDS = 4` tool rounds, `MAX_REPAIRS = 2` attempts.
5. Repairs are **queued behind your own turns** (`setRunActive` in `ws.ts`), so a
   background repair never fights your run for the socket.

The window shows `⟳ self-healing…` while this happens and goes quiet again when
it succeeds. Verified end-to-end: a component throwing `ReferenceError` was
patched from rev 0 → 1 and reached `healthy` without user involvement.

The `healthy + error → log only` rule is deliberate: a widget polling a flaky
network would otherwise trigger an endless repair loop.

---

## 4. Subconscious maintenance

`src/server/maintenance.ts` — a plain 60 s JS interval, **no LLM**.

- **Suspend**: if more than `TESLA_MAX_MOUNTED` (default 8) components are mounted,
  the least-recently-touched ones idle for over `TESLA_INACTIVE_MIN` (default 15 min)
  are suspended — the iframe is torn down to free memory, but the window and the
  registration stay, behind a `💤 suspended — click to wake` overlay.
  **It never deletes anything.**
- Activity is tracked from `pointerdown`/focus on a window (throttled to one ping
  per 30 s) → `lastActive` in the manifest.
- **Snapshot**: once every 24 h, `workspace/components` is committed to **its own
  git repo** (`git init` on first run — the main repo isn't git). If
  `TESLA_COMPONENTS_REMOTE` and a token are set it also pushes; otherwise the local
  commit is the guarantee. Failures are logged, never fatal.

---

## 5. Live data ("show stuff, not code")

The original sin: `web_fetch` runs Readability, which extracts *article prose* — it
returns nothing useful for a JSON API. So the agent used to say "I can't get live
numbers, here's a link to bahn.de".

Fixes:

- **`api_fetch`** — raw HTTP GET, returns the body parsed (JSON) or as text. Size-capped
  (64 KB default, 256 KB hard cap), 15 s timeout, http(s) only.
- **`get_weather`** — wttr.in, keyless.
- **`train_journeys`** — live Deutsche Bahn + regional connections via
  **Transitous/MOTIS** (`api.transitous.org`), keyless. Omit `when` for "from right now".
- **System prompt LIVE DATA POLICY** — never show code, never demand an API key when a
  keyless API exists, never mount placeholder/fake numbers, never tell the user to go
  look it up themselves.

### Tools that render their own UI

`train_journeys` doesn't just return data — it **builds and mounts its own departure
board** (`renderJourneysHtml` in `trains.ts` → `showDataWidget()` in `tools/index.ts`,
under the stable id `trains_live`, so re-asking hot-swaps the same window).

This is on purpose. I first tried instructing the model in the prompt to render
schedule-type answers as components — **and it ignored the instruction**, calling the
tool and then dumping a wall of text. Prompt compliance is too unreliable to hang
"show me things" on. Where showing the result *is* the point, the tool renders it.

---

## Limitations & sharp edges

**Component Factory**
- **Trusted-tier async errors are unattributable.** The shim only works inside the
  sandboxed iframe. A trusted module's *sync* mount/import failure is caught, but an
  error thrown later from a `setTimeout`/promise lands on the host `window` with no way
  to tell which component it came from — so **trusted components only self-heal on sync
  errors**.
- The srcdoc shim is prepended before the component's own HTML. Documents that use
  `document.write` or set a restrictive CSP `<meta>` could break it.
- `update_component` matches the **first** occurrence of `find` and does exact string
  matching — no fuzzy matching, no regex. The agent must `read_component` first if it
  doesn't know the source verbatim.
- Repairs are capped at 2. After that the window shows ✕ and stops trying; you fix it
  or ask for a rewrite.

**Window manager / state**
- `workspace_state.json` is a **single global layout** — not per-session, not per-tab.
  Multiple browser tabs share it and will fight over it.
- HUD events are **broadcast to every connected socket** (`hudBus`), by design for
  multi-tab monitoring. There is no per-session targeting.

**Maintenance**
- The server's "what's mounted" set is **in-memory** and resets on restart, so after a
  restart the suspend loop only knows about components mounted since then.
- Suspension is driven by *pointer activity*, not by whether a component is doing
  useful work. A busy background monitor you never click on can still get suspended.
- Archive-move (relocating very old files) is deliberately **not** enabled; only the
  git snapshot runs.

**Data**
- `transport.rest` (the obvious DB API) was **down (503)** when this was built;
  Transitous is the fallback. Both are free community services with **no uptime
  guarantee** — if trains break, check `api.transitous.org` first.
- Sandboxed components fetch APIs **from the browser**, so a component only works if
  the API sends permissive CORS headers. Server-only APIs must go through `api_fetch`
  and be baked into the component's HTML instead.
- There is **no CSP** on the HUD page, and sandboxed components can reach any host.
  This is acceptable because the server binds loopback-only — **do not widen
  `TESLA_HOST` without adding auth first.**

**Build**
- `npm run build` (tsc) **still fails**, on pre-existing errors in files that are not on
  the runtime path (`backgroundRunner`, `council`, `selfExtend`, `clients/telegram`,
  `osVision`, `telegramPush`). The app runs via `tsx`, which doesn't typecheck, so this
  doesn't affect `npm run web` / `npm run dev`. All *new* code typechecks clean.

## Env knobs

```
TESLA_MAX_MOUNTED=8            # suspend once more than this many are mounted
TESLA_INACTIVE_MIN=15          # ...and idle for this many minutes
TESLA_COMPONENTS_REMOTE=<url>  # optional git remote for component backups
```

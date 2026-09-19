# DECISIONS — 01-helm-agent-runtime

Append-only. Every stack, library, protocol, or pattern choice goes here **with the
alternative that was rejected and why**. Contradicting an entry requires a new entry,
not a silent edit.

Format:

```
## YYYY-MM-DD — <the choice>
**Chose:** X
**Over:** Y, Z
**Because:** <reason grounded in this project's constraints>
**Revisit if:** <the condition that would change this>
```

---
## 2026-09-19 — Core principle: the runtime improves with use

**Chose:** every turn writes back into two stores — a mistake log and a success cache —
so that accuracy rises and latency falls the more the tool is used.
**Over:** a stateless agent that re-derives everything each session.
**Because:** this is the artifact's whole thesis and the only part of it that is
uncommon. Plenty of repos wrap an LLM in a tool loop. Almost none show a measured
improvement curve over real sessions.
**Revisit if:** the curve turns out to be flat after real use — in which case say so in
the README rather than hiding it.

### The two mechanisms

**Fewer mistakes — mistake memory.** A failed tool call records the tool name, the args,
and the exact error. On a later similar call, that record is injected into context before
the model chooses. Deterministic capture: no LLM decides what to record.

**Lower latency — learned bypass.** A *successful* (intent → tool + args) pair is cached.
A later near-identical request resolves from cache and skips the model entirely. This is
where the latency win lives: not in a smaller model, but in not calling one at all. The
regex bypass layer therefore **grows over time** instead of being hand-written once.

### Routing tiers

| Tier | Cost | Reached when |
|---|---|---|
| cache hit | ~0 ms | intent seen before and it worked |
| 0 — router (regex, then 0.6–1.5B local) | low | classify intent / tool family |
| 1 — executor (7–8B local, or cloud) | high | argument synthesis needed |

Most turns should end at cache or tier 0 once the tool has been used for a while. That
shift is the thing to measure.

### What must be logged, from the first commit

Every turn: timestamp, resolution path (cache / tier 0 / tier 1), latency, tool called,
outcome (success / failure + error). Without this from day one there is no curve, and
the curve is the demo. It is three columns in the SQLite table that already exists.

### The claim, and its limit

Claim only what the log shows: "over N sessions and M turns, cache-hit rate went from
X% to Y% and p50 latency from A ms to B ms." Never state an improvement rate that was
not measured on real runs. If the effect is small, report the small number — a measured
small effect reads better than an unmeasured large one.

## 2026-09-19 — LLM provider: OpenAI-compatible base_url, OpenRouter default

**Chose:** one OpenAI SDK client whose `base_url` and model come from `.env`; default
OpenRouter, local (Ollama/vLLM) by env swap.
**Over:** a `LLMProvider` interface with per-vendor implementations; local-only; a
Gemini- or OpenAI-specific SDK.
**Because:** the SDK with a swapped `base_url` already *is* the abstraction — Ollama,
vLLM, LM Studio, OpenRouter, Gemini and OpenAI all speak it. An interface with three
implementations is the over-engineering the root CLAUDE.md forbids. OpenRouter is the
default because a reviewer must be able to clone and run without a 5–20 GB model pull;
local-first loses most reviewers at step one. The provider-chain-with-fallback pattern
already exists in the owner's `dumper.py` — reuse it, do not redesign it.
**Revisit if:** the acceptance test below shows a local model passes and latency in the
loop matters more than reviewer convenience.

### Model acceptance test — size is not the criterion

A model is acceptable if it emits valid tool calls against *this project's real schemas*:

```
20 fixed prompts x the real tool schemas
pass = 20/20 valid JSON, correct tool name, all required args present
then: measure p50/p95 first-token and total latency on the same set
```

Smallest model that passes wins. Expect ~7-8B (Qwen2.5-7B-Instruct / Qwen3-8B, Q4_K_M)
to be the realistic floor and 4B to be borderline. Below ~4B the failure mode is
plausible JSON with wrong argument names — worse than an outright refusal, because it
looks like it worked.

Tier 0 routing is fine at 0.6-1.5B: bucketing into a few intent classes is a genuinely
easier task than argument synthesis.

If nothing under 8B passes, **that is a publishable finding** — write it in the README
with the test method. A measured negative result reads as rigor.

### Mistake memory uses no model

Failure capture is a SQLite write of (tool, args, error string); retrieval is a lookup.
Never ask an LLM to decide what to record — it is slower, costs money, and is less
reliable than recording what actually happened.

## 2026-09-19 — Two deployment configs, no hybrid

**Chose:** one runtime, one env var, two configs — `cloud` (tier 1 = OpenRouter) and
`offline` (tier 1 = local 7-8B). Same code path in both.
**Over:** three separate versions; a hybrid that tries local first and falls back to
cloud per-request.
**Because:** the "lite" idea — cache first, model only on a miss, cache grows until
misses are rare — is not a third version. It is how the runtime works in **every**
config, and it is orthogonal to which model serves the miss. In cloud config it decays
toward "rarely touches the network"; in offline config toward "rarely touches the GPU".
Same mechanism, same log, same graph.

A per-request local->cloud hybrid is rejected specifically: it puts two latency profiles
in one p95, makes behaviour non-deterministic between runs, and adds "which model
actually answered?" to every bug report. Pick one tier 1 per deployment.

**Revisit if:** a real user need appears for per-request escalation. Cost-based routing
is a different feature and needs its own entry.

**README framing this supports:** "Runs fully offline on a 7B model. Runs on OpenRouter
if you would rather not download one. Same runtime, one env var — and in both cases it
calls the model less the longer you use it." The brag is not multi-provider support
(everyone claims that). It is that the dependency on the model **shrinks with use**,
whichever model you pick.

**Cache key must include tool-schema version.** A cache built against one model's
behaviour and one schema silently poisons the other config after a tool changes. One
extra column; nasty bug if missing.

## 2026-09-19 — Provider chain, lifted from the owner's dumper.py

**Chose:** reuse the working provider-chain pattern from `dumper.py` rather than writing
a new client layer.
**Over:** a fresh abstraction, or a single hard-coded client.
**Because:** it already works in production on a live bot, and it is ~20 lines.

**Do not lose this when coding — the mechanism:**

1. `TEXT_CHAIN` is a list of `(OpenAI client, model_name)` tuples.
2. It is **built at startup only for keys actually present in `.env`.** A missing key is
   not an error; that provider simply is not in the chain.
3. Every provider — OpenRouter, OpenAI, local Ollama/vLLM, NVIDIA NIM, Gemini — is
   reached through the **OpenAI SDK with a different `base_url`**. There is no
   per-vendor code.
4. `chat()` walks the chain on failure and **mutates it**: a *hard* error
   (`Incorrect API key`, `Model not found`) removes that provider permanently for the
   process lifetime. A transient error (timeout, 429, 5xx) does not — it retries or
   moves to the next entry and leaves the chain intact.
5. Order in the chain is priority order.

Point 4 is the part worth keeping: it is a circuit breaker that costs one `list.remove`
and stops a dead provider being retried on every call for the rest of the run.

**Scope note:** this is failover *within* tier 1, which is fine and is not the rejected
hybrid above. The rejected thing is escalating between local and cloud **per request as
a routing strategy**. A chain that drops a provider which is genuinely broken is
robustness; a chain that silently changes which class of model answers is not — so in
`offline` config the chain must contain only local entries.

## 2026-09-19 — Semantic cache, grammar-constrained output, arg validation

**Chose:** three small mechanisms that together carry the latency, robustness and
"cutting edge" requirements.
**Over:** exact-string cache; free-form JSON parsing with retries; trusting
schema-valid args.

**1. Semantic cache (not exact match).** Embed the intent with a small local model
(`bge-small`, ~130 MB, CPU, single-digit ms), nearest-neighbour against past successes
with a similarity floor. Storage: SQLite with an embedding column and brute-force
cosine — fine to ~100k rows. **No vector DB.** Exact matching gives a cache that
effectively never hits, which turns the headline metric into a rounding error.

**2. Grammar-constrained decoding.** GBNF locally (llama.cpp), JSON-schema / structured
output mode on the cloud side. The model becomes *structurally incapable* of emitting
malformed JSON or a tool name that does not exist. This is the one robustness claim that
is provable rather than observed: not "rarely fails validation" but **"cannot"**.

Side effect worth knowing: it **lowers the model floor**. A 4B model that fails the
free-form acceptance test often passes under a grammar, because the part it was bad at
has been removed from its job.

**3. Validate arguments before execution.** Schema-valid is not semantically safe — a
path that does not exist, a value out of range. Validate, and route the failure into
mistake memory instead of into a crash. The loop never dies; it learns.

**Because:** these are the latency answer (1), the robustness answer (2, 3), and the
reason the artifact reads as current rather than as another tool-loop wrapper.

**Skip:** vector DB, response streaming, multi-agent, web UI. No boxes, real setup cost.

### The four README numbers these produce

```
cache-hit rate         X% -> Y%   (over N sessions, M turns)
p50 latency            A ms -> B ms
turns with no network  X% -> Y%
malformed tool calls   0  (grammar-enforced, not merely observed)
```

First three are curves from the per-turn log. The fourth is a structural guarantee.
Measured improvement plus a structural impossibility is the combination that is hard to
dismiss. Report p50, p95 and no-network-% separately — tier 1 is rare, so letting it
dominate a single average hides the actual story.

## 2026-09-19 — Provider wiring: `OPENROUTER_API`, boot no longer requires OpenAI

**Chose:** `config.llmApiKey / llmBaseUrl / llmModel`, resolved from the first of
`OPENROUTER_API` or `OPENAI_API_KEY` that is set, with `LLM_BASE_URL` / `LLM_MODEL`
overrides. `openaiApiKey` becomes optional and is used only by OpenAI-only endpoints
(speech-to-text, embeddings).
**Over:** keeping `requireEnv("OPENAI_API_KEY")` at boot; renaming the owner's existing
`OPENROUTER_API` var to `OPENROUTER_API_KEY`.
**Because:** this implements the OpenAI-compatible-base_url decision already taken above
— it is wiring, not a new choice. Two concrete facts forced it: the imported code threw
at import time without an OpenAI key, so nothing booted; and the owner's `.env` already
carries `OPENROUTER_API`, so honouring that exact name costs one string and avoids
editing a working credentials file. `LLM_BASE_URL` is the single switch between the
`cloud` and `offline` configs — pointing it at Ollama or vLLM needs no code change.
**Revisit if:** a provider appears that is not OpenAI-compatible, which would be the
first real argument for an interface rather than a base_url.

**Known consequence, not yet addressed:** `vectorSearch.ts` reads `process.env.OPENAI_API_KEY`
directly for embeddings. With OpenRouter alone, embeddings are unavailable — which the
semantic cache will need. Fix when the cache is built, not before.

## 2026-09-19 — Institution-specific tools become config-driven, not deleted

**Chose:** keep both the mailbox and library-catalogue tools, with every endpoint,
credential and institution code moved out of source into `.env` and read through
`src/config.ts`. `tubafEmail.ts` → `email.ts` (`MAIL_*`), `tubafLibrary.ts` →
`libraryCatalog.ts` (`LIBRARY_BASE_URL`, `LIBRARY_INSTITUTION`).
**Over:** deleting the library tool (my recommendation — institution-locked, ticks no
narrow use case); leaving the original hosts as defaults with env overrides.
**Because:** the owner's call, and it holds up: VuFind/finc is run by many academic
libraries, so once the catalogue URL is configuration the tool is generic rather than
personal, and deleting working code to solve a string problem is the wrong trade. The
defaults-with-override pattern was the real defect — a default mail host in source
names its author just as loudly as a constant does, while looking as if it had been
handled.
**Revisit if:** the scraper breaks against a second VuFind instance, which would mean
the markup assumptions are more institution-specific than the URL.

**Enforced by:** `scripts/scrub-check.sh`, which fails if any tracked file contains an
institutional or personal identifier. This is the publish gate; it scans what git
tracks, so gitignored `.env` values are correctly ignored.

**Deleted as dead weight** (unreferenced duplicates, ~7 MB): `tubaf_utils-main/` (a
vendored unzipped copy of a separate repo) and five `scripts/tubaf_*.py` files that the
TypeScript ports had already superseded — no TS code invoked them.

## 2026-09-19 — Check runner: a loop over spawnSync, not a test framework

**Chose:** `scripts/run-checks.mjs` — runs each standalone check, records pass/fail,
duration and error output, regenerates `TESTS.md`, exits with the failure count.
Wired to `npm test`.
**Over:** Jest, Vitest, or `node:test`.
**Because:** the checks here are already standalone scripts that exit non-zero, so a
framework would add configuration, a transform pipeline and a dependency to re-implement
`spawnSync` in a loop. The runner is ~90 lines and has no dependencies. `node:test` is
the closer call and would be right if these were unit tests, but two of the five checks
are a shell script and `tsc`, which no test runner wraps naturally.
**Revisit if:** the checks become numerous enough that parallelism or filtering matters.

**Typecheck is reported, not gated.** The six inherited errors in `telegram.ts`,
`council.ts` and `osVision.ts` are listed in full in `TESTS.md` and compared against a
file allow-list, so an error in any other file turns the run red. Counting them without
printing them would let a seventh hide among them.

**Both the tests and the runner were mutation-tested** — a guard was removed and a
latency value forced to zero, each was confirmed to turn the suite red, and each was
restored. A suite that has never failed has not been shown to work.

## 2026-09-19 — Carter is a chat + approval console; the visual HUD moves out

**Chose:** delete the component factory, floating-window manager, workspace store and
visual modes from Carter. Eight files removed, eight tools removed (26 → 19 native
tools). The web UI keeps exactly two jobs: a chat transcript and the human-in-the-loop
approval overlay.
**Over:** keeping the machinery and re-scoping Carter as a visual HUD.
**Because:** Carter's thesis is the agent runtime — MCP client/server, mistake memory,
per-turn prompt assembly. The multi-window UI is a separate project of the owner's
whose thesis *is* fluid UI, so keeping it here split Carter's story across two
claims and paid for a second one on every turn: the component tools were ~950 prompt
tokens of schema on every single call (2767 → 1800 measured). The approval overlay stays
because `requestApproval()` fails closed without a client attached — it is a safety
surface, not decoration.
**Side effect, and the reason the bug was real:** `BASE_PROMPT` offered the model an
```html fence that the transcript renderer never rendered, so a request for a diagram
returned raw markup. Removing the component paragraph removed the fence.
**Revisit if:** never for Carter. The deleted code is in git history if it is wanted.

## 2026-09-19 — mistake dedup identity: normalised digest, not exact string

`recordMistake` deduped on the exact error text, so any error carrying an id or a
timestamp never matched itself and `hits` stayed at 1 forever. Now a hidden `err_key`
column holds a SHA-1 of the *normalised full* error (ISO timestamps, hex literals, and
6+ char alphanumeric runs containing a digit → `#`), with a unique index, and
record-or-bump is a single `ON CONFLICT DO UPDATE` upsert.

**Rejected:** collapsing every digit run. It is one regex shorter and it would merge
`upstream returned error 404` with `... error 500` — two genuinely different mistakes
that would then share one fix. `scripts/stress_mistakes.ts` has a case pinning that
apart, so the aggressive version cannot be reintroduced silently.

Hashing the *full* error rather than the 300-char display gist also keeps two long
errors that share a prefix distinct — the gist is for display only.

## 2026-09-19 — the current date is injected per turn, never baked into BASE_PROMPT

The model's sense of "today" is frozen at its training cutoff, so every relative date
resolved to a past year and any tool taking a timestamp failed (measured: 6/6 train
lookups). `assembleSystemPrompt()` now prepends the current ISO timestamp.

**Rejected:** putting it in `BASE_PROMPT`. That constant is evaluated at import time, so
a long-running process would serve a date frozen at boot — the same class of bug, just
slower to notice.

## 2026-09-19 — `npm run stress` is paid and excluded from `npm test`

Mirrors the existing `npm test` / `npm run bench` split. The offline adversarial suite
(`scripts/stress_mistakes.ts`) is free, deterministic and runs as check #7 under
`npm test`; the behavioural A/B (`scripts/stress_behaviour.ts`) calls a real model and
executes real tools, so it stays manual.

**Rejected:** folding the A/B into `npm test`. It would make the check suite cost money
and depend on a network provider's mood — a suite people stop running.

## 2026-09-19 — the bypass caches the plan, never the answer

The improvement curve needs repeat requests to skip the model. Caching the *reply* to
"local news" would serve yesterday's news forever, so `success_plans` stores the ordered
tool calls that worked and a hit **re-runs them** — the content is always fetched fresh,
only the decision about what to run is reused.

**Rejected:** a response cache keyed on the prompt. Fast, trivially built, and wrong for
exactly the class of request people repeat — the time-sensitive ones.

## 2026-09-19 — lexical intent matching, not bge-small embeddings

Supersedes the embeddings line in the retrieval entry **for this table only** (vector
search elsewhere is unchanged). Matching is normalise-to-token-set + Jaccard above a 0.8
floor, which is ~15 lines and no download.

**Rejected for now:** bge-small. It would very likely match paraphrases this cannot
("what's happening nearby" vs "local news"). But a 130 MB dependency justified by a
guess is the thing this repo's rules forbid.

**Revisit when:** the hit rate has been measured on real usage. Poor rate → embeddings
are reopened with a number attached.

## 2026-09-19 — extractive summarizer, not a local model

A cache hit still needs pages turned into points, and that was the half still forcing a
cloud call. `src/summarize/extractive.ts` ranks and selects real sentences — TF + query
overlap + lead bias — with zero new dependencies.

**Said out loud:** this is worse than an LLM summary. It cannot rewrite a sentence,
compress one, or synthesise across two. It can only pick the right ones.

**Rejected:** a 0.6–1.5B local abstractive model. That is tier-0's job and needs the
model download this whole path exists to avoid.

## 2026-09-19 — exact request text as the cache key, not Jaccard over a token set

Reverses the "lexical intent matching" entry above, five hours after it was written. An
external review broke it with four cases, all from one root: **sorting and stopwording
throw away the information that makes a match safe.**

- `flights Boston to Austin` and `flights Austin to Boston` are the same token set. No
  threshold, including 1.0, separates them.
- Adding a word scores *higher* than swapping one — nine content tokens plus a
  jurisdiction gives 0.9 and replays a plan that never saw it.
- `hotels with parking` / `hotels without parking` collide once prepositions are dropped.

The key is now the request text, lowercased, whitespace-collapsed, trailing punctuation
trimmed. Nothing else. Every further normalisation is a claim that two sentences mean the
same thing, and this path answers with no model, so nothing downstream catches a bad
claim.

**Cost, stated plainly:** far fewer hits. "the local news" and "local news" are two
entries. That is the intended direction — the hits given up are the ones whose
equivalence could not be shown.

**Rejected:** keeping Jaccard with negation words restored. It fixes one case of three.

**Revisit when:** repeat traffic is logged and a specific equivalence is worth encoding
one at a time.

## 2026-09-19 — no plan with a time reference, no tool that writes

Two admission rules, both from the same review.

**Time.** The first guard refused only *today's* date, in three formats. "Yesterday's
closing price" stores an absolute past date, passes cleanly, and then replays that frozen
day forever. Widening the regex is unwinnable ("18 Sep", "09/18"), so any date-bearing
argument — by parameter name or by value — makes a plan uncacheable regardless of value.
Costs real hits: `train_journeys` takes a date, so it can never be replayed.

**Writes.** Replay re-runs stored arguments with no model and no confirmation, so only an
allowlist of read-only tools is eligible. `api_fetch` is excluded despite usually reading
— it takes an arbitrary method and URL, so it is read-only by accident, not by contract.

**Rejected:** refusing to cache a step whose argument appeared in an earlier step's
output. Proposed, then dropped on the reviewer's call — it catches a copied URL and
misses transformed ids, derived dates, and any branch taken because a tool returned
nothing. A tripwire sold as a guarantee is worse than no guard, because it would be
quoted as one.

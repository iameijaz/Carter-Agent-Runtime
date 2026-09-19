# FAILS — 01-helm-agent-runtime

Things that did not work after 3 genuine attempts. **Read this before planning.** If
your idea is here, it is dead — do not retry it.

Logging one is not failure, it is how the basic version ships on time.

Format:

```
## YYYY-MM-DD — <what was attempted>
**Goal:** <what it was supposed to do>
**Tried:** 1) ... 2) ... 3) ...
**Symptom:** <exact error or behaviour>
**Best guess:** <why it failed>
**Shipped instead:** <the basic version that went in>
**Would need:** <what a future attempt would require>
```

---

## 2026-09-19 — `set_workspace` cannot be tested by a single-turn benchmark

**What I tried** (three genuinely different prompts, 3 samples each, `openai/gpt-4.1`):

1. "Set my workspace to the robotics project folder." → no tool call, 3/3.
   The tool composes a HUD layout; it has no notion of a path. The model was right.
2. "Lay out a monitoring workspace with the clock and weather widgets side by side."
   → `register_component`, 3/3. Widgets must exist before being laid out. Also right.
3. "I already have clock and weather components registered. Lay them out side by
   side in a new monitoring workspace." → `list_components`, 3/3. `windows[].componentId`
   is a required argument and the model does not know the ids. Right a third time.

**Why it failed.** Not a model weakness and not a bad tool description. `set_workspace`
requires concrete registered component ids, so reaching it *always* costs a lookup turn
first. A one-shot harness that sends a prompt and inspects the first tool call cannot
elicit it, by construction.

**What a future attempt needs.** A multi-turn case: feed the `list_components` result
back as a tool message and score the *second* call. That is a different harness, not a
different prompt — worth building when there are several multi-turn tools to justify it,
not for one case.

**Downgrade taken.** `ws-1` removed from the single-turn set; the set is 19 cases and
`BENCH.md` names `set_workspace` as untested and why. Widening the accepted tool list to
swallow `list_components` was rejected: it would have turned a real coverage gap into a
green tick.

## 2026-09-19 — could not make a replayed failure improve model behaviour

**Goal.** Make the behavioural A/B (`scripts/stress_behaviour.ts`) show arm B — the
mistakes table populated — beating arm A. Three genuinely different failure modes were
tried as the thing to learn from:

1. **`get_weather` with coordinates.** Dead on arrival: wttr.in never throws. It
   silently returns the wrong city ("59.91N,10.75E" → *Nowe, Poland*). No error means
   no recorded mistake, so there is nothing to A/B. That silent-wrong-answer behaviour
   is its own latent problem, not logged here as a memory failure.
2. **`train_journeys` with a relative date.** Arm A failed 6/6 — but not for the
   predicted reason. The model emitted valid ISO timestamps with a *2024* year, because
   the system prompt never told it today's date. Fixed at the root
   (`promptAssembler.ts` now injects the current timestamp); arm A then passed 3/3 and
   the test went vacuous. A real bug found and fixed, but not a usable A/B.
3. **`api_fetch` against a key-gated API.** Every URL fails, which is deliberate — it
   holds model competence constant and isolates the memory effect. Arm A emitted the
   later-recorded call 1/5. Arm B, shown that exact call under the prompt's
   "NEVER repeat these mistakes" heading, emitted it **5/5**. Reproduced on two
   independent runs.

**Why it fails.** A failure replayed with no attached fix works as a salient *example*,
not as a boundary. The model pattern-matches the concrete call in the prompt and
reproduces it. Negative instruction in a system prompt does not reliably invert a
concrete example sitting next to it.

**Downgrade shipped.** The README no longer claims "never makes the same mistake twice".
It claims what is measured — failures are recorded and replayed — and links
`MISTAKES-BENCH.md`, which reports the negative result and its limits. The suite gates
on exact repeats not *increasing*, so this stays visible instead of quietly regressing.

**What a future attempt would need.** Either (a) render unfixed lessons as an abstract
constraint rather than a literal call — the concrete failing arguments are what gets
copied — and re-run the same A/B; or (b) A/B the *fixed*-lesson path, which carries
`DO THIS INSTEAD` guidance and is a different mechanism, untested behaviourally so far.
Do not re-run variants of (3) hoping for a different number: it reproduced twice.

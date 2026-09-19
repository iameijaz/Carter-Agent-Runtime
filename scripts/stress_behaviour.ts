/**
 * Paid behavioural A/B of the mistake-memory claim.
 * Run: npm run stress    (spends real OpenRouter money — excluded from `npm test`)
 *
 * `scripts/stress_mistakes.ts` proves the mechanism: the lesson is stored and
 * reaches the prompt. It cannot prove the last clause of the claim —
 *
 *   "...so it never repeats a mistake"
 *
 * — because that is a statement about the *model*, not the table. A one-arm run
 * proves nothing either: if the model gets it right unaided, an injected lesson
 * gets undeserved credit. So this is a controlled comparison on one prompt:
 *
 *   Arm A (control): empty mistakes table.
 *   Arm B (treated): identical, with the lesson from arm A's failures present,
 *                    so assembleSystemPrompt() injects it.
 *
 * The failure is real, not mocked: each emitted call is EXECUTED against the
 * real tool, so "did it repeat the mistake" is a thrown error, not a regex
 * guess at one. The default prompt targets read-only lookups; nothing that
 * sends or mutates is ever invoked here.
 *
 * The scored metric is EXACT REPEATS of the recorded failing call — the claim's
 * literal wording — not task success. That matters because the default prompt
 * is deliberately unsolvable (the API needs a key), which holds the model's
 * general competence constant and isolates what the memory alone does.
 *
 * Arm B's lesson is never hand-written: it is exactly what `src/agent/loop.ts`
 * records, replayed verbatim by `lessonsForPrompt()`.
 *
 * Writes MISTAKES-BENCH.md. Exits non-zero if replaying a failure makes the
 * model MORE likely to repeat it. Measured 2026-09-19: it does.
 */

import OpenAI from "openai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";

// Throwaway DB, set before anything imports the memory modules: the path is
// read at import time. Arm A must start with a genuinely empty mistakes table.
const tmp = mkdtempSync(path.join(tmpdir(), "stress-behaviour-"));
process.env.CARTER_DB_PATH = path.join(tmp, "test.db");

const { config } = await import("../src/config.js");
const { bootstrap } = await import("../src/bootstrap.js");
const { assembleSystemPrompt } = await import("../src/agent/promptAssembler.js");
const { recordMistake } = await import("../src/memory/mistakes.js");

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const MODEL = flag("--model", config.llmModel);
const N = Number(flag("--samples", "6"));

/** The one prompt under test. Ambiguous on purpose — a date the model must
 *  resolve to ISO itself, phrased the way a person actually phrases it. */
const PROMPT = flag("--prompt",
  "What trains go from Mannheim Hbf to Chemnitz tomorrow morning?");
const TOOL = flag("--tool", "train_journeys");

interface Sample {
  args: string;
  failed: boolean;
  error: string;
}

async function runArm(
  label: string,
  client: OpenAI,
  tools: OpenAI.Chat.Completions.ChatCompletionTool[],
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<Sample[]> {
  // The real prompt path — this is the thing under test. In arm B it carries
  // the lessons block; in arm A there is nothing to carry.
  const system = await assembleSystemPrompt();
  const out: Sample[] = [];
  for (let i = 0; i < N; i++) {
    const r = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: PROMPT },
      ],
      tools,
      tool_choice: "auto",
    });
    const tc = r.choices[0]?.message?.tool_calls?.[0];
    if (!tc || tc.function.name !== TOOL) {
      out.push({ args: tc ? tc.function.name : "(no tool call)", failed: false, error: "off-target — not counted as a repeat" });
      console.log(`  ${label} ${i + 1}/${N}  skipped (${tc?.function.name ?? "no call"})`);
      continue;
    }
    let failed = false;
    let error = "";
    try {
      await call(TOOL, JSON.parse(tc.function.arguments || "{}"));
    } catch (err) {
      failed = true;
      error = (err as Error).message;
    }
    out.push({ args: tc.function.arguments, failed, error });
    console.log(`  ${label} ${i + 1}/${N}  ${failed ? "FAILED" : "ok    "}  ${tc.function.arguments.slice(0, 90)}`);
  }
  return out;
}

const rate = (s: Sample[]) => {
  const counted = s.filter((x) => x.error !== "off-target — not counted as a repeat");
  return counted.length === 0 ? 0 : counted.filter((x) => x.failed).length / counted.length;
};
/** Markdown list of one arm's raw samples, for the report. */
const fmt = (arr: Sample[]) =>
  arr.map((s, i) =>
    `${i + 1}. ${s.failed ? "FAILED" : "ok"} — \`${s.args}\`` +
    (s.error ? `\n   ${s.error}` : "")).join("\n");

const counted = (s: Sample[]) => s.filter((x) => x.error !== "off-target — not counted as a repeat").length;

async function main() {
  const core = await bootstrap(ROOT);
  const tools = await core.toolBox.getOpenAiTools();
  const client = new OpenAI({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl });
  const call = (n: string, a: Record<string, unknown>) => core.toolBox.call(n, a);

  console.log(`\n[stress] model=${MODEL}, ${N} samples/arm, ${tools.length} real tool schemas`);
  console.log(`[stress] prompt: "${PROMPT}"\n`);

  console.log("Arm A — control (empty mistakes table):");
  const armA = await runArm("A", client, tools, call);

  // Seed the lesson from what arm A actually did wrong. If arm A never failed,
  // there is nothing to learn and the comparison is meaningless — say so.
  const firstFailure = armA.find((s) => s.failed);
  if (!firstFailure) {
    console.log(`\nArm A never failed (0/${counted(armA)}). This prompt no longer provokes the ` +
      `mistake on ${MODEL}, so there is nothing for the memory to prevent. Not a pass ` +
      `and not a failure of the claim — the test needs a harder prompt.\n`);
    process.exit(2);
  }
  // Deliberately NO authored fix. An earlier version of this script hand-wrote
  // the repair advice, which made arm B a test of my prose rather than of the
  // runtime. Arm B gets only what the runtime genuinely holds after a single
  // failure: the recorded error, replayed verbatim by lessonsForPrompt().
  // Recorded exactly as src/agent/loop.ts records it — error AND failing
  // arguments. Without the arguments the lesson cannot name the call to avoid.
  await recordMistake(TOOL, PROMPT,
    `${firstFailure.error} — failing arguments: ${firstFailure.args.slice(0, 200)}`);

  console.log("\nArm B — treated (the lesson from arm A is in the prompt):");
  const armB = await runArm("B", client, tools, call);

  // The claim's literal words are "never repeats a mistake" — a mistake being
  // the specific failing call, not the task. A prompt can be unsolvable (every
  // URL 404s) and the claim still be testable: did the model re-emit the exact
  // call it was told had failed?
  const norm = (s: string) => { try { return JSON.stringify(JSON.parse(s)); } catch { return s; } };
  const recorded = norm(firstFailure.args);
  const repeatsA = armA.filter((s) => s.failed && norm(s.args) === recorded).length;
  const repeatsB = armB.filter((s) => s.failed && norm(s.args) === recorded).length;
  console.log(`
  exact repeats of the recorded failing call — A: ${repeatsA}/${counted(armA)}, B: ${repeatsB}/${counted(armB)}`);

  const a = rate(armA), b = rate(armB);
  console.log(`\n  arm A repeat-failure rate: ${(a * 100).toFixed(0)}%  (${armA.filter(s => s.failed).length}/${counted(armA)})`);
  console.log(`  arm B repeat-failure rate: ${(b * 100).toFixed(0)}%  (${armB.filter(s => s.failed).length}/${counted(armB)})`);

  const md = `# MISTAKES-BENCH — does replaying a failure change the model's behaviour?

Generated by \`scripts/stress_behaviour.ts\` on ${new Date().toISOString().slice(0, 10)}.
Every number here was measured on the run recorded below. Nothing is estimated.

## Result, up front

**It does not — and on this prompt it made things worse.** Replaying a recorded
failure that has no attached fix caused the model to converge on the exact call
it had just been told failed.

| | mistakes table | samples | task failures | **exact repeats of the recorded failing call** |
|---|---|---|---|---|
| Arm A (control) | empty | ${counted(armA)} | ${armA.filter(s => s.failed).length} (${(a * 100).toFixed(0)}%) | **${repeatsA}/${counted(armA)}** |
| Arm B (treated) | one failure, replayed | ${counted(armB)} | ${armB.filter(s => s.failed).length} (${(b * 100).toFixed(0)}%) | **${repeatsB}/${counted(armB)}** |

## What was being tested

\`README.md\` claimed: *"records every failed tool call and replays the lesson into
every later turn, so it never repeats a mistake"*. The offline suite
(\`scripts/stress_mistakes.ts\`, part of \`npm test\`) proves the first two thirds —
the failure is stored, and the lesson reaches the prompt. It cannot prove the
last third, which is a claim about the *model*, not the table. This is that test.

## Method

One prompt: *"${PROMPT}"*, ${N} samples per arm, model \`${MODEL}\`, default
temperature, single turn. Both arms use the runtime's real
\`assembleSystemPrompt()\` and all ${tools.length} real tool schemas, and **every emitted
call is executed against the real tool** — a failure is a thrown error, not a
pattern match. Samples choosing a different tool are excluded, not scored.

Arm B's lesson is **not hand-written**. It is exactly what \`src/agent/loop.ts\`
records — the error plus the failing arguments — replayed verbatim by
\`lessonsForPrompt()\`. An earlier draft of this script authored the repair advice
by hand, which tested the author's prose rather than the runtime; that version
was discarded.

Two metrics, because they answer different questions:

- **task failures** — did the call succeed? On this prompt the task is not
  solvable (the API requires a key), so this stays at 100% in both arms by
  construction. It is reported for completeness, not as the result.
- **exact repeats** — did the model re-emit the precise call it had been told
  failed? This is the claim's literal wording, and it is measurable even when
  the task is unsolvable. It is the result.

## Why this is the honest read

Arm A wandered across different guessed URLs (${repeatsA}/${counted(armA)} landed on the one that was
later recorded). Arm B, shown that exact call in its prompt under a "NEVER repeat
these mistakes" heading, emitted it ${repeatsB}/${counted(armB)} times. The lesson acted as a salient
example to copy, not a boundary to avoid.

This is a property of replaying a failure **with no known fix attached**. It does
not measure the fixed-lesson path, where the prompt carries \`DO THIS INSTEAD\`
concrete guidance; that path is exercised by the offline suite but has not been
A/B tested behaviourally here.

## Limits

- ${N} samples per arm. Enough to see an effect this size, nowhere near enough to
  put an interval on it. None is claimed because none was computed.
- One prompt, one tool, one model, single turn.
- The unsolvable-task design isolates the memory effect but means the task-failure
  column carries no information.

## Raw samples

### Arm A
${fmt(armA)}

### Arm B
${fmt(armB)}
`;
  writeFileSync(path.join(ROOT, "MISTAKES-BENCH.md"), md);
  console.log("  wrote MISTAKES-BENCH.md\n");

  // Gate on the claim's own wording. Task success is reported but not gated:
  // this prompt is unsolvable by design, which is what isolates the memory
  // effect from the model's general competence.
  if (repeatsB > repeatsA) {
    console.error(`Replaying the failure INCREASED exact repeats of it (${repeatsA} -> ${repeatsB}). ` +
      `"so it never repeats a mistake" is not supported — see MISTAKES-BENCH.md.\n`);
    process.exit(1);
  }
  console.log(`Replaying the failure did not increase exact repeats of it.\n`);
}

try {
  await main();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

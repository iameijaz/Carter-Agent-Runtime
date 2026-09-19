/**
 * Shows what the runtime puts around a one-line user message before the model
 * ever sees it, and how that block grows as the runtime learns.
 *
 * The system prompt is rebuilt from scratch on every turn by
 * `assembleSystemPrompt()` — it is not a constant. Four sources compose it:
 * base policy, learned preferences, tracked conversation facts, and lessons
 * from past failures. The last three change with use, and they are the reason
 * turn N+1 is better than turn N.
 *
 * Writes nothing to real state: mistakes go to a throwaway database via
 * CARTER_DB_PATH, and preferences are formatted from an in-memory array rather
 * than written, because preferences.json has a fixed path and a demo has no
 * business overwriting the operator's real one.
 *
 * Run: npx tsx scripts/demo_prompt_enrichment.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

process.env.CARTER_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "enrich-")), "demo.db");

const { assembleSystemPrompt, BASE_PROMPT } = await import("../src/agent/promptAssembler.js");
const { formatPreferencesForPrompt } = await import("../src/prefs/store.js");
const { recordMistake, recordFix, lessonsForPrompt } = await import("../src/memory/mistakes.js");

const USER_MESSAGE = "what's the weather in Oslo?";

const rule = (t: string) => console.log(`\n${"─".repeat(64)}\n${t}\n${"─".repeat(64)}`);

async function main() {
  rule("1. What the user typed");
  console.log(`  "${USER_MESSAGE}"  (${USER_MESSAGE.length} characters)`);

  rule("2. What the model actually receives on a cold start");
  const cold = await assembleSystemPrompt();
  console.log(`  base policy        ${String(BASE_PROMPT.length).padStart(6)} chars`);
  console.log(`  + prefs + facts    ${String(cold.length - BASE_PROMPT.length).padStart(6)} chars`);
  console.log(`  = system prompt    ${String(cold.length).padStart(6)} chars`);
  console.log(`\n  ${Math.round(cold.length / USER_MESSAGE.length)}x the user's message, before anything has been learned.`);

  rule("3. The runtime fails a tool call, and records it");
  const id = await recordMistake(
    "get_weather",
    "user asked for Oslo weather",
    "get_weather failed: location must be a city name, not coordinates",
  );
  await recordFix(id, "Pass the city name directly: { location: 'Oslo' }");
  console.log(`  recorded mistake #${id} on get_weather, with the fix that worked`);

  rule("4. The same assembly call, after learning");
  const warm = await assembleSystemPrompt();
  const lessons = await lessonsForPrompt();
  console.log(`  system prompt      ${String(warm.length).padStart(6)} chars  (+${warm.length - cold.length})`);
  console.log(`\n  The delta is the lesson block, injected verbatim into every later turn:\n`);
  console.log(lessons.split("\n").map((l) => `    ${l}`).join("\n"));

  rule("5. Preferences compose into the same prompt");
  // Formatted, not saved — see the header.
  const prefBlock = formatPreferencesForPrompt([
    { topic: "weather", source: "open-meteo", approach: "metric units, no imperial", updated: new Date().toISOString() },
  ]);
  console.log(prefBlock.split("\n").map((l) => `    ${l}`).join("\n"));

  rule("Summary");
  console.log(`  one line in  →  ${USER_MESSAGE.length} chars`);
  console.log(`  cold prompt  →  ${cold.length} chars`);
  console.log(`  warm prompt  →  ${warm.length} chars  (grew by ${warm.length - cold.length} from one recorded failure)`);
  console.log(`\n  Nothing here was hand-written for the demo: every number is measured`);
  console.log(`  from the same assembleSystemPrompt() the agent loop calls per turn.`);

  // The claim this demo makes is "the prompt grows with what it learns". If that
  // stops being true the demo must fail, not print a flat number.
  assert.ok(warm.length > cold.length, "recorded lesson did not reach the system prompt");
  assert.ok(lessons.includes("get_weather"), "lesson block does not name the failed tool");
  assert.ok(cold.length > BASE_PROMPT.length, "preferences/facts did not compose into the prompt");
  console.log("\n  self-check: 3 assertions passed\n");
}

main().catch((e) => { console.error(e); process.exit(1); });

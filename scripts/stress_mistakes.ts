/**
 * Adversarial stress test of the mistake-memory claim.
 * Run: npx tsx scripts/stress_mistakes.ts
 *
 * `scripts/test_mistakes.ts` proves the happy path. This one attacks the
 * sentence the README, the video and the share copy all rest on:
 *
 *   "records every failed tool call and replays the lesson into every later
 *    turn, so it never repeats a mistake"
 *
 * Each case names the specific word it is trying to break — "every", "later",
 * "never" — because a test that only shows the mechanism working is marketing,
 * not a test. Failures print the claim they falsify.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Throwaway DB, set before the module loads: the path is read at import time.
const tmp = mkdtempSync(path.join(tmpdir(), "stress-mistakes-"));
process.env.CARTER_DB_PATH = path.join(tmp, "test.db");

const { recordMistake, recordFix, addLesson, knownFixes, lessonsForPrompt } =
  await import("../src/memory/mistakes.js");
const { sharedDb, sharedExec } = await import("../src/retrieval/vectorSearch.js");

const rows = async (sql: string, p: unknown[] = []) => sharedExec(await sharedDb(), sql, p);
const countRows = async (tool: string) =>
  Number((await rows(`SELECT COUNT(*) FROM mistakes WHERE tool = ?`, [tool]))[0][0]);

let failed = 0;
async function attack(claim: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${claim}`);
  } catch (err) {
    failed++;
    console.log(`  FALSE ${claim}`);
    console.log(`        ${(err as Error).message.split("\n")[0]}`);
  }
}

async function main() {
  console.log("\nAttacking: \"records EVERY failed tool call and replays the lesson\n" +
              "            into EVERY later turn, so it NEVER repeats a mistake\"\n");

  // ── "every later turn" ────────────────────────────────────────────────
  await attack(`a single failure, never retried, reaches the next prompt`, async () => {
    const tool = "c1_single_failure";
    await recordMistake(tool, "user asked for the weather", "location must be a city name");
    const block = await lessonsForPrompt();
    assert.ok(block.includes(tool),
      `one unfixed failure is absent from the prompt block. ` +
      `lessonsForPrompt filters "fix IS NOT NULL OR hits >= 2", so a failure that ` +
      `happens once and is never retried is never replayed — the most common case.`);
  });

  await attack(`a fix attaches when the retry lands in a LATER run`, async () => {
    const tool = "c2_cross_run";
    const id = await recordMistake(tool, "ctx", "bad argument shape");
    // Simulates the next turn/session succeeding — no per-run map in scope.
    const { attachFixForTool } = await import("../src/memory/mistakes.js") as any;
    assert.equal(typeof attachFixForTool, "function",
      `no way to attach a fix outside the failing run. loop.ts records fixes from ` +
      `the per-send "failedThisRun" map, so a correction that arrives next turn or ` +
      `next session never becomes a lesson.`);
    await attachFixForTool(tool, `{"city":"Oslo"}`);
    const [fix] = await knownFixes(tool);
    assert.ok(fix?.fix, `mistake #${id} still has no fix after a later success`);
  });

  // ── "every failed tool call" ──────────────────────────────────────────
  await attack(`the same failure with a varying id dedups into one row`, async () => {
    const tool = "c3_varying_id";
    for (const id of ["a41f9c", "b72e10", "c93d88"]) {
      await recordMistake(tool, "ctx", `request ${id} failed at 2026-09-19T10:0${id[0]}:00Z: rate limited`);
    }
    const n = await countRows(tool);
    assert.equal(n, 1,
      `${n} rows for one recurring failure. Dedup compares the error string exactly, ` +
      `so any error carrying an id or timestamp never matches — hits stays 1 and the ` +
      `lesson is never promoted.`);
    const hits = Number((await rows(`SELECT hits FROM mistakes WHERE tool = ?`, [tool]))[0][0]);
    assert.equal(hits, 3, `hits should count all 3 occurrences, got ${hits}`);
  });

  await attack(`normalising does not over-collapse genuinely different errors`, async () => {
    const tool = "c3b_distinct_codes";
    await recordMistake(tool, "ctx", "upstream returned error 404");
    await recordMistake(tool, "ctx", "upstream returned error 500");
    const n = await countRows(tool);
    assert.equal(n, 2,
      `${n} row(s): two different status codes were treated as the same mistake, so ` +
      `the fix for one would be offered for the other. Normalisation is too aggressive.`);
  });

  await attack(`two errors sharing a 320-char prefix stay distinct`, async () => {
    const tool = "c4_truncation";
    const prefix = "E".repeat(320);
    await recordMistake(tool, "ctx", `${prefix} — disk quota exceeded`);
    await recordMistake(tool, "ctx", `${prefix} — permission denied`);
    const n = await countRows(tool);
    assert.equal(n, 2,
      `${n} row(s): two different errors collapsed into one. gist() truncates to 300 ` +
      `chars BEFORE the comparison, so a long shared prefix makes unrelated failures ` +
      `look identical and inflates one row's hit count.`);
  });

  await attack(`20 concurrent identical failures write exactly one row`, async () => {
    const tool = "c5_race";
    await Promise.all(Array.from({ length: 20 }, () =>
      recordMistake(tool, "ctx", "connection refused")));
    const n = await countRows(tool);
    assert.equal(n, 1,
      `${n} duplicate rows. recordMistake does SELECT-then-INSERT with no atomicity, ` +
      `and loop.ts runs a round's tool calls under Promise.all — so parallel failures ` +
      `of the same tool race and each insert their own row.`);
  });

  // ── durability and correctness of what IS stored ──────────────────────
  await attack(`a lesson survives a process restart`, async () => {
    const tool = "c6_restart";
    const id = await recordMistake(tool, "ctx", "stale handle");
    await recordFix(id, "reopen the handle first");
    // A real restart: a child process, re-importing against the same DB file.
    // `tsx --eval` silently executes nothing here, so the probe must be a file.
    const { spawnSync } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");
    // The probe must live inside the repo: a script outside it cannot resolve
    // the repo's ESM dependencies.
    const { rmSync: rm } = await import("node:fs");
    const probe = path.resolve("scripts/_restart_probe.ts");
    writeFileSync(probe,
      `const m = await import("../src/memory/mistakes.js");\n` +
      `process.stdout.write("FIXES=" + (await m.knownFixes(${JSON.stringify(tool)})).length);\n`);
    try {
      const r = spawnSync("npx", ["tsx", probe], { encoding: "utf8", shell: true });
      assert.match(r.stdout, /FIXES=1/,
        `a fresh process found no lesson in the DB file — the write never reached disk. ` +
        `stdout: ${JSON.stringify(r.stdout.slice(-200))} stderr: ${JSON.stringify(r.stderr.slice(-300))}`);
    } finally {
      rm(probe, { force: true });
    }
  });

  await attack(`superseding replaces one tool's history and no other's`, async () => {
    const other = "c7_bystander";
    await addLesson(other, "ctx", "old error", "old fix");
    const tool = "c7_superseded";
    await addLesson(tool, "ctx", "old error", "stale advice");
    await addLesson(tool, "ctx", "new error", "current advice", true);
    const fixes = await knownFixes(tool, 10);
    assert.equal(fixes.length, 1, `${fixes.length} live lessons; superseding should leave 1`);
    assert.equal(fixes[0].fix, "current advice", `newest guidance did not win`);
    assert.equal((await knownFixes(other, 10)).length, 1, `a bystander tool's lesson was superseded too`);
  });

  // ── the ceiling: what the claim cannot promise ────────────────────────
  await attack(`the prompt block is bounded, and drops the least valuable first`, async () => {
    for (let i = 0; i < 30; i++) {
      const id = await recordMistake(`c8_bulk_${i}`, "ctx", `failure variant ${i}`);
      if (i % 2 === 0) await recordFix(id, `fix variant ${i}`);
    }
    const block = await lessonsForPrompt();
    const lines = block.split("\n").filter((l) => l.startsWith("- ["));
    assert.ok(lines.length <= 15, `prompt block is unbounded: ${lines.length} lessons`);
    const fixed = lines.filter((l) => l.includes("DO THIS INSTEAD")).length;
    assert.equal(fixed, 15,
      `with 15 fixed lessons available, all 15 slots should hold fixed ones; got ${fixed}`);
    console.log(`        (ceiling: ${lines.length} lessons, ${block.length} chars injected per turn)`);
  });

  console.log();
  if (failed > 0) {
    console.error(`${failed} claim(s) falsified — the headline sentence is not literally true.\n`);
    process.exit(1);
  }
  console.log("All claims held under attack.\n");
}

try {
  await main();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

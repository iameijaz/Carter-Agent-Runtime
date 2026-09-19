/**
 * Self-check for the mistake memory (src/memory/mistakes.ts).
 * Run: npx tsx scripts/test_mistakes.ts — exits non-zero on failure.
 * Uses throwaway tool names and deletes its rows afterwards.
 */
import assert from "node:assert";
import { recordMistake, recordFix, addLesson, knownFixes, lessonsForPrompt } from "../src/memory/mistakes.js";
import { sharedDb, sharedRun, sharedFlush } from "../src/retrieval/vectorSearch.js";

const TOOL = "__selfcheck_tool__";

async function main() {
  // record → dedupe bumps hits, same id
  const id1 = await recordMistake(TOOL, "testing", "boom: connection refused");
  const id2 = await recordMistake(TOOL, "testing again", "boom: connection refused");
  assert.strictEqual(id1, id2, "same tool+error must dedupe to one row");

  // no fix yet → knownFixes empty
  assert.strictEqual((await knownFixes(TOOL)).length, 0, "unfixed mistakes must not surface as fixes");

  // fix lands and is retrievable
  await recordFix(id1, "use port 8080 instead");
  const fixes = await knownFixes(TOOL);
  assert.strictEqual(fixes.length, 1);
  assert.match(fixes[0].fix!, /8080/);

  // repeat offenders + fixed lessons appear in the prompt block
  const block = await lessonsForPrompt();
  assert.match(block, /NEVER repeat/, "prompt block header missing");
  assert.match(block, /8080/, "fix missing from prompt block");

  // a superseding lesson hides the old one
  await addLesson(TOOL, "corrected by user", "old approach wrong", "always use the new endpoint", true);
  const after = await knownFixes(TOOL);
  assert.strictEqual(after.length, 1, "supersede must leave exactly one active lesson");
  assert.match(after[0].fix!, /new endpoint/);

  // cleanup
  const d = await sharedDb();
  sharedRun(d, `DELETE FROM mistakes WHERE tool = ?`, [TOOL]);
  sharedFlush(d);

  console.log("mistake memory self-check: all assertions passed");
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });

/**
 * Self-check for the per-turn log. Run: npx tsx src/memory/turns.selfcheck.ts
 *
 * Writes rows, reads them back, asserts the shape survives the round trip.
 * Fails loudly if the column list and the reader ever drift apart — which is
 * the only way this table breaks, and it would silently destroy the curve.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Throwaway database, set before the module loads — the DB path is read at
// import time. A self-check must never write fixtures into the real turn log:
// those rows would silently corrupt the improvement curve they exist to prove.
const tmp = mkdtempSync(path.join(tmpdir(), "turns-selfcheck-"));
process.env.CARTER_DB_PATH = path.join(tmp, "test.db");

const { logTurn, recentTurns } = await import("./turns.js");

async function main() {
  const before = (await recentTurns(1000)).length;
  assert.equal(before, 0, "must start against an empty throwaway database");

  await logTurn({
    path: "tier1", latencyMs: 1234.6, brain: "gpt",
    tools: ["web_search", "get_weather"], outcome: "ok",
    rounds: 2, schemaVersion: 7,
  });
  await logTurn({
    path: "tier1", latencyMs: 40, brain: "grok",
    tools: [], outcome: "error", rounds: 1, schemaVersion: 7,
    error: "tool 'nope' not found",
  });

  const rows = await recentTurns(1000);
  assert.equal(rows.length, before + 2, "both turns should be persisted");

  // recentTurns is newest-first, so the error turn is row 0.
  const [err, ok] = rows;

  assert.equal(ok.outcome, "ok");
  assert.equal(ok.brain, "gpt");
  assert.equal(ok.latencyMs, 1235, "latency is rounded to whole ms");
  assert.deepEqual(ok.tools, ["web_search", "get_weather"], "tool list survives the CSV round trip");
  assert.equal(ok.rounds, 2);
  assert.equal(ok.schemaVersion, 7, "schema version must travel with the row");
  assert.equal(ok.error, null);
  assert.ok(ok.ts > 0 && ok.ts <= Date.now(), "timestamp is set at write time");

  assert.equal(err.outcome, "error");
  assert.equal(err.error, "tool 'nope' not found");
  assert.deepEqual(err.tools, [], "no tools must read back as an empty array, not ['']");

  console.log(`ok — ${rows.length} turns round-tripped in a throwaway database`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * Self-check for the learned bypass. Run:
 *   npx tsx src/memory/successCache.selfcheck.ts
 *
 * The cache answers without a model, so nothing downstream can catch a bad
 * match — these asserts are the only thing standing between a near-miss and a
 * confidently wrong answer. The negative cases matter more than the positive
 * one.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Throwaway DB, set before import — DB_PATH is read at module load.
const tmp = mkdtempSync(path.join(tmpdir(), "successcache-selfcheck-"));
process.env.CARTER_DB_PATH = path.join(tmp, "test.db");

const { normalise, similarity, intentKey, recordPlan, lookupPlan } =
  await import("./successCache.js");
const { summarise } = await import("../summarize/extractive.js");

async function main() {
  // ── the key ───────────────────────────────────────────────────────────────
  assert.equal(intentKey("  What's the LOCAL news?  "), "what's the local news",
    "case, padding and a trailing question mark are noise");
  assert.notEqual(intentKey("flights Boston to Austin"), intentKey("flights Austin to Boston"),
    "word order carries meaning and must survive into the key");

  // ── storage ───────────────────────────────────────────────────────────────
  assert.equal(await lookupPlan("local news", 1), null, "must start empty");

  const plan = [
    { tool: "web_search", args: { query: "local news" } },
    { tool: "web_fetch", args: { url: "https://example.org/news" } },
  ];
  await recordPlan("what's the local news", plan, 1);

  const hit = await lookupPlan("What's the local news?", 1);
  assert.ok(hit, "the same request again must hit");
  assert.equal(hit.steps.length, 2, "the whole recipe comes back, in order");
  assert.equal(hit.steps[0].tool, "web_search");

  assert.equal(await lookupPlan("what's the local news in Berlin", 1), null,
    "adding a restriction changes the request — it must not ride the old plan");
  assert.equal(await lookupPlan("what's the local news", 2), null,
    "a plan built against one tool schema must not fire against another");

  // The four cases an external review broke the first version with (2026-09-19).
  await recordPlan("hotels with parking", [{ tool: "web_search", args: { query: "hotels parking" } }], 1);
  assert.equal(await lookupPlan("hotels without parking", 1), null,
    "negation must not be normalised away");

  await recordPlan("flights Boston to Austin",
    [{ tool: "web_search", args: { query: "flights BOS AUS" } }], 1);
  assert.equal(await lookupPlan("flights Austin to Boston", 1), null,
    "a reversed request must not replay the original direction");

  // Any time reference at all — not just today's date. An absolute PAST date
  // passed the old guard and then replayed the same frozen day forever.
  for (const [what, args] of [
    ["today", { query: `close ${new Date().toISOString().slice(0, 10)}` }],
    ["a past date", { query: "ACME close 18.09.2026" }],
    ["a bare year", { query: "budget 2025" }],
    ["a temporal parameter name", { query: "trains", date: "whenever" }],
  ] as const) {
    await recordPlan(`stock close ${what}`, [{ tool: "web_search", args }], 1);
    assert.equal(await lookupPlan(`stock close ${what}`, 1), null,
      `a plan carrying ${what} must not be cached`);
  }

  await recordPlan("mail the report",
    [{ tool: "email_send", args: { to: "x@example.org" } }], 1);
  assert.equal(await lookupPlan("mail the report", 1), null,
    "replaying a send is an action, not an optimisation");

  await recordPlan("empty turn", [], 1);
  assert.equal(await lookupPlan("empty turn", 1), null, "a turn with no tools has no recipe");

  // normalise/similarity stay, but for the summarizer's dedupe, not the key.
  assert.equal(similarity(normalise("local news please"), normalise("whats the local news")), 1,
    "token-set overlap still ignores order — which is why it is not the cache key");

  // ── summarizer ────────────────────────────────────────────────────────────
  const filler = "The building has stood on the same street corner for a very long time indeed. " +
    "Visitors often remark upon the colour of the paintwork near the entrance doors. ";
  const key = "The city council approved the new tram line funding on Tuesday evening. ";
  const points = summarise(
    [{ title: "Daily", text: filler + key + filler }],
    "tram line funding", 2);

  assert.ok(points.length > 0, "the summarizer must return something");
  assert.ok(points.some((p) => p.text.includes("tram line funding")),
    "a sentence matching the query must outrank filler");
  assert.equal(points[0].source, "Daily", "each point names where it came from");

  // Two outlets on the same wire copy must not produce the same bullet twice.
  const dedup = summarise(
    [{ title: "A", text: filler + key }, { title: "B", text: filler + key }],
    "tram line funding", 4);
  const trams = dedup.filter((p) => p.text.includes("tram line funding")).length;
  assert.equal(trams, 1, `duplicate wire copy must collapse (got ${trams})`);

  console.log("successCache + extractive summarizer ok");
}

try {
  await main();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

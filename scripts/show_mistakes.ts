/** Debug: dump the mistakes table. Run: npx tsx scripts/show_mistakes.ts */
import { sharedDb, sharedExec } from "../src/retrieval/vectorSearch.js";

const d = await sharedDb();
const rows = sharedExec(d,
  `SELECT id, tool, error, fix, hits, superseded, datetime(created_at/1000,'unixepoch') FROM mistakes ORDER BY id`);
console.log(rows.length === 0 ? "(no mistakes recorded)" : rows.map((r) => JSON.stringify(r)).join("\n"));
process.exit(0);

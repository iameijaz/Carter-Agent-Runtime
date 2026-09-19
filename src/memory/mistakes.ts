/**
 * Mistake memory — Carter never repeats a known error.
 *
 * Every failed tool call becomes a row. When a later call of the same tool
 * succeeds in the same run (or the user corrects course), the row gains a
 * `fix`. Lessons with fixes are injected into the system prompt each turn and
 * attached to repeat failures, so the model self-corrects instead of retrying
 * the same dead end. Corrections supersede older lessons for the same tool.
 *
 * Lives on the shared sql.js connection (same file as the rest of memory).
 */

import { createHash } from "node:crypto";
import { sharedDb, sharedFlush, sharedRun, sharedExec } from "../retrieval/vectorSearch.js";

let _ready = false;

async function db(): Promise<any> {
  const d = await sharedDb();
  if (_ready) return d;
  sharedRun(d, `
    CREATE TABLE IF NOT EXISTS mistakes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tool       TEXT NOT NULL,
      context    TEXT NOT NULL,
      error      TEXT NOT NULL,
      fix        TEXT,
      hits       INTEGER DEFAULT 1,
      superseded INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
  sharedRun(d, `CREATE INDEX IF NOT EXISTS mistakes_tool ON mistakes(tool, superseded)`);
  // err_key is the dedup identity: a digest of the *whole* normalised error.
  // Added after the fact, so existing databases are migrated and backfilled.
  const cols = sharedExec(d, `PRAGMA table_info(mistakes)`).map((r) => String(r[1]));
  if (!cols.includes("err_key")) {
    sharedRun(d, `ALTER TABLE mistakes ADD COLUMN err_key TEXT`);
    for (const [id, tool, error] of sharedExec(d, `SELECT id, tool, error FROM mistakes`)) {
      sharedRun(d, `UPDATE mistakes SET err_key = ? WHERE id = ?`, [errKey(String(tool), String(error)), id]);
    }
  }
  // Makes record-or-bump a single atomic upsert instead of SELECT-then-INSERT.
  sharedRun(d, `CREATE UNIQUE INDEX IF NOT EXISTS mistakes_key ON mistakes(err_key)`);
  sharedFlush(d);
  _ready = true;
  return d;
}

/**
 * Dedup identity for a failure. Two failures are "the same mistake" when they
 * come from the same tool and their errors differ only in variable detail —
 * ids, timestamps, hex blobs, addresses, quantities. Hashing the *full*
 * normalised error (not the 300-char display gist) keeps two long errors that
 * share a prefix distinct.
 */
export function errKey(tool: string, error: string): string {
  // Deliberately conservative: it collapses the things that vary between two
  // occurrences of the *same* mistake (timestamps, request ids, hashes) and
  // leaves short bare numbers alone, because "error 404" and "error 500" are
  // genuinely different mistakes and must not share a fix.
  const norm = error
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}\S*/g, "#")          // ISO timestamps
    .replace(/0x[0-9a-f]+/g, "#")                   // hex literals
    .replace(/\b(?=[0-9a-z]*\d)[0-9a-z]{6,}\b/g, "#") // ids/hashes: 6+ chars containing a digit
    .replace(/\s+/g, " ")
    .trim();
  return tool + ":" + createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

export interface Lesson {
  id: number;
  tool: string;
  context: string;
  error: string;
  fix: string | null;
  hits: number;
}

const gist = (s: string, max = 300) => (s.length > max ? s.slice(0, max) + "…" : s);

/**
 * Record a failed tool call. If the same tool+error is already known, bump its
 * hit counter instead of duplicating. Returns the row id.
 */
export async function recordMistake(tool: string, context: string, error: string): Promise<number> {
  const d = await db();
  const key = errKey(tool, error);
  // One atomic statement: insert the mistake, or bump the hit count of the
  // one already holding this key. No window for a parallel tool call to
  // duplicate the row.
  sharedRun(d,
    `INSERT INTO mistakes (tool, context, error, err_key, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT(err_key) DO UPDATE SET hits = hits + 1`,
    [tool, gist(context), gist(error), key, Date.now()]);
  const row = sharedExec(d, `SELECT id FROM mistakes WHERE err_key = ?`, [key]);
  sharedFlush(d);
  return Number(row[0][0]);
}

/** Attach what actually worked to a recorded mistake. */
export async function recordFix(id: number, fix: string): Promise<void> {
  const d = await db();
  sharedRun(d, `UPDATE mistakes SET fix = ? WHERE id = ?`, [gist(fix, 500), id]);
  sharedFlush(d);
}

/**
 * Attach a fix to this tool's newest still-open failure, whenever it happened.
 * A correction usually arrives on a later turn or in a later session, so the
 * fix cannot depend on the failure and the success sharing one run.
 * Returns the mistake id it resolved, or null if the tool has none open.
 */
export async function attachFixForTool(tool: string, fix: string): Promise<number | null> {
  const d = await db();
  const open = sharedExec(d,
    `SELECT id FROM mistakes WHERE tool = ? AND superseded = 0 AND fix IS NULL
     ORDER BY created_at DESC LIMIT 1`, [tool]);
  if (open.length === 0) return null;
  const id = Number(open[0][0]);
  await recordFix(id, fix);
  return id;
}

/**
 * A user correction or an explicitly taught lesson. Supersedes all previous
 * lessons for the same tool when `supersedes_tool_history` is set — newest
 * guidance wins at retrieval time.
 */
export async function addLesson(
  tool: string, context: string, error: string, fix: string, supersedeHistory = false,
): Promise<number> {
  const d = await db();
  if (supersedeHistory) {
    sharedRun(d, `UPDATE mistakes SET superseded = 1 WHERE tool = ?`, [tool]);
  }
  sharedRun(d, `INSERT INTO mistakes (tool, context, error, fix, created_at) VALUES (?,?,?,?,?)`,
    [tool, gist(context), gist(error), gist(fix, 500), Date.now()]);
  const row = sharedExec(d, `SELECT last_insert_rowid()`);
  sharedFlush(d);
  return Number(row[0][0]);
}

/** Known fixes for a tool, best (most-hit, newest) first. */
export async function knownFixes(tool: string, limit = 3): Promise<Lesson[]> {
  const d = await db();
  const rows = sharedExec(d,
    `SELECT id, tool, context, error, fix, hits FROM mistakes
     WHERE tool = ? AND superseded = 0 AND fix IS NOT NULL
     ORDER BY hits DESC, created_at DESC LIMIT ?`, [tool, limit]);
  return rows.map(toLesson);
}

/**
 * Prompt block of the most valuable lessons: everything with a fix, plus
 * repeat offenders still awaiting one. Empty string when there's nothing —
 * costs zero tokens until Carter has actually made a mistake.
 */
export async function lessonsForPrompt(limit = 15): Promise<string> {
  const d = await db();
  const rows = sharedExec(d,
    // Every live failure is replayed, not just fixed or repeated ones: a
    // mistake that happened once and was never retried is the commonest case,
    // and excluding it was the gap between this table and the claim made for
    // it. Fixed lessons still sort first, so the cap drops the least useful.
    `SELECT id, tool, context, error, fix, hits FROM mistakes
     WHERE superseded = 0
     ORDER BY (fix IS NOT NULL) DESC, hits DESC, created_at DESC LIMIT ?`, [limit]);
  if (rows.length === 0) return "";
  const lines = rows.map(toLesson).map((l) =>
    l.fix
      ? `- [#${l.id}] ${l.tool}: "${l.error}" → DO THIS INSTEAD: ${l.fix}`
      : `- [#${l.id}] ${l.tool}: failed ${l.hits}× with "${l.error}" — no known fix yet; try a different approach and it will be recorded.`,
  );
  return (
    "\n\n## Learned lessons — NEVER repeat these mistakes\n" +
    "Past failures and their fixes. Apply the fix pre-emptively; do not re-attempt " +
    "the failing pattern. To supersede an outdated lesson call record_lesson with its id.\n" +
    lines.join("\n")
  );
}

function toLesson(r: unknown[]): Lesson {
  return {
    id: Number(r[0]), tool: String(r[1]), context: String(r[2]),
    error: String(r[3]), fix: r[4] == null ? null : String(r[4]), hits: Number(r[5]),
  };
}

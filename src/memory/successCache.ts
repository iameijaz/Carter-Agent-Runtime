/**
 * Learned bypass — the success cache.
 *
 * What is cached is the **recipe, not the answer**. Caching the reply to
 * "local news" would serve yesterday's news forever; caching the ordered tool
 * calls that produced it means a later turn re-runs those tools and gets
 * today's pages, with no model asked to decide what to run. That is the whole
 * point: the model is skipped for *choosing*, never for *freshness*.
 *
 * Matching is an exact match on minimally normalised request text. It began as
 * Jaccard overlap over a sorted, stopworded token set; an external review of
 * 2026-09-19 broke that with four cases, all of which come from the same root:
 * sorting and stopwording destroy the information that makes a match safe.
 * "Boston to Austin" and "Austin to Boston" are the same token set; adding one
 * word scores HIGHER (0.9) than swapping one; "with parking" and "without
 * parking" collide once the prepositions are dropped. Exact ordered text has
 * none of those. It hits far less often, and every hit it does make is one the
 * two requests actually agree on.
 *
 * Lives on the shared sql.js connection, same file as the rest of memory.
 */

import { sharedDb, sharedFlush, sharedRun, sharedExec } from "../retrieval/vectorSearch.js";

/** One step of a recipe: a tool and the arguments that worked. */
export interface PlanStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface CachedPlan {
  id: number;
  steps: PlanStep[];
  intent: string;
  hits: number;
}

// Words carrying no intent. Deliberately short: an aggressive list starts
// merging genuinely different requests, and a false hit is the expensive error.
export const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "am",
  "i", "me", "my", "you", "your", "it", "its", "we", "us", "our",
  "what", "whats", "which", "who", "how", "when", "where", "why",
  "do", "does", "did", "can", "could", "will", "would", "should",
  "please", "thanks", "hey", "hi", "ok", "okay", "just", "now",
  "and", "or", "but", "of", "to", "for", "with", "on", "at", "by",
  "some", "any", "get", "give", "show", "tell", "find", "want", "need",
]);

/**
 * The cache key: the request text, lowercased and with whitespace and trailing
 * punctuation tidied. Nothing else — no sorting, no stopwords, no stemming.
 * Every one of those is a claim that two different sentences mean the same
 * thing, and this cache answers without a model, so there is nothing
 * downstream to catch the claim when it is wrong.
 *
 * ponytail: exact text means "local news" and "the local news" are two
 * entries. That is the intended trade. Loosen it only against measured repeat
 * traffic, one equivalence at a time.
 */
export function intentKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[\s?!.,;:]+$/g, "").trim();
}

/**
 * Tools that only read. A replay re-runs stored arguments with no model and no
 * user confirmation, so anything that sends, writes, installs or spawns is not
 * eligible — repeating it is an action, not an optimisation.
 */
const REPLAYABLE = new Set([
  "web_search", "web_fetch", "duckduckgo", "wikimedia", "get_weather",
  "library_search", "library_check_availability", "train_journeys",
  "openverse", "pixabay", "unsplash",
  "email_search", "email_folders", "email_fetch",
]);
// Deliberately excludes api_fetch: it takes an arbitrary method and URL, so it
// is only read-only by accident of its arguments.

/**
 * Intent → a sorted, de-duplicated token set. Used by the offline summarizer to
 * spot two outlets running the same sentence, where word order genuinely does
 * not matter. NOT the cache key — see `intentKey` for why.
 */
export function normalise(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return [...new Set(tokens)].sort();
}

/** Jaccard overlap of two token sets: |A ∩ B| / |A ∪ B|, in [0, 1]. */
export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const shared = a.filter((t) => setB.has(t)).length;
  return shared / (a.length + b.length - shared);
}

let _ready = false;

async function db(): Promise<any> {
  const d = await sharedDb();
  if (_ready) return d;
  sharedRun(d, `
    CREATE TABLE IF NOT EXISTS success_plans (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_norm    TEXT    NOT NULL,
      intent_raw     TEXT    NOT NULL,
      plan           TEXT    NOT NULL,
      schema_version INTEGER NOT NULL,
      hits           INTEGER NOT NULL DEFAULT 0,
      created        INTEGER NOT NULL,
      last_used      INTEGER NOT NULL
    )`);
  // A plan is only ever looked up within one schema version, so that is the
  // column worth indexing.
  sharedRun(d, `CREATE INDEX IF NOT EXISTS success_plans_ver ON success_plans(schema_version)`);
  sharedFlush(d);
  _ready = true;
  return d;
}

const TEMPORAL_KEY = /date|time|day|month|year|from|to|since|until|when|datum|zeit|tag|jahr/i;
const TEMPORAL_VALUE = new RegExp(
  [
    "\\d{4}-\\d{2}-\\d{2}",                       // 2026-09-19
    "\\d{1,2}[./-]\\d{1,2}([./-]\\d{2,4})?",      // 19.09.2026, 09/19
    "\\b(19|20)\\d{2}\\b",                        // a bare year
    "\\d{1,2}:\\d{2}",                            // 14:30
    "\\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)",
    "\\b(mär|mai|okt|dez)",
    "\\b(today|tomorrow|yesterday|tonight|heute|morgen|gestern)\\b",
    "\\b(this|last|next|diese|letzte|nächste)\\s+(week|month|year|woche|monat|jahr)",
  ].join("|"),
  "i",
);

/**
 * Refuse any plan carrying a time reference, whatever it looks like.
 *
 * The first version of this rejected only *today's* date in three formats. The
 * review of 2026-09-19 pointed out the hole: "yesterday's closing price" stores
 * an absolute PAST date, passes that guard cleanly, and then replays the same
 * frozen day forever. Widening the regex is a losing game ("18 Sep", "09/18"),
 * so the rule is now the conservative one it recommended — a date-bearing
 * parameter is not cacheable regardless of its value.
 *
 * ponytail: costs real hits. `train_journeys` takes a date, so it can never be
 * replayed. Correct for now; the upgrade is rebinding documented time
 * parameters from the current request, which needs a per-tool contract.
 */
function containsTime(plan: PlanStep[]): boolean {
  return plan.some((step) =>
    Object.entries(step.args).some(([k, v]) =>
      TEMPORAL_KEY.test(k) || TEMPORAL_VALUE.test(JSON.stringify(v ?? "")),
    ),
  );
}

/**
 * Remember a recipe that worked. Never throws — the cache is an optimisation,
 * and it must not be able to fail a turn that already succeeded.
 */
export async function recordPlan(
  intent: string,
  steps: PlanStep[],
  schemaVersion: number,
): Promise<void> {
  try {
    if (steps.length === 0) return;          // a pure-chat turn has no recipe
    if (containsTime(steps)) return;
    if (!steps.every((s) => REPLAYABLE.has(s.tool))) return;
    const key = intentKey(intent);
    if (key.length === 0) return;

    const d = await db();
    // Same intent, same schema version → bump rather than accumulate
    // near-duplicate rows that would all match each other.
    const existing = sharedExec(d,
      `SELECT id FROM success_plans WHERE intent_norm = ? AND schema_version = ?`,
      [key, schemaVersion]);
    if (existing.length > 0) {
      sharedRun(d, `UPDATE success_plans SET plan = ?, last_used = ? WHERE id = ?`,
        [JSON.stringify(steps), Date.now(), Number(existing[0][0])]);
    } else {
      sharedRun(d,
        `INSERT INTO success_plans (intent_norm, intent_raw, plan, schema_version, hits, created, last_used)
         VALUES (?,?,?,?,0,?,?)`,
        [key, intent.slice(0, 300), JSON.stringify(steps), schemaVersion, Date.now(), Date.now()]);
    }
    sharedFlush(d);
  } catch { /* the cache is evidence of learning, not a dependency */ }
}

/**
 * Best recipe for this intent, or null. Only plans recorded against the same
 * tool-schema version are considered: a plan built when a tool took different
 * arguments is not a plan any more, it is a trap.
 */
export async function lookupPlan(
  intent: string,
  schemaVersion: number,
): Promise<CachedPlan | null> {
  try {
    const key = intentKey(intent);
    if (key.length === 0) return null;

    const d = await db();
    const rows = sharedExec(d,
      `SELECT id, intent_raw, plan, hits FROM success_plans
       WHERE intent_norm = ? AND schema_version = ? LIMIT 1`,
      [key, schemaVersion]);
    if (rows.length === 0) return null;

    const steps = JSON.parse(String(rows[0][2])) as PlanStep[];
    // Re-checked on the way out, not just on the way in: a tool can be dropped
    // from the allowlist after a plan was stored.
    if (!steps.every((s) => REPLAYABLE.has(s.tool))) return null;

    return {
      id: Number(rows[0][0]),
      intent: String(rows[0][1]),
      steps,
      hits: Number(rows[0][3]),
    };
  } catch {
    return null; // a broken cache must degrade to "call the model", not to an error
  }
}

/** Count a replay. Separate from lookup so a failed replay is not counted. */
export async function markPlanUsed(id: number): Promise<void> {
  try {
    const d = await db();
    sharedRun(d, `UPDATE success_plans SET hits = hits + 1, last_used = ? WHERE id = ?`,
      [Date.now(), id]);
    sharedFlush(d);
  } catch { /* non-fatal */ }
}

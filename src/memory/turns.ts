/**
 * Per-turn log — the improvement curve.
 *
 * One row per user turn: how it was resolved, how long it took, which tools
 * ran, whether it worked. Every headline metric this project claims is a
 * SELECT over this table, so it has to exist from the first commit — a turn
 * that ran before the log existed is a turn that can never be counted.
 *
 * `path` records which tier answered:
 *   cache — resolved from a past success, no model call
 *   tier0 — cheap router model only
 *   tier1 — full executor model
 * Only tier1 is reachable today; the cache and tier0 layers are not built yet.
 * That is the point: these rows are the flat baseline the curve starts from.
 *
 * `schema_version` is the MCP registry version at turn time. A cache built
 * against one set of tool schemas says nothing about a later set, so the
 * version travels with every row rather than being inferred afterwards.
 *
 * Lives on the shared sql.js connection, same file as the rest of memory.
 */

import { sharedDb, sharedFlush, sharedRun, sharedExec } from "../retrieval/vectorSearch.js";

export type TurnPath = "cache" | "tier0" | "tier1";
export type TurnOutcome = "ok" | "error" | "cancelled" | "capped";

export interface TurnRecord {
  path: TurnPath;
  latencyMs: number;
  brain: string;
  /** Tools called this turn, in call order; may repeat across rounds. */
  tools: string[];
  outcome: TurnOutcome;
  /** How many tool-call rounds the loop went through. */
  rounds: number;
  /** MCP registry version the tool schemas came from. */
  schemaVersion: number;
  error?: string;
}

export interface TurnRow extends Omit<TurnRecord, "tools" | "error"> {
  id: number;
  ts: number;
  tools: string[];
  error: string | null;
}

let _ready = false;

async function db(): Promise<any> {
  const d = await sharedDb();
  if (_ready) return d;
  sharedRun(d, `
    CREATE TABLE IF NOT EXISTS turns (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      ts             INTEGER NOT NULL,
      path           TEXT    NOT NULL,
      latency_ms     INTEGER NOT NULL,
      brain          TEXT    NOT NULL,
      tools          TEXT    NOT NULL DEFAULT '',
      outcome        TEXT    NOT NULL,
      rounds         INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT 0,
      error          TEXT
    )`);
  sharedRun(d, `CREATE INDEX IF NOT EXISTS turns_ts ON turns(ts)`);
  sharedFlush(d);
  _ready = true;
  return d;
}

const gist = (s: string, max = 300) => (s.length > max ? s.slice(0, max) + "…" : s);

/** Append one turn. Never throws — logging must not be able to kill a run. */
export async function logTurn(t: TurnRecord): Promise<void> {
  try {
    const d = await db();
    sharedRun(d,
      `INSERT INTO turns (ts, path, latency_ms, brain, tools, outcome, rounds, schema_version, error)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [Date.now(), t.path, Math.round(t.latencyMs), t.brain, t.tools.join(","),
       t.outcome, t.rounds, t.schemaVersion, t.error ? gist(t.error) : null]);
    sharedFlush(d);
  } catch { /* the log is evidence, not a dependency */ }
}

/** Most recent turns, newest first. */
export async function recentTurns(limit = 50): Promise<TurnRow[]> {
  const d = await db();
  const rows = sharedExec(d,
    `SELECT id, ts, path, latency_ms, brain, tools, outcome, rounds, schema_version, error
     FROM turns ORDER BY ts DESC, id DESC LIMIT ?`, [limit]);
  return rows.map((r: unknown[]) => ({
    id: Number(r[0]),
    ts: Number(r[1]),
    path: String(r[2]) as TurnPath,
    latencyMs: Number(r[3]),
    brain: String(r[4]),
    tools: String(r[5]) ? String(r[5]).split(",") : [],
    outcome: String(r[6]) as TurnOutcome,
    rounds: Number(r[7]),
    schemaVersion: Number(r[8]),
    error: r[9] == null ? null : String(r[9]),
  }));
}

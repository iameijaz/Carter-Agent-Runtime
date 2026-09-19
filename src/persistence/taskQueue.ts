/**
 * Transactional task queue backed by SQLite via sql.js (pure WASM — no
 * native compilation needed). Append-only event log; state is derived by
 * replaying events for a transaction ID.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CARTER_DB_PATH ?? path.join(__dirname, "../../carter.db");

// sql.js needs its WASM file — resolve it from node_modules
const require = createRequire(import.meta.url);
const initSqlJs = require("sql.js");

type Action = "initialize" | "update_state" | "mark_paused" | "resolve";

export interface TaskEvent {
  id: number;
  transaction_id: string;
  action: Action;
  payload: string | null;
  created_at: string;
}

export interface TaskState {
  transaction_id: string;
  status: "running" | "paused" | "resolved";
  payload: string | null;
  created_at: string;
  updated_at: string;
  events: TaskEvent[];
}

// Lazy singleton — loaded once, flushed to disk on every write
let _db: any = null;

async function getDb() {
  if (_db) return _db;

  const SQL = await initSqlJs();

  if (existsSync(DB_PATH)) {
    const fileBuffer = readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }

  _db.run(`
    CREATE TABLE IF NOT EXISTS task_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_id TEXT    NOT NULL,
      action         TEXT    NOT NULL,
      payload        TEXT,
      created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_txn ON task_events(transaction_id);
  `);

  return _db;
}

function flushDb(db: any) {
  const data: Buffer = Buffer.from(db.export());
  writeFileSync(DB_PATH, data);
}

export async function appendEvent(
  transactionId: string,
  action: Action,
  payload?: string,
): Promise<TaskEvent> {
  const db = await getDb();
  db.run(
    `INSERT INTO task_events (transaction_id, action, payload) VALUES (?, ?, ?)`,
    [transactionId, action, payload ?? null],
  );
  flushDb(db);

  // Fetch the row we just inserted
  const rows = db.exec(
    `SELECT * FROM task_events WHERE transaction_id = ? ORDER BY id DESC LIMIT 1`,
    [transactionId],
  );
  const row = rows[0]?.values[0];
  return {
    id: row[0] as number,
    transaction_id: row[1] as string,
    action: row[2] as Action,
    payload: row[3] as string | null,
    created_at: row[4] as string,
  };
}

export async function getTaskState(transactionId: string): Promise<TaskState | null> {
  const db = await getDb();
  const rows = db.exec(
    `SELECT * FROM task_events WHERE transaction_id = ? ORDER BY id ASC`,
    [transactionId],
  );
  if (!rows[0]?.values?.length) return null;

  const events: TaskEvent[] = rows[0].values.map((r: any[]) => ({
    id: r[0], transaction_id: r[1], action: r[2], payload: r[3], created_at: r[4],
  }));

  let status: TaskState["status"] = "running";
  let payload: string | null = null;

  for (const ev of events) {
    if (ev.action === "initialize")   { status = "running"; payload = ev.payload; }
    if (ev.action === "update_state") { payload = ev.payload; }
    if (ev.action === "mark_paused")  { status = "paused"; }
    if (ev.action === "resolve")      { status = "resolved"; payload = ev.payload; }
  }

  return {
    transaction_id: transactionId,
    status,
    payload,
    created_at: events[0].created_at,
    updated_at: events[events.length - 1].created_at,
    events,
  };
}

export async function listActiveTasks(): Promise<TaskState[]> {
  const db = await getDb();
  const rows = db.exec(`SELECT DISTINCT transaction_id FROM task_events`);
  if (!rows[0]?.values?.length) return [];

  const states = await Promise.all(
    rows[0].values.map((r: any[]) => getTaskState(r[0] as string)),
  );
  return states.filter((s): s is TaskState => s !== null && s.status !== "resolved");
}

export async function closeDb(): Promise<void> {
  if (_db) { _db.close(); _db = null; }
}

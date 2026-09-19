/**
 * Hybrid vector + FTS5 search.
 *
 * Two backends, selected automatically:
 *
 * NATIVE (preferred): better-sqlite3 + sqlite-vec extension (vec0.dll)
 *   - Cosine similarity runs in native C, handles full corpus
 *   - Requires: scripts/install-sqlite-vec.cmd + Visual Studio build tools
 *   - Active when: lib/sqlite-vec/vec0.dll exists AND better-sqlite3 loads
 *
 * FALLBACK: sql.js (WASM SQLite, always available)
 *   - FTS5 narrows to 40 candidates, JS cosine reranks
 *   - No native deps, works everywhere
 *
 * Namespaces: papers | notes | tasks | history
 * Embeddings: OpenAI text-embedding-3-small (1536-dim)
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require    = createRequire(import.meta.url);
const ROOT_DIR   = path.resolve(__dirname, "../..");
const DB_PATH    = process.env.CARTER_DB_PATH ?? path.join(ROOT_DIR, "carter.db");
const VEC_DLL    = path.join(ROOT_DIR, "lib", "sqlite-vec", "vec0.dll");

export type Namespace = "papers" | "notes" | "tasks" | "history";

export interface SearchItem {
  id: string;
  namespace: Namespace;
  content: string;         // full text
  metadata?: string;       // JSON string of extra fields (title, url, date…)
}

export interface SearchResult extends SearchItem {
  score: number;           // 0–1, higher = more relevant
  matchType: "vector" | "fts" | "hybrid";
}

// ── Backend detection ─────────────────────────────────────────────────────────
// Try to load better-sqlite3 + vec0.dll. Falls back silently to sql.js.

let _nativeDb: any = null;
let _useNative = false;

function tryNativeBackend(): boolean {
  if (!existsSync(VEC_DLL)) return false;
  try {
    const Database = require("better-sqlite3");
    const db = new Database(DB_PATH);
    db.loadExtension(VEC_DLL.replace(/\\/g, "/").replace(/\.dll$/, ""));
    db.exec(`
      CREATE TABLE IF NOT EXISTS search_items (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL, content TEXT NOT NULL,
        metadata TEXT, embedding TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
        id UNINDEXED, namespace UNINDEXED, content,
        content='search_items', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS ai_fts AFTER INSERT ON search_items BEGIN
        INSERT INTO search_fts(rowid,id,namespace,content) VALUES(new.rowid,new.id,new.namespace,new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS ad_fts AFTER DELETE ON search_items BEGIN
        INSERT INTO search_fts(search_fts,rowid,id,namespace,content) VALUES('delete',old.rowid,old.id,old.namespace,old.content);
      END;
    `);
    _nativeDb = db;
    _useNative = true;
    console.log("[vector] sqlite-vec native backend active");
    return true;
  } catch {
    return false;
  }
}

tryNativeBackend();

// ── DB singleton (sql.js fallback) ────────────────────────────────────────────
let _db: any = null;
// The stock sql.js wasm build ships without FTS5. When it's missing, keyword
// candidate selection degrades to a LIKE scan (see hybridSearch) instead of
// taking the whole memory layer down with "no such module: fts5".
let _ftsAvailable = true;

async function getDb() {
  if (_useNative) return _nativeDb;
  if (_db) return _db;
  const SQL = await require("sql.js")();
  _db = existsSync(DB_PATH)
    ? new SQL.Database(readFileSync(DB_PATH))
    : new SQL.Database();

  _db.run(`
    CREATE TABLE IF NOT EXISTS search_items (
      id        TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      content   TEXT NOT NULL,
      metadata  TEXT,
      embedding TEXT,          -- JSON array of floats
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
  `);
  try {
    _db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
        id UNINDEXED,
        namespace UNINDEXED,
        content,
        content='search_items',
        content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS search_items_ai AFTER INSERT ON search_items BEGIN
        INSERT INTO search_fts(rowid, id, namespace, content)
          VALUES (new.rowid, new.id, new.namespace, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS search_items_ad AFTER DELETE ON search_items BEGIN
        INSERT INTO search_fts(search_fts, rowid, id, namespace, content)
          VALUES ('delete', old.rowid, old.id, old.namespace, old.content);
      END;
    `);
  } catch {
    _ftsAvailable = false;
    console.warn("[vector] this sql.js build has no FTS5 — keyword search degrades to a LIKE scan");
  }
  return _db;
}

function flush(db: any) {
  if (_useNative) return; // better-sqlite3 writes synchronously — no flush needed
  writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function dbRun(db: any, sql: string, params: any[] = []) {
  if (_useNative) return db.prepare(sql).run(...params);
  return db.run(sql, params);
}

function dbExec(db: any, sql: string, params: any[] = []): Array<any[]> {
  if (_useNative) {
    const rows = db.prepare(sql).all(...params);
    return rows.map((r: any) => Object.values(r));
  }
  const result = db.exec(sql, params);
  return result[0]?.values ?? [];
}

// ── Embeddings ────────────────────────────────────────────────────────────────
async function embed(text: string): Promise<number[] | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "text-embedding-3-small", input: text.slice(0, 8000) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: { embedding: number[] }[] };
    return data.data[0].embedding;
  } catch { return null; }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Index a document into the search store. */
export async function indexItem(item: SearchItem): Promise<void> {
  const db = await getDb();
  const embedding = await embed(item.content);
  dbRun(db,
    `INSERT OR REPLACE INTO search_items (id, namespace, content, metadata, embedding)
     VALUES (?, ?, ?, ?, ?)`,
    [item.id, item.namespace, item.content, item.metadata ?? null,
     embedding ? JSON.stringify(embedding) : null],
  );
  flush(db);
}

/** Hybrid search: FTS5 keyword match + optional cosine rerank. */
export async function hybridSearch(
  query: string,
  namespace: Namespace,
  limit = 10,
): Promise<SearchResult[]> {
  const db = await getDb();

  // Stage 1: keyword candidates (top 40) — FTS5 when the build has it,
  // otherwise a LIKE scan with a term-hit fraction standing in for bm25.
  let rows: Array<any[]>;
  if (_useNative || _ftsAvailable) {
    rows = dbExec(db,
      `SELECT s.id, s.namespace, s.content, s.metadata, s.embedding,
              bm25(search_fts) AS bm25_score
       FROM search_fts f
       JOIN search_items s ON s.id = f.id
       WHERE search_fts MATCH ? AND f.namespace = ?
       ORDER BY bm25_score
       LIMIT 40`,
      [query, namespace],
    );
  } else {
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2).slice(0, 6);
    if (terms.length === 0) terms.push(query.toLowerCase());
    const where = terms.map(() => `lower(content) LIKE ?`).join(" OR ");
    rows = dbExec(db,
      `SELECT id, namespace, content, metadata, embedding, 0 AS bm25_score
       FROM search_items WHERE namespace = ? AND (${where}) LIMIT 40`,
      [namespace, ...terms.map((t) => `%${t}%`)],
    );
    // pseudo-bm25: fraction of query terms present → bm25Norm below equals it
    for (const r of rows) {
      const text = String(r[2]).toLowerCase();
      const hits = terms.filter((t) => text.includes(t)).length;
      r[5] = (hits / terms.length - 1) * 10;
    }
  }

  if (!rows.length) return [];

  const candidates = rows.map((r: any[]) => ({
    id:        r[0] as string,
    namespace: r[1] as Namespace,
    content:   r[2] as string,
    metadata:  r[3] as string,
    embedding: r[4] ? JSON.parse(r[4] as string) as number[] : null,
    bm25:      r[5] as number,
  }));

  // Stage 2: embed query and cosine-rerank if embeddings available
  const queryVec = await embed(query);
  const results: SearchResult[] = candidates.map(c => {
    let score: number;
    let matchType: SearchResult["matchType"] = "fts";

    if (queryVec && c.embedding) {
      const sim = cosine(queryVec, c.embedding);
      const bm25Norm = Math.max(0, 1 + c.bm25 / 10);
      score = 0.6 * sim + 0.4 * Math.min(bm25Norm, 1);
      matchType = "hybrid";
    } else {
      score = Math.max(0, 1 + c.bm25 / 10);
    }

    return { id: c.id, namespace: c.namespace, content: c.content,
             metadata: c.metadata, score, matchType };
  });

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Delete a document from the search store. */
export async function deleteItem(id: string): Promise<void> {
  const db = await getDb();
  dbRun(db, `DELETE FROM search_items WHERE id = ?`, [id]);
  flush(db);
}

/** Count items per namespace. */
export async function indexStats(): Promise<Record<Namespace, number>> {
  const db = await getDb();
  const rows = dbExec(db, `SELECT namespace, COUNT(*) FROM search_items GROUP BY namespace`);
  const stats: Record<string, number> = { papers: 0, notes: 0, tasks: 0, history: 0 };
  for (const row of rows) {
    stats[row[0] as string] = row[1] as number;
  }
  return stats as Record<Namespace, number>;
}

/** Which backend is active. */
export function vectorBackend(): "native-sqlite-vec" | "sql.js-wasm" {
  return _useNative ? "native-sqlite-vec" : "sql.js-wasm";
}

// ── Shared DB access for the memory engine ──────────────────────────────────
// The memory engine (buffer/entities/relations/archive tables) MUST ride this
// same connection. carter.db has two sql.js consumers already (this module +
// taskQueue); each keeps its own in-memory copy and flushes the WHOLE file, so
// a third independent handle would clobber writes. These helpers let memory/db.ts
// create and query its tables on THIS module's handle instead of opening its own.
export async function sharedDb(): Promise<any> { return getDb(); }
export function sharedFlush(db: any): void { flush(db); }
export function sharedRun(db: any, sql: string, params: any[] = []) { return dbRun(db, sql, params); }
export function sharedExec(db: any, sql: string, params: any[] = []): Array<any[]> { return dbExec(db, sql, params); }
export { embed as embedText };

/**
 * Cognitive Memory Engine — shared schema + graph helpers.
 *
 * Three layers, all inside carter.db, all on vectorSearch's sql.js connection
 * (see sharedDb — a third independent handle would clobber whole-file flushes):
 *
 *   1. buffer     — raw ingested docs, purged after 48h.
 *   2. entities + relations — the lightweight knowledge graph, kept forever.
 *   3. archive    — gzipped originals of consolidated weekly notes (tiny footprint).
 *
 * Atoms themselves also live in search_items (namespace "notes") via indexItem()
 * so hybridSearch can recall them; this module only owns the extra tables.
 */

import { sharedDb, sharedFlush, sharedRun, sharedExec } from "../retrieval/vectorSearch.js";

const BUFFER_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

let _ready = false;

/** Idempotently create the memory tables on the shared connection. */
export async function initMemory(): Promise<any> {
  const db = await sharedDb();
  if (_ready) return db;
  sharedRun(db, `
    CREATE TABLE IF NOT EXISTS mem_buffer (
      id         TEXT PRIMARY KEY,
      source     TEXT NOT NULL,
      title      TEXT,
      raw        TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  sharedRun(db, `
    CREATE TABLE IF NOT EXISTS mem_entities (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      kind      TEXT,
      note_path TEXT,
      updated_at INTEGER NOT NULL
    )`);
  sharedRun(db, `CREATE INDEX IF NOT EXISTS mem_entities_name ON mem_entities(name)`);
  sharedRun(db, `
    CREATE TABLE IF NOT EXISTS mem_relations (
      src    TEXT NOT NULL,
      rel    TEXT NOT NULL,
      dst    TEXT NOT NULL,
      weight REAL DEFAULT 1,
      PRIMARY KEY (src, rel, dst)
    )`);
  sharedRun(db, `
    CREATE TABLE IF NOT EXISTS mem_archive (
      id       TEXT PRIMARY KEY,
      week     TEXT NOT NULL,
      title    TEXT,
      gz       BLOB NOT NULL,
      bytes    INTEGER,
      archived_at INTEGER NOT NULL
    )`);
  sharedFlush(db);
  _ready = true;
  return db;
}

// ── Buffer (layer 1) ────────────────────────────────────────────────────────

export async function bufferPut(id: string, source: string, title: string, raw: string): Promise<void> {
  const db = await initMemory();
  sharedRun(db, `INSERT OR REPLACE INTO mem_buffer (id, source, title, raw, created_at) VALUES (?,?,?,?,?)`,
    [id, source, title, raw, Date.now()]);
  sharedFlush(db);
}

/** Delete buffer rows older than 48h. Returns count purged. */
export async function bufferPurge(now = Date.now()): Promise<number> {
  const db = await initMemory();
  const cutoff = now - BUFFER_TTL_MS;
  const before = sharedExec(db, `SELECT COUNT(*) FROM mem_buffer WHERE created_at < ?`, [cutoff]);
  const n = Number(before[0]?.[0] ?? 0);
  sharedRun(db, `DELETE FROM mem_buffer WHERE created_at < ?`, [cutoff]);
  sharedFlush(db);
  return n;
}

// ── Graph (layer 2) ─────────────────────────────────────────────────────────

export interface GraphEntity { name: string; kind?: string; }
export interface GraphRelation { src: string; rel: string; dst: string; }

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export async function upsertGraph(
  entities: GraphEntity[],
  relations: GraphRelation[],
  notePath: string,
): Promise<void> {
  const db = await initMemory();
  const now = Date.now();
  for (const e of entities) {
    const id = slug(e.name);
    if (!id) continue;
    sharedRun(db, `INSERT OR REPLACE INTO mem_entities (id, name, kind, note_path, updated_at) VALUES (?,?,?,?,?)`,
      [id, e.name, e.kind ?? null, notePath, now]);
  }
  for (const r of relations) {
    const src = slug(r.src), dst = slug(r.dst);
    if (!src || !dst) continue;
    // bump weight when a relation recurs — repetition = confidence
    sharedRun(db,
      `INSERT INTO mem_relations (src, rel, dst, weight) VALUES (?,?,?,1)
       ON CONFLICT(src, rel, dst) DO UPDATE SET weight = weight + 1`,
      [src, r.rel, dst]);
  }
  sharedFlush(db);
}

export async function graphStats(): Promise<{ buffer: number; entities: number; relations: number; archive: number }> {
  const db = await initMemory();
  const one = (sql: string) => Number(sharedExec(db, sql)[0]?.[0] ?? 0);
  return {
    buffer:    one(`SELECT COUNT(*) FROM mem_buffer`),
    entities:  one(`SELECT COUNT(*) FROM mem_entities`),
    relations: one(`SELECT COUNT(*) FROM mem_relations`),
    archive:   one(`SELECT COUNT(*) FROM mem_archive`),
  };
}

// ── Archive (layer 3) ───────────────────────────────────────────────────────

import { gzipSync } from "node:zlib";

export async function archivePut(id: string, week: string, title: string, text: string): Promise<number> {
  const db = await initMemory();
  const gz = gzipSync(Buffer.from(text, "utf-8"));
  sharedRun(db, `INSERT OR REPLACE INTO mem_archive (id, week, title, gz, bytes, archived_at) VALUES (?,?,?,?,?,?)`,
    [id, week, title, gz, gz.length, Date.now()]);
  sharedFlush(db);
  return gz.length;
}

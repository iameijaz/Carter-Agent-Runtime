/**
 * Nightly + weekly consolidation — runs during idle time (see scheduler.ts).
 *
 *  nightly():  purge the 48h buffer, then a conflict-resolution pass that finds
 *              contradicting atoms (via hybrid similarity) and merges them with a
 *              single LLM call.
 *  weekly():   compress the week's daily notes into one "Summary Synthesis" note,
 *              gzip the originals into the archive table, and reindex.
 *
 * Everything is best-effort and logged; a failure never takes down the server.
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { brains } from "../agent/brains.js";
import { hybridSearch, indexItem, deleteItem } from "../retrieval/vectorSearch.js";
import { bufferPurge, archivePut, graphStats } from "./db.js";
import { VAULT_DIR } from "./librarian.js";

function log(msg: string) { console.log(`[memory] ${msg}`); }

// ── Nightly: purge buffer + conflict resolution ─────────────────────────────

const MERGE_PROMPT = `Two remembered atoms may agree, refine, or CONTRADICT each other.
Return STRICT JSON: {"conflict": true|false, "merged": "single reconciled atom, or empty if no conflict"}.
Only set conflict=true for genuine factual contradiction. If they merely overlap, conflict=false.`;

/**
 * Scan recent atoms; for each, pull its nearest neighbour and ask the model
 * whether they contradict. If so, replace both with a merged atom.
 */
export async function nightly(now = Date.now()): Promise<{ purged: number; merged: number }> {
  const purged = await bufferPurge(now);
  log(`nightly: purged ${purged} buffer row(s) older than 48h`);

  let merged = 0;
  if (!existsSync(VAULT_DIR)) return { purged, merged };

  // Sample today's atoms by re-reading fresh notes' atoms through recall.
  // We probe with each note's title to find near-duplicates / conflicts.
  const files = readdirSync(VAULT_DIR).filter((f) => f.endsWith(".md") && !f.includes("synthesis"));
  const seen = new Set<string>();

  for (const file of files.slice(-40)) {
    const full = path.join(VAULT_DIR, file);
    const text = readFileSync(full, "utf-8");
    const atoms = text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());

    for (const atom of atoms.slice(0, 8)) {
      if (seen.has(atom)) continue;
      seen.add(atom);
      const hits = await hybridSearch(atom, "notes", 3);
      const other = hits.find((h) => h.content.trim() !== atom && h.score > 0.55);
      if (!other) continue;

      try {
        const res = await brains.gpt.client.chat.completions.create({
          model: brains.gpt.model,
          messages: [
            { role: "system", content: MERGE_PROMPT },
            { role: "user", content: `ATOM A: ${atom}\nATOM B: ${other.content.trim()}` },
          ],
          response_format: { type: "json_object" },
          temperature: 0,
        });
        const p = JSON.parse(res.choices[0]?.message?.content ?? "{}") as { conflict?: boolean; merged?: string };
        if (p.conflict && p.merged?.trim()) {
          await deleteItem(other.id);
          await indexItem({ id: other.id, namespace: "notes", content: p.merged.trim(), metadata: other.metadata });
          merged++;
          log(`nightly: merged conflict → ${p.merged.trim().slice(0, 80)}`);
        }
      } catch (err) {
        log(`nightly: merge check failed — ${(err as Error).message}`);
      }
    }
  }
  log(`nightly: resolved ${merged} conflict(s)`);
  return { purged, merged };
}

// ── Weekly: synthesise + archive ────────────────────────────────────────────

function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const SYNTH_PROMPT = `Compress these daily research notes into ONE dense "Summary Synthesis".
Keep every durable fact and relation; drop redundancy. Prefer bullet atoms grouped by theme.
Return Markdown only (no frontmatter): a "# " title line, then a short overview, then themed bullets.`;

/**
 * Fold the week's per-day notes into a single synthesis note. Originals are
 * gzipped into mem_archive and deleted from disk (small footprint), the
 * synthesis is written to the vault and indexed.
 */
export async function weekly(now = new Date()): Promise<{ folded: number; week: string; bytesArchived: number }> {
  const week = isoWeek(now);
  if (!existsSync(VAULT_DIR)) { mkdirSync(VAULT_DIR, { recursive: true }); return { folded: 0, week, bytesArchived: 0 }; }

  // Notes older than 7 days, excluding existing syntheses.
  const cutoff = now.getTime() - 7 * 86400000;
  const stale = readdirSync(VAULT_DIR)
    .filter((f) => f.endsWith(".md") && !f.includes("synthesis"))
    .map((f) => ({ f, full: path.join(VAULT_DIR, f) }))
    .filter(({ f }) => {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? new Date(m[1]).getTime() < cutoff : false;
    });

  if (stale.length < 2) { log(`weekly: only ${stale.length} stale note(s), skipping synthesis`); return { folded: 0, week, bytesArchived: 0 }; }

  const combined = stale.map(({ f, full }) => `### ${f}\n${readFileSync(full, "utf-8")}`).join("\n\n---\n\n");

  const res = await brains.gpt.client.chat.completions.create({
    model: brains.gpt.model,
    messages: [
      { role: "system", content: SYNTH_PROMPT },
      { role: "user", content: combined.slice(0, 48000) },
    ],
    temperature: 0.3,
  });
  const synthBody = res.choices[0]?.message?.content?.trim() || `# Synthesis ${week}\n(empty)`;

  // Archive originals (gzip → mem_archive), then delete from disk.
  let bytesArchived = 0;
  for (const { f, full } of stale) {
    bytesArchived += await archivePut(`${week}::${f}`, week, f, readFileSync(full, "utf-8"));
    unlinkSync(full);
  }

  // Write + index the synthesis.
  const synthId = `${new Date().toISOString().slice(0, 10)}-synthesis-${week}`;
  const synthPath = path.join(VAULT_DIR, `${synthId}.md`);
  const fm = `---\ntitle: "Summary Synthesis ${week}"\nsource: "consolidation"\ndate: ${new Date().toISOString().slice(0, 10)}\nkind: synthesis\n---\n\n`;
  writeFileSync(synthPath, fm + synthBody, "utf-8");
  await indexItem({
    id: synthId, namespace: "notes", content: synthBody,
    metadata: JSON.stringify({ title: `Summary Synthesis ${week}`, source: "consolidation", kind: "synthesis", notePath: synthPath }),
  });

  const stats = await graphStats();
  log(`weekly: folded ${stale.length} note(s) into ${week}, archived ${bytesArchived}B; graph=${JSON.stringify(stats)}`);
  return { folded: stale.length, week, bytesArchived };
}

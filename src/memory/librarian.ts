/**
 * The Librarian — ingests a URL or file path, distils it to high-value semantic
 * atoms, and files a Markdown note in the vault. Deterministic pipeline with a
 * SINGLE LLM call (no AgentLoop): parse → buffer → extract → write note →
 * upsert graph → index atoms for recall.
 *
 * Philosophy: "understand, not index". We keep dense atoms + a small graph, not
 * the raw text (that lives in the 48h buffer, then evaporates).
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brains } from "../agent/brains.js";
import { fetchReadable } from "../tools/native/webFetch.js";
import { documentParse } from "../tools/native/documentParse.js";
import { indexItem } from "../retrieval/vectorSearch.js";
import { bufferPut, upsertGraph } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
export const VAULT_DIR = process.env.CARTER_VAULT ?? path.join(ROOT, "vault");

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";
const today = () => new Date().toISOString().slice(0, 10);

interface Extraction {
  title: string;
  summary: string;
  atoms: string[];                                   // dense standalone facts/claims
  entities: { name: string; kind?: string }[];
  relations: { src: string; rel: string; dst: string }[];
}

const EXTRACT_PROMPT = `You are a memory librarian. Distil the SOURCE into durable, high-value knowledge.
Discard fluff, navigation, ads, boilerplate. Keep only what is worth remembering.
Return STRICT JSON (no markdown fence) matching:
{
 "title": "concise title",
 "summary": "2-4 sentence dense summary",
 "atoms": ["standalone fact or claim, self-contained", ...],   // 3-15 items, each understandable alone
 "entities": [{"name":"...","kind":"person|org|concept|tech|place|work"}, ...],
 "relations": [{"src":"EntityA","rel":"verb phrase","dst":"EntityB"}, ...]
}
Atoms must be atomic (one idea each) and phrased to stand on their own out of context.`;

export interface IngestResult {
  ok: boolean;
  title: string;
  notePath: string;
  atoms: number;
  entities: number;
  relations: number;
  source: string;
}

/** Parse a URL or local file into (title, raw text). */
async function loadSource(src: string): Promise<{ title: string; text: string }> {
  if (/^https?:\/\//i.test(src)) {
    const page = await fetchReadable(src);
    return { title: page.title, text: page.text };
  }
  if (!existsSync(src)) throw new Error(`Not a URL and file not found: ${src}`);
  const parsed = await documentParse(src);
  return { title: path.basename(src), text: parsed.text };
}

/** One LLM call → structured extraction. */
async function extract(title: string, text: string, source: string): Promise<Extraction> {
  const res = await brains.gpt.client.chat.completions.create({
    model: brains.gpt.model,
    messages: [
      { role: "system", content: EXTRACT_PROMPT },
      { role: "user", content: `SOURCE: ${source}\nTITLE: ${title}\n\n${text.slice(0, 24000)}` },
    ],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });
  const raw = res.choices[0]?.message?.content ?? "{}";
  const p = JSON.parse(raw) as Partial<Extraction>;
  return {
    title: p.title || title,
    summary: p.summary || "",
    atoms: Array.isArray(p.atoms) ? p.atoms.filter(Boolean) : [],
    entities: Array.isArray(p.entities) ? p.entities.filter((e) => e?.name) : [],
    relations: Array.isArray(p.relations) ? p.relations.filter((r) => r?.src && r?.dst) : [],
  };
}

/** Render a vault Markdown note with YAML frontmatter. */
function renderNote(x: Extraction, source: string, date: string): string {
  const yamlList = (arr: string[]) => arr.map((s) => `\n  - ${JSON.stringify(s)}`).join("");
  const fm = [
    "---",
    `title: ${JSON.stringify(x.title)}`,
    `source: ${JSON.stringify(source)}`,
    `date: ${date}`,
    `entities:${x.entities.length ? yamlList(x.entities.map((e) => e.name)) : " []"}`,
    "---",
  ].join("\n");
  const body = [
    `# ${x.title}`,
    "",
    x.summary,
    "",
    "## Atoms",
    ...x.atoms.map((a) => `- ${a}`),
    "",
    "## Relations",
    ...x.relations.map((r) => `- ${r.src} — *${r.rel}* → ${r.dst}`),
    "",
  ].join("\n");
  return `${fm}\n\n${body}`;
}

/** Full ingestion pipeline. */
export async function ingest(source: string): Promise<IngestResult> {
  mkdirSync(VAULT_DIR, { recursive: true });
  const { title, text } = await loadSource(source);
  if (!text.trim()) throw new Error(`Empty content extracted from: ${source}`);

  const date = today();
  const id = `${date}-${slug(title)}`;

  // Layer 1: keep raw for 48h (lets consolidation re-examine before it evaporates)
  await bufferPut(id, source, title, text);

  // One LLM distillation call
  const x = await extract(title, text, source);

  // Vault note
  const notePath = path.join(VAULT_DIR, `${id}.md`);
  writeFileSync(notePath, renderNote(x, source, date), "utf-8");

  // Layer 2: graph
  await upsertGraph(x.entities, x.relations, notePath);

  // Index atoms for hybrid recall (namespace "notes")
  const meta = JSON.stringify({ title: x.title, source, date, notePath });
  await indexItem({ id: `${id}::summary`, namespace: "notes", content: `${x.title}\n${x.summary}`, metadata: meta });
  let i = 0;
  for (const atom of x.atoms) {
    await indexItem({ id: `${id}::atom-${i++}`, namespace: "notes", content: atom, metadata: meta });
  }

  return {
    ok: true,
    title: x.title,
    notePath,
    atoms: x.atoms.length,
    entities: x.entities.length,
    relations: x.relations.length,
    source,
  };
}

/**
 * Conversational context memory — lets Carter carry facts across turns instead
 * of asking the user to repeat themselves. If the operator asks about "weather
 * in Mannheim", that implies they're in Mannheim; a later "trains to Berlin"
 * should default the origin to Mannheim without a clarifying question.
 *
 * Two extraction paths per user message:
 *  1. a cheap synchronous heuristic for the most common patterns (so the fact
 *     is available immediately), and
 *  2. a fire-and-forget LLM pass that lands richer facts for the *next* turn.
 * Neither blocks the run. Facts are keyed (last write wins) and persisted.
 */
import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brains } from "./brains.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CTX_PATH = path.join(__dirname, "../../context.json");

export interface Fact {
  key: string;       // e.g. "location", "train_origin", "timezone", "language"
  value: string;
  evidence?: string; // why we believe it (the phrasing that implied it)
  updated: string;   // ISO
}

let facts: Record<string, Fact> | null = null;

function load(): Record<string, Fact> {
  if (facts) return facts;
  if (existsSync(CTX_PATH)) {
    try { facts = JSON.parse(readFileSync(CTX_PATH, "utf-8")); return facts!; }
    catch { /* fall through */ }
  }
  facts = {};
  return facts;
}

async function persist(): Promise<void> {
  try { await writeFile(CTX_PATH, JSON.stringify(load(), null, 2), "utf-8"); } catch { /* best effort */ }
}

export function upsertFact(key: string, value: string, evidence?: string): void {
  const v = value.trim();
  if (!key || !v) return;
  load()[key] = { key, value: v, evidence, updated: new Date().toISOString() };
  void persist();
}

export function getFacts(): Fact[] { return Object.values(load()); }

export function formatFactsForPrompt(): string {
  const list = getFacts();
  if (!list.length) return "";
  const lines = list.map((f) => `- ${f.key}: ${f.value}${f.evidence ? ` (${f.evidence})` : ""}`);
  return (
    "\n\n## What you already know (conversation context)\n" +
    "Use these as defaults. Do NOT ask the user to repeat them. If a request is " +
    "ambiguous and one of these resolves it, apply it silently — e.g. a train " +
    "request with no origin departs from the operator's known location, valid DB " +
    "connections, departing now unless a time is given:\n" +
    lines.join("\n")
  );
}

/** Cheap, instant heuristic for the highest-value fact: where the user is. */
function heuristic(text: string): void {
  // "weather in Mannheim", "something in Berlin", "I'm in Worms", "here in X"
  const m = text.match(/\b(?:in|from|here in|based in|i'?m in)\s+([A-Z][\p{L}.-]+(?:\s+[A-Z][\p{L}.-]+)?)/u);
  if (m && /\b(weather|temp|rain|forecast|here|live|in)\b/i.test(text)) {
    upsertFact("location", m[1], `mentioned "${m[0].trim()}"`);
  }
}

const EXTRACT_PROMPT =
  "Extract durable facts about the USER or this session from their message. " +
  "Only include a fact if it is clearly implied — never guess. Prefer keys: " +
  "location (city the user is in), train_origin, home, timezone, language, and " +
  "any stable entity worth remembering. Respond as JSON: " +
  '{"facts":[{"key":"...","value":"...","evidence":"..."}]}. Empty list if none.';

/**
 * Note a user message: run the heuristic now, kick off LLM extraction in the
 * background. Safe to call fire-and-forget; never throws into the caller.
 */
export function noteUserMessage(text: string): void {
  try { heuristic(text); } catch { /* ignore */ }

  // ponytail: reuses the gpt brain (gpt-4.1) for extraction; if this proves
  // costly, point it at a cheaper model via a dedicated config knob.
  void (async () => {
    try {
      const res = await brains.gpt.client.chat.completions.create({
        model: brains.gpt.model,
        messages: [
          { role: "system", content: EXTRACT_PROMPT },
          { role: "user", content: text },
        ],
        response_format: { type: "json_object" },
        max_tokens: 300,
      });
      const parsed = JSON.parse(res.choices[0]?.message?.content ?? "{}");
      for (const f of parsed.facts ?? []) {
        if (f?.key && f?.value) upsertFact(String(f.key), String(f.value), f.evidence ? String(f.evidence) : undefined);
      }
    } catch { /* extraction is best-effort */ }
  })();
}

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREFS_PATH = path.join(__dirname, "../../preferences.json");

export interface Preference {
  topic: string;       // e.g. "song lyrics", "integer sequences", "news"
  source?: string;     // e.g. "genius.com", "oeis.org"
  approach?: string;   // free-text instruction, e.g. "search site:genius.com {query}"
  notes?: string;      // extra context
  updated: string;     // ISO date
}

export interface PreferencesStore {
  preferences: Preference[];
}

async function load(): Promise<PreferencesStore> {
  if (!existsSync(PREFS_PATH)) return { preferences: [] };
  try {
    return JSON.parse(await readFile(PREFS_PATH, "utf-8"));
  } catch {
    return { preferences: [] };
  }
}

async function save(store: PreferencesStore): Promise<void> {
  await writeFile(PREFS_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export async function getPreferences(): Promise<Preference[]> {
  const store = await load();
  return store.preferences;
}

export async function rememberPreference(pref: Omit<Preference, "updated">): Promise<void> {
  const store = await load();
  const idx = store.preferences.findIndex(
    (p) => p.topic.toLowerCase() === pref.topic.toLowerCase()
  );
  const entry: Preference = { ...pref, updated: new Date().toISOString() };
  if (idx >= 0) {
    store.preferences[idx] = entry;
  } else {
    store.preferences.push(entry);
  }
  await save(store);
}

export async function forgetPreference(topic: string): Promise<boolean> {
  const store = await load();
  const before = store.preferences.length;
  store.preferences = store.preferences.filter(
    (p) => p.topic.toLowerCase() !== topic.toLowerCase()
  );
  if (store.preferences.length < before) { await save(store); return true; }
  return false;
}

/** Format preferences as a system-prompt injection block. */
export function formatPreferencesForPrompt(prefs: Preference[]): string {
  if (prefs.length === 0) return "";
  const lines = prefs.map((p) => {
    const parts = [`- **${p.topic}**:`];
    if (p.source)   parts.push(`prefer ${p.source}`);
    if (p.approach) parts.push(p.approach);
    if (p.notes)    parts.push(`(${p.notes})`);
    return parts.join(" ");
  });
  return `\n\n## Your learned preferences\nApply these automatically — do not ask for confirmation:\n${lines.join("\n")}`;
}

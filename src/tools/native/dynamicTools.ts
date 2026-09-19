/**
 * Dynamic tool registry — Carter can create new tools at runtime from generated
 * scripts. Bound tools are persisted to workspace/.tools.json and reloaded on
 * startup.
 *
 * Flow:
 *   1. Agent writes a script with write_file
 *   2. Agent tests it with run_script (max 3 attempts)
 *   3. On success, agent calls bind_tool to register it permanently
 *   4. The tool becomes callable via ToolBox.call() immediately
 *   5. On future startups, bound tools are restored from .tools.json
 *
 * Each bound tool is a thin wrapper: it calls run_script on the backing file,
 * passing the tool arguments as --key value CLI flags.
 */

import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { WORKSPACE_DIR, runScriptFile } from "./scriptRunner.js";

const TOOLS_MANIFEST = path.join(WORKSPACE_DIR, ".tools.json");

export interface BoundToolSpec {
  name: string;
  description: string;
  filename: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  createdAt: string;
  fixHistory?: string[];
}

let _boundTools: Map<string, BoundToolSpec> = new Map();
let _loaded = false;

async function loadManifest(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  if (!existsSync(TOOLS_MANIFEST)) return;
  try {
    const raw = JSON.parse(await readFile(TOOLS_MANIFEST, "utf-8")) as BoundToolSpec[];
    for (const t of raw) _boundTools.set(t.name, t);
    if (_boundTools.size > 0) {
      console.log(`[dyntools] loaded ${_boundTools.size} bound tool(s): ${[..._boundTools.keys()].join(", ")}`);
    }
  } catch { /* ignore corrupt manifest */ }
}

async function saveManifest(): Promise<void> {
  const list = [..._boundTools.values()];
  await writeFile(TOOLS_MANIFEST, JSON.stringify(list, null, 2), "utf-8");
}

/** Register a generated script as a persistent tool. */
export async function bindTool(spec: BoundToolSpec): Promise<void> {
  await loadManifest();
  spec.createdAt = spec.createdAt ?? new Date().toISOString();
  _boundTools.set(spec.name, spec);
  await saveManifest();
  console.log(`[dyntools] bound tool: ${spec.name} → ${spec.filename}`);
}

/** Remove a bound tool by name. */
export async function unbindTool(name: string): Promise<boolean> {
  await loadManifest();
  const removed = _boundTools.delete(name);
  if (removed) await saveManifest();
  return removed;
}

/** List all bound tools. */
export async function listBoundTools(): Promise<BoundToolSpec[]> {
  await loadManifest();
  return [..._boundTools.values()];
}

/** Get a bound tool spec by name. */
export async function getBoundTool(name: string): Promise<BoundToolSpec | undefined> {
  await loadManifest();
  return _boundTools.get(name);
}

/** Record a fix applied to a bound tool (for memory/learning). */
export async function recordToolFix(name: string, fix: string): Promise<void> {
  await loadManifest();
  const tool = _boundTools.get(name);
  if (!tool) return;
  tool.fixHistory = [...(tool.fixHistory ?? []), fix];
  await saveManifest();
}

/**
 * Call a bound tool by name. Converts the args object to CLI flags
 * and runs the backing script, returning stdout as JSON if possible.
 */
export async function callBoundTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  await loadManifest();
  const spec = _boundTools.get(name);
  if (!spec) throw new Error(`No bound tool named "${name}". Use list_bound_tools to see available tools.`);

  // Convert args to CLI flags: {query: "foo", limit: 5} → ["--query", "foo", "--limit", "5"]
  const cliArgs: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v !== undefined && v !== null) {
      cliArgs.push("--" + k, String(v));
    }
  }

  const result = await runScriptFile(spec.filename, cliArgs);

  if (result.exitCode !== 0) {
    throw new Error(`Tool "${name}" failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`);
  }

  // Try to parse stdout as JSON; fall back to raw string
  const raw = result.stdout.trim();
  try { return JSON.parse(raw); }
  catch { return { output: raw }; }
}

/** Build OpenAI tool schema for a bound tool. */
export function boundToolToSchema(spec: BoundToolSpec) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, param] of Object.entries(spec.parameters)) {
    properties[name] = { type: param.type, description: param.description };
    if (param.required !== false) required.push(name);
  }
  return {
    type: "function" as const,
    function: {
      name: spec.name,
      description: spec.description,
      parameters: { type: "object", properties, required },
    },
  };
}

// Initialise on module load
loadManifest().catch(() => {});

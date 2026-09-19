/**
 * Script generation and execution tools.
 * write_file: writes any text file to a safe workspace directory.
 * run_script: executes a whitelisted script (python, node, bash/cmd).
 *
 * The workspace dir is CARTER_WORKSPACE_DIR env var or ~/Documents/Carter.
 * Scripts run with a 60s timeout and stdout/stderr returned to the agent.
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import path from "node:path";

const exec = promisify(execFile);

export const WORKSPACE_DIR = process.env.CARTER_WORKSPACE_DIR
  ?? path.join(homedir(), "Documents", "Carter");

const ALLOWED_EXTENSIONS = new Set([
  ".py", ".js", ".ts", ".sh", ".cmd", ".bat", ".ps1",
  ".md", ".txt", ".json", ".yaml", ".yml", ".env", ".csv",
  ".html", ".css", ".sql",
]);

const ALLOWED_RUNNERS: Record<string, { cmd: string; args: (f: string) => string[] }> = {
  ".py":  { cmd: "python",  args: (f) => [f] },
  ".js":  { cmd: "node",    args: (f) => [f] },
  ".ts":  { cmd: "npx",     args: (f) => ["tsx", f] },
  ".sh":  { cmd: "bash",    args: (f) => [f] },
  ".cmd": { cmd: "cmd.exe", args: (f) => ["/c", f] },
  ".bat": { cmd: "cmd.exe", args: (f) => ["/c", f] },
  ".ps1": { cmd: "powershell.exe", args: (f) => ["-ExecutionPolicy", "Bypass", "-File", f] },
};

async function ensureWorkspace() {
  await mkdir(WORKSPACE_DIR, { recursive: true });
}

function safeName(name: string): string {
  // Strip directory traversal, keep only filename
  return path.basename(name).replace(/[^\w\-_.]/g, "_");
}

export async function writeScriptFile(filename: string, content: string): Promise<{ path: string; filename: string }> {
  await ensureWorkspace();
  const safe = safeName(filename);
  const ext  = path.extname(safe).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`File extension "${ext}" not allowed. Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`);
  }
  const filePath = path.join(WORKSPACE_DIR, safe);
  await writeFile(filePath, content, "utf-8");
  return { path: filePath, filename: safe };
}

export async function runScriptFile(
  filename: string,
  args: string[] = [],
  envVars: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  await ensureWorkspace();
  const safe = safeName(filename);
  const filePath = path.join(WORKSPACE_DIR, safe);
  if (!existsSync(filePath)) {
    throw new Error(`Script not found: ${safe}. Write it first with write_file.`);
  }
  const ext = path.extname(safe).toLowerCase();
  const runner = ALLOWED_RUNNERS[ext];
  if (!runner) throw new Error(`No runner for extension "${ext}". Supported: ${Object.keys(ALLOWED_RUNNERS).join(", ")}`);

  const env = { ...process.env, ...envVars } as Record<string, string>;
  try {
    const { stdout, stderr } = await exec(
      runner.cmd,
      [...runner.args(filePath), ...args],
      { timeout: 60_000, env, cwd: WORKSPACE_DIR, maxBuffer: 1024 * 1024 },
    );
    return { stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 1000), exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? "").slice(0, 4000),
      stderr: (err.stderr ?? err.message ?? "").slice(0, 1000),
      exitCode: err.code ?? 1,
    };
  }
}

export async function readScriptFile(filename: string): Promise<string> {
  const safe = safeName(filename);
  const filePath = path.join(WORKSPACE_DIR, safe);
  return readFile(filePath, "utf-8");
}

export async function appendEnvFile(vars: Record<string, string>): Promise<{ path: string }> {
  return upsertEnvFile(vars);
}

/**
 * Safe .env upsert — deduplicates keys, never corrupts existing entries.
 * Reads the current file, removes any lines matching the new keys, appends fresh.
 */
export async function upsertEnvFile(vars: Record<string, string>): Promise<{ path: string }> {
  await ensureWorkspace();
  const envPath = path.join(WORKSPACE_DIR, ".env");

  let existing = "";
  try { existing = await readFile(envPath, "utf-8"); } catch { /* new file */ }

  const newKeys = new Set(Object.keys(vars));
  // Keep lines that don't match any new key
  const kept = existing
    .split("\n")
    .filter(line => {
      const key = line.split("=")[0].trim().replace(/^export\s+/, "");
      return !newKeys.has(key);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // collapse blank lines
    .trimEnd();

  const newLines = Object.entries(vars)
    .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join("\n");

  const final = kept ? kept + "\n\n" + newLines + "\n" : newLines + "\n";
  await writeFile(envPath, final, "utf-8");
  return { path: envPath };
}

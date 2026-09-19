/**
 * OS control — strictly whitelisted subprocess commands.
 * Opens local files/URLs/applications using the OS default handler.
 * Whitelist: start (Windows), xdg-open (Linux), open (macOS).
 * Never executes arbitrary commands — only the open handler + a safe path.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";

const exec = promisify(execFile);

// Safe path characters — no shell metacharacters
const SAFE_PATH = /^[a-zA-Z0-9 _\-./\\:@#%+=,()[\]{}]+$/;

export async function osOpen(target: string): Promise<{ opened: boolean; target: string }> {
  if (!SAFE_PATH.test(target)) {
    throw new Error(`Unsafe characters in target: "${target}". Only alphanumeric paths allowed.`);
  }

  const cmd = process.platform === "win32"  ? "cmd.exe"
            : process.platform === "darwin" ? "open"
            : "xdg-open";

  const args = process.platform === "win32"
    ? ["/c", "start", "", target]
    : [target];

  try {
    await exec(cmd, args, { timeout: 10_000 });
    return { opened: true, target };
  } catch (err) {
    // `start` on Windows exits non-zero for some file types — check if it launched
    const msg = (err as Error).message ?? "";
    if (process.platform === "win32" && !msg.includes("cannot find")) {
      return { opened: true, target };
    }
    throw new Error(`Failed to open "${target}": ${msg}`);
  }
}

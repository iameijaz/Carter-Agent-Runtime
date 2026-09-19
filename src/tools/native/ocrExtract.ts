import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const VENV_PY = path.join(ROOT, "markitdown-venv", "Scripts", "python.exe");
const SCRIPT  = path.join(ROOT, "scripts", "ocr_extract.py");

export interface OcrResult {
  text: string;
  provider: string;
  confidence: number | null;
}

export function ocrExtract(imagePath: string, languageHint = "en"): Promise<OcrResult> {
  return new Promise((resolve, reject) => {
    if (!existsSync(VENV_PY)) {
      reject(new Error("Python venv not set up. Run scripts\\setup-python.cmd first."));
      return;
    }
    if (!existsSync(imagePath)) {
      reject(new Error(`Image not found: ${imagePath}`));
      return;
    }

    const child = spawn(VENV_PY, [SCRIPT, imagePath, languageHint]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", d => stdout.push(d));
    child.stderr.on("data", d => stderr.push(d));
    child.on("close", code => {
      const raw = Buffer.concat(stdout).toString("utf-8").trim();
      if (!raw) {
        reject(new Error(Buffer.concat(stderr).toString("utf-8").trim() || `ocr_extract exited ${code}`));
        return;
      }
      try {
        const result = JSON.parse(raw);
        if (result.error) reject(new Error(result.error));
        else resolve(result as OcrResult);
      } catch {
        reject(new Error(`Bad JSON from ocr_extract: ${raw.slice(0, 200)}`));
      }
    });
    child.on("error", reject);
  });
}

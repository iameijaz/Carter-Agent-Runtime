/**
 * PDF compilation — converts Markdown or LaTeX to PDF via Pandoc.
 * Falls back gracefully if Pandoc isn't installed.
 * Output files served via GET /api/files/:name.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = promisify(execFile);

const OUTPUT_DIR = process.env.CARTER_FILES_DIR ?? path.join(tmpdir(), "carter-files");

export type CompileFormat = "markdown" | "latex" | "html";

export interface CompileResult {
  filename: string;
  downloadUrl: string;
  provider: string;
  sizeBytes: number;
}

async function ensureOutputDir() {
  await mkdir(OUTPUT_DIR, { recursive: true });
}

async function pandocAvailable(): Promise<boolean> {
  try { await exec("pandoc", ["--version"], { timeout: 3000 }); return true; }
  catch { return false; }
}

export async function compilePdf(
  content: string,
  filename: string,
  format: CompileFormat = "markdown",
): Promise<CompileResult> {
  await ensureOutputDir();

  const slug = filename.replace(/[^a-zA-Z0-9_\-]/g, "_").replace(/\.pdf$/, "");
  const outPath = path.join(OUTPUT_DIR, `${slug}.pdf`);

  // Input extension
  const ext = format === "latex" ? "tex" : format === "html" ? "html" : "md";
  const inPath = path.join(OUTPUT_DIR, `${slug}_input.${ext}`);
  await writeFile(inPath, content, "utf-8");

  if (await pandocAvailable()) {
    const args = [
      inPath,
      "-o", outPath,
      "--pdf-engine=xelatex",
      "-V", "geometry:margin=2.5cm",
      "-V", "fontsize=11pt",
    ];
    if (format === "markdown") args.push("--from=markdown");
    if (format === "latex")   args.push("--from=latex");
    if (format === "html")    args.push("--from=html");

    try {
      await exec("pandoc", args, { timeout: 60_000 });
    } catch {
      // xelatex not available — try pdflatex fallback
      args[args.indexOf("xelatex")] = "pdflatex";
      await exec("pandoc", args, { timeout: 60_000 });
    }

    const { statSync } = await import("node:fs");
    const size = statSync(outPath).size;
    return {
      filename: `${slug}.pdf`,
      downloadUrl: `/api/files/${encodeURIComponent(slug + ".pdf")}`,
      provider: "pandoc",
      sizeBytes: size,
    };
  }

  throw new Error(
    "Pandoc not installed. Install with: winget install JohnMacFarlane.Pandoc\n" +
    "Or: choco install pandoc"
  );
}

export { OUTPUT_DIR };

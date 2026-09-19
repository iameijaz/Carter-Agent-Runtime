/**
 * Pure Node.js document extractors — zero Python, zero native compilation.
 * Used as Tier 3 fallback when the Python venv isn't set up.
 *
 * Supported:
 *   PDF  — pdf-parse
 *   PPTX, DOCX, XLSX, ODP, ODT, ODS — officeparser
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export async function pdfParseNode(filePath: string): Promise<{ text: string; pages: number; provider: string }> {
  const buffer = await readFile(filePath);
  const pdfParse = require("pdf-parse");
  const data = await pdfParse(buffer);
  return {
    text:     data.text?.trim() ?? "",
    pages:    data.numpages ?? 0,
    provider: "pdf-parse-node",
  };
}

export async function officeParseNode(filePath: string): Promise<{ text: string; pages: number | null; provider: string }> {
  const officeParser = require("officeparser");
  const text: string = await new Promise((resolve, reject) => {
    officeParser.parseOffice(filePath, (data: string, err: Error) => {
      if (err) reject(err);
      else resolve(data ?? "");
    });
  });
  return {
    text:     text.trim(),
    pages:    null,
    provider: "officeparser-node",
  };
}

const OFFICE_EXTS = new Set(["pptx","ppt","docx","doc","xlsx","xls","odp","odt","ods"]);

export async function parseDocumentNode(filePath: string): Promise<{ text: string; pages: number | null; provider: string }> {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return pdfParseNode(filePath);
  if (OFFICE_EXTS.has(ext)) return officeParseNode(filePath);
  // Plain text fallback
  const text = await readFile(filePath, "utf-8");
  return { text, pages: null, provider: "plaintext-node" };
}

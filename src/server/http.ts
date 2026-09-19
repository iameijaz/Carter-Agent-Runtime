import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleTranscribe } from "./transcribe.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readBody(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("Body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "POST" && url.pathname === "/api/transcribe") {
    await handleTranscribe(req, res);
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405).end("Method Not Allowed");
    return;
  }

  await serveStatic(url.pathname, res);
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_DIR, rel);

  // Path-traversal guard: resolved path must stay inside PUBLIC_DIR.
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(resolved);
    if (!info.isFile()) {
      res.writeHead(404).end("Not Found");
      return;
    }
  } catch {
    res.writeHead(404).end("Not Found");
    return;
  }

  const type = MIME[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  createReadStream(resolved).pipe(res);
}

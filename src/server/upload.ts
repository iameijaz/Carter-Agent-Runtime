import type { IncomingMessage, ServerResponse } from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const UPLOAD_DIR = process.env.CARTER_UPLOAD_DIR ?? path.join(tmpdir(), "carter-uploads");
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

// Allowed MIME types → file extensions
const ALLOWED: Record<string, string> = {
  "application/pdf":                                                          "pdf",
  "application/msword":                                                       "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":  "docx",
  "application/vnd.ms-excel":                                                 "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":        "xlsx",
  "application/vnd.ms-powerpoint":                                            "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":"pptx",
  "text/plain":                                                               "txt",
  "text/csv":                                                                 "csv",
  "text/markdown":                                                            "md",
  "image/png":                                                                "png",
  "image/jpeg":                                                               "jpg",
  "image/webp":                                                               "webp",
  "image/gif":                                                                "gif",
  "image/tiff":                                                               "tif",
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawMime = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const ext = ALLOWED[rawMime];
  if (!ext) {
    json(res, 415, { error: `Unsupported file type: ${rawMime}` });
    return;
  }

  // Read body with size cap
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_FILE_BYTES) {
        json(res, 413, { error: "File too large (max 100 MB)" });
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
  } catch (err) {
    json(res, 400, { error: `Failed to read upload: ${(err as Error).message}` });
    return;
  }

  const buffer = Buffer.concat(chunks);
  if (!buffer.length) {
    json(res, 400, { error: "Empty file" });
    return;
  }

  // Save to temp dir with a unique name
  await mkdir(UPLOAD_DIR, { recursive: true });
  const filename = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const filePath = path.join(UPLOAD_DIR, filename);
  await writeFile(filePath, buffer);

  // Return the original filename hint and the server-side path
  const originalName = decodeURIComponent(req.headers["x-filename"] as string ?? filename);
  json(res, 200, { path: filePath, filename: originalName, size: buffer.length, mime: rawMime });
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { runWaterfall } from "../retrieval/waterfall.js";
import { sttProviders } from "./stt.js";

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB
const STT_TIMEOUT_MS = 30_000;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/** POST /api/transcribe — raw audio body in, `{ text, provider }` out. */
export async function handleTranscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const mimeType = req.headers["content-type"] ?? "audio/webm";

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_AUDIO_BYTES) {
        json(res, 413, { error: "Audio too large (max 25 MB)" });
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
  } catch (err) {
    json(res, 400, { error: `Failed to read audio: ${(err as Error).message}` });
    return;
  }

  const buffer = Buffer.concat(chunks);
  if (buffer.length === 0) {
    json(res, 400, { error: "Empty audio body" });
    return;
  }

  try {
    const { provider, results } = await runWaterfall(
      sttProviders,
      { buffer, mimeType },
      { timeoutMs: STT_TIMEOUT_MS }
    );
    json(res, 200, { text: results[0], provider });
  } catch (err) {
    json(res, 500, { error: `Transcription failed: ${(err as Error).message}` });
  }
}

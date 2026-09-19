/**
 * Local model router — uses llama-server (llama.cpp) when available.
 *
 * llama-server exposes an OpenAI-compatible /v1/chat/completions endpoint.
 * We probe it at startup and on each turn; if it's down we fall back to cloud.
 *
 * GPU detection: nvidia-smi presence + llama-server /health response.
 * The same OpenAI SDK client works — just point baseURL at the local server.
 *
 * Start llama-server via: scripts/start-llama-server.cmd
 */

import OpenAI from "openai";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LLAMA_URL   = process.env.LLAMA_SERVER_URL   ?? "http://127.0.0.1:8080";
const LLAMA_MODEL = process.env.LLAMA_MODEL_NAME   ?? "local";  // name sent in requests
const PROBE_TTL_MS = 30_000; // re-probe every 30s

export interface LocalModelStatus {
  available: boolean;
  modelName: string | null;
  gpuLayers: number | null;
  lastChecked: number;
}

let _status: LocalModelStatus = {
  available: false,
  modelName: null,
  gpuLayers: null,
  lastChecked: 0,
};

/** Check if llama-server is running and responding. Cached for PROBE_TTL_MS. */
export async function probeLocalModel(): Promise<LocalModelStatus> {
  if (Date.now() - _status.lastChecked < PROBE_TTL_MS) return _status;

  try {
    const res = await fetch(`${LLAMA_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { status?: string; slots?: { n_gpu_layers?: number }[] };

    // /health returns { status: "ok" } when ready, "loading model" while loading
    if (data.status !== "ok") throw new Error(`not ready: ${data.status}`);

    const gpuLayers = data.slots?.[0]?.n_gpu_layers ?? null;

    // /props gives us the loaded model name
    let modelName = LLAMA_MODEL;
    try {
      const propsRes = await fetch(`${LLAMA_URL}/props`, { signal: AbortSignal.timeout(1000) });
      const props = await propsRes.json() as { default_generation_settings?: { model?: string } };
      modelName = props.default_generation_settings?.model ?? LLAMA_MODEL;
      // Strip path, keep filename without extension
      modelName = modelName.split(/[\\/]/).pop()?.replace(/\.(gguf|bin)$/i, "") ?? modelName;
    } catch { /* ignore, use env name */ }

    _status = { available: true, modelName, gpuLayers, lastChecked: Date.now() };
  } catch {
    _status = { available: false, modelName: null, gpuLayers: null, lastChecked: Date.now() };
  }
  return _status;
}

/** Detect NVIDIA GPU via nvidia-smi. Returns VRAM in MB or 0 if no GPU. */
export async function detectGpu(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-gpu=memory.total",
      "--format=csv,noheader,nounits",
    ], { timeout: 3000 });
    return Number(stdout.trim().split("\n")[0]) || 0;
  } catch {
    return 0;
  }
}

/** Build an OpenAI-compatible client pointing at llama-server. */
export function buildLocalClient(): OpenAI {
  return new OpenAI({
    apiKey: "local",          // llama-server ignores auth
    baseURL: `${LLAMA_URL}/v1`,
  });
}

/** Log GPU/local model status to console on boot. */
export async function logLocalModelStatus(): Promise<void> {
  const [gpu, status] = await Promise.all([detectGpu(), probeLocalModel()]);
  if (gpu > 0) {
    console.log(`[local] GPU detected: ${Math.round(gpu / 1024)}GB VRAM`);
  }
  if (status.available) {
    const gpuInfo = status.gpuLayers ? ` (${status.gpuLayers} GPU layers)` : " (CPU only)";
    console.log(`[local] llama-server ready: ${status.modelName}${gpuInfo}`);
  } else {
    console.log("[local] llama-server not available — using cloud models");
  }
}

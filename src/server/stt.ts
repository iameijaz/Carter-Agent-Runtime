import OpenAI, { toFile } from "openai";
import { config } from "../config.js";
import type { WaterfallProvider } from "../retrieval/waterfall.js";

/** Input to an STT provider: raw audio bytes plus their MIME type. */
export interface AudioInput {
  buffer: Buffer;
  mimeType: string;
}

/**
 * An STT provider returns `[transcript]` on success, or `[]` when it produced
 * no usable text (so the waterfall falls through to the next provider).
 */
export type SttProvider = WaterfallProvider<AudioInput, string>;

// Transcription is OpenAI-only; without that key this client is never reached
// (callers check config.openaiApiKey first).
const openaiClient = new OpenAI({ apiKey: config.openaiApiKey ?? "" });

/**
 * Deepgram Nova-3 via its REST API — no SDK, just a fetch with the raw audio
 * body. Only registered when DEEPGRAM_API_KEY is present.
 */
const deepgramStt: SttProvider = {
  name: "deepgram-nova-3",
  async run({ buffer, mimeType }) {
    const res = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true", {
      method: "POST",
      headers: {
        Authorization: `Token ${config.deepgramApiKey}`,
        "Content-Type": mimeType,
      },
      body: new Uint8Array(buffer),
    });
    if (!res.ok) {
      throw new Error(`Deepgram HTTP ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
    };
    const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? "";
    return transcript ? [transcript] : [];
  },
};

/** OpenAI transcription — always available (reuses OPENAI_API_KEY). */
const openaiStt: SttProvider = {
  name: "openai",
  async run({ buffer, mimeType }) {
    const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("wav") ? "wav" : "mp3";
    const file = await toFile(buffer, `audio.${ext}`, { type: mimeType });
    const r = await openaiClient.audio.transcriptions.create({
      file,
      model: config.transcribeModel,
    });
    const transcript = r.text?.trim() ?? "";
    return transcript ? [transcript] : [];
  },
};

/**
 * Local-first slot (Parakeet TDT / faster-whisper). Stubbed — implementing
 * this is a class swap, not a redesign. See docs/WhatsNext.md.
 */
const localStt: SttProvider = {
  name: "local",
  async run() {
    throw new Error("Local STT (Parakeet/faster-whisper) not implemented yet — see docs/WhatsNext.md");
  },
};

/**
 * STT fallback chain, highest-preference first. Deepgram is only in the chain
 * when its key is set; OpenAI is the always-on fallback; the local slot is a
 * stub that simply gets skipped (it throws) until implemented.
 */
export const sttProviders: SttProvider[] = [
  ...(config.deepgramApiKey ? [deepgramStt] : []),
  openaiStt,
  localStt,
];

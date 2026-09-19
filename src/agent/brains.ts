import OpenAI from "openai";
import { config } from "../config.js";

/** A reasoning backend: an OpenAI-compatible client plus its model id. */
export interface Brain {
  name: "gpt" | "grok";
  client: OpenAI;
  model: string;
}

// Named "gpt" for the router's benefit; it is whatever OpenAI-compatible
// provider config points at (OpenRouter by default).
const gpt: Brain = {
  name: "gpt",
  client: new OpenAI({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl }),
  model: config.llmModel,
};

// Grok only exists when its key is set (xAI is OpenAI-compatible — same SDK,
// different baseURL).
const grok: Brain | undefined = config.grokApiKey
  ? {
      name: "grok",
      client: new OpenAI({ apiKey: config.grokApiKey, baseURL: config.grokBaseUrl }),
      model: config.grokModel,
    }
  : undefined;

/**
 * Where a brain's tokens actually come from, for the HUD's provenance readout.
 * `name` ("gpt") is a router label and says nothing about the provider — the
 * same label serves OpenRouter, a local Ollama, or OpenAI depending only on
 * env. An operator needs to know which, because one of them costs money and
 * leaves the machine.
 */
export function brainOrigin(b: Brain): { model: string; via: string } {
  const host = b.client.baseURL ? new URL(b.client.baseURL).hostname : "api.openai.com";
  const local = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(host) || host.endsWith(".local");
  return { model: b.model, via: local ? "local" : host.replace(/^www\./, "") };
}

export const brains = {
  gpt,
  grok,
  /** Whether the router has a second brain to route/fall back to. */
  grokAvailable: Boolean(grok),
};

/**
 * Resolves a routing decision to a concrete Brain, falling back to GPT when
 * Grok is chosen but no key is configured.
 */
export function resolveBrain(name: "gpt" | "grok"): Brain {
  if (name === "grok" && grok) return grok;
  return gpt;
}

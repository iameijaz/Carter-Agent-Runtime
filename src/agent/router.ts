import { brains } from "./brains.js";

export interface RouteDecision {
  brain: "gpt" | "grok";
  reason: string;
}

/**
 * Signals that a query is about live human sentiment / social trends / public
 * opinion — the area where Grok (with its X/real-time data) genuinely beats
 * GPT. Kept as a fast keyword heuristic: instant, zero-cost, and transparent.
 * Swap `classify` for an LLM classifier later without touching the loop.
 */
const GROK_PATTERNS: RegExp[] = [
  /\b(what|how)\s+(do|are|did)\s+people\s+(think|feel|say|reac)/i,
  /\bpublic\s+(opinion|sentiment|reaction)/i,
  /\bsentiment\b/i,
  /\b(trending|going viral|viral|buzz)\b/i,
  /\b(on|from)\s+(twitter|x\.com|\bx\b)\b/i,
  /\bwhat('?s| is)\s+(everyone|the internet)\s+(saying|talking about)/i,
  /\breactions?\s+to\b/i,
  /\binternet\s+(culture|reaction)/i,
  /\bmemes?\b/i,
];

// Explicit per-turn model requests in natural language, e.g. "use grok",
// "try grok for this", "ask gpt", "switch to chatgpt".
const EXPLICIT_MODEL = /\b(?:use|try|ask|via|switch to|answer (?:with|using))\s+(grok|gpt|openai|chat\s?gpt)\b/i;

export function classify(userMessage: string): RouteDecision {
  // No Grok key → always GPT (routing is a no-op).
  if (!brains.grokAvailable) {
    return { brain: "gpt", reason: "grok not configured" };
  }

  const explicit = userMessage.match(EXPLICIT_MODEL);
  if (explicit) {
    const named = /grok/i.test(explicit[1]) ? "grok" : "gpt";
    return { brain: named, reason: "explicit request in message" };
  }

  for (const pattern of GROK_PATTERNS) {
    if (pattern.test(userMessage)) {
      return { brain: "grok", reason: "social/sentiment/trends query" };
    }
  }
  return { brain: "gpt", reason: "default (reasoning/coding/writing/research)" };
}

/**
 * Parses a `/model gpt|grok|auto` command. Returns the target ("auto" clears
 * any override) or null if the message isn't a model command.
 */
export function parseModelCommand(message: string): "gpt" | "grok" | "auto" | null {
  const m = message.trim().match(/^\/model\s+(gpt|grok|auto)\b/i);
  return m ? (m[1].toLowerCase() as "gpt" | "grok" | "auto") : null;
}

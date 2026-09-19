/**
 * Native memory tools for the main agent:
 *
 *   ingest_source(url_or_path) — Librarian: parse → distil → file in vault + graph.
 *   memory_recall(query)       — hybrid recall over stored atoms; flags thin results.
 *   memory_gap(topic)          — when recall is thin, queue a background research
 *                                task (web_search → ingest_source) to fill the gap.
 *   consolidate_now(scope)     — manual trigger for nightly/weekly (ops/testing).
 *
 * Registered in src/tools/index.ts. Handlers are plain async fns; the schemas
 * are exported so the ToolBox can advertise them.
 */

import type OpenAI from "openai";
import { ingest } from "./librarian.js";
import { hybridSearch } from "../retrieval/vectorSearch.js";
import { graphStats } from "./db.js";
import { nightly, weekly } from "./consolidate.js";
import { startBackgroundTask } from "../agent/backgroundRunner.js";
import type { ToolBox } from "../tools/index.js";
import type { Skill } from "../skills/loader.js";

export type MemoryToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * memory_gap needs a ToolBox + skills to spawn its research agent. The server
 * injects them at boot; until then the tool reports it isn't ready.
 */
let _deps: { toolBox: ToolBox; skills: Skill[] } | null = null;
export function wireMemoryTools(toolBox: ToolBox, skills: Skill[]) { _deps = { toolBox, skills }; }

export const memoryTools: Record<string, { schema: OpenAI.Chat.Completions.ChatCompletionTool; handler: MemoryToolHandler }> = {
  ingest_source: {
    schema: {
      type: "function",
      function: {
        name: "ingest_source",
        description:
          "Librarian: ingest a URL or local file path into long-term memory. Parses the source, " +
          "distils it to high-value semantic atoms, files a Markdown note in the vault, and updates " +
          "the knowledge graph. Use this to remember an article, paper, or document permanently.",
        parameters: {
          type: "object",
          properties: {
            url_or_path: { type: "string", description: "An http(s) URL or an absolute local file path." },
          },
          required: ["url_or_path"],
        },
      },
    },
    handler: async (args) => ingest(String(args.url_or_path)),
  },

  memory_recall: {
    schema: {
      type: "function",
      function: {
        name: "memory_recall",
        description:
          "Recall from long-term memory: hybrid keyword+semantic search over stored atoms and notes. " +
          "Returns the best-matching atoms with sources. If results are thin, consider memory_gap.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "What to recall." },
            limit: { type: "number", description: "Max atoms to return (default 8)." },
          },
          required: ["query"],
        },
      },
    },
    handler: async (args) => {
      const query = String(args.query);
      const limit = args.limit != null ? Number(args.limit) : 8;
      const hits = await hybridSearch(query, "notes", limit);
      const strong = hits.filter((h) => h.score >= 0.5);
      return {
        query,
        results: hits.map((h) => ({ atom: h.content, score: Number(h.score.toFixed(3)), source: safeSource(h.metadata) })),
        thin: strong.length < 2,
        hint: strong.length < 2 ? "Recall is thin — call memory_gap to research and ingest this topic." : undefined,
      };
    },
  },

  memory_gap: {
    schema: {
      type: "function",
      function: {
        name: "memory_gap",
        description:
          "Fill a gap in memory: queue a background research task that web-searches the topic and " +
          "ingests the best sources into long-term memory. Returns immediately with a task id; the " +
          "vault fills in the background. Use when memory_recall came back thin.",
        parameters: {
          type: "object",
          properties: {
            topic: { type: "string", description: "The topic/question to research and remember." },
          },
          required: ["topic"],
        },
      },
    },
    handler: async (args) => {
      const topic = String(args.topic);
      if (!_deps) return { queued: false, message: "Memory research not wired (server not fully booted)." };
      const instructions =
        `Research the topic thoroughly to fill a gap in long-term memory.\n` +
        `1. Call web_search for "${topic}" (and refined follow-up queries).\n` +
        `2. Pick the 1-3 most authoritative result URLs.\n` +
        `3. Call ingest_source on EACH chosen URL to store it permanently.\n` +
        `Stop once the best sources are ingested. Report which URLs you ingested.`;
      const taskId = await startBackgroundTask(`Fill memory gap: ${topic}`, instructions, _deps.toolBox, _deps.skills);
      return { queued: true, taskId, topic, message: "Researching in the background; the vault will fill shortly." };
    },
  },

  consolidate_now: {
    schema: {
      type: "function",
      function: {
        name: "consolidate_now",
        description:
          "Manually run memory consolidation now (normally automatic overnight). scope 'nightly' " +
          "purges the 48h buffer and resolves conflicts; 'weekly' also folds old notes into a synthesis.",
        parameters: {
          type: "object",
          properties: {
            scope: { type: "string", enum: ["nightly", "weekly"], description: "Which pass to run. Default 'nightly'." },
          },
        },
      },
    },
    handler: async (args) => {
      const scope = args.scope === "weekly" ? "weekly" : "nightly";
      const night = await nightly();
      if (scope === "weekly") {
        const week = await weekly();
        return { scope, ...night, ...week, stats: await graphStats() };
      }
      return { scope, ...night, stats: await graphStats() };
    },
  },
};

function safeSource(metadata?: string): string | undefined {
  if (!metadata) return undefined;
  try { return (JSON.parse(metadata) as { source?: string }).source; } catch { return undefined; }
}

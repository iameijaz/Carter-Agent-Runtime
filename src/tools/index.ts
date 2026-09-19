import type OpenAI from "openai";
import { McpRegistry } from "../mcp/registry.js";
import { ddgSearch } from "./native/webSearch.js";
import { scrapeStaged } from "../retrieval/scrape.js";
import { runWaterfall, type SearchProvider } from "../retrieval/waterfall.js";
import type { SearchResult } from "./native/webSearch.js";
import { requestApproval } from "../agent/hudBus.js";
import { apiFetch } from "./native/apiFetch.js";
import { getWeather } from "./native/weather.js";
import { trainJourneys } from "./native/trains.js";
import { emailFetch, emailSearch, emailSend, emailFolders } from "./native/email.js";
import { librarySearch, libraryCheckAvailability } from "./native/libraryCatalog.js";
import { memoryTools } from "../memory/tools.js";
import { rememberPreference, forgetPreference, getPreferences } from "../prefs/store.js";
import { startBackgroundTask } from "../agent/backgroundRunner.js";
import type { Skill } from "../skills/loader.js";
import { searchNpmMcp, installMcpServer, createSkill } from "../agent/selfExtend.js";
import { addLesson, lessonsForPrompt } from "../memory/mistakes.js";
import { AgentLoop } from "../agent/loop.js";

/** delegate_capability_fix needs a ToolBox + skills to spawn its fixer agent.
 *  Injected at boot (see bootstrap.ts); until then the tool reports not ready. */
let _deps: { toolBox: ToolBox; skills: Skill[] } | null = null;
export function wireNativeTools(toolBox: ToolBox, skills: Skill[]) { _deps = { toolBox, skills }; }

const searchProviders: SearchProvider<SearchResult>[] = [
  { name: "duckduckgo", run: (q) => ddgSearch(q) },
  // Future slots (see docs/WhatsNext.md): SearXNG (self-hosted, primary),
  // Brave Search API (paid fallback). Add providers here in priority order.
];

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const nativeTools: Record<string, { schema: OpenAI.Chat.Completions.ChatCompletionTool; handler: ToolHandler }> = {
  web_search: {
    schema: {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web and return top results (title, url, snippet).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
          },
          required: ["query"],
        },
      },
    },
    handler: async (args) => {
      const { provider, results } = await runWaterfall(searchProviders, args.query as string);
      return { provider, results };
    },
  },
  web_fetch: {
    schema: {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch a URL and extract its main readable text content.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch" },
          },
          required: ["url"],
        },
      },
    },
    handler: async (args) => scrapeStaged(args.url as string),
  },
  api_fetch: {
    schema: {
      type: "function",
      function: {
        name: "api_fetch",
        description:
          "HTTP GET a JSON/text API and return the raw body (parsed if JSON). Use this for real data " +
          "from keyless APIs (wttr.in, open-meteo.com, frankfurter.app, api.coingecko.com …). " +
          "Unlike web_fetch, it does NOT strip the response — use it whenever you need actual numbers.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Full http(s) URL of the API endpoint." },
            headers: { type: "object", description: "Optional extra request headers." },
            max_bytes: { type: "number", description: "Max body bytes to read (default 65536, cap 262144)." },
          },
          required: ["url"],
        },
      },
    },
    handler: async (args) =>
      apiFetch(
        String(args.url),
        (args.headers as Record<string, string>) ?? {},
        args.max_bytes != null ? Number(args.max_bytes) : undefined,
      ),
  },
  get_weather: {
    schema: {
      type: "function",
      function: {
        name: "get_weather",
        description: "Current conditions + 3-day forecast for a location (wttr.in, no API key needed).",
        parameters: {
          type: "object",
          properties: { location: { type: "string", description: "City or place name, e.g. 'Mannheim'." } },
          required: ["location"],
        },
      },
    },
    handler: async (args) => getWeather(String(args.location)),
  },
  train_journeys: {
    schema: {
      type: "function",
      function: {
        name: "train_journeys",
        description:
          "Live train / public-transport connections (Deutsche Bahn + regional operators) between two " +
          "places, with real departure and arrival times, platforms and changes. Omit `when` to get " +
          "departures from right now. Use this for ANY train or travel-time question — never tell the " +
          "user to go look it up on bahn.de themselves.",
        parameters: {
          type: "object",
          properties: {
            from: { type: "string", description: "Origin station or city, e.g. 'Mannheim Hbf'." },
            to: { type: "string", description: "Destination station or city, e.g. 'Chemnitz'." },
            when: { type: "string", description: "ISO departure time. Omit for 'now'." },
            results: { type: "number", description: "How many connections (default 4, max 6)." },
          },
          required: ["from", "to"],
        },
      },
    },
    handler: async (args) => {
      const data = await trainJourneys(
        String(args.from),
        String(args.to),
        args.when != null ? String(args.when) : undefined,
        args.results != null ? Number(args.results) : 4,
      );
      return data;
    },
  },

  // ── Mailbox + library catalogue (both configured in .env) ─────────────────
  email_fetch: {
    schema: {
      type: "function",
      function: {
        name: "email_fetch",
        description: "Read the user's mailbox — most recent messages in a folder.",
        parameters: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Mailbox folder. Default INBOX." },
            limit: { type: "number", description: "How many messages. Default 10." },
            unread_only: { type: "boolean", description: "Only unread messages. Default false." },
          },
        },
      },
    },
    handler: async (args) =>
      emailFetch(
        args.folder != null ? String(args.folder) : "INBOX",
        args.limit != null ? Number(args.limit) : 10,
        args.unread_only === true,
      ),
  },
  email_search: {
    schema: {
      type: "function",
      function: {
        name: "email_search",
        description: "Search the user's mailbox.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search text (subject/from/body)." },
            limit: { type: "number", description: "Max results. Default 10." },
          },
          required: ["query"],
        },
      },
    },
    handler: async (args) =>
      emailSearch(String(args.query), args.limit != null ? Number(args.limit) : 10),
  },
  email_folders: {
    schema: {
      type: "function",
      function: {
        name: "email_folders",
        description: "List folders in the user's mailbox.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: async () => emailFolders(),
  },
  email_send: {
    schema: {
      type: "function",
      function: {
        name: "email_send",
        description: "Send an email from the user's configured account. Requires operator approval.",
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "Recipient address." },
            subject: { type: "string", description: "Subject line." },
            body: { type: "string", description: "Plain-text body." },
          },
          required: ["to", "subject", "body"],
        },
      },
    },
    handler: async (args) => {
      const to = String(args.to), subject = String(args.subject), body = String(args.body);
      // Sending mail is irreversible and outward-facing — always ask the operator first.
      const { approved, editedCode } = await requestApproval(
        `mail_${Date.now().toString(36)}`,
        `Send email to ${to} — subject: "${subject}". Edit the body below if needed, then approve.`,
        body,
        "trusted",
      );
      if (!approved) return { sent: false, message: "Operator declined; nothing was sent." };
      return emailSend(to, subject, editedCode ?? body);
    },
  },
  library_search: {
    schema: {
      type: "function",
      function: {
        name: "library_search",
        description: "Search the configured library catalogue.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Title, author or keyword." },
            limit: { type: "number", description: "Max results. Default 10." },
            only_available: { type: "boolean", description: "Only currently-available items." },
          },
          required: ["query"],
        },
      },
    },
    handler: async (args) =>
      librarySearch(
        String(args.query),
        args.limit != null ? Number(args.limit) : 10,
        args.only_available === true,
      ),
  },
  library_check_availability: {
    schema: {
      type: "function",
      function: {
        name: "library_check_availability",
        description: "Check whether a specific book is available in the configured library.",
        parameters: {
          type: "object",
          properties: { title: { type: "string", description: "Book title." } },
          required: ["title"],
        },
      },
    },
    handler: async (args) => libraryCheckAvailability(String(args.title)),
  },

  remember_preference: {
    schema: {
      type: "function",
      function: {
        name: "remember_preference",
        description:
          "Persist a durable user preference so you apply it automatically next time " +
          "without asking. E.g. topic 'song lyrics' source 'genius.com'; or topic 'trains' " +
          "approach 'assume Deutschland-Ticket regional connections, depart now unless a time is given'.",
        parameters: {
          type: "object",
          properties: {
            topic: { type: "string", description: "What the preference is about." },
            source: { type: "string", description: "Preferred source/site, if any." },
            approach: { type: "string", description: "Free-text instruction for how to handle it." },
            notes: { type: "string" },
          },
          required: ["topic"],
        },
      },
    },
    handler: async (args) => {
      await rememberPreference({
        topic: String(args.topic),
        source: args.source ? String(args.source) : undefined,
        approach: args.approach ? String(args.approach) : undefined,
        notes: args.notes ? String(args.notes) : undefined,
      });
      return { ok: true, preferences: await getPreferences() };
    },
  },

  forget_preference: {
    schema: {
      type: "function",
      function: {
        name: "forget_preference",
        description: "Remove a stored user preference by topic.",
        parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
      },
    },
    handler: async (args) => ({ removed: await forgetPreference(String(args.topic)) }),
  },

  delegate_capability_fix: {
    schema: {
      type: "function",
      function: {
        name: "delegate_capability_fix",
        description:
          "When you cannot fully answer because a capability, tool or data source is " +
          "missing, delegate the fix to a background agent instead of apologizing. Give " +
          "the missing capability, a goal, and a concrete ordered todo list. " +
          "The fixer works the list top-to-bottom (it can self-extend). " +
          "After calling this, tell the user in one line that it's being built and present the " +
          "best interim answer.",
        parameters: {
          type: "object",
          properties: {
            missing: { type: "string", description: "What is missing or what broke." },
            goal: { type: "string", description: "What 'fixed' looks like." },
            todo: { type: "array", items: { type: "string" }, description: "Ordered steps to close the gap." },
          },
          required: ["missing", "goal", "todo"],
        },
      },
    },
    handler: async (args) => {
      if (!_deps) return { error: "background runner not wired yet" };
      const todo = Array.isArray(args.todo) ? args.todo.map(String) : [];
      const instructions =
        `Missing capability: ${args.missing}\n\n` +
        `Work this todo list top-to-bottom. You may self-extend (install new MCP ` +
        `servers) to close gaps:\n` +
        todo.map((t, i) => `${i + 1}. ${t}`).join("\n");
      const taskId = await startBackgroundTask(String(args.goal), instructions, _deps.toolBox, _deps.skills);
      return { taskId, status: "delegated", todo };
    },
  },

  // ── Self-extension: find, install, and activate new capabilities live ─────
  search_extensions: {
    schema: {
      type: "function",
      function: {
        name: "search_extensions",
        description:
          "Search the npm registry for MCP servers that could close a capability gap " +
          "(e.g. 'image resize', 'postgres', 'github'). Returns candidate packages. " +
          "Pick the best one and call install_mcp_server — never tell the user a " +
          "capability is missing without searching first.",
        parameters: {
          type: "object",
          properties: {
            capability: { type: "string", description: "What you need to be able to do." },
          },
          required: ["capability"],
        },
      },
    },
    handler: async (args) => ({ candidates: await searchNpmMcp(String(args.capability)) }),
  },

  install_mcp_server: {
    schema: {
      type: "function",
      function: {
        name: "install_mcp_server",
        description:
          "Install an MCP server from npm and hot-connect it — its tools become available " +
          "THIS conversation, no restart. The config is persisted to mcp_servers.json. " +
          "Requires operator approval. If the operator declines, never propose that same " +
          "package again (a lesson is recorded automatically).",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Short server alias, e.g. 'image-tools'." },
            package: { type: "string", description: "Exact npm package name." },
            args: { type: "array", items: { type: "string" }, description: "Extra CLI args after the package." },
            env: { type: "object", description: "Env vars the server needs (values may use ${VAR})." },
          },
          required: ["name", "package"],
        },
      },
    },
    handler: async (args) => {
      if (!_deps) return { error: "toolbox not wired yet" };
      const pkg = String(args.package);
      const alias = String(args.name);
      const { approved } = await requestApproval(
        `mcp_${Date.now().toString(36)}`,
        `Install MCP server "${alias}" (npm package: ${pkg})? Its tools become available immediately.`,
        JSON.stringify({ name: alias, package: pkg, args: args.args ?? [], env: args.env ?? {} }, null, 2),
        "trusted",
      );
      if (!approved) {
        await addLesson(
          "install_mcp_server", `proposed installing ${pkg}`,
          `operator declined install of ${pkg}`,
          `Do not propose installing "${pkg}" again; find another way or ask what they prefer.`,
        );
        return { installed: false, message: "Operator declined; lesson recorded — will not propose this package again." };
      }
      const result = await installMcpServer(
        alias, pkg,
        Array.isArray(args.args) ? args.args.map(String) : [],
        (args.env as Record<string, string>) ?? {},
        _deps.toolBox.mcp,
      );
      return result;
    },
  },

  create_skill: {
    schema: {
      type: "function",
      function: {
        name: "create_skill",
        description:
          "Write a new reusable skill (SKILL.md) and load it live. Use when you've worked out " +
          "a repeatable procedure worth keeping — next time a message matches a trigger, the " +
          "skill body is injected automatically.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "kebab-case skill name." },
            description: { type: "string", description: "One line: what the skill does." },
            triggers: { type: "array", items: { type: "string" }, description: "Words/phrases that should activate it." },
            body: { type: "string", description: "Markdown instructions for future runs." },
          },
          required: ["name", "description", "triggers", "body"],
        },
      },
    },
    handler: async (args) => {
      if (!_deps) return { error: "toolbox not wired yet" };
      return createSkill(
        String(args.name), String(args.description),
        Array.isArray(args.triggers) ? args.triggers.map(String) : [],
        String(args.body), _deps.toolBox,
      );
    },
  },

  record_lesson: {
    schema: {
      type: "function",
      function: {
        name: "record_lesson",
        description:
          "Permanently record a mistake + its fix so it is NEVER repeated (it is injected into " +
          "your system prompt from now on). Call this whenever the user corrects you ('no, do Y', " +
          "'that's wrong, use X') or you discover the right way after a wrong attempt. Set " +
          "supersede_history true when the correction invalidates older lessons about the same tool.",
        parameters: {
          type: "object",
          properties: {
            tool: { type: "string", description: "Tool or area the lesson is about (e.g. 'train_journeys', 'general')." },
            situation: { type: "string", description: "When this applies." },
            mistake: { type: "string", description: "What went wrong / what not to do." },
            fix: { type: "string", description: "What to do instead." },
            supersede_history: { type: "boolean", description: "Replace all older lessons for this tool. Default false." },
          },
          required: ["tool", "situation", "mistake", "fix"],
        },
      },
    },
    handler: async (args) => {
      const id = await addLesson(
        String(args.tool), String(args.situation), String(args.mistake), String(args.fix),
        args.supersede_history === true,
      );
      return { recorded: true, lessonId: id };
    },
  },

  dispatch_agents: {
    schema: {
      type: "function",
      function: {
        name: "dispatch_agents",
        description:
          "Split a task that is too big for one pass across parallel sub-agents and wait for their " +
          "merged results. Each sub-agent gets its own brief and full tool access. Use ONLY when a " +
          "task has 2+ genuinely independent parts (e.g. research three topics, or fetch data + " +
          "build a report + check schedules). For a single long-running job use " +
          "delegate_capability_fix / background tasks instead.",
        parameters: {
          type: "object",
          properties: {
            tasks: {
              type: "array",
              description: "One entry per sub-agent (2-5).",
              items: {
                type: "object",
                properties: {
                  goal: { type: "string", description: "What this sub-agent must deliver." },
                  instructions: { type: "string", description: "Concrete steps / constraints." },
                },
                required: ["goal"],
              },
            },
          },
          required: ["tasks"],
        },
      },
    },
    handler: async (args) => {
      if (!_deps) return { error: "toolbox not wired yet" };
      const specs = (Array.isArray(args.tasks) ? args.tasks : []) as Array<{ goal?: unknown; instructions?: unknown }>;
      const tasks = specs
        .map((t) => ({ goal: String(t.goal ?? ""), instructions: t.instructions ? String(t.instructions) : "" }))
        .filter((t) => t.goal)
        .slice(0, 5);
      if (tasks.length < 2) return { error: "dispatch_agents needs 2+ tasks; do a single task yourself." };

      const lessons = await lessonsForPrompt();
      // ponytail: sub-agents run in-process sharing the ToolBox; separate
      // processes/chips only if isolation ever matters.
      const results = await Promise.all(tasks.map(async (t, i) => {
        const prompt =
          `You are a focused sub-agent (worker ${i + 1}/${tasks.length}). Deliver exactly this goal, ` +
          `then answer with a concise result the orchestrator can merge:\n\nGOAL: ${t.goal}` +
          (t.instructions ? `\n\nINSTRUCTIONS:\n${t.instructions}` : "") +
          `\n\nReturn findings as text.${lessons}`;
        const agent = new AgentLoop(_deps!.toolBox, _deps!.skills, prompt);
        try {
          const answer = await agent.send(t.goal, { maxRounds: 8 });
          return { goal: t.goal, ok: true, result: answer };
        } catch (err) {
          return { goal: t.goal, ok: false, error: (err as Error).message };
        }
      }));
      return { results, note: "Merge these into one answer for the user." };
    },
  },

  ...memoryTools,
};

export class ToolBox {
  /** Live skill set — create_skill hot-swaps it; AgentLoop reads it each turn. */
  skills: Skill[] = [];
  /** Tool schemas cached against the MCP registry version (native ones are static). */
  private toolCache: { version: number; tools: OpenAI.Chat.Completions.ChatCompletionTool[] } | null = null;

  constructor(public mcp: McpRegistry) {}

  async getOpenAiTools(): Promise<OpenAI.Chat.Completions.ChatCompletionTool[]> {
    if (this.toolCache && this.toolCache.version === this.mcp.version) {
      return this.toolCache.tools;
    }
    const mcpTools = await this.mcp.getAllTools();
    const mcpSchemas: OpenAI.Chat.Completions.ChatCompletionTool[] = mcpTools.map((t) => ({
      type: "function",
      function: {
        name: `mcp__${t.serverName}__${t.name}`,
        description: t.description ?? `MCP tool ${t.name} from ${t.serverName}`,
        parameters: t.inputSchema as OpenAI.FunctionParameters,
      },
    }));
    let tools = [...Object.values(nativeTools).map((t) => t.schema), ...mcpSchemas];
    // OpenAI rejects >128 tools per request. Natives come first; MCP tools are
    // trimmed in reverse registry order (later servers lose out first).
    // ponytail: dumb truncation — score tools by usage if the cap ever hurts.
    const MAX_TOOLS = 128;
    if (tools.length > MAX_TOOLS) {
      console.warn(`[tools] ${tools.length} tools exceeds the OpenAI limit of ${MAX_TOOLS} — trimming ${tools.length - MAX_TOOLS} MCP tool(s)`);
      tools = tools.slice(0, MAX_TOOLS);
    }
    this.toolCache = { version: this.mcp.version, tools };
    return tools;
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (nativeTools[name]) {
      return nativeTools[name].handler(args);
    }
    const mcpMatch = name.match(/^mcp__(.+?)__(.+)$/);
    if (mcpMatch) {
      const [, serverName, toolName] = mcpMatch;
      return this.mcp.callTool(serverName, toolName, args);
    }
    throw new Error(`Unknown tool: ${name}`);
  }
}

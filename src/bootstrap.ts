import path from "node:path";
import { McpRegistry } from "./mcp/registry.js";
import { loadSkills, type Skill } from "./skills/loader.js";
import { ToolBox, wireNativeTools } from "./tools/index.js";
import { wireMemoryTools } from "./memory/tools.js";
import { AgentLoop } from "./agent/loop.js";

/**
 * The shared Carter core, independent of any client (CLI, web server, …).
 * `createAgent()` mints a fresh conversation: the CLI makes one, the web
 * server makes one per session — all backed by the same MCP tools and skills.
 */
export interface CarterCore {
  mcp: McpRegistry;
  toolBox: ToolBox;
  skills: Skill[];
  /** `systemPrompt` overrides the default — used by background workers (repairs). */
  createAgent(systemPrompt?: string): AgentLoop;
}

/**
 * Boots the expensive, shared singletons once: connects MCP servers and loads
 * skills. `rootDir` is the project root (where mcp_servers.json and skills/
 * live).
 */
export async function bootstrap(rootDir: string): Promise<CarterCore> {
  const mcp = new McpRegistry();
  await mcp.loadFromFile(path.join(rootDir, "mcp_servers.json"));

  const skills = await loadSkills(path.join(rootDir, "skills"));
  console.log(`[skills] loaded ${skills.length} skill(s)`);

  const toolBox = new ToolBox(mcp);
  toolBox.skills = skills; // live skill set — create_skill hot-swaps this
  // Inject deps into tools that spawn background agents (delegate_capability_fix,
  // memory_gap) — both need a ToolBox + skills, only available here at boot.
  wireNativeTools(toolBox, skills);
  wireMemoryTools(toolBox, skills);

  return {
    mcp,
    toolBox,
    skills,
    createAgent: (systemPrompt?: string) => new AgentLoop(toolBox, skills, systemPrompt),
  };
}

/**
 * Self-extension system — Carter can find, install, and activate new MCP
 * servers and skills at runtime when it hits a capability gap.
 *
 * Three actions:
 *   search_extensions  — search npm for MCP servers matching a capability
 *   install_mcp_server — install an MCP server package and hot-connect it
 *   create_skill       — write a new SKILL.md to skills/ and reload
 */

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpRegistry } from "../mcp/registry.js";
import { loadSkills } from "../skills/loader.js";
import type { ToolBox } from "../tools/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = path.resolve(__dirname, "../..");

export interface NpmPackageResult {
  name: string;
  description: string;
  version: string;
  keywords: string[];
  links: { npm: string };
}

/** Search npm registry for MCP server packages matching a query. */
export async function searchNpmMcp(query: string, limit = 8): Promise<NpmPackageResult[]> {
  const q = encodeURIComponent(`${query} mcp server`);
  const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${q}&size=${limit}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`npm search HTTP ${res.status}`);
  const data = await res.json() as { objects: Array<{ package: NpmPackageResult }> };
  // Filter to likely MCP packages
  return data.objects
    .map(o => o.package)
    .filter(p =>
      p.name.includes("mcp") ||
      p.keywords?.some(k => ["mcp", "model-context-protocol", "claude", "tool-server"].includes(k))
    );
}

/** Verify a package exists on npm and return its metadata. */
export async function verifyNpmPackage(pkgName: string): Promise<{ exists: boolean; description?: string; version?: string }> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { exists: false };
    const data = await res.json() as { description?: string; version?: string };
    return { exists: true, description: data.description, version: data.version };
  } catch {
    return { exists: false };
  }
}

/** Install an MCP server and hot-connect it to the running Carter instance. */
export async function installMcpServer(
  name: string,
  packageName: string,
  args: string[],
  envVars: Record<string, string>,
  mcp: McpRegistry,
): Promise<{ success: boolean; toolsAdded: string[]; message: string }> {
  // Verify package exists first
  const check = await verifyNpmPackage(packageName);
  if (!check.exists) {
    throw new Error(`Package "${packageName}" not found on npm. Check the name and try again.`);
  }

  // Don't reinstall if already connected
  const connected = mcp.getConnectedServers();
  if (connected.find(s => s.name === name)) {
    const allTools = await mcp.getAllTools();
    const existingTools = allTools.filter(t => t.serverName === name).map(t => `mcp__${name}__${t.name}`);
    return { success: true, toolsAdded: existingTools, message: `"${name}" is already connected with ${existingTools.length} tools. No restart needed.` };
  }

  const cfg = {
    name,
    command: "npx",
    args: ["-y", packageName, ...args],
    env: envVars,
  };

  const { connected: didConnect, newTools } = await mcp.installAndConnect(cfg);

  if (!didConnect) {
    throw new Error(`MCP server "${name}" installed but failed to connect. Check logs for details.`);
  }

  return {
    success: true,
    toolsAdded: newTools,
    message: newTools.length > 0
      ? `✅ "${name}" is now live. ${newTools.length} new tools available this turn:\n${newTools.map(t => `  • ${t}`).join("\n")}`
      : `✅ "${name}" connected. Call list_tools to see available tools.`,
  };
}

/** Write a new SKILL.md and reload skills in the ToolBox. */
export async function createSkill(
  skillName: string,
  description: string,
  triggers: string[],
  body: string,
  toolBox: ToolBox,
): Promise<{ success: boolean; path: string }> {
  const skillDir = path.join(ROOT_DIR, "skills", skillName);
  await mkdir(skillDir, { recursive: true });

  const skillPath = path.join(skillDir, "SKILL.md");
  const content = `---
name: ${skillName}
description: ${description}
triggers:
${triggers.map(t => `  - "${t}"`).join("\n")}
---

${body}
`;
  await writeFile(skillPath, content, "utf-8");

  // Reload skills into the live ToolBox
  const freshSkills = await loadSkills(path.join(ROOT_DIR, "skills"));
  toolBox.skills = freshSkills;
  console.log(`[extend] skill "${skillName}" created and loaded (${freshSkills.length} total skills)`);

  return { success: true, path: skillPath };
}

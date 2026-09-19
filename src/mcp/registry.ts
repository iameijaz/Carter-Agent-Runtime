import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  lazy?: boolean;
}

/** Expand ${VAR} from process.env. Returns null if a referenced var is missing/empty. */
function expandVars(value: string): string | null {
  let missing: string | null = null;
  const out = value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (!v) missing = name;
    return v ?? "";
  });
  return missing ? null : out;
}

export interface McpTool {
  serverName: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface ConnectedServer {
  config: McpServerConfig;
  client: Client;
}

export class McpRegistry {
  private servers: ConnectedServer[] = [];
  private registryPath: string | null = null;
  /** Bumped whenever the connected-server set changes — ToolBox caches schemas against it. */
  version = 0;

  async loadFromFile(path: string): Promise<void> {
    this.registryPath = path;
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      console.warn(`[mcp] no registry file at ${path}, starting with zero MCP servers`);
      return;
    }
    const configs: McpServerConfig[] = JSON.parse(raw);
    // Eager servers block startup; lazy ones connect in the background, staggered.
    for (const cfg of configs.filter((c) => !c.lazy)) {
      await this.connect(cfg);
    }
    const lazies = configs.filter((c) => c.lazy);
    void Promise.allSettled(
      lazies.map(
        (cfg, i) => new Promise<void>((res) => setTimeout(() => this.connect(cfg).then(() => res()), i * 500)),
      ),
    );
  }

  private async connect(cfg: McpServerConfig): Promise<boolean> {
    // Expand ${VAR} references in env values and args from process.env.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.env ?? {})) {
      const expanded = expandVars(v);
      if (expanded === null) {
        console.warn(`[mcp] skipping "${cfg.name}": env ${k} references an unset variable`);
        return false;
      }
      env[k] = expanded;
    }
    const args: string[] = [];
    for (const a of cfg.args ?? []) {
      const expanded = expandVars(a);
      if (expanded === null) {
        console.warn(`[mcp] skipping "${cfg.name}": arg "${a}" references an unset variable`);
        return false;
      }
      args.push(expanded);
    }
    const transport = new StdioClientTransport({
      command: cfg.command,
      args,
      env: { ...process.env, ...env } as Record<string, string>,
    });
    const client = new Client({ name: "carter", version: "0.1.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      this.servers.push({ config: cfg, client });
      this.version++;
      console.log(`[mcp] connected: ${cfg.name}`);
      return true;
    } catch (err) {
      console.error(`[mcp] failed to connect "${cfg.name}":`, (err as Error).message);
      return false;
    }
  }

  getConnectedServers(): McpServerConfig[] {
    return this.servers.map((s) => s.config);
  }

  /**
   * Hot-install: connect a new server NOW (npx fetches the package on first
   * spawn) and persist its config to mcp_servers.json so it survives restarts.
   * Returns the namespaced tool names it brought.
   */
  async installAndConnect(cfg: McpServerConfig): Promise<{ connected: boolean; newTools: string[] }> {
    const connected = await this.connect(cfg);
    if (!connected) return { connected: false, newTools: [] };

    if (this.registryPath) {
      try {
        let configs: McpServerConfig[] = [];
        try {
          configs = JSON.parse(await readFile(this.registryPath, "utf-8"));
        } catch { /* missing/corrupt file — start fresh */ }
        if (!configs.some((c) => c.name === cfg.name)) {
          // Persist as lazy so a broken package can never block future startups.
          configs.push({ ...cfg, lazy: true });
          await writeFile(this.registryPath, JSON.stringify(configs, null, 2) + "\n", "utf-8");
        }
      } catch (err) {
        console.warn(`[mcp] connected "${cfg.name}" but could not persist config:`, (err as Error).message);
      }
    }

    const tools = await this.getAllTools();
    return {
      connected: true,
      newTools: tools.filter((t) => t.serverName === cfg.name).map((t) => `mcp__${cfg.name}__${t.name}`),
    };
  }

  async getAllTools(): Promise<McpTool[]> {
    const all: McpTool[] = [];
    for (const server of this.servers) {
      let tools;
      try {
        ({ tools } = await server.client.listTools());
      } catch (err) {
        console.warn(`[mcp] listTools failed for "${server.config.name}":`, (err as Error).message);
        continue;
      }
      for (const tool of tools) {
        all.push({
          serverName: server.config.name,
          name: tool.name,
          description: tool.description,
          inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        });
      }
    }
    return all;
  }

  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const server = this.servers.find((s) => s.config.name === serverName);
    if (!server) throw new Error(`Unknown MCP server: ${serverName}`);
    const result = await server.client.callTool({ name: toolName, arguments: args });
    return result.content;
  }

  async closeAll(): Promise<void> {
    await Promise.all(this.servers.map((s) => s.client.close()));
  }
}

import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap } from "./bootstrap.js";
import type { AgentEvent } from "./agent/events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

/** Renders agent events to the terminal: stream tokens inline, flag tools. */
function cliRenderer(): (ev: AgentEvent) => void {
  let streaming = false;
  return (ev) => {
    switch (ev.type) {
      case "token":
        process.stdout.write(ev.text);
        streaming = true;
        break;
      case "tool_call_started":
        if (streaming) {
          process.stdout.write("\n");
          streaming = false;
        }
        process.stdout.write(`[tool] ${ev.name} …\n`);
        break;
      case "tool_call_finished":
        process.stdout.write(`[tool] ${ev.name} ${ev.ok ? "✓" : "✗"}\n`);
        break;
      case "assistant_message":
        // Newline to close out the streamed line.
        process.stdout.write("\n");
        streaming = false;
        break;
      case "run_cancelled":
        process.stdout.write("\n(cancelled)\n");
        streaming = false;
        break;
      case "error":
        process.stdout.write(`\n[error] ${ev.message}\n`);
        streaming = false;
        break;
    }
  };
}

async function main() {
  const core = await bootstrap(rootDir);
  const agent = core.createAgent();
  const onEvent = cliRenderer();

  console.log("Carter is ready. Type a request (Ctrl+C to quit).");
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      let input: string;
      try {
        input = await rl.question("> ");
      } catch {
        break; // stdin closed (EOF / Ctrl+D)
      }
      if (!input.trim()) continue;
      await agent.send(input, { onEvent });
    }
  } finally {
    rl.close();
    await core.mcp.closeAll();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

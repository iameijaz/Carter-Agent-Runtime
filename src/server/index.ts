import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { config } from "../config.js";
import { bootstrap } from "../bootstrap.js";
import { handleHttp } from "./http.js";
import { SessionStore } from "./sessions.js";
import { attachWebSocket } from "./ws.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");

async function main() {
  const core = await bootstrap(rootDir);
  const sessions = new SessionStore(core);

  const server = http.createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ app: "carter", pid: process.pid }));
      return;
    }
    handleHttp(req, res).catch((err) => {
      console.error("[http] handler error:", err);
      if (!res.headersSent) res.writeHead(500);
      res.end("Internal Server Error");
    });
  });

  const wss = new WebSocketServer({ server });
  attachWebSocket(wss, sessions);
  // ws re-emits the http server's errors; without a listener EADDRINUSE would
  // throw here before our retry below gets a chance.
  wss.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") console.error("[ws]", err.message);
  });

  let tryPort = config.carterPort;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err;
    if (tryPort >= config.carterPort + 10) { console.error("[server] no free port in range"); process.exit(1); }
    tryPort++;
    console.warn(`[server] port busy — trying ${tryPort} (stop the stale instance to reclaim ${config.carterPort})`);
    server.listen(tryPort, config.carterHost);
  });
  server.on("listening", () => {
    console.log(`Carter HUD on http://${config.carterHost}:${tryPort}`);
  });
  server.listen(tryPort, config.carterHost);

  const shutdown = async () => {
    console.log("\nShutting down…");
    server.close();
    await core.mcp.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Browser task tool — talks to the persistent browser service over WebSocket.
 * The service must be running (node src/browser/service.js) for this to work.
 * On first call, attempts to auto-start the service if it's not reachable.
 */

import { WebSocket } from "ws";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_URL = "ws://127.0.0.1:3132";
const SERVICE_SCRIPT = path.join(__dirname, "../../src/browser/service.js");
const CONNECT_TIMEOUT = 5000;
const COMMAND_TIMEOUT = 35000;

let autoStartAttempted = false;

/** Send one command to the browser service and await the response. */
export async function browserCommand(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
  // Try to connect; if it fails and we haven't auto-started yet, spawn the service
  try {
    return await sendCommand(action, params);
  } catch (err) {
    if (!autoStartAttempted) {
      autoStartAttempted = true;
      await spawnService();
      return sendCommand(action, params);
    }
    throw err;
  }
}

function spawnService(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SERVICE_SCRIPT],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
    // Give the service 3s to start up
    setTimeout(() => resolve(), 3000);
    child.on("error", reject);
  });
}

function sendCommand(action: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVICE_URL);
    const id = Math.random().toString(36).slice(2);
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.terminate();
        reject(new Error(`Browser command "${action}" timed out after ${COMMAND_TIMEOUT}ms`));
      }
    }, COMMAND_TIMEOUT);

    ws.on("open", () => {
      ws.send(JSON.stringify({ id, action, ...params }));
    });

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== id) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      if (msg.ok) resolve(msg.result);
      else reject(new Error(msg.error));
    });

    ws.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Browser service not reachable: ${err.message}`));
      }
    });

    ws.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Browser service closed connection unexpectedly"));
      }
    });

    const connectTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        settled = true;
        clearTimeout(timeout);
        ws.terminate();
        reject(new Error("Browser service connection timeout — is it running?"));
      }
    }, CONNECT_TIMEOUT);

    ws.on("open", () => clearTimeout(connectTimeout));
  });
}

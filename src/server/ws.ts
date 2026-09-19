import type { IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentEvent } from "../agent/events.js";
import type { SessionStore, Session } from "./sessions.js";
import { registerHudBroadcaster, resolveApproval } from "../agent/hudBus.js";

interface ClientMessage {
  type: "user_message" | "cancel" | "hil_response";
  text?: string;
  /** hil_response: which approval this answers + the operator's decision. */
  id?: string;
  approved?: boolean;
  editedCode?: string;
}

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function attachWebSocket(wss: WebSocketServer, sessions: SessionStore): void {
  // All live sockets — out-of-band HUD events (approval prompts, background
  // task updates) are broadcast to every connected tab (loopback/single-user).
  const clients = new Set<WebSocket>();
  registerHudBroadcaster((ev: AgentEvent) => {
    for (const c of clients) send(c, ev as unknown as Record<string, unknown>);
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    clients.add(ws);
    const url = new URL(req.url ?? "/", "http://localhost");
    const sessionId = url.searchParams.get("session") ?? crypto.randomUUID();
    const session = sessions.getOrCreate(sessionId);

    // Replay history so a reconnecting/refreshing client restores its transcript.
    send(ws, { type: "history", messages: session.transcript });

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", message: "Malformed message" });
        return;
      }

      switch (msg.type) {
        case "cancel":
          session.activeRun?.abort();
          return;

        case "hil_response":
          // Resolve a pending operator approval (see hudBus).
          if (msg.id) resolveApproval(msg.id, { approved: Boolean(msg.approved), editedCode: msg.editedCode });
          return;

        case "user_message": {
          const text = (msg.text ?? "").trim();
          if (!text) return;
          void runTurn(ws, session, text);
          return;
        }
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      // Keep the session (allows reconnect); abort any run tied to this socket.
      session.activeRun?.abort();
    });
  });
}

async function runTurn(ws: WebSocket, session: Session, text: string): Promise<void> {
  if (session.activeRun) {
    send(ws, { type: "error", message: "busy" });
    return;
  }

  const controller = new AbortController();
  session.activeRun = controller;
  session.transcript.push({ role: "user", text });

  let finalText = "";
  const onEvent = (ev: AgentEvent) => {
    if (ev.type === "assistant_message") finalText = ev.text;
    send(ws, ev as unknown as Record<string, unknown>);
  };

  try {
    await session.agent.send(text, { onEvent, signal: controller.signal });
    if (finalText) session.transcript.push({ role: "assistant", text: finalText });
  } catch (err) {
    // AgentLoop already emitted an `error` event before rethrowing.
    if (!controller.signal.aborted) {
      console.error("[ws] run failed:", (err as Error).message);
    }
  } finally {
    session.activeRun = null;
  }
}

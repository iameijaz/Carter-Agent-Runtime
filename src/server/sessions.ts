import type { CarterCore } from "../bootstrap.js";
import type { AgentLoop } from "../agent/loop.js";

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

export interface Session {
  id: string;
  agent: AgentLoop;
  /** Rendered turns replayed to a (re)connecting client. */
  transcript: TranscriptTurn[];
  /** AbortController for the in-flight run, if any. */
  activeRun: AbortController | null;
  lastSeen: number;
}

/**
 * In-memory session store keyed by a client-generated id. Survives WebSocket
 * reconnects (refresh) so conversation history isn't lost. Not persisted to
 * disk and not swept on idle yet — see docs/WhatsNext.md.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private core: CarterCore) {}

  getOrCreate(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = {
        id,
        agent: this.core.createAgent(),
        transcript: [],
        activeRun: null,
        lastSeen: Date.now(),
      };
      this.sessions.set(id, session);
    }
    session.lastSeen = Date.now();
    return session;
  }
}

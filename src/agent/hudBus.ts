/**
 * HUD bus — a tiny out-of-band channel from native tool handlers to connected
 * HUD clients. Native tools run inside the shared ToolBox and have no
 * per-session socket, so they push here and the web server fans the event out
 * to all connected sockets. This mirrors `backgroundRunner.registerBgBroadcaster`
 * (broadcast-to-all is intentional: Carter is loopback/single-user and multi-tab
 * monitoring is desirable — see Fable_Todo.md).
 *
 * It also brokers the operator approval handshake: a tool can
 * `requestApproval()` (which emits `hil_intercept` to the HUD and blocks) and
 * the server resolves it when the operator's `hil_response` arrives.
 */
import type { AgentEvent } from "./events.js";

type Broadcaster = (ev: AgentEvent) => void;

let _broadcaster: Broadcaster | null = null;

/** Called once by the web server (ws.ts) to receive HUD events. */
export function registerHudBroadcaster(fn: Broadcaster): void {
  _broadcaster = fn;
}

/** Push a HUD event to every connected client. No-op with no server attached. */
export function broadcastHud(ev: AgentEvent): void {
  try {
    _broadcaster?.(ev);
  } catch (err) {
    console.warn("[hudBus] broadcast failed:", (err as Error).message);
  }
}

// ── Operator approval handshake ─────────────────────────────────────────────

export interface ApprovalResult {
  approved: boolean;
  /** Operator may edit the payload in the HIL overlay before approving. */
  editedCode?: string;
}

interface Pending {
  resolve: (r: ApprovalResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const _pending = new Map<string, Pending>();
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * Emit a `hil_intercept` to the HUD and wait for the operator's decision.
 * Resolves `{approved:false}` if no client is attached or the timeout elapses,
 * so the agent never blocks forever.
 */
export function requestApproval(
  id: string,
  reason: string,
  code: string,
  tier: "sandboxed" | "trusted" = "trusted",
): Promise<ApprovalResult> {
  if (!_broadcaster) return Promise.resolve({ approved: false });
  return new Promise<ApprovalResult>((resolve) => {
    const timer = setTimeout(() => {
      _pending.delete(id);
      resolve({ approved: false });
    }, APPROVAL_TIMEOUT_MS);
    _pending.set(id, { resolve, timer });
    broadcastHud({ type: "hil_intercept", id, reason, code, tier });
  });
}

/** Called by the server when a `hil_response` arrives from the operator. */
export function resolveApproval(id: string, result: ApprovalResult): void {
  const pending = _pending.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  _pending.delete(id);
  pending.resolve(result);
}

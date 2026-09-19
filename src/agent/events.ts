/**
 * The event seam between Carter's core (AgentLoop) and any client that drives
 * it — CLI, web server/WebSocket, and later Telegram/Discord/VS Code. Clients
 * subscribe via `SendOptions.onEvent`; they should never reach into the loop's
 * internals. Adding a new client means consuming these events, not changing
 * the loop.
 */
export type AgentEvent =
  | { type: "run_started" }
  /** Which brain the router picked for this turn, and why. `model` is the real
   *  model id and `via` the host that served it ("local" for a loopback
   *  endpoint) — the router's name alone cannot tell an operator whether a turn
   *  cost money or ran on their own hardware. */
  | { type: "model_selected"; brain: string; reason: string; model: string; via: string }
  /** The primary brain failed; the run switched to the fallback brain. */
  | { type: "model_fallback"; from: string; to: string; reason: string; model: string; via: string }
  /** A streamed slice of the assistant's visible answer. */
  | { type: "token"; text: string }
  | { type: "tool_call_started"; id: string; name: string; args: unknown }
  | { type: "tool_call_finished"; id: string; name: string; ok: boolean; resultPreview: string }
  /** The full final answer text (also the resolved value of `send`). */
  | { type: "assistant_message"; text: string }
  | { type: "run_cancelled" }
  | { type: "error"; message: string }
  // ── Out-of-band HUD events (pushed via hudBus, not the per-run stream).
  //    Clients that don't render a HUD can ignore them. ──
  /** Human-in-the-loop: pause and ask the operator to approve/edit code. */
  | { type: "hil_intercept"; id: string; reason: string; code: string; tier?: string }
  /** Background-task progress (from backgroundRunner). */
  | { type: "bg_task_update"; taskId: string; status: string; message: string; goal: string };

export interface SendOptions {
  onEvent?: (ev: AgentEvent) => void;
  signal?: AbortSignal;
  /** Cap tool-call rounds for this turn (background repairs use a small budget). */
  maxRounds?: number;
}

/**
 * Background task runner — fires off an AgentLoop in a separate async context,
 * sends Telegram progress updates, and persists state to SQLite.
 *
 * Usage: tell Carter "work on X in the background" or "set up an agent to do Y"
 * Tools exposed: start_background_task, get_task_status, list_background_tasks,
 *                cancel_background_task
 */

import { AgentLoop } from "../agent/loop.js";
import type { ToolBox } from "../tools/index.js";
import type { Skill } from "../skills/loader.js";
import { appendEvent, getTaskState, listActiveTasks } from "../persistence/taskQueue.js";
import { sendTelegramMessage } from "../tools/native/telegramPush.js";
import { notify } from "../notifications/notify.js";
import { config } from "../config.js";

/** Registered by ws.ts — broadcasts bg_task_update to all connected clients. */
let _broadcaster: ((ev: object) => void) | null = null;
export function registerBgBroadcaster(fn: (ev: object) => void) { _broadcaster = fn; }

function broadcast(taskId: string, status: string, message: string, goal: string) {
  _broadcaster?.({ type: "bg_task_update", taskId, status, message, goal });
}

export interface BackgroundTask {
  id: string;
  goal: string;
  startedAt: Date;
  controller: AbortController;
}

// In-memory registry of running tasks
const runningTasks = new Map<string, BackgroundTask>();

function makeId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

async function pushUpdate(taskId: string, message: string, level: "info" | "warning" | "urgent" = "info", goal = "") {
  const status = level === "info" ? "running" : level === "urgent" ? "error" : "done";
  broadcast(taskId, status, message, goal);
  const text = `🤖 *Background Task* \`${taskId}\`\n${message}`;
  if (config.telegramBotToken && config.telegramChatId) {
    try { await sendTelegramMessage(text); } catch { /* ignore */ }
  }
  await notify({ title: "Carter Background Task", message, level });
  console.log(`[bg:${taskId}] ${message}`);
}

export async function startBackgroundTask(
  goal: string,
  instructions: string,
  toolBox: ToolBox,
  skills: Skill[],
): Promise<string> {
  const id = makeId();
  const controller = new AbortController();

  const task: BackgroundTask = { id, goal, startedAt: new Date(), controller };
  runningTasks.set(id, task);

  // Persist initial state
  await appendEvent(id, "initialize", JSON.stringify({ goal, instructions }));

  // Fire and forget — runs in background
  void runTask(id, goal, instructions, toolBox, skills, controller);

  return id;
}

async function runTask(
  id: string,
  goal: string,
  instructions: string,
  toolBox: ToolBox,
  skills: Skill[],
  controller: AbortController,
): Promise<void> {
  await pushUpdate(id, `Started: ${goal}`, "info", goal);

  const systemPrompt = `You are an autonomous background agent. Your goal:

${goal}

Instructions:
${instructions}

Work step by step. Use available tools. When complete, summarize what you accomplished.
You are running in the background — the user is not watching in real time.`;

  const agent = new AgentLoop(toolBox, skills, systemPrompt);

  try {
    // Stream progress updates every time a tool completes
    let lastUpdate = Date.now();
    const onEvent = async (ev: any) => {
      if (ev.type === "tool_call_finished" && Date.now() - lastUpdate > 15_000) {
        lastUpdate = Date.now();
        await appendEvent(id, "update_state", JSON.stringify({ lastTool: ev.name, ok: ev.ok }));
        await pushUpdate(id, `In progress — ${ev.name} ${ev.ok ? "✓" : "✗"}`, "info", goal);
      }
    };

    const result = await agent.send(
      `Complete your goal: ${goal}\n\nAdditional instructions: ${instructions}`,
      { signal: controller.signal, onEvent }
    );

    await appendEvent(id, "resolve", JSON.stringify({ result: result.slice(0, 500) }));
    broadcast(id, "done", `✅ Done: ${result.slice(0, 200)}`, goal);
    await pushUpdate(id, `✅ Done: ${result.slice(0, 200)}`, "warning", goal);
  } catch (err) {
    const msg = controller.signal.aborted ? "Cancelled by user" : `Failed: ${(err as Error).message}`;
    await appendEvent(id, "resolve", JSON.stringify({ error: msg }));
    broadcast(id, controller.signal.aborted ? "cancelled" : "error", msg, goal);
    await pushUpdate(id, msg, controller.signal.aborted ? "warning" : "urgent", goal);
  } finally {
    runningTasks.delete(id);
  }
}

export function cancelBackgroundTask(id: string): boolean {
  const task = runningTasks.get(id);
  if (!task) return false;
  task.controller.abort();
  runningTasks.delete(id);
  return true;
}

export async function getBackgroundTaskStatus(id: string) {
  const running = runningTasks.get(id);
  const state = await getTaskState(id);
  return {
    id,
    running: Boolean(running),
    goal: running?.goal ?? (state ? JSON.parse(state.payload ?? "{}").goal : null),
    status: state?.status ?? "unknown",
    started_at: running?.startedAt ?? state?.created_at,
    last_updated: state?.updated_at,
    event_count: state?.events.length ?? 0,
  };
}

export async function listBackgroundTaskStatuses() {
  const activeIds = new Set(runningTasks.keys());
  const persisted = await listActiveTasks();
  const all = new Map<string, any>();

  for (const task of runningTasks.values()) {
    all.set(task.id, { id: task.id, running: true, goal: task.goal, status: "running" });
  }
  for (const state of persisted) {
    if (!all.has(state.transaction_id)) {
      const payload = JSON.parse(state.payload ?? "{}");
      all.set(state.transaction_id, {
        id: state.transaction_id,
        running: false,
        goal: payload.goal ?? "unknown",
        status: state.status,
        last_updated: state.updated_at,
      });
    }
  }
  return Array.from(all.values());
}

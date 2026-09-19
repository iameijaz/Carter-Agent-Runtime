import OpenAI from "openai";
import { ToolBox } from "../tools/index.js";
import { matchSkills, type Skill } from "../skills/loader.js";
import type { AgentEvent, SendOptions } from "./events.js";
import { classify } from "./router.js";
import { brains, resolveBrain, brainOrigin, type Brain } from "./brains.js";
import { assembleSystemPrompt, BASE_PROMPT } from "./promptAssembler.js";
import { noteUserMessage } from "./contextTracker.js";
import { recordMistake, attachFixForTool, knownFixes } from "../memory/mistakes.js";
import { logTurn, type TurnPath, type TurnOutcome } from "../memory/turns.js";
import { lookupPlan, recordPlan, markPlanUsed, type PlanStep } from "../memory/successCache.js";
import { summarise, formatPoints, type Source } from "../summarize/extractive.js";

const MAX_TOOL_ROUNDS = 8;

/** Tool calls that put something on the HUD — used by Total Visual enforcement. */

/** Accumulator for one tool call assembled from streamed deltas. */
interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

export class AgentLoop {
  private history: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  /** True when using Carter's default prompt — re-assembled (modes/prefs/context)
   *  each turn. Background workers/healer pass a fixed prompt and stay static. */
  private dynamicPrompt: boolean;

  constructor(
    private toolBox: ToolBox,
    private skills: Skill[],
    systemPrompt?: string,
  ) {
    this.dynamicPrompt = systemPrompt === undefined;
    this.history = [{ role: "system", content: systemPrompt ?? BASE_PROMPT }];
  }

  async send(userMessage: string, opts: SendOptions = {}): Promise<string> {
    const emit = (ev: AgentEvent) => opts.onEvent?.(ev);
    const { signal } = opts;

    // Per-turn log. Every exit path below calls done() exactly once; the
    // counters it reads are mutated as the turn progresses.
    const startedAt = Date.now();
    const toolsUsed: string[] = [];
    // The recipe for this turn, in execution order — only calls that succeeded.
    const planSteps: PlanStep[] = [];
    let roundsRun = 0;
    // ponytail: tier0 (a small local router that re-synthesises arguments for a
    // near-miss) is still not built; a turn is either a replayed plan or a full
    // model call.
    let path: TurnPath = "tier1";
    let logged = false;
    const done = (outcome: TurnOutcome, error?: string) => {
      if (logged) return;
      logged = true;
      void logTurn({
        path,
        latencyMs: Date.now() - startedAt,
        brain: brain?.name ?? "unknown",
        tools: toolsUsed,
        outcome,
        rounds: roundsRun,
        schemaVersion: this.toolBox.mcp.version,
        error,
      });
    };

    // The learned bypass: if a near-identical request has been answered before,
    // replay the tool calls that worked and summarise the results locally. The
    // plan is reused, never the answer — the tools re-run, so the content is
    // today's. Returns null for "no usable plan", and every failure inside is a
    // null, so the worst case is the normal model turn one lookup later.
    const replayed = await this.tryCachedPlan(userMessage, emit, signal);
    if (replayed !== null) {
      path = "cache";
      logged = true;
      void logTurn({
        path, latencyMs: Date.now() - startedAt, brain: "cache",
        tools: replayed.tools, outcome: "ok", rounds: 1,
        schemaVersion: this.toolBox.mcp.version,
      });
      // The turn never reached the model, so history has no assistant turn for
      // it — record both sides or the next turn loses the thread.
      this.history.push({ role: "user", content: userMessage });
      this.history.push({ role: "assistant", content: replayed.text });
      emit({ type: "assistant_message", text: replayed.text });
      return replayed.text;
    }

    // Refresh the system prompt with the live modes/preferences/context, and
    // learn from this message for later turns (both no-op for static prompts).
    if (this.dynamicPrompt) {
      this.history[0] = { role: "system", content: await assembleSystemPrompt() };
      noteUserMessage(userMessage);
    }

    // toolBox.skills is the live set (create_skill hot-reloads it); the
    // constructor copy is only the boot-time fallback.
    const activeSkills = this.toolBox.skills.length > 0 ? this.toolBox.skills : this.skills;
    const matched = matchSkills(activeSkills, userMessage);
    const skillContext = matched.map((s) => `# Skill: ${s.name}\n${s.body}`).join("\n\n");

    this.history.push({
      role: "user",
      content: skillContext ? `${skillContext}\n\n---\n\n${userMessage}` : userMessage,
    });

    const tools = await this.toolBox.getOpenAiTools();
    emit({ type: "run_started" });

    // Route this turn to a brain (GPT by default; Grok for social/sentiment).
    const decision = classify(userMessage);
    let brain = resolveBrain(decision.brain);
    let usedFallback = false;
    emit({ type: "model_selected", brain: brain.name, reason: decision.reason, ...brainOrigin(brain) });

    try {
      const maxRounds = opts.maxRounds ?? MAX_TOOL_ROUNDS;
      // tool name -> the arguments that failed, so a later success can say
      // what to do INSTEAD of what, not just what worked.
      const failedThisRun = new Map<string, string>();
      for (let round = 0; round < maxRounds; round++) {
        roundsRun = round + 1;
        if (signal?.aborted) {
          done("cancelled");
          emit({ type: "run_cancelled" });
          return "";
        }

        let content: string;
        let toolCalls: PartialToolCall[];
        try {
          ({ content, toolCalls } = await this.streamOnce(brain, tools, emit, signal));
        } catch (err) {
          // A non-abort failure (rate-limit, auth, network) falls back to the
          // other brain once, then retries this same round.
          const other = brain.name === "gpt" ? brains.grok : brains.gpt;
          if (!signal?.aborted && !usedFallback && other) {
            usedFallback = true;
            emit({ type: "model_fallback", from: brain.name, to: other.name, reason: (err as Error).message, ...brainOrigin(other) });
            brain = other;
            round--;
            continue;
          }
          throw err;
        }

        // Aborting a streamed completion makes the SDK's async iterator return
        // early with partial content instead of throwing — so check here too,
        // not only in the catch below.
        if (signal?.aborted) {
          done("cancelled");
          emit({ type: "run_cancelled" });
          return content;
        }

        // Assemble the assistant turn (content + any tool calls) for history.
        const assistantMsg: OpenAI.Chat.Completions.ChatCompletionMessageParam = {
          role: "assistant",
          content: content || null,
        };
        if (toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          }));
        }
        this.history.push(assistantMsg);

        if (toolCalls.length === 0) {
          done("ok");
          // Learn the recipe, not the reply. Next time this intent arrives the
          // same calls run again and fetch whatever is current.
          if (planSteps.length > 0)
            void recordPlan(userMessage, planSteps, this.toolBox.mcp.version);
          emit({ type: "assistant_message", text: content });
          return content;
        }

        if (signal?.aborted) {
          done("cancelled");
          emit({ type: "run_cancelled" });
          return "";
        }
        // Tool calls in one round are independent by construction (the model
        // can't see one's result while requesting another) — run them all in
        // parallel, then append results to history in the original order.
        const settled = await Promise.all(toolCalls.map(async (call) => {
          toolsUsed.push(call.name);
          const args = safeParse(call.arguments) as Record<string, unknown>;
          emit({ type: "tool_call_started", id: call.id, name: call.name, args });
          let result: unknown;
          let ok = true;
          try {
            result = await this.toolBox.call(call.name, args);
            planSteps.push({ tool: call.name, args });
            // A success closes this tool's newest open failure — whenever it
            // happened. Corrections usually arrive a turn or a session later
            // than the failure, so this must not be scoped to one run.
            const failedArgs = failedThisRun.get(call.name);
            failedThisRun.delete(call.name);
            void attachFixForTool(
              call.name,
              failedArgs
                ? `call it as ${call.arguments.slice(0, 200)} — NOT as ${failedArgs.slice(0, 200)}`
                : `these arguments work: ${call.arguments.slice(0, 300)}`,
            );
          } catch (err) {
            ok = false;
            const message = (err as Error).message;
            // Mistake memory: record the failure and surface any known fix so
            // the model corrects course instead of retrying the same dead end.
            let knownFix: string | undefined;
            try {
              // The arguments belong IN the lesson. Recording only the error
              // ("fetch failed") tells a later turn that this tool broke, not
              // which call broke it — so the model cannot avoid repeating it,
              // which is precisely what the claim promises. Measured by
              // scripts/stress_behaviour.ts.
              await recordMistake(call.name, userMessage,
                `${message} — failing arguments: ${call.arguments.slice(0, 200)}`);
              failedThisRun.set(call.name, call.arguments);
              knownFix = (await knownFixes(call.name))[0]?.fix ?? undefined;
            } catch { /* memory must never break execution */ }
            result = knownFix ? { error: message, known_fix_from_past_mistake: knownFix } : { error: message };
          }
          const serialized = JSON.stringify(result);
          emit({
            type: "tool_call_finished",
            id: call.id,
            name: call.name,
            ok,
            resultPreview: serialized.length > 500 ? serialized.slice(0, 500) + "…" : serialized,
          });
          return { call, serialized };
        }));
        for (const { call, serialized } of settled) {
          this.history.push({ role: "tool", tool_call_id: call.id, content: serialized });
        }
      }

      const capped = "(stopped after too many tool-call rounds)";
      done("capped");
      emit({ type: "assistant_message", text: capped });
      return capped;
    } catch (err) {
      // An aborted request surfaces as an APIUserAbortError — treat as cancel.
      if (signal?.aborted) {
        done("cancelled");
        emit({ type: "run_cancelled" });
        return "";
      }
      done("error", (err as Error).message);
      emit({ type: "error", message: (err as Error).message });
      throw err;
    }
  }

  /**
   * Runs one streamed completion, emitting `token` events for visible content
   * and assembling any tool calls from their streamed fragments.
   */
  /**
   * Try to answer with no model at all: look up a recipe for this intent,
   * re-run its tool calls, summarise the results offline.
   *
   * Fails open — a missing plan, a tool that errors, or a summary that comes
   * out empty all return null, and the caller takes the normal model path. The
   * cache may make a turn faster; it must never make one worse.
   */
  private async tryCachedPlan(
    userMessage: string,
    emit: (ev: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<{ text: string; tools: string[] } | null> {
    const plan = await lookupPlan(userMessage, this.toolBox.mcp.version);
    if (!plan) return null;

    emit({ type: "run_started" });
    emit({
      type: "model_selected", brain: "cache",
      reason: `replayed a plan learned from "${plan.intent}" (exact repeat, ${plan.hits} prior)`,
      model: "replayed plan — no model", via: "local",
    });

    const sources: Source[] = [];
    const tools: string[] = [];
    for (const [i, step] of plan.steps.entries()) {
      if (signal?.aborted) return null;
      const id = `replay-${i}`;
      emit({ type: "tool_call_started", id, name: step.tool, args: step.args });
      try {
        const result = await this.toolBox.call(step.tool, step.args);
        tools.push(step.tool);
        sources.push(...toSources(result));
        const s = JSON.stringify(result);
        emit({ type: "tool_call_finished", id, name: step.tool, ok: true,
               resultPreview: s.length > 500 ? s.slice(0, 500) + "…" : s });
      } catch (err) {
        // A recipe that has rotted goes into mistake memory rather than
        // failing silently, so the model turn that follows can see it.
        const message = (err as Error).message;
        emit({ type: "tool_call_finished", id, name: step.tool, ok: false,
               resultPreview: JSON.stringify({ error: message }) });
        void recordMistake(step.tool, userMessage,
          `${message} — failing arguments (replayed from cache): ${JSON.stringify(step.args).slice(0, 200)}`);
        return null;
      }
    }

    const points = summarise(sources, userMessage);
    if (points.length === 0) return null;
    await markPlanUsed(plan.id);
    // Labelled, not disguised. These are sentences lifted from the pages, not a
    // synthesis: nothing here reconciles two sources or keeps a correction
    // attached to the claim it corrects. The reader is told which they got.
    const header = "*Offline replay — excerpts from the sources, not a summary.*\n\n";
    return { text: header + formatPoints(points), tools };
  }

  private async streamOnce(
    brain: Brain,
    tools: OpenAI.Chat.Completions.ChatCompletionTool[],
    emit: (ev: AgentEvent) => void,
    signal?: AbortSignal
  ): Promise<{ content: string; toolCalls: PartialToolCall[] }> {
    const stream = await brain.client.chat.completions.create(
      {
        model: brain.model,
        messages: this.history,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
      },
      { signal }
    );

    let content = "";
    const toolCalls: PartialToolCall[] = [];

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        emit({ type: "token", text: delta.content });
      }

      for (const tcDelta of delta.tool_calls ?? []) {
        const idx = tcDelta.index;
        if (!toolCalls[idx]) {
          toolCalls[idx] = { id: "", name: "", arguments: "" };
        }
        const acc = toolCalls[idx];
        if (tcDelta.id) acc.id = tcDelta.id;
        if (tcDelta.function?.name) acc.name = tcDelta.function.name;
        if (tcDelta.function?.arguments) acc.arguments += tcDelta.function.arguments;
      }
    }

    // Compact any gaps left by sparse indices.
    return { content, toolCalls: toolCalls.filter(Boolean) };
  }
}

/**
 * Readable text out of an arbitrary tool result, for the offline summarizer.
 * Deliberately shape-based rather than keyed by tool name: a tool the cache has
 * never seen still contributes if it returns something with words in it, and
 * one that returns an id or a status code contributes nothing and is skipped.
 */
function toSources(result: unknown): Source[] {
  const out: Source[] = [];
  const visit = (v: unknown, depth = 0) => {
    if (depth > 3 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) visit(x, depth + 1); return; }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const text = [o.text, o.content, o.snippet, o.body].find((x) => typeof x === "string" && x.length > 80);
    if (typeof text === "string") {
      out.push({ title: String(o.title ?? o.url ?? "source"), text });
      return; // its children are parts of this text
    }
    for (const x of Object.values(o)) visit(x, depth + 1);
  };
  visit(result);
  return out;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json || "{}");
  } catch {
    return {};
  }
}

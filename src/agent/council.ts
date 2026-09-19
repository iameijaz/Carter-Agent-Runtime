/**
 * Council mode — parallel multi-role deliberation with structured JSON output.
 *
 * Each role returns a typed JSON object (enforced via response_format).
 * This prevents crashes from malformed responses, especially from smaller models.
 * The synthesizer receives structured data and produces the final answer.
 */

import OpenAI from "openai";
import { resolveBrainAsync } from "./brains.js";
import type { ToolBox } from "../tools/index.js";
import type { Skill } from "../skills/loader.js";

// ── Role output schemas ───────────────────────────────────────────────────────

interface PlannerOutput {
  steps: Array<{ step: number; action: string; rationale: string }>;
  information_needed: string[];
  ambiguities: string[];
}

interface ResearcherOutput {
  findings: Array<{ claim: string; source?: string; confidence: "high" | "medium" | "low" }>;
  gaps: string[];
  contradictions: string[];
}

interface CriticOutput {
  flaws: Array<{ issue: string; severity: "critical" | "moderate" | "minor" }>;
  missing_evidence: string[];
  unanswered_questions: string[];
}

interface DevilsAdvocateOutput {
  counter_argument: string;
  strongest_objections: string[];
  minority_viewpoints: string[];
}

interface RoleResult {
  role: string;
  output: PlannerOutput | ResearcherOutput | CriticOutput | DevilsAdvocateOutput | string;
  raw: string;
  error?: string;
}

export interface CouncilResult {
  final: string;
  roleOutputs: RoleResult[];
  rolesUsed: string[];
}

// ── Role prompts — instruct model to return JSON ──────────────────────────────

const ROLE_PROMPTS: Record<string, { system: string; schema: object }> = {
  planner: {
    system: `You are the Planner in a council deliberation.
Return a JSON object with:
- steps: array of {step, action, rationale}
- information_needed: array of strings
- ambiguities: array of strings
Be concise. Do NOT answer the question — only plan.`,
    schema: {
      type: "object",
      properties: {
        steps: { type: "array", items: { type: "object", properties: { step: { type: "number" }, action: { type: "string" }, rationale: { type: "string" } }, required: ["step","action","rationale"] } },
        information_needed: { type: "array", items: { type: "string" } },
        ambiguities: { type: "array", items: { type: "string" } },
      },
      required: ["steps","information_needed","ambiguities"],
    },
  },
  researcher: {
    system: `You are the Researcher in a council deliberation. Use web_search and web_fetch tools.
Return a JSON object with:
- findings: array of {claim, source (URL if available), confidence: high/medium/low}
- gaps: information you couldn't find
- contradictions: conflicting evidence found`,
    schema: {
      type: "object",
      properties: {
        findings: { type: "array", items: { type: "object", properties: { claim: { type: "string" }, source: { type: "string" }, confidence: { type: "string", enum: ["high","medium","low"] } }, required: ["claim","confidence"] } },
        gaps: { type: "array", items: { type: "string" } },
        contradictions: { type: "array", items: { type: "string" } },
      },
      required: ["findings","gaps","contradictions"],
    },
  },
  critic: {
    system: `You are the Critic in a council deliberation.
Return a JSON object with:
- flaws: array of {issue, severity: critical/moderate/minor}
- missing_evidence: what's unproven
- unanswered_questions: hard questions not yet addressed`,
    schema: {
      type: "object",
      properties: {
        flaws: { type: "array", items: { type: "object", properties: { issue: { type: "string" }, severity: { type: "string", enum: ["critical","moderate","minor"] } }, required: ["issue","severity"] } },
        missing_evidence: { type: "array", items: { type: "string" } },
        unanswered_questions: { type: "array", items: { type: "string" } },
      },
      required: ["flaws","missing_evidence","unanswered_questions"],
    },
  },
  devils_advocate: {
    system: `You are the Devil's Advocate in a council deliberation.
Return a JSON object with:
- counter_argument: the strongest case against the consensus
- strongest_objections: array of specific objections
- minority_viewpoints: unconventional perspectives`,
    schema: {
      type: "object",
      properties: {
        counter_argument: { type: "string" },
        strongest_objections: { type: "array", items: { type: "string" } },
        minority_viewpoints: { type: "array", items: { type: "string" } },
      },
      required: ["counter_argument","strongest_objections","minority_viewpoints"],
    },
  },
};

const SYNTHESIZER_PROMPT = `You are the Synthesizer. You have received structured analysis from a council.
Compile everything into a single, well-reasoned, user-facing answer.
- Resolve contradictions explicitly
- Address critical flaws raised by the Critic
- Acknowledge the Devil's Advocate's strongest objections
- Flag remaining uncertainties
Be clear, structured, and actionable.`;

// ── Run a single role with JSON enforcement ───────────────────────────────────

async function runRole(
  role: string,
  question: string,
  toolBox: ToolBox,
  skills: Skill[],
): Promise<RoleResult> {
  const { system, schema } = ROLE_PROMPTS[role];
  const brain = await resolveBrainAsync("gpt");

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    { role: "user",   content: question },
  ];

  try {
    const tools = await toolBox.getOpenAiTools();
    let response: string;

    // Researcher gets tools; others get structured JSON output
    if (role === "researcher") {
      // Tool-calling loop (max 4 rounds)
      let history = [...messages];
      for (let i = 0; i < 4; i++) {
        const completion = await brain.client.chat.completions.create({
          model: brain.model,
          messages: history,
          tools: tools.length > 0 ? tools : undefined,
          response_format: { type: "json_object" },
        });
        const msg = completion.choices[0].message;
        history.push(msg as any);
        if (!msg.tool_calls?.length) {
          response = msg.content ?? "{}";
          break;
        }
        for (const call of msg.tool_calls) {
          let result: unknown;
          try { result = await toolBox.call(call.function.name, JSON.parse(call.function.arguments || "{}")); }
          catch (e) { result = { error: (e as Error).message }; }
          history.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        }
        response = "{}";
      }
      response ??= "{}";
    } else {
      const completion = await brain.client.chat.completions.create({
        model: brain.model,
        messages,
        response_format: { type: "json_object" },
      });
      response = completion.choices[0].message.content ?? "{}";
    }

    let parsed: object;
    try { parsed = JSON.parse(response); }
    catch { parsed = { raw: response }; }

    return { role, output: parsed, raw: response };
  } catch (err) {
    return { role, output: "", raw: "", error: (err as Error).message };
  }
}

// ── Format role outputs for synthesizer ──────────────────────────────────────

function formatForSynthesizer(results: RoleResult[]): string {
  return results.filter(r => r.raw && !r.error).map(r => {
    const out = r.output as any;
    let text = `## ${r.role.toUpperCase()}\n`;

    if (r.role === "planner" && out.steps) {
      text += out.steps.map((s: any) => `${s.step}. ${s.action} — ${s.rationale}`).join("\n");
      if (out.ambiguities?.length) text += `\n\nAmbiguities: ${out.ambiguities.join("; ")}`;
    } else if (r.role === "researcher" && out.findings) {
      text += out.findings.map((f: any) => `- [${f.confidence}] ${f.claim}${f.source ? ` (${f.source})` : ""}`).join("\n");
      if (out.contradictions?.length) text += `\n\nContradictions: ${out.contradictions.join("; ")}`;
    } else if (r.role === "critic" && out.flaws) {
      text += out.flaws.map((f: any) => `- [${f.severity}] ${f.issue}`).join("\n");
      if (out.unanswered_questions?.length) text += `\n\nOpen questions: ${out.unanswered_questions.join("; ")}`;
    } else if (r.role === "devils_advocate" && out.counter_argument) {
      text += out.counter_argument;
      if (out.strongest_objections?.length) text += `\n\nObjections: ${out.strongest_objections.join("; ")}`;
    } else {
      text += r.raw;
    }
    return text;
  }).join("\n\n---\n\n");
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface CouncilOptions {
  question: string;
  roles?: string[];
  toolBox: ToolBox;
  skills: Skill[];
  onProgress?: (role: string, status: "started" | "done" | "error") => void;
}

export async function runCouncil(opts: CouncilOptions): Promise<CouncilResult> {
  const roles = opts.roles ?? ["planner", "researcher", "critic", "devils_advocate"];
  const { question, toolBox, skills, onProgress } = opts;

  const roleResults = await Promise.all(
    roles.map(async (role): Promise<RoleResult> => {
      onProgress?.(role, "started");
      const result = await runRole(role, question, toolBox, skills);
      onProgress?.(role, result.error ? "error" : "done");
      return result;
    })
  );

  // Synthesize
  const councilContext = formatForSynthesizer(roleResults);
  const synthPrompt = `The council has deliberated on:\n\n> ${question}\n\n${councilContext}\n\nSynthesize the final answer.`;
  const brain = await resolveBrainAsync("gpt");

  onProgress?.("synthesizer", "started");
  let final: string;
  try {
    const completion = await brain.client.chat.completions.create({
      model: brain.model,
      messages: [
        { role: "system", content: SYNTHESIZER_PROMPT },
        { role: "user",   content: synthPrompt },
      ],
    });
    final = completion.choices[0].message.content ?? "";
    onProgress?.("synthesizer", "done");
  } catch (err) {
    final = `Synthesis failed: ${(err as Error).message}\n\n${councilContext}`;
    onProgress?.("synthesizer", "error");
  }

  return { final, roleOutputs: roleResults, rolesUsed: [...roles, "synthesizer"] };
}

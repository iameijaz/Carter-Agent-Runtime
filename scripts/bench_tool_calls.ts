/**
 * Model acceptance test — the one specified in DECISIONS.md:
 *
 *   20 fixed prompts x the real tool schemas
 *   pass = valid JSON, correct tool name, all required args present
 *   then: measure p50/p95 latency on the same set
 *
 * Deliberately does NOT execute the tools. Two reasons: the question here is
 * whether the model can *choose* correctly, which is separable from whether a
 * network call succeeds; and the real tool set contains `email_send`, which
 * must never fire from a benchmark.
 *
 * Writes BENCH.md and bench-results.json. Exits non-zero if the pass rate is
 * below the floor, so it can gate a release.
 *
 * Run: npx tsx scripts/bench_tool_calls.ts [--model openai/gpt-4.1] [--runs 1]
 */

import OpenAI from "openai";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap } from "../src/bootstrap.js";
import { config } from "../src/config.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url)) + "/..";

/**
 * Each case names the tool the model should choose and the arguments it must
 * populate. `alt` lists tool names that are also defensible — a prompt about a
 * book could reasonably go to search or to availability — so the test measures
 * capability rather than punishing a reasonable alternative reading.
 */
interface Case {
  id: string;
  prompt: string;
  want: string;
  alt?: string[];
  /** Argument names that must be present and non-empty. */
  needs?: string[];
  /** Optional predicate for argument *quality*, not just presence. */
  check?: (args: Record<string, unknown>) => string | null;
}

const CASES: Case[] = [
  { id: "weather-1", prompt: "What's the weather in Oslo right now?", want: "get_weather", needs: ["location"],
    check: (a) => /oslo/i.test(String(a.location)) ? null : `location was "${a.location}", expected Oslo` },
  { id: "weather-2", prompt: "Do I need an umbrella in Lisbon tomorrow?", want: "get_weather", needs: ["location"] },
  { id: "search-1", prompt: "Search the web for the latest ROS 2 Jazzy release notes.", want: "web_search", needs: ["query"] },
  { id: "search-2", prompt: "What are people saying about the new Raspberry Pi 5 compute module?", want: "web_search", needs: ["query"] },
  { id: "fetch-1", prompt: "Read https://example.com and summarise it.", want: "web_fetch", needs: ["url"],
    check: (a) => String(a.url).includes("example.com") ? null : `url was "${a.url}"` },
  { id: "mail-1", prompt: "Check my inbox for anything new.", want: "email_fetch", alt: ["email_search"] },
  { id: "mail-2", prompt: "Find the email from the landlord about the deposit.", want: "email_search", needs: ["query"] },
  { id: "mail-3", prompt: "What mail folders do I have?", want: "email_folders" },
  { id: "lib-1", prompt: "Is 'Probabilistic Robotics' available in the library?", want: "library_check_availability",
    alt: ["library_search"], needs: ["title"] },
  { id: "lib-2", prompt: "Search the library catalogue for books on Kalman filtering.", want: "library_search" },
  { id: "train-1", prompt: "How do I get from Berlin to Hamburg by train tomorrow morning?", want: "train_journeys" },
  { id: "pref-1", prompt: "Remember that I prefer metric units.", want: "remember_preference" },
  { id: "pref-2", prompt: "Forget what I told you about my dietary preferences.", want: "forget_preference" },
  { id: "mcp-1", prompt: "Find me an MCP server that can talk to Postgres.", want: "search_extensions",
    alt: ["install_mcp_server"] },
  { id: "skill-1", prompt: "Create a skill that summarises a PDF into bullet points.", want: "create_skill" },
  { id: "lesson-1", prompt: "Record a lesson: always check the file exists before writing.", want: "record_lesson" },
  // The component-factory cases (list/mount/set_workspace) were removed with the
  // tools themselves on 2026-09-19 — Carter is a chat + approval console now;
  // the multi-window UI belongs to a different project. See DECISIONS.md.
];

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const MODEL = flag("--model", config.llmModel);
const RUNS = Number(flag("--runs", "1"));
const FLOOR = Number(flag("--floor", "80")); // % pass required to exit 0

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

interface Result {
  id: string; prompt: string; want: string; got: string | null;
  ok: boolean; ms: number; reason: string; args: string;
}

async function main() {
  const core = await bootstrap(ROOT);
  const tools = await core.toolBox.getOpenAiTools();
  console.log(`[bench] ${tools.length} tool schemas, ${CASES.length} cases x ${RUNS} run(s), model=${MODEL}\n`);

  const client = new OpenAI({ apiKey: config.llmApiKey, baseURL: config.llmBaseUrl });
  const results: Result[] = [];
  // Reported by the provider on each completion, so this costs nothing extra.
  // Prompt tokens are dominated by the tool schemas, which is the point: the
  // schema block is paid for on every single turn.
  let promptTokens = 0;
  let completionTokens = 0;

  for (let run = 0; run < RUNS; run++) {
    for (const c of CASES) {
      const started = Date.now();
      let got: string | null = null;
      let reason = "";
      let argsStr = "";
      let ok = false;

      try {
        const r = await client.chat.completions.create({
          model: MODEL,
          messages: [
            { role: "system", content: "You are a helpful assistant with tools. Call a tool when one fits the request." },
            { role: "user", content: c.prompt },
          ],
          tools,
          tool_choice: "auto",
        });

        promptTokens += r.usage?.prompt_tokens ?? 0;
        completionTokens += r.usage?.completion_tokens ?? 0;

        const call = r.choices[0]?.message?.tool_calls?.[0];
        if (!call) {
          reason = "no tool call emitted";
        } else {
          got = call.function.name;
          argsStr = call.function.arguments ?? "";
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(argsStr || "{}");
          } catch {
            reason = "arguments were not valid JSON";
          }

          if (!reason) {
            const accepted = [c.want, ...(c.alt ?? [])];
            if (!accepted.includes(got)) {
              reason = `chose ${got}, wanted ${accepted.join(" or ")}`;
            } else {
              const missing = (c.needs ?? []).filter(
                (k) => args[k] === undefined || String(args[k]).trim() === "",
              );
              if (missing.length) reason = `missing required arg(s): ${missing.join(", ")}`;
              else reason = c.check?.(args) ?? "";
              ok = !reason;
            }
          }
        }
      } catch (e) {
        reason = `API error: ${e instanceof Error ? e.message : String(e)}`;
      }

      const ms = Date.now() - started;
      results.push({ id: c.id, prompt: c.prompt, want: c.want, got, ok, ms, reason, args: argsStr });
      console.log(`${ok ? "pass" : "FAIL"}  ${c.id.padEnd(12)} ${String(ms).padStart(6)} ms  ${ok ? (got ?? "") : reason}`);
    }
  }

  const passed = results.filter((r) => r.ok);
  const rate = (passed.length / results.length) * 100;
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const failures = results.filter((r) => !r.ok);

  // Group failures by reason shape so the report says what went wrong, not just how often.
  const byReason = new Map<string, Result[]>();
  for (const f of failures) {
    const key = f.reason.replace(/".*?"/g, '"…"').replace(/chose \w+/, "chose <other tool>");
    byReason.set(key, [...(byReason.get(key) ?? []), f]);
  }

  const md = `# BENCH — model tool-call accuracy

Generated by \`npx tsx scripts/bench_tool_calls.ts\`. Do not edit by hand.

Model: \`${MODEL}\` · ${CASES.length} cases × ${RUNS} run(s) · ${tools.length} tool schemas
Run at: ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC

## Result

| | |
|---|---|
| Pass rate | **${rate.toFixed(0)}%** (${passed.length}/${results.length}) |
| p50 latency | ${pct(lat, 50)} ms |
| p95 latency | ${pct(lat, 95)} ms |
| min / max | ${lat[0]} / ${lat[lat.length - 1]} ms |
| Prompt tokens / call | ${Math.round(promptTokens / results.length)} (mostly the ${tools.length} tool schemas) |
| Completion tokens / call | ${Math.round(completionTokens / results.length)} |

**Method.** Each prompt is sent once with the runtime's real tool schemas and
\`tool_choice: "auto"\`. A case passes when the model emits a tool call whose name
is the expected tool (or a listed defensible alternative), whose arguments parse
as JSON, and which populates every required argument. Tools are **not executed** —
this measures tool *choice*, and the live tool set includes \`email_send\`.
Latency is one full non-streaming completion, so it includes argument generation.

## Cases

| Case | Result | ms | Chose | Note |
|---|---|---|---|---|
${results.map((r) => `| ${r.id} | ${r.ok ? "pass" : "**FAIL**"} | ${r.ms} | ${r.got ?? "—"} | ${r.reason || "—"} |`).join("\n")}

## Failures, grouped

${
  failures.length === 0
    ? "_None._"
    : [...byReason.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([reason, rs]) => `**${reason}** — ${rs.length} case(s): ${rs.map((r) => `\`${r.id}\``).join(", ")}\n\n${rs.map((r) => `- \`${r.id}\` — prompt: "${r.prompt}"\n  - wanted \`${r.want}\`, got \`${r.got ?? "nothing"}\`\n  - args: \`${r.args.slice(0, 200) || "—"}\``).join("\n")}`)
        .join("\n\n")
}

## Limits of this number

- One sample per case unless \`--runs\` was raised: tool choice is not deterministic,
  so a single run cannot separate a real weakness from one unlucky sample.
- Latency is measured over the public internet to OpenRouter and includes its
  routing hop. It is not a model-inference benchmark.
- The cases were written alongside the tool descriptions, so they test whether the
  descriptions are usable — not whether an arbitrary user's phrasing would work.
- **${tools.length - CASES.length} of the ${tools.length} exposed tools are not covered.** The cases exercise
  ${CASES.length}. Destructive tools — \`email_send\` above all — are excluded on purpose,
  as are tools that only make sense mid-conversation (\`install_mcp_server\`,
  \`run_skill\`) which a single-turn harness cannot reach.
`;

  writeFileSync(path.join(ROOT, "BENCH.md"), md);
  writeFileSync(
    path.join(ROOT, "bench-results.json"),
    JSON.stringify({ model: MODEL, runs: RUNS, at: new Date().toISOString(), rate, p50: pct(lat, 50), p95: pct(lat, 95), results }, null, 2),
  );

  console.log(`\n${passed.length}/${results.length} passed (${rate.toFixed(0)}%) · p50 ${pct(lat, 50)} ms · p95 ${pct(lat, 95)} ms`);
  console.log("wrote BENCH.md + bench-results.json");
  process.exit(rate >= FLOOR ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

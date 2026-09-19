/**
 * HUD self-check — asserts the tool rail and the provenance readout against the
 * real page in a real browser.
 *
 *   npm run web          # in another terminal
 *   node scripts/hud_selfcheck.mjs
 *
 * Not part of `npm test`: it needs a live server on 3132. It costs nothing —
 * no model is called. Instead it pushes synthetic events through the page's own
 * `route()`, which is the same entry point the WebSocket uses, so what is
 * asserted is the shipped controller and the shipped CSS, not a copy of them.
 */
import { chromium } from "playwright";

const URL = process.env.HUD_URL ?? "http://127.0.0.1:3132";
let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? "  ok  " : "  FAIL"}  ${name}`);
  if (!cond) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => window.__carter);

// Drive the real controller with the events the loop emits.
await page.evaluate(() => {
  const h = window.__carter;
  h.route({ type: "model_selected", brain: "gpt", reason: "default", model: "openai/gpt-4.1", via: "openrouter.ai" });
  h.route({ type: "run_started" });
  h.route({ type: "tool_call_started", id: "t1", name: "web_search", args: { query: "local news" } });
  h.route({ type: "tool_call_started", id: "t2", name: "api_fetch", args: { url: "https://example.org" } });
  h.route({ type: "tool_call_finished", id: "t1", name: "web_search", ok: true, resultPreview: '{"results":[…]}' });
  h.route({ type: "tool_call_finished", id: "t2", name: "api_fetch", ok: false, resultPreview: '{"error":"fetch failed"}' });
  // A finish with no start — what a mid-run reconnect produces.
  h.route({ type: "tool_call_finished", id: "t3", name: "get_weather", ok: true, resultPreview: "{}" });
  h.route({ type: "assistant_message", text: "Three things happened today." });
});

const rows = page.locator("#tool-list .tool");
check("three tool rows in the rail", (await rows.count()) === 3);
check("success row marked ok", await rows.nth(0).evaluate((e) => e.classList.contains("ok")));
check("failed row marked err", await rows.nth(1).evaluate((e) => e.classList.contains("err")));
check("orphan finish still rendered", (await rows.nth(2).locator(".tool-name").textContent()) === "get_weather");
check("no row left spinning", (await page.locator("#tool-list .tool.run").count()) === 0);
check("duration shown", /\d+ ms/.test(await rows.nth(0).locator(".tool-ms").textContent()));
check("args shown", (await rows.nth(0).locator(".tool-args").textContent()).includes("local news"));
check("empty placeholder hidden", await page.locator("#tool-empty").evaluate((e) => e.classList.contains("hidden")));

// The point of the change: tool detail is NOT in the conversation.
const transcript = await page.locator("#transcript").innerText();
check("transcript free of tool detail", !transcript.includes("web_search") && !transcript.includes("api_fetch"));
check("answer still in transcript", transcript.includes("Three things happened today."));

check("model id shown", (await page.locator("#model-name").textContent()).includes("GPT-4.1"));
check("provider shown", (await page.locator("#model-via").textContent()) === "OPENROUTER.AI");

// Rail must actually sit beside the transcript, not under it.
const rail = await page.locator("#toolrail").boundingBox();
const main = await page.locator("#transcript").boundingBox();
check("rail is beside the transcript", rail.x >= main.x + main.width - 1);

// Local endpoints read differently — that distinction is the whole feature.
await page.evaluate(() => window.__carter.route(
  { type: "model_selected", brain: "gpt", reason: "d", model: "qwen2.5", via: "local" }));
check("local turn labelled LOCAL", (await page.locator("#model-via").textContent()) === "LOCAL");
check("local turn styled differently", await page.locator("#model-via").evaluate((e) => e.classList.contains("local")));

await page.screenshot({ path: "hud-check.png" });
await browser.close();
console.log(failures ? `\n${failures} failed\n` : "\nHUD ok — wrote hud-check.png\n");
process.exit(failures ? 1 : 0);

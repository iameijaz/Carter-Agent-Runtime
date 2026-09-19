/**
 * Telegram client for Carter.
 *
 * Consumes the same AgentEvent stream as the Web UI and CLI — no agent logic
 * lives here. Each Telegram chat_id gets its own AgentLoop (session) so
 * conversations are isolated. Streaming is emulated by editing the bot's
 * reply message as tokens arrive.
 *
 * Requires: TELEGRAM_BOT_TOKEN in .env.
 * Voice notes are transcribed via the same STT waterfall used by the Web UI.
 *
 * Run: npm run telegram   (add script to package.json, or invoke directly)
 */

import TelegramBot from "node-telegram-bot-api";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap } from "../bootstrap.js";
import type { AgentLoop } from "../agent/loop.js";
import type { AgentEvent } from "../agent/events.js";
import { config } from "../config.js";
import { transcribeBuffer } from "../server/transcribe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");

// How often to flush streamed tokens to Telegram (ms). Editing too fast hits
// rate limits; too slow feels laggy. 1 000ms is a safe middle ground.
const STREAM_FLUSH_INTERVAL_MS = 1000;

// Minimum accumulated text before the first edit (avoid editing an empty msg).
const MIN_FLUSH_CHARS = 20;

interface ChatSession {
  agent: AgentLoop;
  activeRun: AbortController | null;
}

export async function startTelegramClient(): Promise<void> {
  if (!config.telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set in .env");
  }

  const core = await bootstrap(ROOT_DIR);
  const bot = new TelegramBot(config.telegramBotToken, {
    polling: {
      interval: 1000,
      autoStart: true,
      params: { timeout: 30 },
    },
  });
  const sessions = new Map<number, ChatSession>();

  // If TELEGRAM_CHAT_ID is set, reject any message not from that chat.
  const allowedChatId = config.telegramChatId;
  const isAllowed = (chatId: number) => !allowedChatId || chatId === allowedChatId;

  console.log("[telegram] bot polling started" + (allowedChatId ? ` (locked to chat ${allowedChatId})` : ""));

  // Swallow transient network errors (ECONNRESET, timeouts) — polling will
  // automatically retry. Only log genuinely unexpected codes.
  bot.on("polling_error", (err) => {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") return;
    console.warn("[telegram] polling error:", err.message);
  });

  // EFATAL would otherwise kill the process — restart polling instead.
  bot.on("error", (err) => {
    console.warn("[telegram] error, restarting polling:", err.message);
    void bot.stopPolling().then(() => bot.startPolling()).catch(() => {});
  });

  function getSession(chatId: number): ChatSession {
    let session = sessions.get(chatId);
    if (!session) {
      session = { agent: core.createAgent(), activeRun: null };
      sessions.set(chatId, session);
    }
    return session;
  }

  async function runTurn(chatId: number, text: string): Promise<void> {
    const session = getSession(chatId);

    if (session.activeRun) {
      await bot.sendMessage(chatId, "⏳ Still working on the previous request — send /cancel to abort it.");
      return;
    }

    // Send a placeholder message we'll edit with streamed content.
    const placeholder = await bot.sendMessage(chatId, "…");
    const msgId = placeholder.message_id;

    const controller = new AbortController();
    session.activeRun = controller;

    let accumulated = "";
    let lastFlushed = "";
    let flushTimer: ReturnType<typeof setInterval> | null = null;

    const flush = async () => {
      if (accumulated === lastFlushed || accumulated.length < MIN_FLUSH_CHARS) return;
      const toSend = accumulated;
      lastFlushed = toSend;
      try {
        await bot.editMessageText(toSend, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
      } catch {
        // Telegram rejects identical edits — ignore those.
      }
    };

    flushTimer = setInterval(() => { void flush(); }, STREAM_FLUSH_INTERVAL_MS);

    const onEvent = (ev: AgentEvent) => {
      switch (ev.type) {
        case "token":
          accumulated += ev.text;
          break;
        case "tool_call_started":
          accumulated += `\n_[${ev.name}…]_\n`;
          break;
        case "tool_call_finished":
          // Strip the "…" placeholder and replace with ✓/✗
          accumulated = accumulated.replace(
            new RegExp(`\\[${ev.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}…\\]`),
            `[${ev.name} ${ev.ok ? "✓" : "✗"}]`
          );
          break;
        case "model_fallback":
          accumulated += `\n_[switched to ${ev.to}]_\n`;
          break;
        case "run_cancelled":
          accumulated += "\n_(cancelled)_";
          break;
        case "error":
          accumulated += `\n⚠️ ${ev.message}`;
          break;
      }
    };

    try {
      await session.agent.send(text, { onEvent, signal: controller.signal });
    } catch (err) {
      const msg = (err as Error).message;
      console.error("[telegram] agent error:", msg);
      accumulated += `\n⚠️ Agent error: ${msg}`;
    } finally {
      session.activeRun = null;
      if (flushTimer) clearInterval(flushTimer);

      // Final edit with complete content.
      const finalText = accumulated.trim() || "_(no response)_";
      if (finalText !== lastFlushed) {
        try {
          await bot.editMessageText(finalText, { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" });
        } catch {
          // If Markdown parse fails (e.g. unmatched backticks), fall back to plain.
          try {
            await bot.editMessageText(finalText, { chat_id: chatId, message_id: msgId });
          } catch {
            /* nothing more we can do */
          }
        }
      }
    }
  }

  // Text messages
  bot.on("message", (msg) => {
    const chatId = msg.chat.id;
    console.log(`[telegram] message from chat=${chatId} allowed=${isAllowed(chatId)} text=${msg.text?.slice(0,50)}`);
    if (!isAllowed(chatId)) return;
    const text = msg.text;
    if (!text) return; // handled separately for voice/audio

    if (text === "/start") {
      void bot.sendMessage(chatId, "👋 I'm Carter. Send me anything — questions, tasks, research, code. Use /cancel to abort a running task, /model to switch GPT ↔ Grok.");
      return;
    }
    if (text === "/cancel") {
      const session = sessions.get(chatId);
      if (session?.activeRun) {
        session.activeRun.abort();
        void bot.sendMessage(chatId, "Cancelled.");
      } else {
        void bot.sendMessage(chatId, "Nothing running.");
      }
      return;
    }

    // /model command — handled by AgentLoop, reply directly
    const session = getSession(chatId);
    const modelReply = session.agent.handleModelCommand(text);
    if (modelReply !== null) {
      void bot.sendMessage(chatId, modelReply);
      return;
    }

    void runTurn(chatId, text);
  });

  // Voice notes
  bot.on("voice", async (msg) => {
    const chatId = msg.chat.id;
    if (!isAllowed(chatId)) return;
    const fileId = msg.voice?.file_id;
    if (!fileId) return;

    const statusMsg = await bot.sendMessage(chatId, "🎤 Transcribing…");

    let tmpPath: string | null = null;
    try {
      // Download the voice note as a Buffer, write to a temp file, transcribe.
      const fileLink = await bot.getFileLink(fileId);
      const audioRes = await fetch(fileLink);
      if (!audioRes.ok) throw new Error(`Failed to download voice note: HTTP ${audioRes.status}`);
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

      tmpPath = join(tmpdir(), `carter_voice_${chatId}_${Date.now()}.oga`);
      writeFileSync(tmpPath, audioBuffer);

      const transcript = await transcribeBuffer(audioBuffer, "audio/ogg");

      await bot.editMessageText(`🎤 _${transcript}_`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: "Markdown" });
      void runTurn(chatId, transcript);
    } catch (err) {
      const message = (err as Error).message;
      console.error("[telegram] voice error:", message);
      try {
        await bot.editMessageText(`⚠️ Transcription failed: ${message}`, { chat_id: chatId, message_id: statusMsg.message_id });
      } catch {
        /* ignore */
      }
    } finally {
      if (tmpPath) try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("[telegram] shutting down…");
    bot.stopPolling();
    await core.mcp.closeAll();
    process.exit(0);
  });
}

// Entry point when run directly
startTelegramClient().catch((err) => {
  console.error("[telegram]", err);
  process.exit(1);
});

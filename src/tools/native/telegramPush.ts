/**
 * Telegram push tool — lets the agent send messages to the user's Telegram
 * chat from any client (Web UI, CLI). Uses the bot token + chat ID from .env.
 */

import { config } from "../../config.js";

export async function sendTelegramMessage(text: string): Promise<void> {
  if (!config.telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN not set in .env");
  if (!config.telegramChatId)   throw new Error("TELEGRAM_CHAT_ID not set in .env");

  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: "Markdown",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${err}`);
  }
}

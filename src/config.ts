import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name} (copy .env.example to .env)`);
  }
  return value;
}

/** First of `names` that is set. Throws naming all of them if none is. */
function requireOneOf(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  throw new Error(`Missing required env var: set one of ${names.join(", ")} (copy .env.example to .env)`);
}

export const config = {
  // Primary reasoning backend. Every provider worth using — OpenRouter,
  // OpenAI, Ollama, vLLM, LM Studio — speaks the OpenAI wire format, so the
  // SDK with a swapped baseURL *is* the abstraction; there is no per-vendor
  // code here by design. OpenRouter is the default because a reviewer must be
  // able to clone and run without a multi-GB model pull.
  llmApiKey: requireOneOf("OPENROUTER_API", "OPENAI_API_KEY"),
  llmBaseUrl:
    process.env.LLM_BASE_URL ??
    (process.env.OPENROUTER_API ? "https://openrouter.ai/api/v1" : undefined),
  llmModel: process.env.LLM_MODEL ?? process.env.OPENAI_MODEL ?? "openai/gpt-4.1",

  // Speech-to-text and other OpenAI-only endpoints need a real OpenAI key.
  // Optional: absent simply means those features are unavailable, which must
  // not stop the agent loop from booting.
  openaiApiKey: process.env.OPENAI_API_KEY,

  // Grok (xAI) — second brain used by the model router for social-sentiment/
  // trend queries and as the fallback when OpenAI errors. xAI's API is
  // OpenAI-compatible, so it's the same SDK with a different baseURL. Routing
  // is only active when this key is set.
  grokApiKey: process.env.GROK_API_KEY,
  grokModel: process.env.GROK_MODEL ?? "grok-4.3",
  grokBaseUrl: process.env.GROK_BASE_URL ?? "https://api.x.ai/v1",

  // Mailbox (IMAP read + SMTP send). Entirely env-driven: no host, address or
  // institution belongs in source. Absent credentials simply mean the email
  // tools refuse to run — they must not stop the runtime booting.
  mailImapHost: process.env.MAIL_IMAP_HOST,
  mailImapPort: Number(process.env.MAIL_IMAP_PORT ?? 993),
  mailSmtpHost: process.env.MAIL_SMTP_HOST,
  mailSmtpPort: Number(process.env.MAIL_SMTP_PORT ?? 465),
  mailUsername: process.env.MAIL_USERNAME,
  mailPassword: process.env.MAIL_PASSWORD,
  mailFrom: process.env.MAIL_FROM,
  // Only ever set this false against a host you control; it disables TLS
  // certificate verification.
  mailTlsVerify: process.env.MAIL_TLS_VERIFY !== "false",

  // Library catalogue (VuFind/finc, which many academic libraries run). The
  // catalogue base URL and institution code identify a specific library, so
  // they are configuration, not constants.
  libraryBaseUrl: process.env.LIBRARY_BASE_URL,
  libraryInstitution: process.env.LIBRARY_INSTITUTION,

  // Web server (src/server) — binds loopback-only by default; never widen
  // the host without adding auth first.
  carterPort: Number(process.env.CARTER_PORT ?? 3132),
  carterHost: process.env.CARTER_HOST ?? "127.0.0.1",

  // Telegram push for background-task updates (optional).
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,

  // Speech-to-text. OpenAI is the always-available provider (reuses
  // openaiApiKey); Deepgram Nova-3 is preferred when its key is present.
  transcribeModel: process.env.CARTER_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe",
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
};

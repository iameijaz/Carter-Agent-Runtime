/**
 * Config guards: the mailbox and catalogue tools must refuse to run when they
 * are not configured, and must refuse *before* touching the network.
 *
 * This is the path that the .env scrub created (2026-09-19). Previously both
 * tools carried working defaults, so "unconfigured" was unreachable; now it is
 * the default state for anyone who clones this repo, which makes it the most
 * likely first experience of these tools and worth a check.
 *
 * Run: npx tsx scripts/test_config_guards.ts
 */

import assert from "node:assert/strict";

// Blanked before the modules load — config reads process.env at import time.
// Set to "" rather than deleted: `src/config.ts` does `import "dotenv/config"`,
// and dotenv only fills vars that are *absent*, so a delete here would be undone
// by the owner's real .env and make "unconfigured" unreachable again.
for (const k of [
  "MAIL_IMAP_HOST", "MAIL_SMTP_HOST", "MAIL_USERNAME", "MAIL_PASSWORD",
  "MAIL_FROM", "LIBRARY_BASE_URL", "LIBRARY_INSTITUTION",
]) process.env[k] = "";

// Fail loudly rather than silently passing if a test ever reaches the network.
const realFetch = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("network reached: a guard let an unconfigured call through");
}) as typeof fetch;

const { librarySearch, libraryCheckAvailability } = await import("../src/tools/native/libraryCatalog.js");
const { emailFetch, emailSearch, emailFolders, emailSend } = await import("../src/tools/native/email.js");

/** Asserts `fn` rejects with a message matching `re`. Returns the message. */
async function rejects(label: string, fn: () => Promise<unknown>, re: RegExp): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assert.match(msg, re, `${label}: wrong error — ${msg}`);
    return msg;
  }
  assert.fail(`${label}: resolved instead of refusing while unconfigured`);
}

async function main() {
  // Catalogue: every entry point must refuse, not just the one we remembered.
  await rejects("librarySearch", () => librarySearch("any title"), /not configured|LIBRARY_BASE_URL/i);
  await rejects("libraryCheckAvailability", () => libraryCheckAvailability("any title"), /not configured|LIBRARY_BASE_URL/i);

  // Mailbox: same, across read, search, list and send.
  await rejects("emailFetch", () => emailFetch(), /not configured|MAIL_/i);
  await rejects("emailSearch", () => emailSearch("q"), /not configured|MAIL_/i);
  await rejects("emailFolders", () => emailFolders(), /not configured|MAIL_/i);
  await rejects("emailSend", () => emailSend("a@b.c", "s", "b"), /not configured|MAIL_/i);

  // The refusal must name the variable to set — a bare "not configured" leaves
  // the user guessing which of seven MAIL_* vars is missing.
  const msg = await rejects("emailFetch message", () => emailFetch(), /MAIL_/);
  assert.ok(/MAIL_USERNAME|MAIL_PASSWORD/.test(msg), `message should name the missing var — got: ${msg}`);

  globalThis.fetch = realFetch;
  console.log("config guards: 7 assertions passed — no unconfigured call reached the network");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

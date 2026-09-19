/**
 * Mailbox access — pure Node.js IMAP/SMTP client via `imapflow` + `nodemailer`.
 *
 * Every endpoint and credential comes from config; there is no default host and
 * no address in this file. That is deliberate: a hard-coded mail host names the
 * person who wrote it, and this runtime is meant to be published.
 */

import { config } from "../../config.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/** Throws unless a host and both credentials are configured. */
function checkCreds() {
  if (!config.mailUsername || !config.mailPassword) {
    throw new Error("Mailbox not configured: set MAIL_USERNAME and MAIL_PASSWORD in .env");
  }
  if (!config.mailImapHost && !config.mailSmtpHost) {
    throw new Error("Mailbox not configured: set MAIL_IMAP_HOST and/or MAIL_SMTP_HOST in .env");
  }
}

function buildImapClient() {
  const { ImapFlow } = require("imapflow");
  return new ImapFlow({
    host:   config.mailImapHost,
    port:   config.mailImapPort,
    secure: true,
    auth:   { user: config.mailUsername, pass: config.mailPassword },
    logger: false,
    tls:    { rejectUnauthorized: config.mailTlsVerify },
  });
}

export async function emailFetch(folder = "INBOX", limit = 10, unreadOnly = false) {
  checkCreds();
  const client = buildImapClient();
  await client.connect();
  const messages: object[] = [];
  try {
    await client.mailboxOpen(folder);
    const criteria = unreadOnly ? { seen: false } : { all: true };
    const uids: number[] = [];
    for await (const msg of client.fetch(criteria, { uid: true })) {
      uids.push(msg.uid);
    }
    const toFetch = uids.slice(-limit);
    for await (const msg of client.fetch(toFetch, {
      envelope: true, bodyStructure: true, bodyParts: ["text"], uid: true, flags: true,
    }, { uid: true })) {
      const env = msg.envelope;
      messages.push({
        uid:      msg.uid,
        subject:  env?.subject ?? "",
        from:     env?.from?.[0]?.address ?? "",
        date:     env?.date?.toISOString() ?? "",
        unread:   !msg.flags?.has("\\Seen"),
        body:     (msg.bodyParts?.get("text") as Buffer | undefined)
                    ?.toString("utf-8")?.slice(0, 1500) ?? "",
      });
    }
  } finally {
    await client.logout();
  }
  return { folder, total: messages.length, messages: messages.reverse() };
}

export async function emailSearch(query: string, limit = 10) {
  checkCreds();
  const client = buildImapClient();
  await client.connect();
  const messages: object[] = [];
  try {
    await client.mailboxOpen("INBOX");
    const uids: number[] = [];
    for await (const msg of client.fetch(
      { or: [{ header: ["subject", query] }, { body: query }] },
      { uid: true }
    )) {
      uids.push(msg.uid);
    }
    const toFetch = uids.slice(-limit);
    for await (const msg of client.fetch(toFetch, {
      envelope: true, bodyParts: ["text"], uid: true, flags: true,
    }, { uid: true })) {
      const env = msg.envelope;
      messages.push({
        uid:     msg.uid,
        subject: env?.subject ?? "",
        from:    env?.from?.[0]?.address ?? "",
        date:    env?.date?.toISOString() ?? "",
        body:    (msg.bodyParts?.get("text") as Buffer | undefined)
                   ?.toString("utf-8")?.slice(0, 1000) ?? "",
      });
    }
  } finally {
    await client.logout();
  }
  return { query, total: messages.length, messages: messages.reverse() };
}

export async function emailSend(to: string, subject: string, body: string) {
  checkCreds();
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host:   config.mailSmtpHost,
    port:   config.mailSmtpPort,
    secure: true,
    auth:   { user: config.mailUsername, pass: config.mailPassword },
    tls:    { rejectUnauthorized: config.mailTlsVerify },
  });
  await transporter.sendMail({ from: config.mailFrom, to, subject, text: body });
  return { sent: true, to, subject };
}

export async function emailFolders() {
  checkCreds();
  const client = buildImapClient();
  await client.connect();
  try {
    const list = await client.list();
    return { folders: list.map((f: any) => f.path) };
  } finally {
    await client.logout();
  }
}

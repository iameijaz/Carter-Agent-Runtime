/**
 * Native Windows toast notifications via node-notifier (Windows 8+).
 * Three urgency levels, each with a distinct sound:
 *   info    — silent / soft chime
 *   warning — Windows default notification sound
 *   urgent  — Windows critical alert sound, stays on screen longer
 *
 * Falls back gracefully on non-Windows or if node-notifier isn't installed.
 */

import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export type NotificationLevel = "info" | "warning" | "urgent";

export interface NotificationOptions {
  title: string;
  message: string;
  level?: NotificationLevel;
  /** Override the sound. Pass false to silence. */
  sound?: string | boolean;
  /** Auto-dismiss after N seconds (0 = stay until dismissed) */
  timeout?: number;
}

// Windows system sounds mapped to levels
const LEVEL_SOUNDS: Record<NotificationLevel, string> = {
  info:    "Notification.Default",   // soft, non-intrusive
  warning: "Notification.Reminder",  // draws attention
  urgent:  "Notification.Looping.Alarm", // hard to miss
};

const LEVEL_ICONS: Record<NotificationLevel, string> = {
  info:    "info",
  warning: "warn",
  urgent:  "error",
};

/** Send a native notification. Returns true if sent, false if unavailable. */
export async function notify(opts: NotificationOptions): Promise<boolean> {
  const level = opts.level ?? "info";

  // Try node-notifier first (cross-platform, richer options)
  try {
    const notifier = require("node-notifier");
    await new Promise<void>((resolve) => {
      notifier.notify({
        title:   opts.title,
        message: opts.message,
        icon:    LEVEL_ICONS[level],
        sound:   opts.sound !== undefined ? opts.sound : (level !== "info"),
        wait:    level === "urgent",
        timeout: opts.timeout ?? (level === "urgent" ? 0 : 10),
        appID:   "Carter Intelligence Core",
      }, () => resolve());
    });
    return true;
  } catch { /* node-notifier not installed — fall through */ }

  // Windows-only fallback via PowerShell toast (no deps needed)
  if (process.platform === "win32") {
    return sendPowerShellToast(opts.title, opts.message, level, opts.timeout ?? 10);
  }

  console.log(`[notify] ${level.toUpperCase()}: ${opts.title} — ${opts.message}`);
  return false;
}

function sendPowerShellToast(
  title: string,
  message: string,
  level: NotificationLevel,
  timeout: number,
): Promise<boolean> {
  const sound = LEVEL_SOUNDS[level];
  const duration = level === "urgent" ? "long" : "short";

  // Escape single quotes for PowerShell
  const t = title.replace(/'/g, "''");
  const m = message.replace(/'/g, "''");

  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = @"
<toast duration='${duration}'>
  <audio src='ms-winsoundevent:${sound}' />
  <visual><binding template='ToastGeneric'>
    <text>${t}</text>
    <text>${m}</text>
  </binding></visual>
</toast>
"@
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = New-Object Windows.UI.Notifications.ToastNotification($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Carter').Show($toast)
  `.trim();

  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 10000 },
      (err) => resolve(!err)
    );
  });
}

/** Convenience wrappers */
export const notifyInfo    = (title: string, message: string) => notify({ title, message, level: "info" });
export const notifyWarning = (title: string, message: string) => notify({ title, message, level: "warning" });
export const notifyUrgent  = (title: string, message: string) => notify({ title, message, level: "urgent" });

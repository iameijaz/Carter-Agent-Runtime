/**
 * OS Vision Control — Carter's eyes and hands for the entire OS.
 *
 * Perception → Reasoning → Action → Verification loop:
 *   1. capture_screen   — take a screenshot (PowerShell, no deps)
 *   2. vision_locate    — find a UI element by natural language description
 *                         Fallback chain: GPT-4o → llava/moondream2 → jimp template match → HIL
 *   3. mouse_click      — move + click at (x,y) — REQUIRES HIL approval first
 *   4. mouse_move       — move to (x,y) without clicking
 *   5. keyboard_type    — type text at current focus
 *   6. hotkey           — send key combo e.g. ["ctrl","c"]
 *   7. get_cursor_pos   — return current mouse position
 *   8. vision_act       — full closed loop: locate + show HIL + act + verify
 */

import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../../..");
const SCREENSHOT_DIR = path.join(ROOT_DIR, "workspace", "vision-screenshots");

// HIL approval registry — pending approvals waiting for user response
type HilApproval = {
  resolve: (approved: boolean) => void;
  screenshotPath: string;
  screenshotBase64: string;
  action: string;
  x: number;
  y: number;
  description: string;
};
const pendingApprovals = new Map<string, HilApproval>();
let hilEmitter: ((event: VisionHilEvent) => void) | null = null;

export type VisionHilEvent = {
  type: "vision_hil";
  approvalId: string;
  screenshotBase64: string;
  action: string;
  x: number;
  y: number;
  description: string;
  timeoutMs: number;
};

/** Register a broadcaster so the agent loop can emit HIL events to the UI. */
export function registerVisionHilEmitter(fn: (ev: VisionHilEvent) => void) {
  hilEmitter = fn;
}

/** Called by ws.ts when the user approves or rejects a vision HIL. */
export function resolveVisionHil(approvalId: string, approved: boolean) {
  const pending = pendingApprovals.get(approvalId);
  if (pending) {
    pendingApprovals.delete(approvalId);
    pending.resolve(approved);
  }
}

// ── Screenshot ────────────────────────────────────────────────────────────────

export async function captureScreen(monitor = 0): Promise<{ path: string; base64: string; width: number; height: number }> {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const ts = Date.now();
  const outPath = path.join(SCREENSHOT_DIR, `screen-${ts}.png`);

  // PowerShell screen capture — no extra deps, works on all Windows machines
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$screen = $screens[${monitor}]
$bmp = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size)
$bmp.Save('${outPath.replace(/\\/g, "\\\\")}')
$gfx.Dispose(); $bmp.Dispose()
Write-Output "$($screen.Bounds.Width)x$($screen.Bounds.Height)"
`.trim();

  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", ps
  ], { timeout: 10000 });

  const [w, h] = stdout.trim().split("x").map(Number);
  const base64 = (await readFile(outPath)).toString("base64");
  return { path: outPath, base64, width: w || 1920, height: h || 1080 };
}

// ── Vision Locate — 4-tier fallback ──────────────────────────────────────────

export type LocateResult = {
  x: number;
  y: number;
  confidence: number;
  method: "gpt4o" | "local_llm" | "template" | "hil";
  description: string;
};

export async function visionLocate(
  screenshotBase64: string,
  description: string,
  screenshotPath: string,
): Promise<LocateResult | null> {

  // Tier 1: GPT-4o vision
  try {
    const result = await locateWithGpt4o(screenshotBase64, description);
    if (result) return { ...result, method: "gpt4o", description };
  } catch (err) {
    console.warn("[vision] GPT-4o locate failed:", (err as Error).message);
  }

  // Tier 2: Local LLM via llama.cpp (if LLAMA_SERVER_URL set)
  if (process.env.LLAMA_SERVER_URL) {
    try {
      const result = await locateWithLocalLlm(screenshotBase64, description);
      if (result) return { ...result, method: "local_llm", description };
    } catch (err) {
      console.warn("[vision] local LLM locate failed:", (err as Error).message);
    }
  }

  // Tier 3: Template matching via jimp
  try {
    const result = await locateWithTemplateMatch(screenshotPath, description);
    if (result) return { ...result, method: "template", description };
  } catch (err) {
    console.warn("[vision] template match failed:", (err as Error).message);
  }

  // Tier 4: HIL — show screenshot to user, ask them to provide coordinates
  return null; // caller handles HIL escalation
}

async function locateWithGpt4o(base64: string, description: string): Promise<{ x: number; y: number; confidence: number } | null> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 100,
    messages: [{
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${base64}`, detail: "high" },
        },
        {
          type: "text",
          text: `Find "${description}" on this screenshot. Reply with ONLY a JSON object: {"x": <pixel_x>, "y": <pixel_y>, "confidence": <0.0-1.0>}. x and y are the center pixel coordinates of the element. If not found, reply: {"x": null, "y": null, "confidence": 0}`,
        },
      ],
    }],
  });

  const text = response.choices[0]?.message?.content?.trim() ?? "";
  const match = text.match(/\{[^}]+\}/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]);
  if (!parsed.x || !parsed.y) return null;
  return { x: Math.round(parsed.x), y: Math.round(parsed.y), confidence: parsed.confidence ?? 0.8 };
}

async function locateWithLocalLlm(base64: string, description: string): Promise<{ x: number; y: number; confidence: number } | null> {
  const url = `${process.env.LLAMA_SERVER_URL}/v1/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "moondream2",
      max_tokens: 100,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
          { type: "text", text: `Find "${description}". Reply ONLY: {"x": <px>, "y": <px>, "confidence": <0-1>}` },
        ],
      }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Local LLM HTTP ${res.status}`);
  const data = await res.json() as { choices: { message: { content: string } }[] };
  const text = data.choices[0]?.message?.content ?? "";
  const match = text.match(/\{[^}]+\}/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]);
  if (!parsed.x || !parsed.y) return null;
  return { x: Math.round(parsed.x), y: Math.round(parsed.y), confidence: parsed.confidence ?? 0.6 };
}

async function locateWithTemplateMatch(screenshotPath: string, description: string): Promise<{ x: number; y: number; confidence: number } | null> {
  // Jimp-based: look for common UI patterns by text label in description
  // This is a heuristic — works for finding taskbar icons, window titles by region
  try {
    const { Jimp } = await import("jimp");
    const img = await Jimp.read(screenshotPath);
    const w = img.bitmap.width;
    const h = img.bitmap.height;

    // Heuristic zones based on common description keywords
    const desc = description.toLowerCase();
    if (desc.includes("taskbar") || desc.includes("start")) {
      return { x: 30, y: h - 20, confidence: 0.4 };
    }
    if (desc.includes("search bar") || desc.includes("address bar")) {
      return { x: Math.round(w * 0.4), y: 45, confidence: 0.35 };
    }
    if (desc.includes("close") || desc.includes("× button") || desc.includes("x button")) {
      return { x: w - 20, y: 15, confidence: 0.35 };
    }
    if (desc.includes("maximize")) {
      return { x: w - 55, y: 15, confidence: 0.35 };
    }
    if (desc.includes("minimize")) {
      return { x: w - 90, y: 15, confidence: 0.35 };
    }
  } catch {
    // jimp not installed — skip silently
  }
  return null;
}

// ── Mouse + Keyboard control via nutjs ───────────────────────────────────────

async function getNut() {
  // Try @nut-tree-fork/nut-js first, then @nut-tree/nut-js
  try {
    const m = await import("@nut-tree-fork/nut-js");
    return m;
  } catch {
    try {
      const m = await import("@nut-tree/nut-js");
      return m;
    } catch {
      throw new Error("nut-js not installed. Run scripts\\setup-vision.cmd first.");
    }
  }
}

export async function mouseMove(x: number, y: number): Promise<void> {
  const nut = await getNut();
  await nut.mouse.move(nut.straightTo(nut.centerOf(Promise.resolve(new nut.Region(x, y, 1, 1)))));
}

export async function mouseClick(x: number, y: number, button: "left" | "right" | "middle" = "left"): Promise<void> {
  const nut = await getNut();
  // Move to position first
  await nut.mouse.setPosition({ x, y });
  await nut.mouse.click(button === "left" ? nut.Button.LEFT : button === "right" ? nut.Button.RIGHT : nut.Button.MIDDLE);
}

export async function keyboardType(text: string): Promise<void> {
  const nut = await getNut();
  await nut.keyboard.type(text);
}

export async function sendHotkey(keys: string[]): Promise<void> {
  const nut = await getNut();
  // Map string key names to nut Key enum
  const KEY_MAP: Record<string, unknown> = {
    ctrl: nut.Key.LeftControl, control: nut.Key.LeftControl,
    shift: nut.Key.LeftShift, alt: nut.Key.LeftAlt,
    win: nut.Key.LeftSuper, cmd: nut.Key.LeftSuper,
    enter: nut.Key.Return, return: nut.Key.Return,
    escape: nut.Key.Escape, esc: nut.Key.Escape,
    tab: nut.Key.Tab, space: nut.Key.Space,
    backspace: nut.Key.Backspace, delete: nut.Key.Delete,
    up: nut.Key.Up, down: nut.Key.Down, left: nut.Key.Left, right: nut.Key.Right,
    home: nut.Key.Home, end: nut.Key.End, pageup: nut.Key.PageUp, pagedown: nut.Key.PageDown,
    f1: nut.Key.F1, f2: nut.Key.F2, f3: nut.Key.F3, f4: nut.Key.F4,
    f5: nut.Key.F5, f6: nut.Key.F6, f7: nut.Key.F7, f8: nut.Key.F8,
    f9: nut.Key.F9, f10: nut.Key.F10, f11: nut.Key.F11, f12: nut.Key.F12,
    a: nut.Key.A, b: nut.Key.B, c: nut.Key.C, d: nut.Key.D, e: nut.Key.E,
    f: nut.Key.F, g: nut.Key.G, h: nut.Key.H, i: nut.Key.I, j: nut.Key.J,
    k: nut.Key.K, l: nut.Key.L, m: nut.Key.M, n: nut.Key.N, o: nut.Key.O,
    p: nut.Key.P, q: nut.Key.Q, r: nut.Key.R, s: nut.Key.S, t: nut.Key.T,
    u: nut.Key.U, v: nut.Key.V, w: nut.Key.W, x: nut.Key.X, y: nut.Key.Y, z: nut.Key.Z,
  };
  const mapped = keys.map(k => KEY_MAP[k.toLowerCase()]).filter(Boolean) as unknown[];
  if (mapped.length !== keys.length) {
    throw new Error(`Unknown key(s): ${keys.filter(k => !KEY_MAP[k.toLowerCase()])}`);
  }
  await nut.keyboard.pressKey(...(mapped as Parameters<typeof nut.keyboard.pressKey>));
  await nut.keyboard.releaseKey(...(mapped as Parameters<typeof nut.keyboard.releaseKey>));
}

export async function getCursorPos(): Promise<{ x: number; y: number }> {
  const nut = await getNut();
  return nut.mouse.getPosition();
}

/** List open windows — returns title + handle for targeting. */
export async function listWindows(): Promise<Array<{ title: string; handle: string; process: string }>> {
  const ps = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
public class WinList {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lp, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  public static List<string[]> List() {
    var result = new List<string[]>();
    EnumWindows((h, lp) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      string title = sb.ToString().Trim();
      if (string.IsNullOrEmpty(title)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string proc = "";
      try { proc = Process.GetProcessById((int)pid).ProcessName; } catch {}
      result.Add(new string[]{ h.ToString(), title, proc });
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@
[WinList]::List() | ForEach-Object { "$($_[0])|$($_[1])|$($_[2])" }
`.trim();
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", ps
  ], { timeout: 10000 });
  return stdout.trim().split("\n").filter(Boolean).map(line => {
    const [handle, title, process] = line.trim().split("|");
    return { handle: handle ?? "", title: title ?? "", process: process ?? "" };
  });
}

/**
 * Type text directly into a window by title (partial match) — without needing
 * it to be focused. Uses PostMessage WM_CHAR to send characters to the window's
 * focused edit control via Win32 API.
 *
 * For richer input (special keys, combos), falls back to: focus window briefly →
 * type → restore previous focus.
 */
export async function typeToWindow(windowTitle: string, text: string, method: "postmessage" | "focus_and_type" = "focus_and_type"): Promise<{ success: boolean; window: string; message: string }> {
  if (method === "focus_and_type") {
    // Find window, bring to foreground briefly, type, then return
    const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinCtrl {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lp, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  public static IntPtr FindByTitle(string partial) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, lp) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString().IndexOf(partial, StringComparison.OrdinalIgnoreCase) >= 0) {
        found = h; return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$hwnd = [WinCtrl]::FindByTitle("${windowTitle.replace(/"/g, '\\"')}")
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NOT_FOUND"; exit }
[WinCtrl]::ShowWindow($hwnd, 9)  # SW_RESTORE
[WinCtrl]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 300
Write-Output "FOCUSED:$hwnd"
`.trim();
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command", ps
    ], { timeout: 8000 });

    if (stdout.trim() === "NOT_FOUND") {
      return { success: false, window: windowTitle, message: `No window found matching "${windowTitle}"` };
    }

    const foundTitle = stdout.trim().replace("FOCUSED:", "");
    // Now type using nut-js — window is in foreground
    await new Promise(r => setTimeout(r, 200));
    const nut = await getNut();
    await nut.keyboard.type(text);

    return { success: true, window: foundTitle, message: `Typed into "${windowTitle}" (brought to foreground temporarily)` };
  }

  // PostMessage method — truly background, no focus change
  // Uses WM_CHAR (0x0102) for each character
  const chars = Array.from(text).map(c => c.charCodeAt(0));
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinPost {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lp, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string cls, string ttl);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  public static IntPtr FindByTitle(string partial) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, lp) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString().IndexOf(partial, StringComparison.OrdinalIgnoreCase) >= 0) {
        found = h; return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void PostChars(IntPtr hwnd, int[] chars) {
    // Try to find the edit control child first
    IntPtr edit = FindWindowEx(hwnd, IntPtr.Zero, "Edit", null);
    IntPtr target = edit != IntPtr.Zero ? edit : hwnd;
    foreach (int c in chars) {
      PostMessage(target, 0x0102, new IntPtr(c), IntPtr.Zero);
    }
  }
}
"@
$hwnd = [WinPost]::FindByTitle("${windowTitle.replace(/"/g, '\\"')}")
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "NOT_FOUND"; exit }
[WinPost]::PostChars($hwnd, @(${chars.join(",")}))
Write-Output "OK:$hwnd"
`.trim();
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", ps
  ], { timeout: 8000 });

  if (stdout.trim() === "NOT_FOUND") {
    return { success: false, window: windowTitle, message: `No window found matching "${windowTitle}"` };
  }
  return { success: true, window: stdout.trim(), message: `Posted ${chars.length} chars to "${windowTitle}" without focusing it` };
}

// ── HIL approval gate ─────────────────────────────────────────────────────────

async function requestHilApproval(
  screenshotPath: string,
  screenshotBase64: string,
  action: string,
  x: number,
  y: number,
  description: string,
): Promise<boolean> {
  if (!hilEmitter) {
    // No UI connected — auto-deny for safety
    throw new Error("No HIL emitter registered. Cannot approve OS action without UI connection.");
  }

  const approvalId = Math.random().toString(36).slice(2);
  const timeoutMs = Number(process.env.VISION_HIL_TIMEOUT ?? 30000);

  return new Promise((resolve) => {
    pendingApprovals.set(approvalId, {
      resolve,
      screenshotPath,
      screenshotBase64,
      action,
      x,
      y,
      description,
    });

    hilEmitter!({
      type: "vision_hil",
      approvalId,
      screenshotBase64,
      action,
      x,
      y,
      description,
      timeoutMs,
    });

    // Auto-deny after timeout
    setTimeout(() => {
      if (pendingApprovals.has(approvalId)) {
        pendingApprovals.delete(approvalId);
        resolve(false);
      }
    }, timeoutMs);
  });
}

// ── Public high-level API (used by tool handlers) ────────────────────────────

export async function visionAct(goal: string, monitor = 0): Promise<{
  success: boolean;
  method: string;
  x?: number;
  y?: number;
  screenshotBefore?: string;
  screenshotAfter?: string;
  message: string;
}> {
  // Step 1: capture screen
  const before = await captureScreen(monitor);

  // Step 2: locate target
  const located = await visionLocate(before.base64, goal, before.path);

  if (!located) {
    // All vision tiers failed — HIL escalation
    const approved = await requestHilApproval(
      before.path, before.base64,
      "vision_locate_failed", 0, 0,
      `Could not locate "${goal}" automatically. Please click the target.`,
    );
    return {
      success: false,
      method: "hil_escalated",
      screenshotBefore: before.path,
      message: approved
        ? "User acknowledged — please provide coordinates manually."
        : "Action cancelled by user.",
    };
  }

  // Step 3: HIL approval before acting
  const approved = await requestHilApproval(
    before.path, before.base64,
    "mouse_click", located.x, located.y,
    `Click on "${goal}" at (${located.x}, ${located.y}) — found by ${located.method} with ${Math.round(located.confidence * 100)}% confidence`,
  );

  if (!approved) {
    return {
      success: false,
      method: located.method,
      x: located.x,
      y: located.y,
      screenshotBefore: before.path,
      message: "Action cancelled by user.",
    };
  }

  // Step 4: execute click
  await mouseClick(located.x, located.y);
  await new Promise(r => setTimeout(r, 500)); // let UI settle

  // Step 5: verify — capture again
  const after = await captureScreen(monitor);

  return {
    success: true,
    method: located.method,
    x: located.x,
    y: located.y,
    screenshotBefore: before.path,
    screenshotAfter: after.path,
    message: `Clicked "${goal}" at (${located.x}, ${located.y}) via ${located.method}.`,
  };
}

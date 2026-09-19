/**
 * In-process memory scheduler — no node-cron. A single hourly setInterval tick:
 *
 *   - nightly consolidation: once per day, after 03:00 local, only when idle.
 *   - weekly archive/synthesis: on Sundays, after nightly has run, only when idle.
 *
 * "Idle" = no active chat run and no running background task, so heavy LLM
 * passes never fight the user for the brain. Last-run stamps persist to a small
 * JSON file so a restart doesn't double-run or skip a day.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nightly, weekly } from "./consolidate.js";
import { listBackgroundTaskStatuses } from "../agent/backgroundRunner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const STAMP = path.join(ROOT, ".memory", "scheduler.json");

const TICK_MS = 60 * 60 * 1000; // hourly

interface Stamps { lastNightly?: string; lastWeekly?: string; }

function loadStamps(): Stamps {
  try { return existsSync(STAMP) ? JSON.parse(readFileSync(STAMP, "utf-8")) : {}; }
  catch { return {}; }
}
function saveStamps(s: Stamps) {
  mkdirSync(path.dirname(STAMP), { recursive: true });
  writeFileSync(STAMP, JSON.stringify(s, null, 2), "utf-8");
}

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

/** Any running background task means the brain is busy. */
async function bgBusy(): Promise<boolean> {
  try { return (await listBackgroundTaskStatuses()).some((t) => t.running); }
  catch { return false; }
}

/**
 * @param isBusy extra idleness probe from the server (e.g. an active chat run).
 *               Returns true when a user run is in flight.
 */
export function startScheduler(isBusy: () => boolean = () => false): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const stamps = loadStamps();
      const idle = !isBusy() && !(await bgBusy());
      if (!idle) return;

      // Nightly: after 03:00, once per calendar day.
      if (now.getHours() >= 3 && stamps.lastNightly !== dayKey(now)) {
        try { await nightly(now.getTime()); stamps.lastNightly = dayKey(now); saveStamps(stamps); }
        catch (e) { console.error("[memory] nightly failed:", (e as Error).message); }
      }

      // Weekly: Sundays, once per day-key, after nightly.
      if (now.getDay() === 0 && stamps.lastWeekly !== dayKey(now) && stamps.lastNightly === dayKey(now)) {
        try { await weekly(now); stamps.lastWeekly = dayKey(now); saveStamps(stamps); }
        catch (e) { console.error("[memory] weekly failed:", (e as Error).message); }
      }
    } finally {
      running = false;
    }
  };

  const handle = setInterval(() => void tick(), TICK_MS);
  handle.unref?.();
  void tick(); // probe once at boot (catches a missed nightly after downtime)
  console.log("[memory] scheduler started (hourly tick)");
  return () => clearInterval(handle);
}

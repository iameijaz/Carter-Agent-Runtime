/**
 * Train / public-transport journeys via Transitous (MOTIS) — free, keyless, and
 * covers Deutsche Bahn plus regional operators.
 *
 * Two-step like every journey planner: resolve each place name to a stop id,
 * then plan. `when` defaults to now, so "trains from now" just works.
 */

const API = "https://api.transitous.org/api/v1";

export interface JourneyLeg {
  line: string;          // "ICE 598", "RE6", "walk"
  from: string;
  to: string;
  departure: string;     // ISO
  arrival: string;
  departure_platform?: string;
  arrival_platform?: string;
  mode: string;
  realtime: boolean;
}

export interface Journey {
  departure: string;
  arrival: string;
  duration_min: number;
  transfers: number;
  legs: JourneyLeg[];
}

async function resolve(place: string): Promise<{ id: string; name: string }> {
  const res = await fetch(`${API}/geocode?text=${encodeURIComponent(place)}`, {
    headers: { "User-Agent": "Carter/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`geocode "${place}": HTTP ${res.status}`);
  const hits = (await res.json()) as Array<{ id: string; name: string; type: string }>;
  // Prefer actual stops over addresses/places.
  const hit = hits.find((h) => h.type === "STOP") ?? hits[0];
  if (!hit) throw new Error(`No station found for "${place}".`);
  return { id: hit.id, name: hit.name };
}

/** Plan journeys between two places. `when` is an ISO time or undefined for now. */
export async function trainJourneys(
  from: string,
  to: string,
  when?: string,
  results = 4,
): Promise<{ from: string; to: string; journeys: Journey[]; source: string }> {
  const [a, b] = await Promise.all([resolve(from), resolve(to)]);

  const time = when ? new Date(when) : new Date();
  if (Number.isNaN(time.getTime())) throw new Error(`Could not read the time "${when}".`);

  const url =
    `${API}/plan?fromPlace=${encodeURIComponent(a.id)}&toPlace=${encodeURIComponent(b.id)}` +
    `&time=${encodeURIComponent(time.toISOString())}&numItineraries=${Math.min(results, 6)}`;
  const res = await fetch(url, { headers: { "User-Agent": "Carter/1.0" }, signal: AbortSignal.timeout(30_000) });
  // A bare status code teaches the caller — and mistake memory — nothing. The
  // overwhelmingly common cause of a 400 here is a `when` the planner will not
  // serve, so name it: a lesson recorded from this string has to be actionable.
  if (!res.ok) {
    const stale = time.getTime() < Date.now() - 86_400_000;
    throw new Error(
      `journey planner rejected the request (HTTP ${res.status})` +
      (stale
        ? `: \`when\` was ${time.toISOString()}, which is in the past. Timetables only ` +
          `cover the near future — pass an upcoming timestamp.`
        : `. Check \`when\` (${time.toISOString()}) is a near-future ISO timestamp.`),
    );
  }
  const data = (await res.json()) as { itineraries?: any[] };

  const journeys: Journey[] = (data.itineraries ?? []).map((it) => ({
    departure: it.startTime,
    arrival: it.endTime,
    duration_min: Math.round((it.duration ?? 0) / 60),
    transfers: it.transfers ?? 0,
    legs: (it.legs ?? []).map((l: any): JourneyLeg => ({
      line: l.routeShortName ?? l.mode ?? "?",
      from: l.from?.name ?? "",
      to: l.to?.name ?? "",
      departure: l.startTime,
      arrival: l.endTime,
      departure_platform: l.from?.track,
      arrival_platform: l.to?.track,
      mode: l.mode ?? "",
      realtime: Boolean(l.realTime),
    })),
  }));

  if (!journeys.length) throw new Error(`No connections found from ${a.name} to ${b.name}.`);
  return { from: a.name, to: b.name, journeys, source: "transitous.org (MOTIS)" };
}

const esc = (s: string) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
const hhmm = (iso: string) => (iso ? new Date(iso).toTimeString().slice(0, 5) : "--:--");

/** A self-contained departure board for the HUD — the tool renders its own UI. */
export function renderJourneysHtml(data: Awaited<ReturnType<typeof trainJourneys>>): string {
  const rows = data.journeys.map((j) => {
    const legs = j.legs.filter((l) => l.mode !== "WALK");
    const lines = legs.map((l) => `<span class="line">${esc(l.line)}</span>`).join('<span class="arr">›</span>');
    const plat = legs[0]?.departure_platform;
    return `<div class="j">
      <div class="times"><b>${hhmm(j.departure)}</b><span class="dash">→</span><b>${hhmm(j.arrival)}</b></div>
      <div class="meta">${Math.floor(j.duration_min / 60)}h ${j.duration_min % 60}m · ${j.transfers} change${j.transfers === 1 ? "" : "s"}${plat ? ` · pl. ${esc(plat)}` : ""}</div>
      <div class="lines">${lines || "—"}</div>
    </div>`;
  }).join("");

  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#01060d;color:#bfe6ff;font:13px/1.5 "Segoe UI",system-ui,sans-serif;padding:14px}
h1{font-size:11px;letter-spacing:.18em;color:#00c8ff;text-transform:uppercase;margin-bottom:2px}
.sub{font-size:10px;color:#3d6a8c;margin-bottom:12px}
.j{border:1px solid #0d3a5c;border-left:2px solid #00c8ff;border-radius:4px;padding:9px 11px;margin-bottom:8px;background:rgba(0,40,70,.25)}
.times{font-size:17px;color:#fff;display:flex;align-items:center;gap:8px}
.dash{color:#3d6a8c;font-size:13px}
.meta{font-size:11px;color:#3d6a8c;margin-top:2px}
.lines{margin-top:6px;display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.line{background:rgba(0,200,255,.12);border:1px solid rgba(0,200,255,.3);color:#00c8ff;border-radius:3px;padding:1px 7px;font-size:11px;font-weight:600}
.arr{color:#3d6a8c;font-size:10px}
</style>
<h1>${esc(data.from)} → ${esc(data.to)}</h1>
<div class="sub">live · ${esc(data.source)}</div>
${rows}`;
}

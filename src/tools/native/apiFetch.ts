/**
 * Raw HTTP GET for JSON/text APIs. Unlike web_fetch (Readability article
 * extraction, useless on JSON), this returns the response body as-is so the
 * agent can hit keyless APIs (wttr.in, open-meteo, frankfurter.app, …).
 */

const DEFAULT_MAX = 65_536;
const HARD_CAP = 262_144;

export interface ApiFetchResult {
  status: number;
  contentType: string;
  truncated: boolean;
  body: unknown; // parsed object for JSON, else string
}

export async function apiFetch(
  url: string,
  headers: Record<string, string> = {},
  maxBytes = DEFAULT_MAX,
): Promise<ApiFetchResult> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`api_fetch only supports http/https, got "${u.protocol}"`);
  }
  const cap = Math.min(Math.max(1024, maxBytes), HARD_CAP);

  const res = await fetch(u, {
    headers: { "User-Agent": "Carter/1.0", Accept: "application/json, text/*", ...headers },
    signal: AbortSignal.timeout(15_000),
  });
  const contentType = res.headers.get("content-type") ?? "";

  const raw = await res.text();
  const truncated = raw.length > cap;
  const text = truncated ? raw.slice(0, cap) : raw;

  let body: unknown = text;
  if (!truncated && /json/i.test(contentType)) {
    try { body = JSON.parse(text); } catch { /* keep text */ }
  }
  return { status: res.status, contentType, truncated, body };
}

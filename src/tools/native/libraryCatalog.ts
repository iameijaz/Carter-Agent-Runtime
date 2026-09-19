/**
 * Library catalogue search — a VuFind/finc scraper over fetch + JSDOM.
 *
 * VuFind is run by a great many academic libraries, so which library this talks
 * to is configuration (LIBRARY_BASE_URL + LIBRARY_INSTITUTION), never a constant
 * here. Hard-coding one catalogue both names the author and makes the tool
 * useless to everyone else.
 */

import { JSDOM } from "jsdom";
import { config } from "../../config.js";

/** Throws unless a catalogue is configured. Called before any request. */
function baseUrl(): string {
  if (!config.libraryBaseUrl) {
    throw new Error("Library catalogue not configured: set LIBRARY_BASE_URL in .env");
  }
  return config.libraryBaseUrl.replace(/\/+$/, "");
}

const HEADERS = {
  "User-Agent":    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  "Accept":        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,de;q=0.8",
};

// Session cookie — planted once to bypass finc JS challenge
let sessionCookie = "finc_open=1";
let sessionReady  = false;

async function getSession() {
  if (sessionReady) return;
  // Bootstrap: hit homepage, plant cookie, reload
  await fetch(baseUrl(), { headers: HEADERS });
  sessionCookie = "finc_open=1";
  await fetch(baseUrl(), { headers: { ...HEADERS, Cookie: sessionCookie, Referer: baseUrl() + "/" } });
  sessionReady = true;
}

async function get(url: string, params?: Record<string, string | number | boolean>) {
  await getSession();
  let fullUrl = url;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) qs.append(k, String(v));
    fullUrl += "?" + qs.toString();
  }
  const res = await fetch(fullUrl, {
    headers: { ...HEADERS, Cookie: sessionCookie, Referer: baseUrl() + "/" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Catalog HTTP ${res.status}`);
  return res.text();
}

function parseRecord(li: Element, baseUrl: string) {
  const titleA  = li.querySelector("a.title");
  const title   = titleA
    ? Array.from(titleA.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent?.trim())
        .join(" ").trim()
    : "N/A";
  const href    = titleA?.getAttribute("href") ?? "";
  const url     = href ? new URL(href, baseUrl).toString() : null;
  const fmt     = li.querySelector("span.format, .label-format")?.textContent?.trim() ?? "N/A";
  const authors = Array.from(li.querySelectorAll("span.authors a.author, a.author"))
                    .map(a => a.textContent?.trim() ?? "");
  const year    = li.querySelector("span.year, .record-year")?.textContent?.trim().replace(/[()]/g, "") ?? null;
  const publisher = li.querySelector("span.publisher")?.textContent?.trim() ?? null;
  const abstract  = li.querySelector("div.abstract, p.abstract")?.textContent?.trim() ?? null;
  return { title, format: fmt, authors, year, publisher, abstract, url, available: null as boolean | null };
}

async function checkAvailability(recordUrl: string): Promise<boolean> {
  try {
    const html = await get(recordUrl);
    const doc  = new JSDOM(html).window.document;
    for (const el of Array.from(doc.querySelectorAll(".availability-status, .status"))) {
      const t = el.textContent?.toLowerCase() ?? "";
      if (t.includes("available") && !t.includes("not")) return true;
    }
  } catch { /* ignore */ }
  return false;
}

export async function librarySearch(
  query: string,
  limit = 10,
  onlyAvailable = false,
  includeArticles = false,
) {
  // Build query params manually to allow repeated keys
  const params = new URLSearchParams();
  params.append("lookfor", query);
  params.append("type",    "AllFields");
  params.append("limit",   String(Math.min(limit, 50)));
  params.append("lng",     "en");
  if (config.libraryInstitution) {
    params.append("hiddenFilters[]", `institution:${config.libraryInstitution}`);
  }
  if (!includeArticles) {
    params.append("hiddenFilters[]", "-format:Article");
    params.append("hiddenFilters[]", "-format:ElectronicArticle");
  }

  await getSession();
  const res = await fetch(`${`${baseUrl()}/Search/Results`}?${params.toString()}`, {
    headers: { ...HEADERS, Cookie: sessionCookie, Referer: baseUrl() + "/" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Catalog HTTP ${res.status}`);
  const html = await res.text();
  const doc  = new JSDOM(html).window.document;

  // Total count
  const totalEl = doc.querySelector(".search-stats strong, #searchStats strong");
  const total   = totalEl ? parseInt(totalEl.textContent?.replace(/,/g, "") ?? "0") : 0;

  const records = Array.from(doc.querySelectorAll("ol.record-list > li.result"));
  let items = records.map(li => parseRecord(li, baseUrl()));

  if (onlyAvailable) {
    const checked = await Promise.all(items.map(async item => {
      if (!item.url) return null;
      item.available = await checkAvailability(item.url);
      return item.available ? item : null;
    }));
    items = checked.filter(Boolean) as typeof items;
  }

  return { query, total, results: items.slice(0, limit) };
}

export async function libraryCheckAvailability(title: string) {
  const result = await librarySearch(title, 5, false, false);
  if (!result.results.length) return { found: false, message: `No results for "${title}"` };
  const book = result.results[0];
  if (book.url) book.available = await checkAvailability(book.url);
  return { found: true, ...book };
}

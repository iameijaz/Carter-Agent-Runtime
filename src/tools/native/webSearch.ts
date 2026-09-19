import { JSDOM } from "jsdom";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 300;

// Rotate a couple of realistic UAs across attempts — DDG rate-limits partly by
// UA+IP, so varying it helps a retry get through.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Signals a transient/rate-limited response worth retrying, as opposed to a
 * genuine empty result set. DDG under load answers with a 202 or a page that
 * has zero `a.result__a` links; both should be retried rather than surfaced as
 * "no results".
 */
class TransientSearchError extends Error {}

/**
 * Uses DuckDuckGo's no-JS HTML endpoint directly (html.duckduckgo.com), with
 * retry + backoff. Deliberately not using `duck-duck-scrape` (its VQD anti-bot
 * token broke in practice). A single free scraper is inherently flaky, so this
 * retries transient failures; the durable fix is adding SearXNG/Brave providers
 * to the waterfall.
 */
export async function ddgSearch(query: string, limit = 5): Promise<SearchResult[]> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return await ddgSearchOnce(query, limit, USER_AGENTS[attempt % USER_AGENTS.length]);
    } catch (err) {
      lastError = err as Error;
      const transient = err instanceof TransientSearchError || (err as Error).name === "TypeError";
      if (!transient || attempt === MAX_ATTEMPTS - 1) break;
      await sleep(BASE_BACKOFF_MS * 2 ** attempt); // 300ms, 600ms
    }
  }

  throw new Error(`DuckDuckGo search failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message}`);
}

async function ddgSearchOnce(query: string, limit: number, userAgent: string): Promise<SearchResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: `q=${encodeURIComponent(query)}`,
  });

  // 202 is DDG's rate-limit/anomaly signal; 5xx is transient — retry both.
  if (res.status === 202 || res.status >= 500) {
    throw new TransientSearchError(`rate-limited/transient HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const doc = new JSDOM(html).window.document;

  const results: SearchResult[] = [];
  for (const link of Array.from(doc.querySelectorAll("a.result__a"))) {
    if (results.length >= limit) break;
    const title = link.textContent?.trim() ?? "";
    const url = link.getAttribute("href") ?? "";
    const snippetEl = link.closest(".result")?.querySelector(".result__snippet");
    const snippet = snippetEl?.textContent?.trim() ?? "";
    if (title && url) results.push({ title, url, snippet });
  }

  // Zero links on a 200 almost always means an anomaly/block page for a real
  // query — treat as transient so the retry (with a rotated UA) can recover.
  if (results.length === 0) {
    throw new TransientSearchError("no result links (likely a block/anomaly page)");
  }
  return results;
}

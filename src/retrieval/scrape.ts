import { fetchReadable, type FetchedPage } from "../tools/native/webFetch.js";

const MIN_USABLE_LENGTH = 200;

/**
 * Heavy-path scraper (Carter design: Crawl4AI/Playwright headless render for
 * JS-heavy or Cloudflare-gated pages). Not implemented yet — see
 * docs/WhatsNext.md.
 */
async function heavyScrape(_url: string): Promise<FetchedPage> {
  throw new Error("Heavy scrape path (Crawl4AI) not implemented yet — see docs/WhatsNext.md");
}

/**
 * Staged scrape: fast path (Readability extraction) first; if it comes back
 * too short (JS wall, bot-block page, etc.) escalate to the heavy path.
 */
export async function scrapeStaged(url: string): Promise<FetchedPage> {
  const fast = await fetchReadable(url);
  if (fast.length >= MIN_USABLE_LENGTH) return fast;

  try {
    return await heavyScrape(url);
  } catch (err) {
    console.warn(`[scrape] heavy path unavailable for ${url}: ${(err as Error).message}`);
    return fast;
  }
}

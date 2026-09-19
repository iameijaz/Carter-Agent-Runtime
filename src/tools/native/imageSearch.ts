import { JSDOM } from "jsdom";

export interface ImageResult {
  url: string;
  title: string;
  source: string;
}

// ── Pixabay (free API key required — pixabay.com/api/docs) ───────────────────
async function pixabaySearch(query: string, limit: number): Promise<ImageResult[]> {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) throw new Error("PIXABAY_API_KEY not set");
  const url = `https://pixabay.com/api/?key=${key}&q=${encodeURIComponent(query)}&per_page=${Math.min(limit, 20)}&safesearch=true&image_type=photo`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pixabay HTTP ${res.status}`);
  const data = await res.json() as { hits?: any[] };
  return (data.hits ?? []).map((h: any) => ({
    url: h.webformatURL ?? h.largeImageURL ?? "",
    title: h.tags ?? "",
    source: h.pageURL ?? "",
  })).filter((r: ImageResult) => r.url);
}

// ── Unsplash (free API key — unsplash.com/developers) ────────────────────────
async function unsplashSearch(query: string, limit: number): Promise<ImageResult[]> {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) throw new Error("UNSPLASH_ACCESS_KEY not set");
  const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${Math.min(limit, 20)}&client_id=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Unsplash HTTP ${res.status}`);
  const data = await res.json() as { results?: any[] };
  return (data.results ?? []).map((p: any) => ({
    url: p.urls?.regular ?? p.urls?.small ?? "",
    title: p.alt_description ?? p.description ?? "",
    source: p.links?.html ?? "",
  })).filter((r: ImageResult) => r.url);
}

// ── Wikimedia Commons (keyless, good for factual/encyclopedic images) ─────────
async function wikimediaSearch(query: string, limit: number): Promise<ImageResult[]> {
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}&gsrlimit=${limit}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=800&format=json&origin=*`;
  const res = await fetch(url, { headers: { "User-Agent": "Carter/1.0" } });
  if (!res.ok) throw new Error(`Wikimedia HTTP ${res.status}`);
  const data = await res.json() as { query?: { pages?: Record<string, any> } };
  const pages = Object.values(data.query?.pages ?? {});
  return pages.slice(0, limit).map((p: any) => {
    const info = p.imageinfo?.[0];
    const title = p.title?.replace("File:", "") ?? "";
    return {
      url: info?.thumburl ?? info?.url ?? "",
      title,
      source: info?.descriptionurl ?? "",
    };
  }).filter((r: ImageResult) => r.url);
}

// ── OpenVerse (CC-licensed, keyless) ─────────────────────────────────────────
async function openverseSearch(query: string, limit: number): Promise<ImageResult[]> {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${Math.min(limit, 20)}&license_type=commercial,modification`;
  const res = await fetch(url, { headers: { "User-Agent": "Carter/1.0" } });
  if (!res.ok) throw new Error(`Openverse HTTP ${res.status}`);
  const data = await res.json() as { results?: any[] };
  return (data.results ?? []).map((r: any) => ({
    url: r.url ?? "",
    title: r.title ?? "",
    source: r.foreign_landing_url ?? "",
  })).filter((r: ImageResult) => r.url);
}

// ── Main export — waterfall: Pixabay → Unsplash → Openverse → Wikimedia ──────
export async function imageSearch(query: string, limit = 12): Promise<ImageResult[]> {
  const providers: Array<{ name: string; fn: () => Promise<ImageResult[]> }> = [
    { name: "pixabay",   fn: () => pixabaySearch(query, limit)   },
    { name: "unsplash",  fn: () => unsplashSearch(query, limit)  },
    { name: "openverse", fn: () => openverseSearch(query, limit) },
    { name: "wikimedia", fn: () => wikimediaSearch(query, limit) },
  ];

  const errors: string[] = [];
  for (const { name, fn } of providers) {
    try {
      const results = await fn();
      if (results.length > 0) {
        console.log(`[image_search] provider=${name} results=${results.length}`);
        return results;
      }
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  }
  throw new Error(`All image providers failed or returned no results. ${errors.join("; ")}`);
}

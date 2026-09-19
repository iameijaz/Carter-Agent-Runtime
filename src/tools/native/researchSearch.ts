/**
 * Research literature search — 4-tier waterfall:
 *   Tier 1: OpenAlex + Semantic Scholar (parallel, merge)
 *   Tier 2: arXiv, PubMed, Crossref
 *   Tier 3: Unpaywall (full-text URL discovery)
 *
 * All free APIs, no keys required for basic use.
 * SEMANTIC_SCHOLAR_API_KEY in .env removes rate limits on S2.
 */

export interface Paper {
  title: string;
  authors: string[];
  year: number | null;
  abstract: string;
  doi: string | null;
  url: string | null;
  fullTextUrl: string | null;
  source: string;
}

const S2_KEY = process.env.SEMANTIC_SCHOLAR_API_KEY ?? "";

// ── OpenAlex ─────────────────────────────────────────────────────────────────
async function searchOpenAlex(query: string, limit: number): Promise<Paper[]> {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}&select=title,authorships,publication_year,abstract_inverted_index,doi,primary_location`;
  const res = await fetch(url, { headers: { "User-Agent": "Carter/1.0 (research tool)" } });
  if (!res.ok) throw new Error(`OpenAlex HTTP ${res.status}`);
  const data = await res.json() as { results?: any[] };

  return (data.results ?? []).map((w: any) => {
    // OpenAlex stores abstracts as inverted index — reconstruct
    let abstract = "";
    if (w.abstract_inverted_index) {
      const words: [number, string][] = [];
      for (const [word, positions] of Object.entries(w.abstract_inverted_index as Record<string, number[]>)) {
        for (const pos of positions) words.push([pos, word]);
      }
      abstract = words.sort((a, b) => a[0] - b[0]).map(x => x[1]).join(" ");
    }
    return {
      title: w.title ?? "",
      authors: (w.authorships ?? []).slice(0, 5).map((a: any) => a.author?.display_name ?? ""),
      year: w.publication_year ?? null,
      abstract,
      doi: w.doi?.replace("https://doi.org/", "") ?? null,
      url: w.primary_location?.landing_page_url ?? null,
      fullTextUrl: w.primary_location?.pdf_url ?? null,
      source: "openalex",
    };
  });
}

// ── Semantic Scholar ──────────────────────────────────────────────────────────
async function searchSemanticScholar(query: string, limit: number): Promise<Paper[]> {
  const headers: Record<string, string> = { "User-Agent": "Carter/1.0" };
  if (S2_KEY) headers["x-api-key"] = S2_KEY;
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,authors,year,abstract,externalIds,url,openAccessPdf`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`SemanticScholar HTTP ${res.status}`);
  const data = await res.json() as { data?: any[] };
  return (data.data ?? []).map((p: any) => ({
    title: p.title ?? "",
    authors: (p.authors ?? []).slice(0, 5).map((a: any) => a.name ?? ""),
    year: p.year ?? null,
    abstract: p.abstract ?? "",
    doi: p.externalIds?.DOI ?? null,
    url: p.url ?? null,
    fullTextUrl: p.openAccessPdf?.url ?? null,
    source: "semantic_scholar",
  }));
}

// ── arXiv ─────────────────────────────────────────────────────────────────────
async function searchArxiv(query: string, limit: number): Promise<Paper[]> {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`arXiv HTTP ${res.status}`);
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  return entries.map(([, entry]) => {
    const get = (tag: string) => entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1]?.trim() ?? "";
    const id = get("id");
    const arxivId = id.split("/abs/")[1] ?? "";
    return {
      title: get("title").replace(/\s+/g, " "),
      authors: [...entry.matchAll(/<name>(.*?)<\/name>/g)].slice(0, 5).map(m => m[1]),
      year: Number(get("published").slice(0, 4)) || null,
      abstract: get("summary").replace(/\s+/g, " "),
      doi: null,
      url: id,
      fullTextUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : null,
      source: "arxiv",
    };
  });
}

// ── PubMed ────────────────────────────────────────────────────────────────────
async function searchPubMed(query: string, limit: number): Promise<Paper[]> {
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retmode=json`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`PubMed search HTTP ${searchRes.status}`);
  const searchData = await searchRes.json() as { esearchresult?: { idlist?: string[] } };
  const ids = searchData.esearchresult?.idlist ?? [];
  if (!ids.length) return [];

  const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`;
  const sumRes = await fetch(summaryUrl);
  if (!sumRes.ok) throw new Error(`PubMed summary HTTP ${sumRes.status}`);
  const sumData = await sumRes.json() as { result?: Record<string, any> };
  const result = sumData.result ?? {};

  return ids.map(id => {
    const r = result[id] ?? {};
    return {
      title: r.title ?? "",
      authors: (r.authors ?? []).slice(0, 5).map((a: any) => a.name ?? ""),
      year: Number(r.pubdate?.slice(0, 4)) || null,
      abstract: "",
      doi: r.elocationid?.replace("doi: ", "") ?? null,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      fullTextUrl: null,
      source: "pubmed",
    };
  }).filter(p => p.title);
}

// ── Unpaywall (full-text URL discovery by DOI) ────────────────────────────────
async function enrichWithUnpaywall(papers: Paper[]): Promise<Paper[]> {
  const email = process.env.UNPAYWALL_EMAIL ?? "carter@localhost";
  return Promise.all(papers.map(async (p) => {
    if (p.fullTextUrl || !p.doi) return p;
    try {
      const res = await fetch(`https://api.unpaywall.org/v2/${encodeURIComponent(p.doi)}?email=${email}`);
      if (!res.ok) return p;
      const data = await res.json() as { best_oa_location?: { url_for_pdf?: string; url?: string } };
      const loc = data.best_oa_location;
      return { ...p, fullTextUrl: loc?.url_for_pdf ?? loc?.url ?? null };
    } catch { return p; }
  }));
}

// ── Deduplicate by DOI then title ─────────────────────────────────────────────
function dedup(papers: Paper[]): Paper[] {
  const seen = new Set<string>();
  return papers.filter(p => {
    const key = p.doi ?? p.title.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function researchLiteratureSearch(
  query: string,
  limit = 10,
  discoverFullText = true,
): Promise<{ papers: Paper[]; sources: string[] }> {
  const perSource = Math.ceil(limit / 2);
  const errors: string[] = [];
  let papers: Paper[] = [];

  // Tier 1: OpenAlex + S2 in parallel
  const [oaResults, s2Results] = await Promise.allSettled([
    searchOpenAlex(query, perSource),
    searchSemanticScholar(query, perSource),
  ]);
  if (oaResults.status === "fulfilled") papers.push(...oaResults.value);
  else errors.push(`openalex: ${oaResults.reason}`);
  if (s2Results.status === "fulfilled") papers.push(...s2Results.value);
  else errors.push(`semantic_scholar: ${s2Results.reason}`);

  // Tier 2: arXiv + PubMed if we don't have enough
  if (papers.length < limit) {
    const [axResults, pmResults] = await Promise.allSettled([
      searchArxiv(query, perSource),
      searchPubMed(query, perSource),
    ]);
    if (axResults.status === "fulfilled") papers.push(...axResults.value);
    else errors.push(`arxiv: ${axResults.reason}`);
    if (pmResults.status === "fulfilled") papers.push(...pmResults.value);
    else errors.push(`pubmed: ${pmResults.reason}`);
  }

  papers = dedup(papers).slice(0, limit);

  // Tier 3: Unpaywall enrichment
  if (discoverFullText && papers.length > 0) {
    papers = await enrichWithUnpaywall(papers);
  }

  const sources = [...new Set(papers.map(p => p.source))];
  if (errors.length) console.warn("[research] partial errors:", errors.join("; "));
  return { papers, sources };
}

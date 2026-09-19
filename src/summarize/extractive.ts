/**
 * Offline summarizer — points from pages, with no model.
 *
 * The other half of the learned bypass: replaying a cached plan fetches today's
 * pages, but something still has to turn them into points, and that is what
 * would otherwise force a cloud call on every repeat of a known request.
 *
 * Classic extractive ranking: score real sentences, keep the best, emit them in
 * the order they appeared. Nothing is paraphrased.
 *
 * ponytail: extractive only — it can select a sentence but never rewrite one,
 * so it cannot synthesise across two sentences or compress a long one. Upgrade
 * path is a local 0.6–1.5B abstractive model, which is tier-0's job and needs a
 * model download this deliberately avoids.
 */

import { STOPWORDS, similarity, normalise } from "../memory/successCache.js";

export interface Source {
  title: string;
  text: string;
}

export interface Point {
  text: string;
  source: string;
}

/**
 * Sentence split on terminal punctuation followed by whitespace.
 *
 * The digit lookbehind is not defensive coding — it was measured. Without it,
 * a German date ("vom 15. bis 30. September") splits at the ordinal points and
 * the bullet list shows two fragments instead of one fact. Abbreviations
 * ("Dr. Smith") still split wrongly; the cost is one short fragment, which is
 * not worth a tokenizer dependency to avoid.
 */
function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<![0-9])(?<=[.!?])\s+(?=[A-Z"'“])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 400);
}

/**
 * Points for `query` drawn from `sources`, best first within each source but
 * emitted in document order — a summary should read as a sequence, not as a
 * leaderboard.
 */
export function summarise(sources: Source[], query: string, limit = 6): Point[] {
  const queryTerms = new Set(normalise(query));
  const picked: Point[] = [];

  for (const src of sources) {
    const sents = sentences(src.text);
    if (sents.length === 0) continue;

    // Term frequency across this article: a word repeated through the piece is
    // what the piece is about.
    const freq = new Map<string, number>();
    for (const s of sents)
      for (const w of s.toLowerCase().match(/\p{L}{3,}/gu) ?? [])
        if (!STOPWORDS.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);

    const scored = sents.map((s, i) => {
      const words = (s.toLowerCase().match(/\p{L}{3,}/gu) ?? []).filter((w) => !STOPWORDS.has(w));
      if (words.length === 0) return { s, i, score: 0 };
      const tf = words.reduce((a, w) => a + (freq.get(w) ?? 0), 0) / words.length;
      const hits = words.filter((w) => queryTerms.has(w)).length;
      // Lead bias: news puts the answer in the first paragraph, by convention.
      const lead = 1 / (1 + i * 0.15);
      return { s, i, score: tf * lead + hits * 2 };
    });

    // Per source, not globally: one verbose article would otherwise take every
    // slot and the summary would have a single point of view.
    const perSource = Math.max(1, Math.ceil(limit / sources.length));
    const best = scored
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, perSource)
      .sort((a, b) => a.i - b.i);

    for (const b of best) picked.push({ text: b.s, source: src.title });
  }

  // Two outlets running the same wire copy produce the same sentence twice.
  const kept: Point[] = [];
  for (const p of picked) {
    const t = normalise(p.text);
    if (kept.some((k) => similarity(t, normalise(k.text)) > 0.7)) continue;
    kept.push(p);
    if (kept.length >= limit) break;
  }
  return kept;
}

/** Points as the answer text a turn returns. Source named after the claim. */
export function formatPoints(points: Point[]): string {
  return points.map((p) => `- ${p.text} *(${p.source})*`).join("\n");
}

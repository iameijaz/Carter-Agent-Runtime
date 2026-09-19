import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export interface FetchedPage {
  title: string;
  text: string;
  length: number;
}

export async function fetchReadable(url: string): Promise<FetchedPage> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Carter-agent)" } });
  const html = await res.text();
  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  const text = article?.textContent?.trim() ?? "";
  return {
    title: article?.title ?? url,
    text,
    length: text.length,
  };
}

// Shared safe-markdown renderer: marked → DOMPurify. Kept as the single
// sanitization path (the old prototype hand-rolled a renderer with no sanitize).
import { marked } from "https://esm.sh/marked@14.1.3";
import DOMPurify from "https://esm.sh/dompurify@3.1.7";
import hljs from "https://esm.sh/highlight.js@11.10.0";
import mermaid from "https://esm.sh/mermaid@11.4.1";

mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
marked.setOptions({ gfm: true, breaks: false });

/** Render markdown text into `el`, sanitized. Optionally highlight + mermaid. */
export function renderMarkdownInto(el, text, { highlight = false } = {}) {
  const dirty = marked.parse(text ?? "");
  el.innerHTML = DOMPurify.sanitize(dirty, {
    ADD_TAGS: ["img"],
    ADD_ATTR: ["src", "alt", "target"],
  });
  if (highlight) {
    el.querySelectorAll("pre code").forEach((block) => {
      if (!block.classList.contains("language-mermaid")) hljs.highlightElement(block);
    });
    renderMermaid(el);
  }
}

let mermaidSeq = 0;
async function renderMermaid(container) {
  const blocks = container.querySelectorAll("code.language-mermaid");
  for (const code of blocks) {
    const src = code.textContent;
    const holder = document.createElement("div");
    holder.className = "mermaid-rendered";
    try {
      const { svg } = await mermaid.render(`mmd-${mermaidSeq++}`, src);
      holder.innerHTML = svg;
      code.closest("pre").replaceWith(holder);
    } catch {
      /* leave the raw code block if the diagram fails to parse */
    }
  }
}

export const esc = (s) =>
  String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

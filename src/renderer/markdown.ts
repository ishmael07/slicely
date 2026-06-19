// A tiny, dependency-free, SAFE markdown→DOM renderer for chat bubbles.
//
// Security: model output is untrusted and the renderer runs under a strict CSP.
// This module NEVER uses innerHTML on model text — every text run becomes a
// DOM text node, and the only elements that exist are ones we create. So a
// string like `<img onerror=...>` renders as literal characters, not an element.
//
// Supported subset: paragraphs, # / ## / ### headings, - / * and 1. lists,
// > blockquotes (with `[!warn]`/`[!tip]` callout tags), ``` fenced code ```,
// `inline code`, **bold**, *italic* / _italic_.

export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line → skip (block separation).
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block: ``` ... ``` (also handles an unterminated fence
    // mid-stream by reading to end-of-input).
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence if present
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = body.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    // Heading: #, ##, ### → h3/h4/h5 (kept small for a chat bubble).
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = Math.min(2 + heading[1].length, 5); // # → h3
      const h = document.createElement(`h${level}`);
      inlineInto(h, heading[2].trim());
      frag.appendChild(h);
      i++;
      continue;
    }

    // Blockquote / callout: consecutive lines starting with ">".
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const bq = document.createElement("blockquote");
      bq.className = "callout";
      let text = quoted.join("\n");
      const tag = text.match(/^\s*\[!(\w+)\]\s*/);
      if (tag) {
        const kind = tag[1].toLowerCase();
        if (kind === "warn" || kind === "warning" || kind === "caution") {
          bq.classList.add("warn");
        }
        text = text.slice(tag[0].length);
      }
      inlineInto(bq, text.trim());
      frag.appendChild(bq);
      continue;
    }

    // Unordered list: consecutive - / * items.
    if (/^\s*[-*]\s+/.test(line)) {
      const ul = document.createElement("ul");
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const li = document.createElement("li");
        inlineInto(li, lines[i].replace(/^\s*[-*]\s+/, ""));
        ul.appendChild(li);
        i++;
      }
      frag.appendChild(ul);
      continue;
    }

    // Ordered list: consecutive 1. 2. items.
    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = document.createElement("ol");
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = document.createElement("li");
        inlineInto(li, lines[i].replace(/^\s*\d+\.\s+/, ""));
        ol.appendChild(li);
        i++;
      }
      frag.appendChild(ol);
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-block lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !/^(#{1,3})\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    const p = document.createElement("p");
    inlineInto(p, para.join("\n"));
    frag.appendChild(p);
  }

  return frag;
}

/** Inline scanner: code spans, then bold, then italic; everything else is a
 *  literal text node. A single left-to-right pass (no regex-replace on HTML),
 *  so unmatched markers render literally and there's no injection surface. */
function inlineInto(parent: HTMLElement, text: string): void {
  let buf = "";
  const flush = () => {
    if (buf) {
      parent.appendChild(document.createTextNode(buf));
      buf = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // Inline code — highest precedence, no nested formatting.
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        const code = document.createElement("code");
        code.textContent = text.slice(i + 1, end);
        parent.appendChild(code);
        i = end + 1;
        continue;
      }
    }

    // Bold **...**
    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end > i + 1) {
        flush();
        const strong = document.createElement("strong");
        inlineInto(strong, text.slice(i + 2, end));
        parent.appendChild(strong);
        i = end + 2;
        continue;
      }
    }

    // Italic *...* or _..._
    if ((ch === "*" || ch === "_") && text[i + 1] !== ch) {
      const end = text.indexOf(ch, i + 1);
      if (end > i) {
        flush();
        const em = document.createElement("em");
        inlineInto(em, text.slice(i + 1, end));
        parent.appendChild(em);
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }
  flush();
}

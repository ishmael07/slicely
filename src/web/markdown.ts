// ─────────────────────────────────────────────────────────────────────────────
// markdown.ts — a tiny, dependency-free markdown-lite → DOM renderer.
//
// Deliberately NOT innerHTML anywhere: model text is untrusted, so every run of
// text becomes a real DOM text node and the only elements that exist are ones
// this function creates itself.
// ─────────────────────────────────────────────────────────────────────────────
import { externalLink, make } from "./ui.js";

export function renderMarkdownLite(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  const inline = (container: HTMLElement, s: string): void => {
    // Links come first: telling someone to "go to prusa3d.com" in text they
    // cannot click is a dead end, and the agent writes both [label](url) and
    // bare URLs.
    const re =
      /(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>"')]+|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (m.index > last) container.appendChild(document.createTextNode(s.slice(last, m.index)));
      const token = m[0];
      const md = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
      if (md) container.appendChild(externalLink(md[2], md[1]));
      else if (/^https?:\/\//.test(token)) container.appendChild(externalLink(token, token));
      else if (token.startsWith("**")) container.appendChild(make("strong", "", token.slice(2, -2)));
      else if (token.startsWith("`")) container.appendChild(make("code", "", token.slice(1, -1)));
      else container.appendChild(make("em", "", token.slice(1, -1)));
      last = re.lastIndex;
    }
    if (last < s.length) container.appendChild(document.createTextNode(s.slice(last)));
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = /^\s*```/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      const pre = make("pre");
      pre.appendChild(make("code", "", body.join("\n")));
      frag.appendChild(pre);
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = 2 + heading[1].length;
      const h = make(level === 3 ? "h3" : level === 4 ? "h4" : "h5");
      inline(h, heading[2]);
      frag.appendChild(h);
      i++;
      continue;
    }

    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const list = ordered ? make("ol") : make("ul");
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const item = make("li");
        inline(item, lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        list.appendChild(item);
        i++;
      }
      frag.appendChild(list);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*```/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    const p = make("p");
    inline(p, para.join(" "));
    frag.appendChild(p);
  }

  return frag;
}

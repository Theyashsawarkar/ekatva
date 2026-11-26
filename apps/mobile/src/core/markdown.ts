/**
 * The Markdown agents write, parsed for drawing: paragraphs, headings,
 * lists, quotes, code blocks, tables, rules; bold, italic, code and links
 * inside. Small on purpose, and forgiving: what it doesn't know stays text.
 */
export type Span = { text: string; bold?: true; italic?: true; code?: true; href?: string };
export type Md =
  | { kind: "p"; spans: Span[] }
  | { kind: "h"; level: number; spans: Span[] }
  | { kind: "li"; depth: number; mark: string; spans: Span[] }
  | { kind: "quote"; spans: Span[] }
  | { kind: "code"; lang: string; text: string }
  | { kind: "table"; head: Span[][]; rows: Span[][][] }
  | { kind: "hr" };

const INLINE =
  /(`+)(.+?)\1|\*\*(.+?)\*\*|__(.+?)__|\*(?=\S)([^*\n]+?)\*|(?<![\w/])_(?=\S)([^_\n]+?)_(?!\w)|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?])/;

export function spans(text: string, base: Omit<Span, "text"> = {}): Span[] {
  const out: Span[] = [];
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push({ ...base, text: rest });
      break;
    }
    if (m.index) out.push({ ...base, text: rest.slice(0, m.index) });
    if (m[2] !== undefined) out.push({ ...base, text: m[2].trim() || m[2], code: true });
    else if (m[3] !== undefined || m[4] !== undefined)
      out.push(...spans((m[3] ?? m[4]) as string, { ...base, bold: true }));
    else if (m[5] !== undefined || m[6] !== undefined)
      out.push(...spans((m[5] ?? m[6]) as string, { ...base, italic: true }));
    else if (m[7] !== undefined)
      out.push({ ...base, text: m[7].replace(/^`|`$/g, ""), href: m[8] as string });
    else out.push({ ...base, text: m[9] as string, href: m[9] as string });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const cells = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => spans(c.trim().replace(/\\\|/g, "|")));

export function markdown(text: string): Md[] {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: Md[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "p", spans: spans(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(l);
    if (fence) {
      flush();
      const body: string[] = [];
      const pad = l.length - l.trimStart().length;
      // Unfinished (still being written): the rest is code.
      for (
        i++;
        i < lines.length && !(lines[i] as string).trim().startsWith(fence[1] as string);
        i++
      )
        body.push((lines[i] as string).replace(new RegExp(`^ {0,${pad}}`), ""));
      out.push({ kind: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    if (!l.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      flush();
      out.push({ kind: "h", level: (h[1] as string).length, spans: spans(h[2] as string) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      flush();
      out.push({ kind: "hr" });
      continue;
    }
    if (
      l.includes("|") &&
      /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")
    ) {
      flush();
      const head = cells(l);
      const rows: Span[][][] = [];
      for (i += 2; i < lines.length && (lines[i] as string).includes("|"); i++)
        rows.push(cells(lines[i] as string));
      i--;
      out.push({ kind: "table", head, rows });
      continue;
    }
    const li = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/.exec(l);
    if (li) {
      flush();
      const mark = /\d/.test(li[2] as string) ? (li[2] as string).replace(")", ".") : "•";
      const depth = Math.min(4, Math.floor((li[1] as string).replace(/\t/g, "  ").length / 2));
      const body = [li[3] as string];
      // Lines that go on under the item.
      while (
        /^\s{2,}\S/.test(lines[i + 1] ?? "") &&
        !/^\s*([-*+•]|\d{1,3}[.)])\s|^\s*(```|~~~)/.test(lines[i + 1] as string)
      )
        body.push((lines[++i] as string).trim());
      out.push({ kind: "li", depth, mark, spans: spans(body.join(" ")) });
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(l);
    if (q) {
      flush();
      const body = [q[1] as string];
      while (/^\s*>/.test(lines[i + 1] ?? ""))
        body.push((lines[++i] as string).replace(/^\s*>\s?/, ""));
      out.push({ kind: "quote", spans: spans(body.join("\n")) });
      continue;
    }
    para.push(l);
  }
  flush();
  return out;
}

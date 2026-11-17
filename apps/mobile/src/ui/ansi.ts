/**
 * A terminal screen's colours (ANSI SGR) as styled runs of text. The 16
 * colours are the lacquer palette's: sage, rose, amber, steel on warm black.
 */
export interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}
export interface Run {
  text: string;
  style: Style;
}

export const PALETTE = [
  "#3a3242",
  "#e2706d",
  "#9cbf9a",
  "#e3a857",
  "#8ea8c6",
  "#c49ac0",
  "#8fbfb8",
  "#d9cfc3",
  "#5a4f62",
  "#ef8a86",
  "#b3d4b0",
  "#efc07a",
  "#a9c0dc",
  "#d6b0d2",
  "#a7d3cc",
  "#efe7dc",
];

/** Text with no colour of its own, and the terminal's black. */
export const FG = "#e6dfd5";
export const BG = "#120f17";

const hex = (n: number) => n.toString(16).padStart(2, "0");

/** xterm's 256 colours: the 16, a 6×6×6 cube, 24 greys. */
export function color256(n: number): string {
  if (n < 16) return PALETTE[n] as string;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `#${hex(v)}${hex(v)}${hex(v)}`;
  }
  const i = n - 16;
  const step = (x: number) => (x ? 55 + x * 40 : 0);
  return `#${hex(step(Math.floor(i / 36)))}${hex(step(Math.floor(i / 6) % 6))}${hex(step(i % 6))}`;
}

function apply(style: Style, codes: number[]): Style {
  const s = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const n = codes[i] as number;
    if (n === 0) for (const k of Object.keys(s)) delete s[k as keyof Style];
    else if (n === 1) s.bold = true;
    else if (n === 2) s.dim = true;
    else if (n === 3) s.italic = true;
    else if (n === 4) s.underline = true;
    else if (n === 7) s.inverse = true;
    else if (n === 22) {
      s.bold = false;
      s.dim = false;
    } else if (n === 23) s.italic = false;
    else if (n === 24) s.underline = false;
    else if (n === 27) s.inverse = false;
    else if (n >= 30 && n <= 37) s.fg = PALETTE[n - 30];
    else if (n === 39) delete s.fg;
    else if (n >= 40 && n <= 47) s.bg = PALETTE[n - 40];
    else if (n === 49) delete s.bg;
    else if (n >= 90 && n <= 97) s.fg = PALETTE[n - 90 + 8];
    else if (n >= 100 && n <= 107) s.bg = PALETTE[n - 100 + 8];
    else if ((n === 38 || n === 48) && codes[i + 1] === 5) {
      const col = color256(codes[i + 2] ?? 0);
      if (n === 38) s.fg = col;
      else s.bg = col;
      i += 2;
    } else if ((n === 38 || n === 48) && codes[i + 1] === 2) {
      const col = `#${hex(codes[i + 2] ?? 0)}${hex(codes[i + 3] ?? 0)}${hex(codes[i + 4] ?? 0)}`;
      if (n === 38) s.fg = col;
      else s.bg = col;
      i += 4;
    }
  }
  return s;
}

/** Each line of the screen as runs of styled text; other escapes are dropped. */
export function parseAnsi(text: string): Run[][] {
  const lines: Run[][] = [];
  let style: Style = {};
  for (const raw of text.split("\n")) {
    const runs: Run[] = [];
    // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
    const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;
    let at = 0;
    for (let m = re.exec(raw); m; m = re.exec(raw)) {
      if (m.index > at) runs.push({ text: raw.slice(at, m.index), style });
      if (m[1] !== undefined && m[0].endsWith("m"))
        style = apply(style, m[1] === "" ? [0] : m[1].split(";").map(Number));
      at = re.lastIndex;
    }
    if (at < raw.length) runs.push({ text: raw.slice(at), style });
    lines.push(runs);
  }
  return lines;
}

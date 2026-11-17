/**
 * An agent's terminal screen, read as a conversation for a phone: what you
 * said, what it said (its hard line wraps undone, its lists kept), the
 * tools it used with their output, and where it is now. The input box and
 * the footer are left out. Pure, so it's tested against captures.
 *
 * Claude Code's screen, roughly:
 *
 *   ❯ what you typed
 *   ● What it says, wrapped at the terminal's width by Claude Code itself,
 *     each further line indented two spaces.
 *     - a list item
 *   ● Bash(ls -la)                      a tool…
 *     ⎿  its output                     …and what came back
 *     Ran 2 shell commands              a folded group of tools
 *   ✻ Worked for 2m 3s                  a turn's end
 *   ✶ Transfiguring… (16s · ↓ 1k)      working now
 *   ───────────
 *   ❯                                   the input box
 *   ───────────
 *     ⏵⏵ auto mode on · ← 2 agents      the footer
 */

export type Block =
  | { kind: "you"; text: string }
  | { kind: "says"; text: string }
  | { kind: "tool"; title: string; output: string }
  | { kind: "note"; text: string };

export interface Transcript {
  blocks: Block[];
  /** What it's doing right now ("Transfiguring… 16s"), when it's working. */
  status: string | null;
}

const RULE = /^\s*[─━═]{10,}\s*$/;
const STATUS = /^[✻✽✶✳✢·*]\s+(\S.*)$/;
/** A folded group of tool calls, as Claude Code shows them. */
const FOLDED_VERB =
  "(?:Ran|Running|Read|Reading|Created|Creating|Edited|Editing|Wrote|Writing|Searched|Searching|Updated|Updating|Fetched|Fetching|Listed|Listing|Found|Explored|Exploring|Deleted|Moved|Used|Using)";
const FOLDED = new RegExp(
  `^(?:(?:Called|Calling)\\b.*|${FOLDED_VERB}\\b.*\\b(?:commands?|files?|PR\\b|patterns?|search(?:es)?|pages?|tools?|agents?|directories|lines?|times|skills?)\\b.*)$`,
);
/** Terminal control characters (a deleted character shows as ^?). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** "Bash(…)", "Read(…)", "security-reviewer(…)": a tool call. */
const TOOL = /^[\w.-]+(?:\s[\w.-]+)?\(.*\)?$/;
const BULLET = /^(?:[-*•]|\d{1,2}[.)])\s/;

const indent = (l: string) => l.length - l.trimStart().length;

/** Cuts the input box and everything under it (the footer). */
function body(lines: string[]): string[] {
  for (let i = lines.length - 1; i >= 1; i--) {
    if (RULE.test(lines[i] ?? "") && /^\s*[❯>]/.test(lines[i + 1] ?? "")) return lines.slice(0, i);
    if (
      RULE.test(lines[i] ?? "") &&
      /^\s*[❯>]/.test(lines[i - 1] ?? "") &&
      RULE.test(lines[i - 2] ?? "")
    )
      return lines.slice(0, i - 2);
  }
  return lines;
}

/**
 * Lines of one block (its first prefix gone), with Claude Code's hard wraps
 * undone: a line that continues the one before (no new bullet, and the one
 * before reached near the screen's width) joins it.
 */
function unwrap(lines: string[], width: number): string {
  const out: string[] = [];
  let prevLen = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const text = line.trim();
    if (!text) {
      if (out.length && out.at(-1) !== "") out.push("");
      prevLen = 0;
      continue;
    }
    const last = out.at(-1);
    const continues =
      last !== undefined && last !== "" && !BULLET.test(text) && prevLen >= width - 30;
    if (continues) out[out.length - 1] = `${last} ${text}`;
    else out.push(`${" ".repeat(Math.max(0, indent(line) - 2))}${text}`);
    prevLen = line.length;
  }
  while (out.at(-1) === "") out.pop();
  return out.join("\n");
}

export function transcript(capture: string): Transcript {
  // tmux writes a deleted character as the two characters "^?".
  const all = capture.replace(CONTROL, "").replace(/\^\?/g, "").replace(/\s+$/, "").split("\n");
  // The screen's width: the longest line (wrapped lines come close to it).
  const width = Math.max(40, ...all.map((l) => l.replace(/\s+$/, "").length));
  const lines = body(all);
  // Today's Claude Code marks what you typed with ❯; where it does, a ">" line is a quote.
  const you = lines.some((l) => /^❯ \S/.test(l)) ? /^❯\s?/ : /^[❯>]\s?/;
  const blocks: Block[] = [];
  let status: string | null = null;
  let cur: { kind: Block["kind"]; head: string; lines: string[]; output: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    if (cur.kind === "tool")
      blocks.push({ kind: "tool", title: cur.head, output: cur.output.join("\n").trim() });
    else if (cur.kind === "note") blocks.push({ kind: "note", text: cur.head });
    else {
      const text = unwrap([`  ${cur.head}`, ...cur.lines], width);
      if (text) blocks.push({ kind: cur.kind, text } as Block);
    }
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const t = line.trim();
    // Rules, and the "~" an empty screen shows.
    if (RULE.test(line) || t === "~" || /^~\s{8,}/.test(line)) continue;
    // A new block starts at the left edge.
    if (you.test(line) && indent(line) === 0) {
      flush();
      cur = { kind: "you", head: t.replace(you, ""), lines: [], output: [] };
      continue;
    }
    if (/^[●⏺]\s/.test(t) && indent(line) === 0) {
      flush();
      const head = t.replace(/^[●⏺]\s+/, "");
      cur = { kind: TOOL.test(head) ? "tool" : "says", head, lines: [], output: [] };
      continue;
    }
    const st = STATUS.exec(t);
    if (st && indent(line) === 0) {
      flush();
      const text = (st[1] as string).replace(/\s*\((\d+[smh][^·)]*)[^)]*\)/, " · $1").trim();
      // Working now (a timer, or waiting on agents) is the status; a finished turn, a note.
      if (/…/.test(t) || /^Waiting for/i.test(st[1] as string)) status = text;
      else blocks.push({ kind: "note", text });
      continue;
    }
    // What you typed ends at a blank line; text after it without a marker is the agent's.
    if (cur?.kind === "you" && !t) {
      flush();
      continue;
    }
    // A command's reply right under what you typed (/chrome → "Now using…"): a note.
    if (/^⎿/.test(t) && (!cur || cur.kind === "you")) {
      flush();
      const text = t.replace(/^⎿\s*/, "").trim();
      if (text) blocks.push({ kind: "note", text });
      continue;
    }
    if (!cur) {
      if (!t) continue;
      if (FOLDED.test(t) && indent(line) === 2) {
        cur = { kind: "tool", head: t, lines: [], output: [] };
        continue;
      }
      cur = { kind: "says", head: t, lines: [], output: [] };
      continue;
    }
    if (cur.kind === "tool" || /^⎿/.test(t)) {
      // A tool's output: "⎿  …" and what's indented under it.
      if (/^⎿/.test(t) || (cur.kind === "tool" && cur.output.length && indent(line) >= 4)) {
        if (cur.kind !== "tool") {
          // Output under a folded group: it belongs to a tool row.
          flush();
          cur = { kind: "tool", head: "", lines: [], output: [] };
        }
        cur.output.push(t.replace(/^⎿\s*/, ""));
        continue;
      }
    }
    if (FOLDED.test(t) && indent(line) === 2 && cur.kind !== "you") {
      flush();
      cur = { kind: "tool", head: t, lines: [], output: [] };
      continue;
    }
    if (cur.kind === "tool") {
      // Prose after a tool, without a "●": the turn goes on.
      if (!t) continue;
      flush();
      cur = { kind: "says", head: t, lines: [], output: [] };
      continue;
    }
    cur.lines.push(line);
  }
  flush();
  // A status only counts while it's the last thing on screen.
  return { blocks: blocks.filter((b) => b.kind !== "tool" || b.title || b.output), status };
}

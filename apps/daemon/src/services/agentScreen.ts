/**
 * Reading an agent's state from its terminal screen (a tmux capture).
 * Pure, so it's tested against real captures.
 *
 * Claude Code shows "esc to interrupt" in its status line while it works,
 * and a numbered menu when it asks (permission prompts, questions):
 *
 *    Do you want to proceed?
 *    ❯ 1. Yes
 *      2. Yes, and don't ask again for pnpm commands in ~/aura
 *      3. No, and tell Claude what to do differently (esc)
 *
 * Some of its menus have no numbers (the "do you trust this folder?" one):
 * a cursor on one option, the others lined up under it, and "Enter to
 * confirm" below. Those are answered by moving the cursor, not by a digit:
 * `cursor` says where it is.
 *
 *    ❯ No, exit
 *      Yes, I trust this folder
 *
 *    Enter to confirm · Esc to cancel
 */
import { toB64u, utf8 } from "@ekatva/link";
import { blake2b } from "@noble/hashes/blake2.js";

export interface Screen {
  state: "working" | "waiting" | "idle";
  question: {
    text: string;
    options: { key: string; label: string }[];
    hash: string;
    /** An unnumbered menu: the option the cursor is on (0-based); answered with arrows. */
    cursor?: number;
  } | null;
  activity: string;
}

const BOX = /^[\s│┃|╭╮╰╯─━]+|[\s│┃|╭╮╰╯─━]+$/g;
const OPTION = /^(?:[❯›>▶]\s*)?(\d{1,2})[.)]\s+(.+)$/;
const RULE = /^[\s─━═╌┄-]{10,}$/;

const clean = (line: string) => line.replace(BOX, "").trim();
/** Below an unnumbered menu. */
const CONFIRM = /Enter to confirm/i;
const CURSOR = /^(\s*)[❯›]\s+(\S.*)$/;

/** True when the agent's input box is there and empty: it's ready for a prompt. */
export function readyForInput(capture: string): boolean {
  const lines = capture.replace(/\s+$/, "").split("\n");
  return lines.some((l, i) => /^\s*❯\s*$/.test(l) && RULE.test(lines[i - 1] ?? ""));
}

/** A menu with a cursor and no numbers, above "Enter to confirm". */
function unnumbered(tail: string[]): Screen["question"] {
  let f = -1;
  for (let i = tail.length - 1; i >= 0; i--)
    if (CONFIRM.test(tail[i] ?? "")) {
      f = i;
      break;
    }
  if (f < 0) return null;
  // Answered already: the screen moved on below it (the input box's rules).
  if (tail.slice(f + 1).some((l) => RULE.test(l))) return null;
  let c = -1;
  for (let i = f - 1; i >= Math.max(0, f - 14); i--)
    if (CURSOR.test(tail[i] ?? "")) {
      c = i;
      break;
    }
  if (c < 0) return null;
  const cur = CURSOR.exec(tail[c] ?? "") as RegExpExecArray;
  const col = (tail[c] ?? "").indexOf(cur[2] as string);
  const indent = (l: string) => l.length - l.trimStart().length;
  const isOption = (l: string | undefined) => !!l?.trim() && indent(l) === col;
  let first = c;
  while (isOption(tail[first - 1])) first--;
  let last = c;
  while (isOption(tail[last + 1])) last++;
  if (last === first) return null;
  const options = [];
  for (let i = first; i <= last; i++) {
    const label = i === c ? (cur[2] as string) : (tail[i] ?? "");
    options.push({ key: String(i - first + 1), label: label.trim().replace(/\s+/g, " ") });
  }
  // The question: the paragraph above that asks something, else the nearest one.
  const paras: string[][] = [[]];
  for (let i = first - 1; i >= 0; i--) {
    const l = tail[i] ?? "";
    if (RULE.test(l)) break;
    const t = clean(l);
    if (!t) {
      if ((paras[0] as string[]).length) paras.unshift([]);
      continue;
    }
    (paras[0] as string[]).unshift(t);
  }
  const blocks = paras.filter((p) => p.length).map((p) => p.join(" "));
  const text = (blocks.find((b) => b.includes("?")) ?? blocks.at(-1) ?? "Choose an option")
    .replace(/\s+/g, " ")
    .slice(0, 300);
  return { text, options, hash: questionHash(text, options), cursor: c - first };
}

export function questionHash(text: string, options: { key: string; label: string }[]): string {
  return toB64u(blake2b(utf8.encode(JSON.stringify([text, options])), { dkLen: 9 }));
}

/** "✶ Transfiguring… (16s · ↓ 1.1k tokens)": Claude Code's line while it works. */
const SPINNER = /^[✻✽✶✳✢·*]\s+\S.*…\s*\(\s*\d+[smh]/;
/** "✻ Waiting for 1 background agent to finish": still working, through its agents. */
const BG_WAIT = /^[✻✽✶✳✢·*]\s+Waiting for \d+ background agents?/i;
/** A background agent in the footer: "◯ security-reviewer  Reading the tests". */
const BG_AGENT = /^\s*[◯○]\s+(\S+)\s{2,}(\S.*?)\s*$/;

/** Background agents still at work, from the footer. */
export function backgroundAgents(capture: string): { name: string; activity: string }[] {
  const out: { name: string; activity: string }[] = [];
  for (const l of capture.split("\n").slice(-12)) {
    const m = BG_AGENT.exec(l);
    if (m) out.push({ name: m[1] as string, activity: (m[2] as string).slice(0, 120) });
  }
  return out;
}

export function readScreen(capture: string): Screen {
  const lines = capture.replace(/\s+$/, "").split("\n");
  const bottom = lines.slice(-8).join("\n");
  // Near the bottom: the status line sits above the input box and its footer.
  const near = lines.slice(-24).map((l) => l.trim());
  const working =
    /esc to interrupt/i.test(bottom) ||
    near.some((l) => SPINNER.test(l) || BG_WAIT.test(l)) ||
    backgroundAgents(capture).length > 0;

  // The last numbered menu: options 1, 2, 3… in order, in the last 30 lines.
  const tail = lines.slice(-30);
  let end = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (OPTION.test(clean(tail[i] ?? ""))) {
      end = i;
      break;
    }
  }
  let question: Screen["question"] = null;
  if (end >= 0) {
    // Walk up from the last option: options, blank lines and indented
    // continuations belong to the menu; anything else ends it.
    const opts: { key: string; label: string; at: number; cursor: boolean }[] = [];
    for (let i = end; i >= 0; i--) {
      const raw = tail[i] ?? "";
      const c = clean(raw);
      const m = OPTION.exec(c);
      if (m) {
        opts.unshift({
          key: m[1] as string,
          label: (m[2] as string).trim(),
          at: i,
          cursor: /^[❯›>▶]/.test(c),
        });
        if (m[1] === "1") break;
      } else if (c && !/^\s{4,}/.test(raw.replace(/^[│┃|]/, ""))) break;
    }
    // A real menu numbers its options 1, 2, 3… and shows a cursor on one;
    // a numbered list in the agent's answer doesn't.
    const menu =
      opts.length >= 2 &&
      opts.every((o, i) => o.key === String(i + 1)) &&
      opts.some((o) => o.cursor);
    if (menu) {
      const first = opts[0]?.at ?? 0;
      const text: string[] = [];
      for (let i = first - 1; i >= 0 && text.length < 4; i--) {
        if (RULE.test(tail[i] ?? "")) break;
        const c = clean(tail[i] ?? "");
        if (!c) {
          if (text.length) break;
          continue;
        }
        text.unshift(c);
      }
      const options = opts.map(({ key, label }) => ({ key, label: label.replace(/\s+/g, " ") }));
      const qtext = text.join(" ").replace(/\s+/g, " ").trim() || "Choose an option";
      question = { text: qtext, options, hash: questionHash(qtext, options) };
    }
  }

  question ??= unnumbered(tail);

  // What it's doing or last said: its spinner line, else its last "●" line.
  let activity = "";
  for (let i = lines.length - 1; i >= 0 && !activity; i--) {
    const l = lines[i] ?? "";
    const spin = /^[✻✽✶✳✢·*]\s+(.+?)(?:\s+\(.*)?$/.exec(l.trim());
    if (spin && working) activity = (spin[1] as string).replace(/…$/, "…");
    else if (/^[●⏺]\s+/.test(l.trim())) activity = l.trim().replace(/^[●⏺]\s+/, "");
  }

  return {
    state: question ? "waiting" : working ? "working" : "idle",
    question,
    activity: activity.slice(0, 160),
  };
}

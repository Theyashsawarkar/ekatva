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
 */
import { toB64u, utf8 } from "@ekatva/link";
import { blake2b } from "@noble/hashes/blake2.js";

export interface Screen {
  state: "working" | "waiting" | "idle";
  question: { text: string; options: { key: string; label: string }[]; hash: string } | null;
  activity: string;
}

const BOX = /^[\s│┃|╭╮╰╯─━]+|[\s│┃|╭╮╰╯─━]+$/g;
const OPTION = /^(?:[❯›>▶]\s*)?(\d{1,2})[.)]\s+(.+)$/;
const RULE = /^[\s─━═╌┄-]{10,}$/;

const clean = (line: string) => line.replace(BOX, "").trim();

export function questionHash(text: string, options: { key: string; label: string }[]): string {
  return toB64u(blake2b(utf8.encode(JSON.stringify([text, options])), { dkLen: 9 }));
}

export function readScreen(capture: string): Screen {
  const lines = capture.replace(/\s+$/, "").split("\n");
  const bottom = lines.slice(-8).join("\n");
  const working = /esc to interrupt/i.test(bottom);

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

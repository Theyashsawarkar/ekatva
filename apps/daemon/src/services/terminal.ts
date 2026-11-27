/**
 * A terminal on the laptop, from the phone: the laptop's own tmux server,
 * the same sessions you use at the laptop (opening on the one used last, as
 * Vayu's terminals do). One tab per window. The phone reads the screen
 * (with its colours) and sends keys; tmux keeps the shells running when the
 * phone goes away.
 *
 * Sizes are never forced: your windows keep the size of the laptop's
 * terminal (the phone fits or scrolls what it gets), and a session the
 * phone starts is born at the phone's size, which tmux then manages as
 * usual when you attach to it at the laptop.
 */
import type { Done, TerminalScreen, TerminalSession, TerminalTab } from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";
import { home } from "../paths.js";
import { tmux as defaultTmux, type Tmux } from "./agents.js";
import { WATCH_SESSION } from "./tmuxWatch.js";

/** The session opened when the laptop has none (tmux always runs in the terminal). */
export const FIRST_SESSION = "main";

/** Keys the phone may press, by name, as tmux names them. */
const KEYS: Record<string, string> = {
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  BackTab: "BTab",
  Backspace: "BSpace",
  Delete: "DC",
  Up: "Up",
  Down: "Down",
  Left: "Left",
  Right: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PPage",
  PageDown: "NPage",
};

/** "C-c", "M-x", or a named key: what tmux send-keys takes, refusing anything else. */
export function keyName(k: string): string {
  if (KEYS[k]) return KEYS[k] as string;
  const m = /^(C|M)-([a-z0-9[\]\\/_@^?])$/i.exec(k);
  if (m) return `${(m[1] as string).toUpperCase()}-${(m[2] as string).toLowerCase()}`;
  throw new TRPCError({ code: "BAD_REQUEST", message: `not a key: ${k}` });
}

/** A session name tmux takes as is: no ":" or "." (tmux's separators), no control characters. */
export function sessionName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (!/^[^:.\x00-\x1f$@%=][^:.\x00-\x1f]{0,63}$/.test(name))
    throw new TRPCError({ code: "BAD_REQUEST", message: "not a session name" });
  return name;
}

const noServer = (e: unknown) =>
  /no server running|no sessions|error connecting|No such file/i.test(String(e));

export class TerminalService {
  constructor(private readonly run: Tmux = defaultTmux) {}

  /** Every tmux session, the one used last first; starts one if the laptop has none. */
  async sessions(): Promise<TerminalSession[]> {
    let list = await this.list();
    if (!list.length) {
      await this.run(["new-session", "-d", "-s", FIRST_SESSION, "-c", home()]);
      list = await this.list();
    }
    return list;
  }

  private async list(): Promise<TerminalSession[]> {
    let out: string;
    try {
      out = await this.run([
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_activity}\t#{session_last_attached}",
      ]);
    } catch (e) {
      if (noServer(e)) return [];
      throw e;
    }
    return (
      out
        .split("\n")
        // ekatva's own watching session (agents' events) isn't one of yours.
        .filter((l) => l && !l.startsWith(`${WATCH_SESSION}\t`))
        .map((l) => {
          const [name, windows, attached, activity, last] = l.split("\t");
          return {
            name: name ?? "",
            windows: Number(windows ?? 0),
            attached: Number(attached ?? 0) > 0,
            activity: Number(activity ?? 0) * 1000,
            lastAttached: Number(last ?? 0) * 1000,
          };
        })
        .sort(
          (a, b) =>
            Number(b.attached) - Number(a.attached) ||
            Math.max(b.lastAttached, b.activity) - Math.max(a.lastAttached, a.activity),
        )
    );
  }

  /** The tabs (windows) of one session. */
  async tabs(session: string): Promise<TerminalTab[]> {
    const name = await this.session(session);
    const out = await this.run([
      "list-windows",
      "-t",
      `=${name}`,
      "-F",
      "#{window_id}\t#{window_index}\t#{window_active}\t#{pane_current_command}\t#{pane_current_path}\t#{window_name}",
    ]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [id, index, active, command, path, title] = l.split("\t");
        return {
          id: id ?? "",
          index: Number(index ?? 0),
          active: active === "1",
          command: command ?? "",
          path: (path ?? "").replace(home(), "~"),
          name: title ?? "",
        };
      });
  }

  async newTab(session: string): Promise<Done<TerminalTab[]>> {
    const name = await this.session(session);
    await this.run(["new-window", "-t", `=${name}:`, "-c", home()]);
    return { value: await this.tabs(name), summary: `Opened a window in tmux session ${name}` };
  }

  /** A new session (tmux names it if you don't), born at the phone's size. */
  async newSession(
    name: string | null,
    cols: number,
    rows: number,
  ): Promise<Done<TerminalSession[]>> {
    const args = ["new-session", "-d", "-P", "-F", "#{session_name}", "-c", home()];
    if (name) args.push("-s", sessionName(name));
    args.push("-x", String(cols), "-y", String(rows));
    const made = (await this.run(args)).trim();
    return { value: await this.sessions(), summary: `Started tmux session ${made}` };
  }

  async closeTab(id: string): Promise<Done<TerminalTab[]>> {
    const session = await this.window(id);
    await this.run(["kill-window", "-t", id]);
    const left = (await this.list()).some((s) => s.name === session);
    return {
      value: left ? await this.tabs(session) : [],
      summary: `Closed a window of tmux session ${session}`,
    };
  }

  /** The screen with its colours (ANSI), where the cursor is, and its size. */
  async screen(id: string, history: number): Promise<TerminalScreen> {
    await this.window(id);
    const [text, info] = await Promise.all([
      this.run(["capture-pane", "-p", "-e", "-t", id, "-S", `-${history}`]),
      this.run([
        "display-message",
        "-p",
        "-t",
        id,
        "#{cursor_x}\t#{cursor_y}\t#{pane_width}\t#{pane_height}\t#{history_size}",
      ]),
    ]);
    const [x, y, cols, rows, hist] = info.trim().split("\t").map(Number);
    return {
      text: text.replace(/\n+$/, ""),
      cursor: { x: x ?? 0, y: y ?? 0 },
      cols: cols ?? 0,
      rows: rows ?? 0,
      /** Lines above the screen in `text` (the cursor's row counts from after them). */
      above: Math.min(history, hist ?? 0),
    };
  }

  /** Types text (as is) and/or presses keys, in that order. "Prefix" is tmux's own prefix key. */
  async send(id: string, text: string | null, keys: string[]): Promise<void> {
    await this.window(id);
    if (text) await this.run(["send-keys", "-t", id, "-l", "--", text]);
    for (const k of keys)
      if (k === "Prefix") await this.run(["send-keys", "-t", id, await this.prefix()]);
      else await this.run(["send-keys", "-t", id, keyName(k)]);
  }

  /** Splits the window (a new pane in the same folder), or scrolls back (copy mode). */
  async action(id: string, what: "split" | "scroll"): Promise<void> {
    await this.window(id);
    if (what === "split") await this.run(["split-window", "-t", id, "-c", "#{pane_current_path}"]);
    else await this.run(["copy-mode", "-t", id]);
  }

  /** The prefix key as tmux names it (the user's own, "C-b" by default). */
  private async prefix(): Promise<string> {
    const p = (await this.run(["show-options", "-gv", "prefix"]).catch(() => "")).trim();
    return /^[A-Za-z0-9-]{1,16}$/.test(p) ? p : "C-b";
  }

  /** The session by its exact name, or NOT_FOUND. */
  private async session(name: string): Promise<string> {
    sessionName(name);
    if (!(await this.list()).some((s) => s.name === name))
      throw new TRPCError({ code: "NOT_FOUND", message: `no tmux session ${name}` });
    return name;
  }

  /** Only a window id ("@3") that exists; returns its session. */
  private async window(id: string): Promise<string> {
    if (!/^@\d+$/.test(id))
      throw new TRPCError({ code: "BAD_REQUEST", message: "not a terminal tab" });
    let out = "";
    try {
      out = await this.run(["list-windows", "-a", "-F", "#{window_id}\t#{session_name}"]);
    } catch (e) {
      if (!noServer(e)) throw e;
    }
    const hit = out
      .split("\n")
      .map((l) => l.split("\t"))
      .find(([w]) => w === id);
    if (!hit) throw new TRPCError({ code: "NOT_FOUND", message: "that terminal tab is closed" });
    return hit[1] ?? "";
  }
}

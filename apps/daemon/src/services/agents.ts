/**
 * AI agent sessions in tmux: which panes run an agent, what each is doing
 * or asking (read from its screen), and acting on them.
 *
 * An answer is sent only if the pane still shows the very question that
 * was answered (by its hash): a late tap can't land on the next question.
 * Replies go in with bracketed paste, so newlines don't submit early.
 */
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentSession, AgentTranscript, Done, Project } from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";
import { expand, home, tilde } from "../paths.js";
import { backgroundAgents, readScreen, readyForInput } from "./agentScreen.js";
import { transcript } from "./agentTranscript.js";

const AGENTS = { claude: "claude", codex: "codex", aider: "aider", gemini: "gemini" } as const;
type Kind = AgentSession["agent"];

export type Tmux = (args: string[], input?: string) => Promise<string>;

/** tmux, on the default server or (for tests) a private socket. */
export const tmuxOn =
  (socket?: string): Tmux =>
  (args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        "tmux",
        socket ? ["-L", socket, ...args] : args,
        { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
        (err, out, errOut) => {
          if (err) reject(new Error(String(errOut || err.message).trim()));
          else resolve(String(out));
        },
      );
      if (input !== undefined) child.stdin?.end(input);
    });

export const tmux = tmuxOn();

const FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{window_index}:#{window_name}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{@claude_wait}",
].join("\t");

export class AgentsService {
  private since = new Map<string, { state: string; at: number }>();
  private listeners = new Set<(s: AgentSession[]) => void>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private last = "";

  constructor(
    private readonly run: Tmux = tmux,
    private readonly roots: string[] = [],
    private readonly now: () => number = Date.now,
    /** How often `deliver` looks at a starting agent's screen. */
    private readonly stepMs = 500,
  ) {}

  async list(): Promise<AgentSession[]> {
    let out: string;
    try {
      out = await this.run(["list-panes", "-a", "-F", FORMAT]);
    } catch {
      return []; // no tmux server: no sessions
    }
    const sessions: AgentSession[] = [];
    for (const line of out.split("\n")) {
      const [id, session, window, command, path, wait] = line.split("\t");
      if (!id || !command) continue;
      const agent = (Object.keys(AGENTS) as (keyof typeof AGENTS)[]).find((k) =>
        command.toLowerCase().includes(AGENTS[k]),
      );
      if (!agent) continue;
      const capture = await this.capture(id, 60);
      const screen = readScreen(capture);
      // The Stop hook marked it waiting: it finished its turn, your move.
      const state = screen.state === "idle" && wait ? "done" : screen.state;
      const prev = this.since.get(id);
      if (!prev || prev.state !== state) this.since.set(id, { state, at: this.now() });
      sessions.push({
        id,
        session: session ?? "",
        window: window ?? "",
        agent: agent as Kind,
        project: tilde(path ?? ""),
        state,
        question: screen.question
          ? {
              text: screen.question.text,
              options: screen.question.options,
              hash: screen.question.hash,
            }
          : null,
        activity: screen.activity,
        since: this.since.get(id)?.at ?? this.now(),
        background: backgroundAgents(capture),
      });
    }
    return sessions;
  }

  /** The session list each time it changes (polling tmux while anyone listens). */
  async *changes(signal: AbortSignal | undefined): AsyncGenerator<AgentSession[]> {
    const queue: AgentSession[][] = [await this.list()];
    let wake: (() => void) | null = null;
    const cb = (s: AgentSession[]) => {
      queue.push(s);
      wake?.();
    };
    this.listeners.add(cb);
    this.poll();
    try {
      while (!signal?.aborted) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((res) => {
          wake = res;
          signal?.addEventListener("abort", () => res(), { once: true });
        });
      }
    } finally {
      this.listeners.delete(cb);
      if (!this.listeners.size && this.poller) {
        clearInterval(this.poller);
        this.poller = null;
      }
    }
  }

  /** Called by the hooks bridge (or the poller) when something may have changed. */
  async refresh(): Promise<AgentSession[]> {
    const now = await this.list();
    const key = JSON.stringify(now.map(({ since: _s, ...rest }) => rest));
    if (key !== this.last) {
      this.last = key;
      for (const cb of this.listeners) cb(now);
    }
    return now;
  }

  private poll(): void {
    if (this.poller) return;
    this.poller = setInterval(() => void this.refresh().catch(() => undefined), 1500);
  }

  private capture(id: string, lines: number): Promise<string> {
    return this.run(["capture-pane", "-p", "-J", "-t", id, "-S", `-${lines}`]).catch(() => "");
  }

  private async find(id: string): Promise<AgentSession> {
    if (!/^%\d+$/.test(id)) throw new TRPCError({ code: "BAD_REQUEST", message: "not a pane" });
    const s = (await this.list()).find((x) => x.id === id);
    if (!s) throw new TRPCError({ code: "NOT_FOUND", message: "that session has ended" });
    return s;
  }

  async tail(id: string, lines: number): Promise<string> {
    await this.find(id);
    return this.capture(id, lines);
  }

  /** The screen as a conversation, for reading on a phone. */
  async transcript(id: string, lines: number): Promise<AgentTranscript> {
    await this.find(id);
    return transcript(await this.capture(id, lines));
  }

  async answer(id: string, option: string, questionHash: string): Promise<Done<null>> {
    const s = await this.find(id);
    if (!s.question || s.question.hash !== questionHash) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "it's asking something else now; look again",
      });
    }
    const chosen = s.question.options.find((o) => o.key === option);
    if (!chosen) throw new TRPCError({ code: "BAD_REQUEST", message: "not one of the options" });
    // A menu without numbers: move its cursor to the option, then Enter.
    const cursor = readScreen(await this.capture(id, 60)).question?.cursor;
    if (cursor !== undefined) {
      const moves = Number(chosen.key) - 1 - cursor;
      for (let i = 0; i < Math.abs(moves); i++)
        await this.run(["send-keys", "-t", id, moves > 0 ? "Down" : "Up"]);
      await this.run(["send-keys", "-t", id, "Enter"]);
    } else await this.run(["send-keys", "-t", id, chosen.key]);
    await this.run(["set", "-p", "-t", id, "-u", "@claude_wait"]).catch(() => undefined);
    void this.refresh().catch(() => undefined);
    return {
      value: null,
      summary: `Answered "${chosen.label}" in ${s.session}: ${s.question.text}`,
    };
  }

  async reply(id: string, text: string): Promise<Done<null>> {
    const s = await this.find(id);
    await this.paste(id, text);
    await this.run(["send-keys", "-t", id, "Enter"]);
    await this.run(["set", "-p", "-t", id, "-u", "@claude_wait"]).catch(() => undefined);
    void this.refresh().catch(() => undefined);
    return { value: null, summary: `Replied to ${s.session} (${text.length} characters)` };
  }

  async interrupt(id: string): Promise<Done<null>> {
    const s = await this.find(id);
    await this.run(["send-keys", "-t", id, "Escape"]);
    return { value: null, summary: `Interrupted ${s.session}` };
  }

  /** A new tmux session in `project`, running the agent, with a first prompt. */
  async start(
    project: string,
    prompt: string | null,
    agent: "claude" | "codex",
  ): Promise<Done<AgentSession>> {
    const dir = expand(project);
    const known = (await this.projects()).some((p) => expand(p.path) === dir);
    if (!known || !statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${tilde(dir)} isn't one of your projects`,
      });
    }
    const taken = new Set(
      (await this.run(["list-sessions", "-F", "#{session_name}"]).catch(() => "")).split("\n"),
    );
    const base =
      basename(dir)
        .replace(/[^\w-]+/g, "_")
        .slice(0, 30) || "agent";
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    // A shell first, so the session stays when the agent exits.
    await this.run(["new-session", "-d", "-s", name, "-c", dir]);
    const pane = (await this.run(["display", "-p", "-t", name, "#{pane_id}"])).trim();
    await this.run(["send-keys", "-t", pane, "-l", "--", agent]);
    await this.run(["send-keys", "-t", pane, "Enter"]);
    // The first prompt goes in once its input box is there, in the background:
    // it may ask something first (whether to trust the folder), which you
    // answer on the phone. Never type before: an Enter would answer that.
    if (prompt) void this.deliver(pane, prompt);
    const s = (await this.list()).find((x) => x.id === pane) ?? {
      id: pane,
      session: name,
      window: "1",
      agent,
      project: tilde(dir),
      state: "working" as const,
      question: null,
      activity: "starting",
      since: this.now(),
      background: [],
    };
    return { value: s, summary: `Started ${agent} in ${tilde(dir)} (session ${name})` };
  }

  /**
   * Types the first prompt once the agent's input box is there: waits while
   * it starts and while it asks something, gives up after `limitMs` or if
   * the agent quit (the pane is a shell again).
   */
  private async deliver(pane: string, prompt: string, limitMs = 10 * 60_000): Promise<boolean> {
    const until = this.now() + limitMs;
    let seen = false;
    while (this.now() < until) {
      await new Promise((r) => setTimeout(r, this.stepMs));
      const cmd = await this.run(["display", "-p", "-t", pane, "#{pane_current_command}"]).catch(
        () => null,
      );
      if (cmd === null) return false; // the pane is gone
      const agent = Object.values(AGENTS).some((a) => cmd.toLowerCase().includes(a));
      if (agent) seen = true;
      else if (seen) return false; // it started and quit (said No): nothing to type into
      const screen = await this.capture(pane, 40);
      if (agent && readyForInput(screen) && !readScreen(screen).question) {
        await this.paste(pane, prompt);
        await this.run(["send-keys", "-t", pane, "Enter"]);
        void this.refresh().catch(() => undefined);
        return true;
      }
    }
    return false;
  }

  private async paste(target: string, text: string): Promise<void> {
    const buf = `ekatva-${process.pid}-${this.now()}`;
    await this.run(["load-buffer", "-b", buf, "-"], text);
    await this.run(["paste-buffer", "-p", "-d", "-b", buf, "-t", target]);
  }

  /** Your projects: Claude's, tmux's, and git repositories under the roots. */
  async projects(): Promise<Project[]> {
    const found = new Map<string, number | null>();
    try {
      const claude = JSON.parse(readFileSync(join(home(), ".claude.json"), "utf8"));
      for (const p of Object.keys(claude.projects ?? {})) found.set(p, null);
    } catch {
      // no Claude config
    }
    const panes = await this.run(["list-panes", "-a", "-F", "#{pane_current_path}"]).catch(
      () => "",
    );
    for (const p of panes.split("\n")) if (p) found.set(p, null);
    for (const r of this.roots.map(expand)) {
      for (const n of await readdir(r).catch(() => [] as string[])) {
        const p = join(r, n);
        if (
          await stat(join(p, ".git")).then(
            () => true,
            () => false,
          )
        )
          found.set(p, null);
      }
    }
    const out: Project[] = [];
    for (const path of found.keys()) {
      if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) continue;
      // Claude keeps each project's history under ~/.claude/projects/<path with - for / and .>.
      const hist = join(home(), ".claude/projects", path.replace(/[/.]/g, "-"));
      const lastUsed = statSync(hist, { throwIfNoEntry: false })?.mtimeMs ?? null;
      out.push({ path: tilde(path), name: basename(path) || path, lastUsed });
    }
    return out.sort(
      (a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0) || a.name.localeCompare(b.name),
    );
  }

  shutdown(): void {
    if (this.poller) clearInterval(this.poller);
  }
}

/**
 * AI agent sessions in tmux: which panes run an agent, what each is doing
 * or asking (read from its screen), and acting on them.
 *
 * An answer is sent only if the pane still shows the very question that
 * was answered (by its hash): a late tap can't land on the next question.
 * Replies go in with bracketed paste, so newlines don't submit early.
 */
import { execFile } from "node:child_process";
import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AgentPage,
  AgentSession,
  AgentTranscript,
  AgentUpdate,
  Done,
  Project,
} from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";
import { expand, home, tilde } from "../paths.js";
import { backgroundAgents, readScreen, readyForInput } from "./agentScreen.js";
import { transcript } from "./agentTranscript.js";
import { ClaudeHistory } from "./claudeHistory.js";
import { type ClaudeSession, ClaudeSessions, within } from "./claudeSessions.js";
import { debounce } from "./lineChild.js";
import { TmuxWatch, WATCH_SESSION } from "./tmuxWatch.js";

const AGENTS = { claude: "claude", codex: "codex", aider: "aider", gemini: "gemini" } as const;
type Kind = AgentSession["agent"];

export type Tmux = ((args: string[], input?: string) => Promise<string>) & {
  /** Set on a real tmux (tmuxOn): its server can be watched in control mode. */
  control?: { socket?: string };
};

/** Says when agents' sessions may have changed, instead of asking every 1.5 s. */
export interface AgentEvents {
  /** `down`: it can't (then the list is polled, as before). */
  start(changed: (why: string) => void, down: () => void): void;
  stop(): void;
}

/** tmux's control mode on the server `run` talks to; null for a tmux that isn't real (tests' fakes). */
export function tmuxEvents(run: Tmux, log?: (m: string) => void): AgentEvents | null {
  if (!run.control) return null;
  let w: TmuxWatch | null = null;
  return {
    start(changed, down) {
      w?.stop();
      w = new TmuxWatch({
        ...(run.control?.socket ? { socket: run.control.socket } : {}),
        onChange: changed,
        onDown: down,
        ...(log ? { log } : {}),
        onlyOurs: async () => {
          const names = (await run(["list-sessions", "-F", "#{session_name}"])).split("\n");
          if (names.some((n) => n && n !== WATCH_SESSION)) return false;
          return (await run(["show-options", "-gv", "exit-empty"])).trim() !== "off";
        },
      });
      w.start();
    },
    stop() {
      w?.stop();
      w = null;
    },
  };
}

/** tmux, on the default server or (for tests) a private socket. */
export const tmuxOn = (socket?: string): Tmux =>
  Object.assign(
    (args: string[], input?: string) =>
      new Promise<string>((resolve, reject) => {
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
      }),
    { control: socket ? { socket } : {} },
  );

export const tmux = tmuxOn();

const FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{window_index}:#{window_name}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{@claude_wait}",
  "#{pane_title}",
  "#{pane_pid}",
].join("\t");

export class AgentsService {
  private since = new Map<string, { state: string; at: number }>();
  private listeners = new Set<(s: AgentSession[]) => void>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private last = "";
  /** While watched by events: a slow look in case one was missed. */
  private safety: ReturnType<typeof setInterval> | null = null;
  /** Claude's own records: its sessions' folder, and the transcripts of the sessions listed. */
  private fsWatches = new Map<string, FSWatcher>();
  /** The transcripts behind the sessions listed last. */
  private files = new Set<string>();
  private evented = false;
  /** A burst of changes is one look, at most one a second (an agent at work prints all the time). */
  private kick = debounce(() => void this.refresh().catch(() => undefined), 100, 1000);
  private readonly events: AgentEvents | null;

  constructor(
    private readonly run: Tmux = tmux,
    private readonly roots: string[] = [],
    private readonly now: () => number = Date.now,
    /** How often `deliver` looks at a starting agent's screen. */
    private readonly stepMs = 500,
    /** Claude Code's folder. */
    private readonly claudeDir = join(home(), ".claude"),
    /** What says when sessions change (default: tmux's control mode on `run`'s server); null polls. */
    events?: AgentEvents | null,
  ) {
    this.claude = new ClaudeSessions(claudeDir);
    this.events = events === undefined ? tmuxEvents(run) : events;
  }

  private readonly claude: ClaudeSessions;
  /** Histories read so far, the latest used last (a few are kept). */
  private histories = new Map<string, ClaudeHistory>();

  async list(): Promise<AgentSession[]> {
    let out: string;
    try {
      out = await this.run(["list-panes", "-a", "-F", FORMAT]);
    } catch {
      return []; // no tmux server: no sessions
    }
    const sessions: AgentSession[] = [];
    const files = new Set<string>();
    const own = await this.own(out);
    for (const line of out.split("\n")) {
      const [id, session, window, command, path, wait, title] = line.split("\t");
      if (!id || !command || session === WATCH_SESSION) continue;
      const agent = (Object.keys(AGENTS) as (keyof typeof AGENTS)[]).find((k) =>
        command.toLowerCase().includes(AGENTS[k]),
      );
      if (!agent) continue;
      const capture = await this.capture(id, 60);
      const screen = readScreen(capture);
      // The Stop hook marked it waiting: it finished its turn, your move.
      const mine = agent === "claude" ? own.get(id) : undefined;
      const background = backgroundAgents(capture);
      // Claude says itself whether it's busy; its screen says what it asks.
      const seen =
        mine?.status === "busy" && screen.state === "idle"
          ? "working"
          : mine?.status === "idle" && screen.state === "working" && !background.length
            ? "idle"
            : screen.state;
      const state = seen === "idle" && wait ? "done" : seen;
      // The list never waits for a history to be read: what's known of it so far.
      const file = mine ? await this.claude.transcript(mine) : null;
      if (file) files.add(file);
      const history = file ? (this.histories.get(file) ?? null) : null;
      if (history) await history.refresh().catch(() => undefined);
      else if (mine?.status === "busy") void this.historyOf(mine).catch(() => undefined);
      const prev = this.since.get(id);
      if (!prev || prev.state !== state) this.since.set(id, { state, at: this.now() });
      sessions.push({
        id,
        session: session ?? "",
        name: nameOf(mine, history, title) ?? session ?? "",
        rich: !!file,
        queued: mine && state === "working" ? (history?.queued(mine.startedAt).length ?? 0) : 0,
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
        background,
      });
    }
    this.files = files;
    return sessions;
  }

  /** The session list each time it changes (told by tmux while anyone listens, else polled). */
  async *changes(signal: AbortSignal | undefined): AsyncGenerator<AgentSession[]> {
    const queue: AgentSession[][] = [await this.list()];
    let wake: (() => void) | null = null;
    const cb = (s: AgentSession[]) => {
      queue.push(s);
      wake?.();
    };
    this.listeners.add(cb);
    if (this.listeners.size === 1) this.watch();
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
      if (!this.listeners.size) this.unwatch();
    }
  }

  /** Starts watching: tmux's events and Claude's files, or polling when tmux can't tell. */
  private watch(): void {
    if (!this.events) {
      this.poll();
      return;
    }
    this.evented = true;
    this.events.start(
      () => this.kick(),
      () => {
        // Control mode doesn't work here: ask every 1.5 s, as before.
        this.evented = false;
        this.unwatchFiles();
        if (this.listeners.size) this.poll();
      },
    );
    this.watchFile(join(this.claudeDir, "sessions"));
    this.safety = setInterval(() => this.kick(), 30_000);
    this.safety.unref?.();
  }

  private unwatch(): void {
    this.events?.stop();
    this.evented = false;
    this.kick.cancel();
    if (this.poller) clearInterval(this.poller);
    if (this.safety) clearInterval(this.safety);
    this.poller = null;
    this.safety = null;
    this.unwatchFiles();
  }

  private watchFile(path: string): void {
    if (this.fsWatches.has(path)) return;
    try {
      const w = watch(path, () => this.kick());
      w.on("error", () => {
        w.close();
        this.fsWatches.delete(path);
      });
      this.fsWatches.set(path, w);
    } catch {
      // not there (yet): tmux's events still come
    }
  }

  private unwatchFiles(): void {
    for (const w of this.fsWatches.values()) w.close();
    this.fsWatches.clear();
  }

  /** Watches the transcripts of the sessions listed now, and no others. */
  private followFiles(): void {
    if (!this.evented) return;
    const sessions = join(this.claudeDir, "sessions");
    for (const [path, w] of this.fsWatches)
      if (path !== sessions && !this.files.has(path)) {
        w.close();
        this.fsWatches.delete(path);
      }
    for (const f of this.files) this.watchFile(f);
  }

  /** How the list is watched now (for tests). */
  get watching(): "events" | "polling" | "idle" {
    return this.poller ? "polling" : this.evented ? "events" : "idle";
  }

  /** Called by the hooks bridge (or the poller) when something may have changed. */
  async refresh(): Promise<AgentSession[]> {
    const now = await this.list();
    this.followFiles();
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
    this.poller.unref?.();
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

  // ---------------------------------------------------- its whole history
  /** Claude's sessions by pane, on this tmux server. */
  private async own(listed?: string): Promise<Map<string, ClaudeSession>> {
    const out = listed ?? (await this.run(["list-panes", "-a", "-F", FORMAT]).catch(() => ""));
    const pids = new Map(
      out.split("\n").map((l) => {
        const f = l.split("\t");
        return [f[0] ?? "", Number(f.at(-1))];
      }),
    );
    return this.claude.byPane((pane, pid) => {
      const shell = pids.get(pane);
      return !!shell && within(pid, shell);
    });
  }

  private async historyOf(s: ClaudeSession): Promise<ClaudeHistory | null> {
    const file = await this.claude.transcript(s);
    if (!file) return null;
    const h = this.histories.get(file) ?? new ClaudeHistory(file);
    this.histories.delete(file);
    this.histories.set(file, h);
    for (const old of this.histories.keys()) {
      if (this.histories.size <= 12) break;
      this.histories.delete(old);
    }
    await h.refresh().catch(() => undefined);
    return h;
  }

  private async richOf(id: string): Promise<{ claude: ClaudeSession; history: ClaudeHistory }> {
    if (!/^%\d+$/.test(id)) throw new TRPCError({ code: "BAD_REQUEST", message: "not a pane" });
    const claude = (await this.own()).get(id);
    const history = claude ? await this.historyOf(claude) : null;
    if (!claude || !history)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "that session has no history to read yet",
      });
    return { claude, history };
  }

  async history(id: string, before: number | null, limit: number): Promise<AgentPage> {
    const { claude, history: h } = await this.richOf(id);
    const to = Math.min(before ?? h.total, h.total);
    return { epoch: epochOf(claude, h), total: h.total, items: h.items(to - limit, to) };
  }

  async output(id: string, n: number, epoch: string): Promise<string> {
    const { claude, history } = await this.richOf(id);
    try {
      if (epoch !== epochOf(claude, history))
        throw new Error("that's not in the conversation any more");
      return await history.full(n, history.epoch);
    } catch (e) {
      throw new TRPCError({ code: "NOT_FOUND", message: (e as Error).message });
    }
  }

  /** The latest items, then each change, looked for every second. */
  async *follow(id: string, signal: AbortSignal | undefined): AsyncGenerator<AgentUpdate> {
    let was: { h: ClaudeHistory; epoch: number; version: number; from: number } | null = null;
    let said = "";
    while (!signal?.aborted) {
      const { claude, history: h } = await this.richOf(id);
      const screen = await this.capture(id, 60);
      const status = claude.status === "idle" ? null : transcript(screen).status;
      const queued = claude.status === "idle" ? [] : h.queued(claude.startedAt);
      const reset: boolean = !was || was.h !== h || was.epoch !== h.epoch;
      const from: number = reset || !was ? Math.max(0, h.total - 60) : was.from;
      const items = reset || !was ? h.items(from, h.total) : h.since(was.version, from);
      const rest = JSON.stringify([status, queued]);
      if (reset || items.length || rest !== said)
        yield { reset, epoch: epochOf(claude, h), total: h.total, items, queued, status };
      was = { h, epoch: h.epoch, version: h.version, from };
      said = rest;
      await new Promise<void>((res) => {
        const t = setTimeout(done, 1000);
        function done() {
          clearTimeout(t);
          signal?.removeEventListener("abort", done);
          res();
        }
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  }

  /** Throws when typing now would land in something else: a question, or words left on the laptop. */
  private async free(id: string): Promise<void> {
    const screen = await this.run(["capture-pane", "-p", "-e", "-J", "-t", id, "-S", "-60"]).catch(
      () => "",
    );
    if (readScreen(plain(screen)).question)
      throw new TRPCError({
        code: "CONFLICT",
        message: "it's asking you something: answer that first",
      });
    if (draftOf(screen))
      throw new TRPCError({
        code: "CONFLICT",
        message: "there are unsent words in its box on the laptop: send or clear them there first",
      });
  }

  async rename(id: string, name: string): Promise<Done<null>> {
    const { claude, history } = await this.richOf(id);
    const was = nameOf(claude, history) ?? id;
    await this.free(id);
    // Claude's own command: it runs at once, also while it works.
    await this.paste(id, `/rename ${name}`);
    await new Promise((r) => setTimeout(r, this.stepMs));
    await this.run(["send-keys", "-t", id, "Enter"]);
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, this.stepMs));
      if ((await this.own()).get(id)?.name === name) {
        void this.refresh().catch(() => undefined);
        return { value: null, summary: `Renamed ${was} to ${name}` };
      }
    }
    throw new TRPCError({ code: "CONFLICT", message: "Claude didn't take the new name" });
  }

  async sendNow(id: string): Promise<Done<null>> {
    const s = await this.find(id);
    const { claude, history } = await this.richOf(id);
    if (!history.queued(claude.startedAt).length)
      throw new TRPCError({ code: "CONFLICT", message: "nothing is waiting: it took it already" });
    await this.pressSendNow(id);
    return { value: null, summary: `Had ${s.name} take what was queued now` };
  }

  /** Claude's "send now" (ctrl+x ctrl+s): what's queued interrupts what it's doing. */
  private async pressSendNow(id: string): Promise<void> {
    await this.run(["send-keys", "-t", id, "C-x", "C-s"]);
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
      summary: `Answered "${chosen.label}" in ${s.name}: ${s.question.text}`,
    };
  }

  async reply(id: string, text: string, now = false): Promise<Done<null>> {
    const s = await this.find(id);
    if (s.rich) await this.free(id);
    await this.paste(id, text);
    await this.run(["send-keys", "-t", id, "Enter"]);
    if (now && s.rich && s.state === "working") {
      const { claude, history } = await this.richOf(id);
      // Once it's in the queue; taken already (it was between steps): nothing to press.
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, this.stepMs / 2));
        await history.refresh().catch(() => undefined);
        if (history.queued(claude.startedAt).length) {
          await this.pressSendNow(id);
          break;
        }
      }
    }
    await this.run(["set", "-p", "-t", id, "-u", "@claude_wait"]).catch(() => undefined);
    void this.refresh().catch(() => undefined);
    return { value: null, summary: `Replied to ${s.name} (${text.length} characters)` };
  }

  async interrupt(id: string): Promise<Done<null>> {
    const s = await this.find(id);
    await this.run(["send-keys", "-t", id, "Escape"]);
    return { value: null, summary: `Interrupted ${s.name}` };
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
      name,
      rich: false,
      queued: 0,
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
    const panes = await this.run([
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{pane_current_path}",
    ]).catch(() => "");
    for (const l of panes.split("\n")) {
      const [session, p] = l.split("\t");
      if (p && session !== WATCH_SESSION) found.set(p, null);
    }
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
    this.listeners.clear();
    this.unwatch();
  }
}

const epochOf = (s: ClaudeSession, h: ClaudeHistory) => `${s.sessionId}:${h.epoch}`;

/** Claude's name for the session: yours or the topic's; a name made from the folder only if there's no topic. */
export function nameOf(
  s: ClaudeSession | undefined,
  h: ClaudeHistory | null,
  /** The terminal's title: Claude puts the topic there ("✳ Fixing the login"). */
  title = "",
): string | null {
  if (!s) return null;
  if (s.name && s.nameSource !== "derived") return s.name;
  const topic = title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return h?.aiTitle ?? (topic && topic !== "Claude Code" ? topic : s.name);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the terminal's own colours
const SGR = /\u001b\[([0-9;:]*)m/g;
const plain = (s: string) => s.replace(SGR, "");

/**
 * Words typed in Claude's input box and not sent, from a capture with
 * colours: its own suggestion there is dim, which isn't a draft.
 */
export function draftOf(capture: string): string {
  const lines = capture.replace(/\s+$/, "").split("\n");
  for (let i = lines.length - 1; i > 0; i--) {
    const l = lines[i] as string;
    if (!/^\s*❯/.test(plain(l)) || !/^\s*[─━═]{10,}/.test(plain(lines[i - 1] ?? ""))) continue;
    // Only what isn't dim, nor under the cursor (a suggestion's first letter is).
    let dim = false;
    let inverse = false;
    let out = "";
    let at = 0;
    for (const m of l.matchAll(SGR)) {
      if (!dim && !inverse) out += l.slice(at, m.index);
      at = (m.index ?? 0) + m[0].length;
      const codes = (m[1] || "0").split(/[;:]/);
      if (codes[0] === "7") inverse = true;
      else if (codes.includes("27") || codes[0] === "0") inverse = false;
      if (codes.includes("2") && !codes.includes("38") && !codes.includes("48")) dim = true;
      else if (codes.includes("0") || codes.includes("22")) dim = false;
    }
    if (!dim && !inverse) out += l.slice(at);
    return out
      .replace(/^\s*❯/, "")
      .replace(/\u00a0/g, " ")
      .trim();
  }
  return "";
}

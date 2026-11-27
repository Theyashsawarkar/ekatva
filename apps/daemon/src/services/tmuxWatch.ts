/**
 * Changes in tmux, told by tmux itself (control mode) instead of asking it
 * every 1.5 s: a `tmux -C` client in a small session of its own subscribes
 * (`refresh-client -B`) to one format over every pane of every session. tmux
 * evaluates it in the server and writes a line only when it changes: a pane
 * running an agent appears or goes, its title, folder, window or
 * @claude_wait changes, or its window shows new output (window_activity,
 * for agents' panes only).
 *
 * Its session ("ekatva-watch") runs nothing but `sleep`, is destroyed by
 * tmux when this client leaves (destroy-unattached), and is left out of
 * every list ekatva shows. It never starts a tmux server (`-N`): with none
 * running it watches tmux's socket folder for one to appear. Nothing in
 * your tmux config changes (no global hooks or options).
 */
import { existsSync, type FSWatcher, statSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LineChild, type Spawn } from "./lineChild.js";

/** The session the control client sits in; ekatva's lists leave it out. */
export const WATCH_SESSION = "ekatva-watch";

const AGENT_RE = "claude|codex|aider|gemini";

/**
 * For each pane running an agent: what the session list is made of, plus
 * when its window last printed something. tmux checks it once a second.
 * Kept free of single quotes (it goes inside them).
 */
export const PANES_FORMAT = `#{S:#{W:#{P:#{?#{m/ri:${AGENT_RE},#{pane_current_command}},#{pane_id} #{session_name} #{window_index}:#{window_name} #{pane_current_command} #{pane_current_path} #{@claude_wait} #{pane_title} #{window_activity}|,}}}}`;

/** Where tmux keeps a server's socket: `-L name`, else "default", under $TMUX_TMPDIR/tmux-UID. */
export function tmuxSocketPath(
  socket: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (socket?.includes("/")) return socket;
  const uid = process.getuid?.() ?? 0;
  return join(env.TMUX_TMPDIR || "/tmp", `tmux-${uid}`, socket ?? "default");
}

export interface TmuxWatchOptions {
  /** The server's `-L` name (tests: a private one); the default server when unset. */
  socket?: string;
  /** Where its socket is (worked out from `socket` when unset). */
  socketPath?: string;
  /** Something may have changed. */
  onChange: (why: string) => void;
  /** Control mode doesn't work here (an old tmux): poll instead. */
  onDown: (why: string) => void;
  spawn?: Spawn;
  log?: (msg: string) => void;
  /** Is ours the only session left, on a server that would exit without it? */
  onlyOurs?: () => Promise<boolean>;
}

export class TmuxWatch {
  private child: LineChild | null = null;
  private dirWatch: FSWatcher | null = null;
  private dirTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Subscribed: its first answer came. */
  private subscribed = false;
  private readonly path: string;
  /** The socket it last tried (inode and change time): a new server makes a
   * new one. The inode alone isn't enough: ext4 and xfs hand a socket made
   * right after the old one was removed the same inode number. */
  private tried: string | null = null;
  /** When it last came back after being closed, for a limit. */
  private rejoins: number[] = [];

  constructor(private readonly o: TmuxWatchOptions) {
    this.path = o.socketPath ?? tmuxSocketPath(o.socket);
  }

  /** Whether tmux is telling us about changes right now. */
  get live(): boolean {
    return this.subscribed;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (existsSync(this.path)) this.attach();
    else this.awaitServer();
  }

  stop(): void {
    this.running = false;
    this.subscribed = false;
    this.child?.stop();
    this.child = null;
    this.unwatchDir();
  }

  private attach(): void {
    this.unwatchDir();
    this.tried = this.identity();
    let failed = false;
    let started = false;
    const args = [
      ...(this.o.socket ? ["-L", this.o.socket] : []),
      "-N",
      "-C",
      "new-session",
      "-A",
      "-s",
      WATCH_SESSION,
      "-x",
      "80",
      "-y",
      "24",
      "-f",
      "ignore-size,no-output",
      "exec sleep infinity",
      // In the same command, so it's set before anything else can run:
      // tmux destroys the session when this client leaves.
      ";",
      "set-option",
      "-t",
      WATCH_SESSION,
      "destroy-unattached",
      "on",
    ];
    const child = new LineChild({
      cmd: "tmux",
      args,
      ...(this.o.spawn ? { spawn: this.o.spawn } : {}),
      respawn: false,
      onStart: () => {
        child.write(`refresh-client -B 'ekatva-panes::${PANES_FORMAT}'`);
      },
      onLine: (line) => {
        if (line.startsWith("%subscription-changed ekatva-panes ")) {
          if (!this.subscribed) this.subscribed = true;
          started = true;
          this.o.onChange("panes");
        } else if (line.startsWith("%error")) {
          failed = true;
        } else if (line === "%sessions-changed" || line.startsWith("%unlinked-window-close")) {
          this.o.onChange("sessions");
          if (line === "%sessions-changed") void this.leaveIfAlone();
        } else if (line.startsWith("%exit")) {
          this.subscribed = false;
        }
      },
      onExit: (_code, stderr) => {
        const was = this.subscribed || started;
        this.subscribed = false;
        if (this.child !== child) return;
        this.child = null;
        if (!this.running) return;
        const gone = /no server|error connecting|server exited|lost server/i.test(stderr);
        if (was) this.o.onChange("server");
        // Thrown out while the server runs on (its session killed, `detach -a`):
        // back in a second, a few times a minute at most.
        if (was && !gone && existsSync(this.path)) {
          const now = Date.now();
          this.rejoins = this.rejoins.filter((t) => now - t < 60_000);
          if (this.rejoins.length >= 5) return this.down("tmux -C keeps being closed");
          this.rejoins.push(now);
          const t = setTimeout(() => {
            if (this.running && !this.child) this.attach();
          }, 1000);
          t.unref?.();
          return;
        }
        // The server went away (or wasn't there after all): wait for one.
        if (was || gone) {
          this.awaitServer();
          return;
        }
        this.down(failed ? "tmux refused control mode" : `tmux -C ended: ${stderr.trim()}`);
      },
      onDown: (why) => this.down(why === "missing" ? "no tmux" : "tmux -C keeps failing"),
    });
    this.child = child;
    child.start();
  }

  private down(why: string): void {
    this.o.log?.(`agents: watching tmux by polling (${why})`);
    this.stop();
    this.o.onDown(why);
  }

  /**
   * Ours is the last session on a server that exits when it has none
   * (exit-empty): leave, so tmux can exit as it would have.
   */
  private async leaveIfAlone(): Promise<void> {
    if (!this.o.onlyOurs || !this.child) return;
    if (!(await this.o.onlyOurs().catch(() => false))) return;
    this.subscribed = false;
    const c = this.child;
    this.child = null;
    c?.stop();
    this.awaitServer();
  }

  /**
   * No server (or only ours was left): wait for a server to make its socket
   * (anew: tmux leaves the old one behind when it exits), watching the folder.
   */
  private awaitServer(): void {
    this.unwatchDir();
    if (!this.running) return;
    const dir = dirname(this.path);
    const name = basename(this.path);
    let soon: ReturnType<typeof setTimeout> | null = null;
    try {
      this.dirWatch = watch(dir, (_event, file) => {
        if ((file && String(file) !== name) || soon) return;
        soon = setTimeout(() => {
          soon = null;
          if (this.running && !this.child && existsSync(this.path)) this.attach();
        }, 150);
        soon.unref?.();
      });
      this.dirWatch.on("error", () => this.unwatchDir());
      // A server that made its socket before the folder was watched.
      const now = this.identity();
      if (now !== null && now !== this.tried) this.attach();
    } catch {
      // No folder yet (tmux never ran here): look now and then, starting nothing.
      this.dirTimer = setInterval(() => {
        if (!existsSync(dir)) return;
        this.awaitServer();
        if (existsSync(this.path)) this.attach();
      }, 10_000);
      this.dirTimer.unref?.();
    }
  }

  private identity(): string | null {
    const st = statSync(this.path, { throwIfNoEntry: false, bigint: true });
    return st ? `${st.ino}:${st.ctimeNs}` : null;
  }

  private unwatchDir(): void {
    this.dirWatch?.close();
    this.dirWatch = null;
    if (this.dirTimer) clearInterval(this.dirTimer);
    this.dirTimer = null;
  }
}

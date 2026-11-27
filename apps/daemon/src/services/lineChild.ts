/**
 * A long-lived helper process whose output is read line by line: the event
 * sources that replace polling (`wl-paste --watch`, `dbus-monitor`,
 * `pactl subscribe`, `tmux -C`). It sleeps until something happens, so the
 * daemon wakes only then.
 *
 * When it dies on its own it comes back, waiting longer each time (a
 * compositor restart, a bus that went away); when it keeps dying right
 * after it starts, or isn't installed, it gives up and says so, and the
 * caller falls back to polling.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";

/** What a watcher needs of a child process (a fake one in tests). */
export interface LineProc {
  stdout: NodeJS.ReadableStream | null;
  stderr?: NodeJS.ReadableStream | null;
  stdin?: NodeJS.WritableStream | null;
  on(event: "exit", cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export type Spawn = (cmd: string, args: string[]) => LineProc;

export const realSpawn: Spawn = (cmd, args) =>
  nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcess as LineProc;

export type Down =
  /** Not installed. */
  | "missing"
  /** It kept dying right after it started. */
  | "failing";

export interface LineChildOptions {
  cmd: string;
  args: string[];
  spawn?: Spawn;
  onLine: (line: string) => void;
  /** Each time it starts (again): commands to write, a first look. */
  onStart?: (proc: LineProc) => void;
  /** Each time it ends, with the last of what it wrote on stderr. */
  onExit?: (code: number | null, stderr: string) => void;
  /** It won't come back: poll instead. */
  onDown?: (why: Down) => void;
  /** Come back after it ends on its own (default true). */
  respawn?: boolean;
  /** The first wait before coming back; it doubles up to maxMs. */
  minMs?: number;
  maxMs?: number;
  /** Ends this soon after starting count as failures; this many in a row gives up. */
  quickMs?: number;
  giveUpAfter?: number;
  now?: () => number;
}

export class LineChild {
  private proc: LineProc | null = null;
  private stopped = true;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private wait: number;
  private startedAt = 0;

  constructor(private readonly o: LineChildOptions) {
    this.wait = o.minMs ?? 1000;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.failures = 0;
    this.wait = this.o.minMs ?? 1000;
    this.launch();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const p = this.proc;
    this.proc = null;
    if (p) {
      try {
        p.stdin?.end();
      } catch {
        // already closed
      }
      p.kill("SIGTERM");
    }
  }

  /** Writes a line to its stdin (tmux commands). */
  write(line: string): void {
    this.proc?.stdin?.write(`${line}\n`);
  }

  private launch(): void {
    const now = this.o.now ?? Date.now;
    let proc: LineProc;
    try {
      proc = (this.o.spawn ?? realSpawn)(this.o.cmd, this.o.args);
    } catch {
      this.give("missing");
      return;
    }
    this.proc = proc;
    this.startedAt = now();
    let buf = "";
    let err = "";
    let ended = false;
    proc.stdout?.setEncoding?.("utf8");
    proc.stdout?.on("data", (chunk: string | Buffer) => {
      buf += String(chunk);
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (this.proc === proc) this.o.onLine(line);
      }
      // A line with no end in sight: nobody's event is this long.
      if (buf.length > 1 << 20) buf = "";
    });
    proc.stderr?.on("data", (chunk: string | Buffer) => {
      err = (err + String(chunk)).slice(-2000);
    });
    const end = (code: number | null, missing: boolean) => {
      if (ended) return;
      ended = true;
      if (this.proc !== proc) return; // stopped, or replaced
      this.proc = null;
      this.o.onExit?.(code, err);
      if (this.stopped) return;
      if (missing) return this.give("missing");
      if (this.o.respawn === false) return;
      const lived = now() - this.startedAt;
      if (lived < (this.o.quickMs ?? 2000)) this.failures++;
      else {
        this.failures = 0;
        this.wait = this.o.minMs ?? 1000;
      }
      if (this.failures >= (this.o.giveUpAfter ?? 5)) return this.give("failing");
      this.retry = setTimeout(() => {
        this.retry = null;
        if (!this.stopped) this.launch();
      }, this.wait);
      this.retry.unref?.();
      this.wait = Math.min(this.wait * 2, this.o.maxMs ?? 30_000);
    };
    proc.on("error", (e: Error) => end(null, (e as NodeJS.ErrnoException).code === "ENOENT"));
    proc.on("exit", (code) => end(code, false));
    this.o.onStart?.(proc);
  }

  private give(why: Down): void {
    this.stopped = true;
    this.proc = null;
    this.o.onDown?.(why);
  }
}

/**
 * Runs `fn` soon after the last call (`waitMs`), and never sooner than
 * `gapMs` after it last ran: a burst of events is one look.
 */
export function debounce(
  fn: () => void,
  waitMs: number,
  gapMs = 0,
): (() => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last = Number.NEGATIVE_INFINITY;
  const run = () => {
    timer = null;
    last = Date.now();
    fn();
  };
  const call = () => {
    if (timer) return;
    const delay = Math.max(waitMs, last + gapMs - Date.now());
    timer = setTimeout(run, delay);
    timer.unref?.();
  };
  call.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return call;
}

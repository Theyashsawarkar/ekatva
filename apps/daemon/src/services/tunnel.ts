/**
 * Reaching the laptop from outside the LAN.
 *
 *   cloudflared   a free quick tunnel (no account): wss://<random>.trycloudflare.com
 *   ngrok         your ngrok account's tunnel
 *   tailscale     no tunnel: the laptop's tailnet address, for phones on your tailnet
 *
 * The tunnel only carries the WebSocket, whose content is end-to-end
 * encrypted (Noise): it is transport, never the security.
 *
 * Two ways to run it:
 *   always      (`keep(true)`, while a phone is paired) it starts at once,
 *               comes back by itself when it dies, and says every new URL
 *               to `onChange` listeners (phones, the mailbox, the window).
 *   on demand   started when something asks (`start()`), stopped after
 *               `idleMinutes` with no phone on it.
 *
 * A tunnel can die while its program keeps running: after a network drop
 * cloudflared may never get its connection back, and the quick tunnel's
 * name is gone (it no longer resolves). So while it's up, every minute it
 * asks itself through the tunnel (`https://<name>/alive`, answered by the
 * laptop): two misses in a row and it's opened again, with a new URL. And
 * before telling a phone where to go (`start()`), it checks first unless it
 * answered in the last 30 s, so a phone is never sent to a dead address.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";

export type TunnelKind = "cloudflared" | "ngrok" | "tailscale" | "none";

export interface Reach {
  /** wss:// URL of a tunnel, if one runs. */
  url: string | null;
  /** Extra direct addresses (a tailnet IP), host:port. */
  lan: string[];
}

/**
 * off       not running (on demand, nobody asked; or kind "none")
 * starting  opening, or waiting to try again after it died
 * up        `url` reaches the laptop
 * missing   the program isn't installed
 */
export type TunnelState = "off" | "starting" | "up" | "missing";

export interface TunnelInfo {
  kind: TunnelKind;
  state: TunnelState;
  url: string | null;
  /** Kept up all the time (a phone is paired), or only on demand. */
  always: boolean;
  /** Since when it has been up (ms), or null. */
  since: number | null;
  /** Why it isn't up, in plain words, or null. */
  problem: string | null;
}

type Spawner = (cmd: string, args: string[]) => ChildProcess;

const URL_IN = {
  cloudflared: /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/,
  ngrok: /"url":"https:\/\/([^"]+)"/,
};

/** After it dies: try again after 2 s, 4 s, 8 s… never more than this apart. */
const RESTART_MAX_MS = 5 * 60_000;
/** Not installed: look again this often (it may be installed meanwhile). */
const MISSING_RETRY_MS = 10 * 60_000;
/** While up: ask through the tunnel this often. */
const HEALTH_EVERY_MS = 60_000;
/** Answered this recently: `start()` trusts it without asking again. */
const FRESH_MS = 30_000;
/** The path the laptop answers on, for asking itself through the tunnel. */
export const ALIVE_PATH = "/alive";
export const ALIVE_BODY = "ekatva";

type Probe = (url: string) => Promise<boolean>;

/** Does the tunnel's URL reach this laptop (through the tunnel and back)? */
const reachable: Probe = async (url) => {
  try {
    const r = await fetch(`${url.replace(/^wss:/, "https:")}${ALIVE_PATH}`, {
      signal: AbortSignal.timeout(10_000),
    });
    return r.status === 200 && (await r.text()) === ALIVE_BODY;
  } catch {
    return false;
  }
};

export class Tunnel {
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private starting: Promise<Reach> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private always = false;
  private state: TunnelState = "off";
  private since: number | null = null;
  private problem: string | null = null;
  private listeners = new Set<(i: TunnelInfo) => void>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  /** When it last answered through the tunnel (ms). */
  private lastOk = 0;
  private misses = 0;
  private checking: Promise<Reach> | null = null;

  constructor(
    readonly kind: TunnelKind,
    private readonly port: () => number,
    private readonly log: (m: string) => void = () => undefined,
    private readonly idleMinutes = 10,
    private readonly spawner: Spawner = (cmd, args) =>
      spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }),
    private readonly restartBaseMs = 2_000,
    private readonly probe: Probe = reachable,
    private readonly healthEveryMs = HEALTH_EVERY_MS,
  ) {}

  get running(): boolean {
    return this.url !== null;
  }

  info(): TunnelInfo {
    return {
      kind: this.kind,
      state: this.state,
      url: this.url,
      always: this.always,
      since: this.since,
      problem: this.problem,
    };
  }

  /** Every change of state or URL; returns a function that stops listening. */
  onChange(cb: (i: TunnelInfo) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setState(state: TunnelState, problem: string | null = null): void {
    const was = this.info();
    this.state = state;
    this.problem = problem;
    this.since = state === "up" ? (was.state === "up" ? was.since : Date.now()) : null;
    const now = this.info();
    if (was.state === now.state && was.url === now.url && was.problem === now.problem) return;
    for (const cb of this.listeners) cb(now);
  }

  /**
   * Keep it up all the time (true), or go back to on demand (false: it
   * stops after `idleMinutes` with nobody on it).
   */
  keep(on: boolean): void {
    if (on === this.always) return;
    this.always = on;
    if (this.kind === "none" || this.kind === "tailscale") return;
    if (on) {
      this.clearIdle();
      this.log(`keeping the ${this.kind} tunnel up while a phone is paired`);
      void this.start();
    } else {
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = null;
      if (this.running) this.touch();
      else this.halt();
      for (const cb of this.listeners) cb(this.info());
    }
  }

  /** Starts it (or reuses the running one); resolves with how to reach the laptop. */
  start(timeoutMs = 30_000): Promise<Reach> {
    this.touch();
    if (this.url) {
      if (Date.now() - this.lastOk < FRESH_MS) return Promise.resolve({ url: this.url, lan: [] });
      // Not heard from lately: make sure it still reaches us before handing it out.
      this.checking ??= this.healthy()
        .then((ok): Promise<Reach> => {
          if (ok && this.url) return Promise.resolve({ url: this.url, lan: [] });
          if (this.url) this.recycle(`the ${this.kind} tunnel doesn't reach the laptop any more`);
          return this.start(timeoutMs);
        })
        .finally(() => {
          this.checking = null;
        });
      return this.checking;
    }
    if (this.kind === "none") return Promise.resolve({ url: null, lan: [] });
    if (this.kind === "tailscale") return this.tailscale();
    this.starting ??= this.spawnTunnel(timeoutMs).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private spawnTunnel(timeoutMs: number): Promise<Reach> {
    const kind = this.kind as "cloudflared" | "ngrok";
    const target = `127.0.0.1:${this.port()}`;
    const args =
      kind === "cloudflared"
        ? ["tunnel", "--no-autoupdate", "--url", `http://${target}`]
        : ["http", target, "--log", "stdout", "--log-format", "json"];
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.setState("starting");
    return new Promise((resolve) => {
      let settled = false;
      const settle = (r: Reach) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      let child: ChildProcess;
      try {
        child = this.spawner(kind, args);
      } catch {
        this.missing(kind);
        settle({ url: null, lan: [] });
        return;
      }
      this.child = child;
      const timer = setTimeout(() => {
        this.log(`${kind} gave no URL in ${timeoutMs / 1000} s`);
        // Kill it: the exit handler retries when it's kept up.
        if (this.child === child) child.kill("SIGTERM");
        settle({ url: null, lan: [] });
      }, timeoutMs);
      const scan = (data: Buffer) => {
        const m = URL_IN[kind].exec(String(data));
        if (m && this.child === child && this.url !== `wss://${m[1]}`) {
          clearTimeout(timer);
          this.url = `wss://${m[1]}`;
          this.failures = 0;
          this.lastOk = Date.now();
          this.misses = 0;
          this.watchHealth();
          this.log(`reachable from anywhere through ${kind}`);
          this.setState("up");
          settle({ url: this.url, lan: [] });
        }
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        if (e.code === "ENOENT") this.missing(kind);
        else this.died(`${kind} failed: ${e.message}`);
        settle({ url: null, lan: [] });
      });
      child.on("exit", () => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = null;
          this.url = null;
          this.stopHealth();
          this.died(`${kind} stopped`);
        }
        settle({ url: null, lan: [] });
      });
    });
  }

  /** Asks through the tunnel whether it still reaches the laptop. */
  private async healthy(): Promise<boolean> {
    const url = this.url;
    if (!url) return false;
    const ok = await this.probe(url);
    if (ok && this.url === url) {
      this.lastOk = Date.now();
      this.misses = 0;
    }
    return ok;
  }

  private watchHealth(): void {
    this.stopHealth();
    this.healthTimer = setInterval(() => {
      if (!this.url || this.checking) return;
      void this.healthy().then((ok) => {
        if (ok || !this.url) return;
        if (++this.misses < 2) return;
        this.recycle(`the ${this.kind} tunnel stopped reaching the laptop`);
        if (this.always) void this.start();
      });
    }, this.healthEveryMs);
    this.healthTimer.unref?.();
  }

  private stopHealth(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  /** Its program runs but the tunnel is dead: stop it (a new one gets a new URL). */
  private recycle(why: string): void {
    this.log(`${why}; opening a new one`);
    this.stopHealth();
    const child = this.child;
    this.child = null;
    this.url = null;
    this.misses = 0;
    child?.kill("SIGTERM");
    this.setState(this.always ? "starting" : "off", this.always ? why : null);
  }

  private missing(kind: string): void {
    this.child = null;
    this.url = null;
    this.log(`${kind} isn't installed: the phone can only reach the laptop on the same network`);
    this.setState("missing", `${kind} isn't installed`);
    if (this.always) this.retryIn(MISSING_RETRY_MS);
  }

  /** It stopped by itself: kept up, try again soon (later each time). */
  private died(why: string): void {
    if (!this.always) {
      this.setState("off");
      return;
    }
    const delay = Math.min(RESTART_MAX_MS, this.restartBaseMs * 2 ** this.failures++);
    this.log(`${why}; opening it again in ${Math.round(delay / 1000)} s`);
    this.setState("starting", why);
    this.retryIn(delay);
  }

  private retryIn(ms: number): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.always && !this.child) void this.start();
    }, ms);
    this.restartTimer.unref?.();
  }

  private tailscale(): Promise<Reach> {
    return new Promise((resolve) => {
      execFile("tailscale", ["ip", "-4"], { timeout: 5000 }, (err, out) => {
        const ip = String(out ?? "")
          .trim()
          .split("\n")[0];
        resolve({ url: null, lan: !err && ip ? [`${ip}:${this.port()}`] : [] });
      });
    });
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Something used the tunnel: keep it a while longer (on demand only). */
  touch(): void {
    this.clearIdle();
    if (this.always) return;
    this.idleTimer = setTimeout(() => this.halt(), this.idleMinutes * 60_000);
    this.idleTimer.unref?.();
  }

  /** Stops it now (on demand: idle; or the laptop's service stopping). */
  private halt(): void {
    this.clearIdle();
    this.stopHealth();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    this.url = null;
    if (child) {
      this.log(`${this.kind} stopped`);
      child.kill("SIGTERM");
    }
    this.setState("off");
  }

  /** Stops it for good (the service is stopping). */
  stop(): void {
    this.always = false;
    this.halt();
  }
}

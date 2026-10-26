/**
 * Reaching the laptop from outside the LAN, started only when needed.
 *
 *   cloudflared   a free quick tunnel (no account): wss://<random>.trycloudflare.com
 *   ngrok         your ngrok account's tunnel
 *   tailscale     no tunnel: the laptop's tailnet address, for phones on your tailnet
 *
 * The tunnel only carries the WebSocket, whose content is end-to-end
 * encrypted; a new URL each time. It stops after `idleMinutes` with no
 * phone connected through it.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";

export type TunnelKind = "cloudflared" | "ngrok" | "tailscale" | "none";

export interface Reach {
  /** wss:// URL of a tunnel, if one runs. */
  url: string | null;
  /** Extra direct addresses (a tailnet IP), host:port. */
  lan: string[];
}

type Spawner = (cmd: string, args: string[]) => ChildProcess;

const URL_IN = {
  cloudflared: /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/,
  ngrok: /"url":"https:\/\/([^"]+)"/,
};

export class Tunnel {
  private child: ChildProcess | null = null;
  private url: string | null = null;
  private starting: Promise<Reach> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly kind: TunnelKind,
    private readonly port: () => number,
    private readonly log: (m: string) => void = () => undefined,
    private readonly idleMinutes = 10,
    private readonly spawner: Spawner = (cmd, args) =>
      spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }),
  ) {}

  get running(): boolean {
    return this.url !== null;
  }

  /** Starts it (or reuses the running one); resolves with how to reach the laptop. */
  start(timeoutMs = 30_000): Promise<Reach> {
    this.touch();
    if (this.url) return Promise.resolve({ url: this.url, lan: [] });
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
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawner(kind, args);
      } catch {
        this.log(
          `${kind} isn't installed: the phone can only reach the laptop on the same network`,
        );
        resolve({ url: null, lan: [] });
        return;
      }
      this.child = child;
      const timer = setTimeout(() => {
        this.log(`${kind} gave no URL in ${timeoutMs / 1000} s`);
        this.stop();
        resolve({ url: null, lan: [] });
      }, timeoutMs);
      const scan = (data: Buffer) => {
        const m = URL_IN[kind].exec(String(data));
        if (m && !this.url) {
          clearTimeout(timer);
          this.url = `wss://${m[1]}`;
          this.log(`reachable from anywhere through ${kind}`);
          resolve({ url: this.url, lan: [] });
        }
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);
      child.on("error", () => {
        clearTimeout(timer);
        this.log(
          `${kind} isn't installed: the phone can only reach the laptop on the same network`,
        );
        this.child = null;
        resolve({ url: null, lan: [] });
      });
      child.on("exit", () => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = null;
          this.url = null;
        }
        resolve({ url: null, lan: [] });
      });
    });
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

  /** Something used the tunnel: keep it a while longer. */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), this.idleMinutes * 60_000);
    this.idleTimer.unref?.();
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.child) {
      this.log(`${this.kind} stopped`);
      this.child.kill("SIGTERM");
    }
    this.child = null;
    this.url = null;
  }
}

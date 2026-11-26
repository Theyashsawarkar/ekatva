/**
 * The daemon's side of the pranali protocol (docs/PROTOCOL.md in
 * ~/personal/pranali): the hello an agent's pipe sends before MCP, the
 * listener systemd hands over (socket activation), and the rules for the
 * socket's directory. No MCP SDK here: it loads with the first session.
 */
import { lstatSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { dirname, isAbsolute } from "node:path";

/** A connection that hasn't said hello in this long is dropped. */
export const HELLO_TIMEOUT_MS = 5_000;
/** The longest hello line taken (PATH can be long). */
export const HELLO_MAX = 64 * 1024;
/** What the daemon answers a good hello with. */
export const HELLO_OK = `${JSON.stringify({ pranali: 1, ok: true })}\n`;
export const helloRefused = (error: string) =>
  `${JSON.stringify({ pranali: 1, ok: false, error })}\n`;

/** The env keys a hello may carry (the spec's six). */
const ENV_KEYS = ["TMUX", "TMUX_PANE", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "PATH"] as const;
/** Those a dialog on the agent's screen needs. */
export const DISPLAY_KEYS = ["DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY"] as const;

export interface Hello {
  /** True for pranali's hello (it wants an answer); false for the old `{"agent":…}` line. */
  pranali: boolean;
  agent: string;
  /** Only the spec's keys, only strings. */
  env: Record<string, string>;
  /** The agent's working directory, when it's absolute. */
  cwd?: string;
}

/**
 * Reads a hello line: pranali's (`{"pranali":1,…}`), or, for one release,
 * the line `ekatva-rs mcp` sent (`{"agent":"name"}`, no answer expected).
 * Unknown fields are ignored.
 */
export function parseHello(line: string): Hello | { pranali: boolean; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { pranali: false, error: "the hello isn't JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { pranali: false, error: "the hello isn't an object" };
  const o = v as Record<string, unknown>;
  const agent = typeof o.agent === "string" && o.agent ? o.agent : "agent";
  if (!("pranali" in o)) return { pranali: false, agent, env: {} };
  if (o.pranali !== 1)
    return {
      pranali: true,
      error: `ekatva speaks pranali protocol 1, not ${JSON.stringify(o.pranali)}`,
    };
  const env: Record<string, string> = {};
  if (o.env && typeof o.env === "object") {
    const e = o.env as Record<string, unknown>;
    for (const k of ENV_KEYS) {
      const x = e[k];
      if (typeof x === "string" && x && !x.includes("\0") && x.length <= 16_384) env[k] = x;
    }
  }
  const cwd = typeof o.cwd === "string" && isAbsolute(o.cwd) ? o.cwd : undefined;
  return { pranali: true, agent, env, ...(cwd ? { cwd } : {}) };
}

/** The hello's DISPLAY, WAYLAND_DISPLAY and XAUTHORITY: where its dialogs go. */
export function displayEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of DISPLAY_KEYS) if (env[k]) out[k] = env[k];
  return out;
}

/**
 * The MCP listener systemd passed (`ekatva-mcp.socket`), as sd_listen_fds
 * finds it: fd 3 when it's the only one, else the one named for the unit
 * (or `FileDescriptorName=mcp`). null when this process wasn't activated.
 */
export function activatedFd(env: NodeJS.ProcessEnv, pid: number): number | null {
  if (env.LISTEN_PID !== String(pid)) return null;
  const n = Number(env.LISTEN_FDS);
  if (!Number.isInteger(n) || n < 1) return null;
  if (n === 1) return 3;
  const names = (env.LISTEN_FDNAMES ?? "").split(":");
  const i = names.findIndex((x) => x === "ekatva-mcp.socket" || x === "mcp");
  return i >= 0 && i < n ? 3 + i : null;
}

/** Takes the activation variables out of the environment, so children don't inherit them. */
export function forgetActivation(env: NodeJS.ProcessEnv): void {
  delete env.LISTEN_PID;
  delete env.LISTEN_FDS;
  delete env.LISTEN_FDNAMES;
}

/** sockaddr_un's limit, less the terminating NUL. */
const MAX_PATH = 107;

/**
 * Makes the socket's directory (0700) and checks it is ours: a real
 * directory, owned by this user, closed to everyone else. Returns what's
 * wrong, or null.
 */
export function prepareSocketDir(path: string): string | null {
  if (Buffer.byteLength(path) > MAX_PATH)
    return `the MCP socket's path is over ${MAX_PATH} bytes: ${path}`;
  const dir = dirname(path);
  if (dir === "/tmp" || dir === "/var/tmp" || dir === "/dev/shm")
    return `the MCP socket would be in ${dir}, a shared directory`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) return `${dir} isn't a directory`;
  if (st.uid !== process.getuid?.()) return `${dir} isn't yours`;
  if (st.mode & 0o077) return `${dir} is open to others (mode ${(st.mode & 0o777).toString(8)})`;
  return null;
}

/**
 * Whether a socket path is a dead daemon's leftover: connecting is refused.
 * A live one, or one that can't be checked (no permission, a timeout), isn't.
 */
export function socketIsDead(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    const done = (dead: boolean) => {
      s.destroy();
      resolve(dead);
    };
    s.once("connect", () => done(false));
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED"));
    s.setTimeout(1_000, () => done(false));
  });
}

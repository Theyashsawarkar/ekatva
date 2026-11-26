/**
 * The Rust clients (apps/daemon-rs) against a real daemon on temporary
 * paths: the MCP pipe (two agents at once, the fallback to `ekatva mcp`,
 * a daemon restart mid-session) and the waybar watcher, line for line
 * against the TypeScript one. Skipped when the binary isn't built
 * (`cargo build --release` in apps/daemon-rs).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { generateKeyPair } from "@ekatva/link";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Daemon } from "../src/daemon.js";
import type { Host } from "../src/services/jyoti.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const RS = join(here, "../../daemon-rs/target/release/ekatva-rs");
const TS = join(here, "../bin/ekatva.js");
const built = existsSync(RS) && existsSync(join(here, "../dist/cli.js"));

const fakeHost: Host = {
  run: async () => ({ code: 0, out: "" }),
  hold: () => ({ stop: async () => undefined, onExit: () => undefined }),
  lock: async () => undefined,
  lidClosed: () => null,
  battery: () => null,
  now: () => Date.now(),
};

let root: string;
let home: string;
let daemon: Daemon;
const children: ChildProcess[] = [];
/** The approval dialog: held until the test lets it go. */
let approval: Promise<boolean> = Promise.resolve(false);

async function startDaemon(): Promise<Daemon> {
  const config = loadConfig(join(root, "none.toml"));
  config.name = "ace";
  const d = new Daemon({
    config,
    key: generateKeyPair(),
    stateDir: join(home, ".local/state/ekatva"),
    configDir: join(home, ".config/ekatva"),
    undoDir: join(home, ".local/share/ekatva/undo"),
    socketPath: join(root, "ekatva.sock"),
    port: 0,
    host: "127.0.0.1",
    beacon: false,
    checkFirewall: false,
    desktopNotifications: false,
    rendezvous: false,
    keepaliveMs: 0,
    jyotiHost: fakeHost,
    mediaHost: { run: async () => ({ code: 127, out: "" }), art: async () => null, now: Date.now },
    approve: () => approval,
    log: () => undefined,
  });
  await d.start();
  return d;
}

async function restart(): Promise<void> {
  await daemon.stop();
  daemon = await startDaemon();
}

const env = (runtime = root, more: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  XDG_RUNTIME_DIR: runtime,
  XDG_STATE_HOME: join(home, ".local/state"),
  XDG_CONFIG_HOME: join(home, ".config"),
  EKATVA_TS_CLI: TS,
  ...more,
});

type Rpc = {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

/** An agent's MCP session through `ekatva-rs mcp`. */
function session(agent: string, runtime = root) {
  const p = spawn(RS, ["mcp"], {
    env: env(runtime, { EKATVA_AGENT: agent }),
    stdio: ["pipe", "pipe", "inherit"],
  });
  children.push(p);
  const waiting = new Map<unknown, (m: Rpc) => void>();
  createInterface({ input: p.stdout! }).on("line", (l) => {
    const m = JSON.parse(l) as Rpc;
    waiting.get(m.id)?.(m);
  });
  let next = 1;
  const send = (m: object) => p.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const call = (method: string, params?: object): Promise<Rpc> => {
    const id = next++;
    return new Promise((res) => {
      waiting.set(id, res);
      send({ id, method, params });
    });
  };
  const tool = async (name: string, args: object = {}) => {
    const r = await call("tools/call", { name, arguments: args });
    return r.result as { content: { text: string }[]; isError?: boolean };
  };
  const init = async () => {
    const r = await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    send({ method: "notifications/initialized" });
    return r;
  };
  const exited = new Promise<number | null>((r) => p.on("exit", (code) => r(code)));
  return { p, call, tool, init, send, exited };
}

const toolNames = (r: Rpc) =>
  ((r.result?.tools ?? []) as { name: string; description: string }[]).map((t) => [
    t.name,
    t.description,
  ]);

/** A watcher's lines, as they come. */
function watch(cmd: string, args: string[]) {
  const p = spawn(cmd, args, { env: env(), stdio: ["ignore", "pipe", "inherit"] });
  children.push(p);
  const lines: string[] = [];
  let wake: (() => void) | null = null;
  createInterface({ input: p.stdout! }).on("line", (l) => {
    lines.push(l);
    wake?.();
  });
  const first = new Promise<void>((r) => (wake = r));
  return { p, lines, first };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The same line twice in a row is one line (the 5 s redraws land a little apart). */
const changes = (lines: string[]) => lines.filter((l, i) => l !== lines[i - 1]);

beforeAll(async () => {
  if (!built) return;
  root = await fs.mkdtemp(join(tmpdir(), "ekatva-rs-"));
  home = join(root, "home");
  await fs.mkdir(home);
  process.env.HOME = home;
  daemon = await startDaemon();
});

afterAll(async () => {
  if (!built) return;
  for (const c of children) c.kill("SIGKILL");
  await daemon.stop();
  await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(!built)("ekatva-rs mcp", () => {
  it("serves two agents at once, with the old server's tools, logged as each", async () => {
    const mcpSock = join(root, "ekatva", "mcp.sock");
    expect((await fs.stat(mcpSock)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(join(root, "ekatva"))).mode & 0o777).toBe(0o700);

    // The old server: `ekatva mcp` in Node, over the CLI's socket (a runtime dir with no MCP socket).
    const bare = join(root, "bare");
    await fs.mkdir(bare, { recursive: true });
    await fs.symlink(join(root, "ekatva.sock"), join(bare, "ekatva.sock"));
    const old = session("gamma", bare);
    const oldInit = await old.init();
    const oldTools = toolNames(await old.call("tools/list"));
    expect(oldTools.length).toBeGreaterThan(10);

    const a = session("alpha");
    const b = session("beta");
    const [ia, ib] = await Promise.all([a.init(), b.init()]);
    expect(ia.result?.serverInfo).toMatchObject({ name: "ekatva" });
    expect(ia.result?.instructions).toBe(oldInit.result?.instructions);
    expect(ib.result?.instructions).toBe(oldInit.result?.instructions);
    expect(toolNames(await a.call("tools/list"))).toEqual(oldTools);
    expect(toolNames(await b.call("tools/list"))).toEqual(oldTools);

    // A harmless call each, at the same time: jyoti off (a fake host).
    const [ra, rb] = await Promise.all([
      a.tool("jyoti_set", { level: "off" }),
      b.tool("jyoti_set", { level: "off" }),
    ]);
    expect(ra.isError).toBeFalsy();
    expect(rb.isError).toBeFalsy();
    await old.tool("jyoti_set", { level: "off" });
    const log = JSON.parse((await a.tool("log_recent", { limit: 10 })).content[0].text) as {
      who: string;
    }[];
    const me = userInfo().username;
    const who = log.map((e) => e.who);
    expect(who).toContain(`${me} via alpha`);
    expect(who).toContain(`${me} via beta`);
    // The fallback (Node) logs the same way.
    expect(who).toContain(`${me} via gamma`);

    old.p.stdin!.end();
    a.p.stdin!.end();
    b.p.stdin!.end();
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);
  });

  it("falls back to the TypeScript server when there's no MCP socket", async () => {
    const bare = join(root, "bare2");
    await fs.mkdir(bare, { recursive: true });
    await fs.symlink(join(root, "ekatva.sock"), join(bare, "ekatva.sock"));
    const s = session("delta", bare);
    await s.init();
    // exec'd: the same process is Node now.
    expect(await fs.readlink(`/proc/${s.p.pid}/exe`)).toBe(await fs.realpath(process.execPath));
    expect(toolNames(await s.call("tools/list")).length).toBeGreaterThan(10);
    s.p.kill();
  });

  it("outlives a daemon restart: the unanswered call fails, the session goes on", async () => {
    const s = session("epsilon");
    await s.init();
    // An SMS waits for the user's approval, which never comes before the restart.
    approval = new Promise(() => undefined);
    const held = s.call("tools/call", {
      name: "sms_send",
      arguments: { to: "+15550100", text: "made-up test message" },
    });
    await sleep(200);
    await restart();
    approval = Promise.resolve(false);
    const failed = await held;
    expect(failed.error).toEqual({ code: -32000, message: "ekatva daemon restarted; try again" });
    // The new daemon has the session (replayed initialize): tools work again.
    const r = await s.tool("jyoti_set", { level: "off" });
    expect(r.isError).toBeFalsy();
    expect(toolNames(await s.call("tools/list")).length).toBeGreaterThan(10);
    s.p.stdin!.end();
    expect(await s.exited).toBe(0);
  });
});

describe.skipIf(!built)("ekatva-rs call --waybar", () => {
  it("prints what `ekatva call --waybar` prints, through a call and a daemon restart", async () => {
    const calls = () => daemon.calls as unknown as { clock: () => number };
    const tsw = watch(process.execPath, [TS, "call", "--waybar"]);
    await tsw.first;
    const rsw = watch(RS, ["call", "--waybar"]);
    const started = Date.now();
    await rsw.first;
    await sleep(800);
    calls().clock = () => Date.now();
    daemon.calls.onEvent("dev1", "Pixel", {
      kind: "call",
      state: "ringing",
      number: "+15550100",
      contact: "Asha Test",
    } as never);
    await sleep(800);
    // Answered half a second before the watchers' 5 s marks: both redraw "5s".
    calls().clock = () => started - 500;
    daemon.calls.onEvent("dev1", "Pixel", {
      kind: "call",
      state: "active",
      number: "",
      contact: null,
    } as never);
    await sleep(5_000 - (Date.now() - started) + 1_500);
    // The daemon restarts during the call: both keep it, reconnect, and hear there's none.
    await restart();
    await sleep(3_500);
    calls().clock = () => Date.now();
    daemon.calls.onEvent("dev1", "Pixel", {
      kind: "call",
      state: "ringing",
      number: "+15550111",
      contact: null,
      app: null,
    } as never);
    await sleep(500);
    daemon.calls.onEvent("dev1", "Pixel", { kind: "call", state: "ended" } as never);
    await sleep(500);
    tsw.p.kill();
    rsw.p.kill();
    const want = changes(tsw.lines);
    expect(changes(rsw.lines)).toEqual(want);
    expect(want).toContainEqual(expect.stringContaining("Asha Test · calling"));
    expect(want).toContainEqual(expect.stringContaining("Asha Test (+15550100) on Pixel · 5s"));
    expect(want.at(-2)).toContain("+15550111 · calling");
    expect(want.at(-1)).toBe('{"text":"","class":"none","tooltip":""}');
  }, 30_000);
});

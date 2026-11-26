/**
 * The daemon's MCP socket against the pranali protocol
 * (~/personal/pranali/docs/PROTOCOL.md), on temporary paths with fake
 * hosts and a fake approval: no phone, no real journal, no real socket.
 *
 * The client here is a minimal one written from the spec (hello, then
 * newline-framed JSON-RPC). When the real binary is built
 * (~/personal/pranali/target/release/pranali, or $PRANALI_BIN), sessions
 * also go through it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { generateKeyPair } from "@ekatva/link";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Daemon } from "../src/daemon.js";
import type { Approve } from "../src/mcp.js";
import { activatedFd, parseHello } from "../src/mcpSocket.js";
import type { Host } from "../src/services/jyoti.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const PRANALI =
  process.env.PRANALI_BIN || join(homedir(), "personal/pranali/target/release/pranali");
const havePranali = existsSync(PRANALI);
const dist = existsSync(join(here, "../dist/daemon.js"));
const me = userInfo().username;

const fakeHost: Host = {
  run: async () => ({ code: 0, out: "" }),
  hold: () => ({ stop: async () => undefined, onExit: () => undefined }),
  lock: async () => undefined,
  lidClosed: () => null,
  battery: () => null,
  now: () => Date.now(),
};

let root: string;
/** What the fake approval does; every question is recorded with its env. */
let answer: Approve = async () => false;
const asked: { body: string; env: Record<string, string> | undefined }[] = [];

async function startDaemon(dir: string, more: Record<string, unknown> = {}): Promise<Daemon> {
  const home = join(dir, "home");
  const config = loadConfig(join(dir, "none.toml"));
  config.name = "ace";
  const d = new Daemon({
    config,
    key: generateKeyPair(),
    stateDir: join(home, ".local/state/ekatva"),
    configDir: join(home, ".config/ekatva"),
    undoDir: join(home, ".local/share/ekatva/undo"),
    socketPath: join(dir, "ekatva.sock"),
    port: 0,
    host: "127.0.0.1",
    beacon: false,
    checkFirewall: false,
    desktopNotifications: false,
    rendezvous: false,
    keepaliveMs: 0,
    jyotiHost: fakeHost,
    mediaHost: { run: async () => ({ code: 127, out: "" }), art: async () => null, now: Date.now },
    approve: (title, body, o) => {
      asked.push({ body, env: o?.env });
      return answer(title, body, o);
    },
    log: () => undefined,
    ...more,
  });
  await d.start();
  return d;
}

type Rpc = {
  id?: unknown;
  result?: Record<string, unknown> & { content?: { text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A session from the spec: the hello (pranali's, the old line, or raw text), then MCP. */
function session(path: string, hello: object | string | null) {
  const s: Socket = connect(path);
  s.on("error", () => undefined);
  const lines: string[] = [];
  const waiting = new Map<unknown, (m: Rpc) => void>();
  let wake: (() => void) | null = null;
  const rl = createInterface({ input: s });
  rl.on("error", () => undefined);
  rl.on("line", (l) => {
    lines.push(l);
    wake?.();
    try {
      const m = JSON.parse(l) as Rpc;
      waiting.get(m.id)?.(m);
    } catch {}
  });
  const ended = new Promise<void>((r) => s.on("end", () => r()));
  const closed = new Promise<void>((r) => s.on("close", () => r()));
  if (hello !== null) s.write(`${typeof hello === "string" ? hello : JSON.stringify(hello)}\n`);
  const line = async (n: number) => {
    while (lines.length <= n) await new Promise<void>((r) => (wake = r));
    return lines[n];
  };
  let next = 1;
  const send = (m: object) => s.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
  const call = (method: string, params?: object): Promise<Rpc> => {
    const id = next++;
    return new Promise((res) => {
      waiting.set(id, res);
      send({ id, method, params });
    });
  };
  const tool = (name: string, args: object = {}) =>
    call("tools/call", { name, arguments: args }).then((r) => r.result ?? r);
  const init = async () => {
    const r = await call("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    send({ method: "notifications/initialized" });
    return r;
  };
  return { s, lines, line, call, tool, init, send, ended, closed };
}

const hello = (agent: string, env: Record<string, string> = {}) => ({
  pranali: 1,
  tool: "ekatva",
  agent,
  pid: 4242,
  cwd: "/home/u/project",
  env,
  later: "an unknown field, ignored",
});

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "ekatva-pr-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("the hello", () => {
  it("reads pranali's, the old line, and nothing else", () => {
    expect(parseHello(JSON.stringify(hello("claude", { DISPLAY: ":0", HOME: "/x" })))).toEqual({
      pranali: true,
      agent: "claude",
      env: { DISPLAY: ":0" },
      cwd: "/home/u/project",
    });
    expect(parseHello('{"agent":"old"}')).toEqual({ pranali: false, agent: "old", env: {} });
    expect(parseHello('{"pranali":2}')).toMatchObject({ pranali: true, error: expect.any(String) });
    expect(parseHello("nope")).toMatchObject({ error: expect.any(String) });
    expect(parseHello('{"pranali":1,"cwd":"rel"}')).toEqual({
      pranali: true,
      agent: "agent",
      env: {},
    });
  });

  it("finds systemd's listener as sd_listen_fds does", () => {
    expect(activatedFd({ LISTEN_PID: "7", LISTEN_FDS: "1" }, 7)).toBe(3);
    expect(activatedFd({ LISTEN_PID: "8", LISTEN_FDS: "1" }, 7)).toBeNull();
    expect(activatedFd({}, 7)).toBeNull();
    expect(
      activatedFd(
        { LISTEN_PID: "7", LISTEN_FDS: "2", LISTEN_FDNAMES: "other.socket:ekatva-mcp.socket" },
        7,
      ),
    ).toBe(4);
    expect(activatedFd({ LISTEN_PID: "7", LISTEN_FDS: "2", LISTEN_FDNAMES: "a:b" }, 7)).toBeNull();
  });
});

describe("the MCP socket", () => {
  let dir: string;
  let daemon: Daemon;
  let mcp: string;

  beforeAll(async () => {
    dir = await fs.mkdtemp(join(root, "s-"));
    daemon = await startDaemon(dir);
    mcp = join(dir, "ekatva", "mcp.sock");
  });
  afterAll(async () => {
    await daemon?.stop();
  });

  it("is the user's alone", async () => {
    expect((await fs.stat(mcp)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(join(dir, "ekatva"))).mode & 0o777).toBe(0o700);
  });

  it("answers pranali's hello, serves MCP after it, and still takes the old line", async () => {
    const a = session(mcp, hello("alpha"));
    expect(JSON.parse(await a.line(0))).toEqual({ pranali: 1, ok: true });
    const b = session(mcp, { agent: "beta" });
    const [ia, ib] = await Promise.all([a.init(), b.init()]);
    expect(ia.result?.serverInfo).toMatchObject({ name: "ekatva" });
    expect(ib.result?.serverInfo).toMatchObject({ name: "ekatva" });
    // The old line gets no answer: the first line is initialize's.
    expect(JSON.parse(b.lines[0])).toMatchObject({ id: 1 });
    const [ra, rb] = await Promise.all([
      a.tool("jyoti_set", { level: "off" }),
      b.tool("jyoti_set", { level: "off" }),
    ]);
    expect(ra.isError).toBeFalsy();
    expect(rb.isError).toBeFalsy();
    // Each session's calls are in the log under its own agent.
    const log = await a.tool("log_recent", { limit: 20 });
    const names = (JSON.parse(log.content?.[0].text ?? "[]") as { who: string }[]).map(
      (e) => e.who,
    );
    expect(names).toContain(`${me} via alpha`);
    expect(names).toContain(`${me} via beta`);
    a.s.end();
    b.s.end();
    await Promise.all([a.closed, b.closed]);
  });

  it("refuses another protocol with a reason, and garbage without one", async () => {
    const v2 = session(mcp, { pranali: 2, agent: "x" });
    expect(JSON.parse(await v2.line(0))).toMatchObject({ pranali: 1, ok: false });
    await v2.closed;
    const junk = session(mcp, "not json");
    await junk.closed;
    expect(junk.lines).toEqual([]);
  });

  it("asks on each session's own display", async () => {
    answer = async () => false;
    asked.length = 0;
    const a = session(
      mcp,
      hello("gamma", { DISPLAY: ":7", WAYLAND_DISPLAY: "wayland-7", TMUX_PANE: "%1", PATH: "/x" }),
    );
    const b = session(mcp, hello("delta", { WAYLAND_DISPLAY: "wayland-8", XAUTHORITY: "/xa" }));
    await Promise.all([a.init(), b.init()]);
    const ra = await a.tool("sms_send", { to: "+15550100", text: "made-up test one" });
    const rb = await b.tool("call_dial", { number: "+15550101" });
    expect(ra.content?.[0].text).toMatch(/^Declined/);
    expect(rb.content?.[0].text).toMatch(/^Declined/);
    expect(asked).toEqual([
      {
        body: expect.stringContaining("gamma wants to send an SMS"),
        env: { DISPLAY: ":7", WAYLAND_DISPLAY: "wayland-7" },
      },
      {
        body: expect.stringContaining("delta wants to call"),
        env: { WAYLAND_DISPLAY: "wayland-8", XAUTHORITY: "/xa" },
      },
    ]);
    a.s.destroy();
    b.s.destroy();
  });

  it("answers a call that finishes after the agent half-closed, then ends", async () => {
    let release: (yes: boolean) => void = () => undefined;
    answer = () => new Promise((r) => (release = r));
    const a = session(mcp, hello("eta"));
    await a.init();
    const late = a.call("tools/call", {
      name: "sms_send",
      arguments: { to: "+15550102", text: "made-up test two" },
    });
    await sleep(100);
    a.s.end(); // pranali's stdin EOF: it half-closes and keeps reading.
    await sleep(200);
    release(false);
    const r = await late;
    expect(r.result?.content?.[0].text).toMatch(/^Declined/);
    await a.ended;
    answer = async () => false;
  });

  it("drops a connection that never says hello, after 5 s", async () => {
    const quiet = session(mcp, null);
    const t = Date.now();
    await quiet.closed;
    expect(Date.now() - t).toBeGreaterThanOrEqual(4_500);
  }, 10_000);
});

describe("stopping (SIGTERM)", () => {
  it("lets calls in flight finish, declines a waiting approval, refuses new calls", async () => {
    const dir = await fs.mkdtemp(join(root, "d-"));
    const d = await startDaemon(dir, { mcpDrainMs: 5_000 });
    const mcp = join(dir, "ekatva", "mcp.sock");
    // theta's approval honours the stop (the zenity one is killed); iota's ignores it, slowly.
    answer = (_t, body, o) =>
      body.startsWith("theta")
        ? new Promise((r) => o?.signal?.addEventListener("abort", () => r(false)))
        : new Promise((r) => setTimeout(() => r(false), 800));
    const a = session(mcp, hello("theta"));
    const b = session(mcp, hello("iota"));
    await Promise.all([a.init(), b.init()]);
    const held = a.call("tools/call", {
      name: "sms_send",
      arguments: { to: "+15550103", text: "made-up test three" },
    });
    const slow = b.call("tools/call", { name: "call_dial", arguments: { number: "+15550104" } });
    await sleep(100);
    const t = Date.now();
    const stopped = d.stop();
    await sleep(50);
    // No new connections (a socket it bound is gone at once); a new call on an open one isn't run.
    const late = session(mcp, hello("kappa"));
    await late.closed;
    const refused = await a.call("tools/list");
    expect(refused.error).toEqual({
      code: -32002,
      message: "ekatva is restarting; this call was not run, retry it",
    });
    expect((await held).result?.content?.[0].text).toMatch(/^Not done: ekatva was stopping/);
    // Answered when its dialog ended (after the stop began): still not sent.
    expect((await slow).result?.content?.[0].text).toMatch(/^Not done: ekatva was stopping/);
    await Promise.all([a.ended, b.ended]);
    await stopped;
    const took = Date.now() - t;
    expect(took).toBeGreaterThanOrEqual(600);
    expect(took).toBeLessThan(4_000);
    // It bound the path itself, so it removed it.
    expect(existsSync(mcp)).toBe(false);
    answer = async () => false;
  });

  it("gives up on a call after the drain time", async () => {
    const dir = await fs.mkdtemp(join(root, "g-"));
    const d = await startDaemon(dir, { mcpDrainMs: 300 });
    answer = () => new Promise(() => undefined); // ignores the stop
    const a = session(join(dir, "ekatva", "mcp.sock"), hello("lambda"));
    await a.init();
    void a.call("tools/call", { name: "call_dial", arguments: { number: "+15550105" } });
    await sleep(100);
    const t = Date.now();
    await d.stop();
    expect(Date.now() - t).toBeLessThan(2_500);
    await a.closed;
    answer = async () => false;
  });

  it("never removes a socket it didn't bind, nor one that answers", async () => {
    const dir = await fs.mkdtemp(join(root, "l-"));
    const first = await startDaemon(dir);
    const mcp = join(dir, "ekatva", "mcp.sock");
    // A second daemon on the same path finds it live and leaves it alone.
    const dir2 = await fs.mkdtemp(join(root, "l2-"));
    const second = await startDaemon(dir2, { mcpSocketPath: mcp });
    const a = session(mcp, hello("mu"));
    expect(JSON.parse(await a.line(0))).toEqual({ pranali: 1, ok: true });
    a.s.destroy();
    await second.stop();
    expect(existsSync(mcp)).toBe(true);
    await first.stop();
    // A dead one left behind (a crash) is replaced.
    const dir3 = await fs.mkdtemp(join(root, "l3-"));
    const stale = join(dir3, "ekatva", "mcp.sock");
    await fs.mkdir(dirname(stale), { mode: 0o700 });
    await new Promise<void>((r) =>
      spawn("python3", [
        "-I",
        "-c",
        "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])",
        stale,
      ]).on("exit", () => r()),
    );
    expect(existsSync(stale)).toBe(true);
    const third = await startDaemon(dir3);
    const b = session(stale, hello("xi"));
    expect(JSON.parse(await b.line(0))).toEqual({ pranali: 1, ok: true });
    b.s.destroy();
    await third.stop();
  });
});

describe.skipIf(!dist)("socket activation", () => {
  it("serves on the listener systemd passes at fd 3, and leaves it in place", async () => {
    const dir = await fs.mkdtemp(join(root, "a-"));
    const sock = join(dir, "run", "mcp.sock");
    await fs.mkdir(join(dir, "run"), { mode: 0o700 });
    // As systemd does: bind and listen, hand it over at fd 3, LISTEN_PID = the daemon's pid.
    const py = [
      "import os, socket, sys",
      "s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
      "s.bind(sys.argv[1]); os.chmod(sys.argv[1], 0o600); s.listen(16)",
      "os.dup2(s.fileno(), 3); os.set_inheritable(3, True)",
      "os.execvp('sh', ['sh', '-c', 'LISTEN_PID=$$ LISTEN_FDS=1 LISTEN_FDNAMES=ekatva-mcp.socket exec \"$0\" \"$1\"', sys.argv[2], sys.argv[3]])",
    ].join("\n");
    const p: ChildProcess = spawn(
      "python3",
      ["-I", "-c", py, sock, process.execPath, join(here, "fixtures/activated-daemon.mjs")],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: join(dir, "home"), ROOT: dir },
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    const exited = new Promise<number | null>((r) => p.on("exit", (c) => r(c)));
    const ready = await new Promise<string>((r) =>
      createInterface({ input: p.stdout! }).once("line", r),
    );
    // fd 3, and the activation variables aren't left for its children.
    expect(ready).toBe("ready 3 -");
    const a = session(sock, hello("nu"));
    expect(JSON.parse(await a.line(0))).toEqual({ pranali: 1, ok: true });
    await a.init();
    expect(((await a.call("tools/list")).result?.tools ?? []) as unknown[]).toHaveLength(17);
    a.s.end();
    await a.ended;
    p.kill("SIGTERM");
    expect(await exited).toBe(0);
    // systemd's socket outlives the daemon: still there, and it never bound its own.
    expect(existsSync(sock)).toBe(true);
    expect(existsSync(join(dir, "never-bound"))).toBe(false);
  });
});

describe.skipIf(!havePranali)("through the real pranali", () => {
  it("serves two agents, each logged as itself, and answers after stdin ends", async () => {
    const dir = await fs.mkdtemp(join(root, "p-"));
    const d = await startDaemon(dir);
    const mcp = join(dir, "ekatva", "mcp.sock");
    const pipe = (agent: string) => {
      const p = spawn(PRANALI, ["ekatva", "--agent", agent], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PRANALI_SOCKET: mcp },
        stdio: ["pipe", "pipe", "inherit"],
      });
      const out: Rpc[] = [];
      createInterface({ input: p.stdout! }).on("line", (l) => out.push(JSON.parse(l) as Rpc));
      const send = (m: object) => p.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
      const exited = new Promise<number | null>((r) => p.on("exit", (c) => r(c)));
      return { p, out, send, exited };
    };
    const runs = ["xi", "omicron"].map((agent) => {
      const x = pipe(agent);
      x.send({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
      });
      x.send({ method: "notifications/initialized" });
      x.send({
        id: 2,
        method: "tools/call",
        params: { name: "jyoti_set", arguments: { level: "off" } },
      });
      x.send({ id: 3, method: "tools/call", params: { name: "log_recent", arguments: {} } });
      x.p.stdin!.end();
      return x;
    });
    for (const x of runs) expect(await x.exited).toBe(0);
    for (const [i, x] of runs.entries()) {
      expect(x.out.map((m) => m.id)).toEqual([1, 2, 3]);
      const log = JSON.parse(x.out[2].result?.content?.[0].text ?? "[]") as { who: string }[];
      expect(log.map((e) => e.who)).toContain(`${me} via ${["xi", "omicron"][i]}`);
    }
    await d.stop();
  });
});

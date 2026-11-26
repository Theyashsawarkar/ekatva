/**
 * The Rust waybar watcher (apps/daemon-rs) against a real daemon on
 * temporary paths, line for line against the TypeScript one. Skipped when
 * the binary isn't built (`pnpm build`, or `cargo build --release` in
 * apps/daemon-rs). Agents' MCP sessions: pranali.test.ts.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
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
    approve: async () => false,
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

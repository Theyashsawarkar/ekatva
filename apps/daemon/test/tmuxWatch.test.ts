import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@ekatva/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentEvents, AgentsService, tmuxOn } from "../src/services/agents.js";
import { PANES_FORMAT, TmuxWatch, WATCH_SESSION } from "../src/services/tmuxWatch.js";
import { fakeSpawn, until } from "./fakeChild.js";

describe("tmux's control mode, from fixture output", () => {
  it("subscribes once, tells each change, and polls when tmux refuses", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ekatva-tw-"));
    const sock = join(dir, "default");
    await fs.writeFile(sock, "");
    const spawn = fakeSpawn();
    const changes: string[] = [];
    const downs: string[] = [];
    const w = new TmuxWatch({
      socketPath: sock,
      spawn,
      onChange: (why) => changes.push(why),
      onDown: (why) => downs.push(why),
    });
    w.start();
    const p = spawn.procs[0];
    expect(p?.args).toContain("-N"); // never starts a server
    expect(p?.args).toContain(WATCH_SESSION);
    await until(() => (p?.input.length ?? 0) >= 2);
    expect(p?.input[0]).toMatch(/destroy-unattached on/);
    expect(p?.input[1]).toBe(`refresh-client -B 'ekatva-panes::${PANES_FORMAT}'`);
    p?.say(
      "%begin 1 1 0",
      "%end 1 1 0",
      "%subscription-changed ekatva-panes $1 - - - : %3 Aura 0:claude claude /p  ✳ Fix 1795770000|",
      "%output %9 ignored",
      "%unlinked-window-close @4",
    );
    await until(() => changes.length === 2);
    expect(changes).toEqual(["panes", "sessions"]);
    expect(w.live).toBe(true);
    w.stop();

    // An old tmux: the subscription is an error, so it falls back to polling.
    const w2 = new TmuxWatch({
      socketPath: sock,
      spawn,
      onChange: () => {},
      onDown: (why) => downs.push(why),
    });
    w2.start();
    const q = spawn.procs[1];
    q?.say("%begin 1 2 0", "%error 1 2 0");
    q?.exit(1, "");
    await until(() => downs.length === 1);
    expect(downs[0]).toMatch(/refused/);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("with no server, waits for its socket instead of starting one", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ekatva-tw-"));
    const sock = join(dir, "default");
    const spawn = fakeSpawn();
    const w = new TmuxWatch({ socketPath: sock, spawn, onChange: () => {}, onDown: () => {} });
    w.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(spawn.procs).toHaveLength(0);
    await fs.writeFile(sock, ""); // a server made its socket
    await until(() => spawn.procs.length === 1);
    // It went away again ("no server"): back to waiting, no retry loop.
    spawn.procs[0]?.exit(1, "no server running on /tmp/x");
    await new Promise((r) => setTimeout(r, 300));
    expect(spawn.procs).toHaveLength(1);
    w.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("a new server racing the folder watch", () => {
  it("isn't missed when its socket appears before the folder is watched", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ekatva-tw-"));
    const sock = join(dir, "default");
    await fs.writeFile(sock, "old");
    const base = fakeSpawn();
    let n = 0;
    // The first try finds no server, and a new one binds its socket meanwhile.
    const spawn = Object.assign(
      (cmd: string, args: string[]) => {
        const p = base(cmd, args);
        if (n++ === 0) {
          execFileSync("rm", [sock]);
          execFileSync("touch", [sock]);
          (p as unknown as { exit: (c: number, e: string) => void }).exit(1, "no server running");
        }
        return p;
      },
      { procs: base.procs },
    );
    const w = new TmuxWatch({ socketPath: sock, spawn, onChange: () => {}, onDown: () => {} });
    w.start();
    await until(() => base.procs.length === 2, 3000);
    w.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// A private tmux server, never the user's sessions.
const socket = `ekatva-tw-${process.pid}`;
const run = tmuxOn(socket);
let dir: string;
const tmuxQ = (args: string[]) =>
  execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "ekatva-twr-"));
  await fs.mkdir(join(dir, "bin"));
  await fs.mkdir(join(dir, "claude", "sessions"), { recursive: true });
  // A copy of sleep named "claude": tmux sees the command "claude".
  await fs.copyFile("/usr/bin/sleep", join(dir, "bin/claude"));
  await fs.chmod(join(dir, "bin/claude"), 0o755);
  tmuxQ(["-f", "/dev/null", "new-session", "-d", "-s", "work", "-x", "100", "-y", "30"]);
});
afterAll(async () => {
  try {
    tmuxQ(["kill-server"]);
  } catch {}
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("agents told by a real (private) tmux", () => {
  it("sees agents come and go without polling, and leaves no session behind", async () => {
    const agents = new AgentsService(run, [], Date.now, 500, join(dir, "claude"));
    const ac = new AbortController();
    const seen: AgentSession[][] = [];
    const reading = (async () => {
      for await (const s of agents.changes(ac.signal)) seen.push(s);
    })();
    await until(() => seen.length >= 1);
    expect(seen[0]).toEqual([]);
    expect(agents.watching).toBe("events");
    // Its own session is there while it watches, and in no list.
    await until(() => tmuxQ(["list-sessions", "-F", "#{session_name}"]).includes(WATCH_SESSION));
    expect((await agents.projects()).some((p) => p.name === "/")).toBe(false);

    tmuxQ(["new-window", "-t", "work", join(dir, "bin/claude"), "300"]);
    await until(() => (seen.at(-1)?.length ?? 0) === 1, 15_000);
    expect(seen.at(-1)?.[0]?.agent).toBe("claude");
    expect(agents.watching).toBe("events");

    tmuxQ(["kill-window", "-t", "work:1"]);
    await until(() => seen.at(-1)?.length === 0, 15_000);

    // Its session killed by hand: it comes back, and still sees changes.
    tmuxQ(["kill-session", "-t", WATCH_SESSION]);
    await until(() => tmuxQ(["list-sessions", "-F", "#{session_name}"]).includes(WATCH_SESSION));
    tmuxQ(["new-window", "-t", "work", join(dir, "bin/claude"), "300"]);
    await until(() => (seen.at(-1)?.length ?? 0) === 1, 15_000);
    tmuxQ(["kill-window", "-t", "work:1"]);
    await until(() => seen.at(-1)?.length === 0, 15_000);

    // The server exits: an empty list; a new one: watched again.
    tmuxQ(["kill-server"]);
    await new Promise((r) => setTimeout(r, 300));
    tmuxQ(["-f", "/dev/null", "new-session", "-d", "-s", "again", "-x", "100", "-y", "30"]);
    tmuxQ(["new-window", "-t", "again", join(dir, "bin/claude"), "300"]);
    await until(() => (seen.at(-1)?.length ?? 0) === 1, 15_000);
    expect(seen.at(-1)?.[0]?.session).toBe("again");

    ac.abort();
    await reading;
    expect(agents.watching).toBe("idle");
    // destroy-unattached: its session goes when it stops watching.
    await until(() => !tmuxQ(["list-sessions", "-F", "#{session_name}"]).includes(WATCH_SESSION));
    agents.shutdown();
  }, 90_000);

  it("polls as before when the event source can't start", async () => {
    const never: AgentEvents = {
      start: (_c, down) => setImmediate(down),
      stop: () => {},
    };
    const agents = new AgentsService(run, [], Date.now, 500, join(dir, "claude"), never);
    const ac = new AbortController();
    const it = agents.changes(ac.signal);
    await it.next();
    await until(() => agents.watching === "polling");
    ac.abort();
    await it.return(undefined);
    expect(agents.watching).toBe("idle");
  });
});

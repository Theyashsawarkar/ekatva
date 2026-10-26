import * as fs from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLaptopCaller, Journal, MemoryStore } from "@ekatva/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RootBridge } from "../src/services/root.js";

let dir: string;
let bridge: RootBridge;
const opened: Socket[] = [];

/** A stand-in for anumati's window: sends a request, collects what comes back. */
async function window(request: object) {
  const s = netConnect(join(dir, "root.sock"));
  opened.push(s);
  await new Promise((r) => s.once("connect", r));
  const got: Record<string, unknown>[] = [];
  let buf = "";
  s.setEncoding("utf8");
  s.on("data", (d: string) => {
    buf += d;
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      got.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  s.write(`${JSON.stringify({ t: "request", v: 1, ...request })}\n`);
  return { s, got, send: (m: object) => s.write(`${JSON.stringify(m)}\n`) };
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 10));
};

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "ekatva-root-"));
  bridge = new RootBridge(join(dir, "root.sock"));
  await bridge.listen();
});
afterEach(async () => {
  for (const s of opened.splice(0)) s.destroy();
  await bridge.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("root approvals from the phone", () => {
  it("relays the request, and the answer with the password, back to the window only", async () => {
    const w = await window({
      id: "r1",
      via: "anumati",
      requester: "claude",
      reason: "install a package",
      commands: [
        { cmd: "pacman -S jq", why: "for the script" },
        { cmd: "rm -rf /tmp/x", why: "clean" },
      ],
    });
    await until(() => bridge.list().length === 1);
    const [r] = bridge.list();
    expect(r).toMatchObject({
      requester: "claude",
      state: "waiting",
      commands: [{ cmd: "pacman -S jq" }, { cmd: "rm -rf /tmp/x" }],
    });
    expect(r?.id).not.toBe("r1");

    // Answered through the API, as the phone does: logged, without the password.
    const journal = new Journal(new MemoryStore(), "laptop");
    const caller = createLaptopCaller({
      actor: { key: "phone", name: "Pixel 8" },
      grants: { has: (c) => c === "root" },
      journal,
      services: {
        root: {
          pending: async () => bridge.list(),
          changes: (s: AbortSignal | undefined) => bridge.changes(s),
          respond: bridge.respond.bind(bridge),
        },
      } as never,
    });
    const out = await caller.root.respond({
      id: r?.id ?? "",
      approve: true,
      password: "hunter2!",
      allow: [0],
    });
    expect(out).toBeNull();
    await until(() => w.got.length === 1);
    expect(w.got[0]).toEqual({ t: "answer", approve: true, allow: [0], password: "hunter2!" });
    const [entry] = await journal.since(0);
    expect(entry?.summary).toBe("Approved 1 of 2 root commands for claude");
    expect(JSON.stringify(entry)).not.toContain("hunter2");

    // Wrong password: the phone sees it, and can try again.
    w.send({ t: "wrong", attempts: 1 });
    await until(() => bridge.list()[0]?.state === "wrong");
    expect(bridge.list()[0]?.attempts).toBe(1);
    await caller.root.respond({
      id: r?.id ?? "",
      approve: true,
      password: "right one",
      allow: null,
    });
    await until(() => w.got.length === 2);
    expect(w.got[1]).toMatchObject({ allow: [0, 1], password: "right one" });

    // Done (here or there): gone.
    w.send({ t: "done", status: "completed" });
    await until(() => bridge.list().length === 0);
    expect(bridge.list()).toHaveLength(0);
  });

  it("drops the request when the window goes away, and refuses stale answers", async () => {
    const w = await window({
      via: "anumati",
      requester: "codex",
      commands: [{ cmd: "true", why: "" }],
    });
    await until(() => bridge.list().length === 1);
    const id = bridge.list()[0]?.id ?? "";
    w.s.destroy();
    await until(() => bridge.list().length === 0);
    await expect(bridge.respond(id, true, "pw", null)).rejects.toThrow(/already answered/);
  });

  it("denying sends no password; approving needs one", async () => {
    const w = await window({
      via: "anumati",
      requester: "claude",
      commands: [{ cmd: "true", why: "" }],
    });
    await until(() => bridge.list().length === 1);
    const id = bridge.list()[0]?.id ?? "";
    await expect(bridge.respond(id, true, null, null)).rejects.toThrow(/needs your password/);
    await bridge.respond(id, false, "ignored", null);
    await until(() => w.got.length === 1);
    expect(w.got[0]).toEqual({ t: "answer", approve: false, allow: [0] });
    expect(bridge.list()).toHaveLength(0);
  });

  it("the socket is yours alone", async () => {
    expect((await fs.stat(join(dir, "root.sock"))).mode & 0o777).toBe(0o600);
  });
});

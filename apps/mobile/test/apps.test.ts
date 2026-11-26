import type { AppInfo } from "@ekatva/protocol";
import { describe, expect, it } from "vitest";
import {
  type Approval,
  type LaptopApps,
  type NativeAppMessage,
  type NativeApps,
  PhoneApps,
  type PhoneAppsOptions,
} from "../src/core/apps";
import type { Fs } from "../src/core/files";
import { MemoryKV } from "../src/core/kv";

const NADA = {
  id: "nada",
  name: "nāda",
  version: "1",
  methods: [{ name: "queue", why: "What the phone is playing" }],
  events: [{ name: "handoff", why: "Continue here" }],
};
const PKG = "io.example.nada";
const CERT = "ab".repeat(32);
const LAPTOP = { key: "laptop-key", name: "Ace" };

/** The Android side, faked: records what ekatva sends each app, and lets the test speak as one. */
function fakeNative() {
  let cb: ((m: NativeAppMessage) => void) | null = null;
  const sent: { pkg: string; what: string; body: Record<string, unknown> }[] = [];
  const pins = new Map<string, Approval>();
  const native: NativeApps = {
    onMessage: (f) => {
      cb = f;
      return () => {
        cb = null;
      };
    },
    send: (pkg, what, json) => sent.push({ pkg, what, body: JSON.parse(json) }),
    decide: async (a) => {
      pins.set(a.package, a);
    },
    approvals: async () => [...pins.values()],
    revoke: async (pkg) => {
      pins.delete(pkg);
    },
  };
  const from = (m: NativeAppMessage) => cb?.(m);
  const hello = (status: "allowed" | "pending" | "denied" | "refused", manifest: unknown = NADA) =>
    from({ kind: "hello", package: PKG, cert: CERT, status, json: JSON.stringify(manifest) });
  const asks = () => hello("pending", { ...NADA, link: true });
  const last = (what: string) => sent.filter((s) => s.what === what).at(-1)?.body;
  return { native, from, hello, asks, sent, last, pins };
}

function fakeLaptop() {
  const calls: unknown[] = [];
  const m = (name: string, risk: "low" | "high") => ({ name, why: `${name} it`, risk, log: true });
  const apps: AppInfo[] = [
    {
      id: "darshan",
      name: "darshan",
      version: "1",
      side: "laptop",
      online: true,
      granted: true,
      methods: [m("open", "low"), m("wipe", "high")],
      events: [],
    },
  ];
  const api: LaptopApps = {
    name: "Ace",
    invoke: async (c) => {
      calls.push(c);
      if (c.method === "boom") throw new Error("TRPCClientError: nāda isn't running on the laptop");
      return { from: "laptop", got: c.input };
    },
    emit: async (e) => {
      calls.push(e);
      return null;
    },
    list: async () => apps,
    upload: {
      begin: async (c) => {
        calls.push({ begin: c });
        return { id: "u1" };
      },
      put: async (c) => calls.push({ put: c.data }),
      finish: async () => ({ ref: "ref1" }),
      cancel: async () => undefined,
    },
  };
  return { api, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 1));

async function setup(linked = true, o: PhoneAppsOptions = {}) {
  const n = fakeNative();
  const l = fakeLaptop();
  const apps = new PhoneApps(n.native, new MemoryKV(), () => (linked ? l.api : null), o);
  await apps.start();
  return { apps, ...n, laptop: l };
}

describe("the phone's app hub", () => {
  it("holds an app you haven't approved, and lets it in once you allow it", async () => {
    const { apps, hello, asks, last, pins } = await setup();
    // Opening an app asks nothing; its user linking it does.
    hello("pending");
    expect(last("welcome")).toMatchObject({ status: "unlinked" });
    expect(apps.waiting()).toEqual([]);
    asks();
    expect(last("welcome")).toEqual({ status: "pending", why: "allow it in ekatva on this phone" });
    expect(apps.waiting().map((r) => r.manifest.id)).toEqual(["nada"]);
    await apps.decide(PKG, true);
    // Pinned to the certificate it asked with, and to its id.
    expect(pins.get(PKG)).toEqual({
      package: PKG,
      cert: CERT,
      id: "nada",
      name: "nāda",
      state: "allowed",
    });
    expect(apps.waiting()).toEqual([]);
    // Android hands it over again as allowed: now it's in.
    hello("allowed");
    expect(last("welcome")).toEqual({ status: "allowed" });
    expect((await apps.services().list())[0]).toMatchObject({ id: "nada", online: true });
  });

  it("refuses an impostor or a denied app, and a bad manifest", async () => {
    const { hello, last, from } = await setup();
    hello("refused");
    expect(last("welcome")).toEqual({ status: "refused" });
    hello("denied");
    expect(last("welcome")).toEqual({ status: "denied" });
    hello("allowed", { id: "Not An Id!" });
    expect(last("welcome")).toEqual({ status: "refused", why: "its manifest isn't valid" });
    // Not attached: its calls are refused too.
    from({ kind: "call", package: PKG, json: JSON.stringify({ id: "1", method: "queue" }) });
    await tick();
    expect(last("result")).toEqual({
      id: "1",
      ok: false,
      error: "allow this app in ekatva on the phone first",
    });
  });

  it("carries an app's call to the laptop's app with the same id, and the answer back", async () => {
    const { hello, from, last, laptop } = await setup();
    hello("allowed");
    from({
      kind: "call",
      package: PKG,
      json: JSON.stringify({ id: "7", method: "play", input: { song: 3 } }),
    });
    await tick();
    expect(laptop.calls[0]).toEqual({
      app: "nada",
      method: "play",
      input: { song: 3 },
      caller: "nada",
      files: [],
    });
    expect(last("result")).toEqual({
      id: "7",
      ok: true,
      result: { from: "laptop", got: { song: 3 } },
    });
    // The laptop's words come back as they are.
    from({ kind: "call", package: PKG, json: JSON.stringify({ id: "8", method: "boom" }) });
    await tick();
    expect(last("result")).toEqual({
      id: "8",
      ok: false,
      error: "nāda isn't running on the laptop",
    });
    from({
      kind: "emit",
      package: PKG,
      json: JSON.stringify({ id: "9", name: "handoff", input: 1, keep: 60 }),
    });
    await tick();
    expect(laptop.calls.at(-1)).toEqual({ app: "nada", name: "handoff", data: 1, keep: 60 });
  });

  it("says when the laptop isn't connected", async () => {
    const { hello, from, last } = await setup(false);
    hello("allowed");
    from({ kind: "call", package: PKG, json: JSON.stringify({ id: "1", method: "play" }) });
    await tick();
    expect(last("result")).toEqual({ id: "1", ok: false, error: "the laptop isn't connected" });
    from({ kind: "status", package: PKG, json: JSON.stringify({ id: "2" }) });
    await tick();
    expect(last("result")).toEqual({ id: "2", ok: true, result: { laptop: null, app: null } });
  });

  it("carries the laptop's call to the phone app, and its reply back", async () => {
    const { apps, hello, from, last } = await setup();
    hello("allowed");
    const answer = apps
      .services()
      .call(LAPTOP, { app: "nada", method: "queue", input: null, files: [] });
    await tick();
    const incoming = last("incoming") as { kind: string; id: string; from: unknown };
    expect(incoming).toMatchObject({ kind: "call", method: "queue", from: LAPTOP });
    from({
      kind: "reply",
      package: PKG,
      json: JSON.stringify({ id: incoming.id, ok: true, result: ["Monsoon Letters"] }),
    });
    expect(await answer).toEqual({ value: ["Monsoon Letters"], summary: "nāda: queue", log: true });
    // It goes away: the laptop hears so at once, in words.
    const waiting = apps
      .services()
      .call(LAPTOP, { app: "nada", method: "queue", input: null, files: [] });
    await tick();
    from({ kind: "bye", package: PKG });
    await expect(waiting).rejects.toThrow("nāda stopped on the phone");
  });

  it("keeps the laptop's event until the app opens", async () => {
    const { apps, hello, from, sent } = await setup();
    hello("allowed");
    from({ kind: "bye", package: PKG });
    await apps
      .services()
      .emit(LAPTOP, { app: "nada", name: "handoff", data: { at: 42 }, keep: 60 });
    hello("allowed");
    expect(sent.filter((s) => s.what === "incoming").map((s) => s.body)).toEqual([
      expect.objectContaining({ kind: "event", name: "handoff", data: { at: 42 } }),
    ]);
  });

  it("taking an approval back cuts the app off and forgets it", async () => {
    const { apps, hello, asks, pins } = await setup();
    asks();
    await apps.decide(PKG, true);
    hello("allowed");
    await apps.revoke(PKG);
    expect(pins.has(PKG)).toBe(false);
    expect(await apps.services().list()).toEqual([]);
  });

  it("linking an app lets the laptop reach it; its switch takes that back", async () => {
    let opened = 0;
    const linked = async () => {
      opened++;
    };
    const { apps, asks, hello } = await setup(true, { linked });
    asks();
    await apps.decide(PKG, true);
    expect(opened).toBe(1);
    hello("allowed");
    await apps.setReachable("nada", false);
    expect((await apps.services().list())[0]).toMatchObject({ id: "nada", granted: false });
    await expect(
      apps.services().call(LAPTOP, { app: "nada", method: "queue", input: null, files: [] }),
    ).rejects.toThrow('the laptop may not use "nada" on this phone');
  });

  it("another app is a route: asked once, remembered, high risk asked every time", async () => {
    const { apps, hello, from, last, laptop } = await setup(true, { routeWaitMs: 30 });
    hello("allowed");
    const call = (id: string, method: string) =>
      from({
        kind: "call",
        package: PKG,
        json: JSON.stringify({ id, method, to: "laptop:darshan" }),
      });
    call("1", "open");
    await tick();
    expect(apps.waitingRoutes()).toEqual([
      expect.objectContaining({ callerName: "nāda", to: "laptop:darshan", toName: "darshan" }),
    ]);
    apps.decideRoute(apps.waitingRoutes()[0]?.id ?? "", "always");
    await tick();
    expect(last("result")).toMatchObject({ id: "1", ok: true });
    expect(laptop.calls[0]).toMatchObject({ app: "darshan", method: "open", caller: "nada" });
    call("2", "open");
    await tick();
    expect(last("result")).toMatchObject({ id: "2", ok: true });
    call("3", "wipe");
    await tick();
    expect(apps.waitingRoutes()).toHaveLength(1);
    apps.decideRoute(apps.waitingRoutes()[0]?.id ?? "", "refuse");
    await tick();
    expect(last("result")).toMatchObject({ id: "3", error: "you didn't let nāda use darshan" });
    // Taken back: asked again, and unanswered is refused.
    await apps.removeRoute("nada", "laptop:darshan");
    call("4", "open");
    await new Promise((r) => setTimeout(r, 60));
    expect(last("result")).toMatchObject({ id: "4", ok: false });
  });

  it("files go to the laptop ahead of the call, and the laptop's reach only their own app", async () => {
    const disk = new Map<string, string>([["/f/old", "left over"]]);
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const fs = {
      list: async () => [...disk.keys()].map((k) => k.slice(3)),
      stat: async (p: string) => (disk.has(p) ? { isDir: false, size: 1, mtime: 0 } : null),
      read: async (p: string, at: number, n: number) => b64((disk.get(p) ?? "").slice(at, at + n)),
      write: async (p: string, d: string) => void disk.set(p, Buffer.from(d, "base64").toString()),
      append: async (p: string, d: string) =>
        void disk.set(p, (disk.get(p) ?? "") + Buffer.from(d, "base64").toString()),
      mkdir: async () => undefined,
      remove: async (p: string) => void disk.delete(p),
    } as unknown as Fs;
    const { apps, hello, from, last, laptop } = await setup(true, { files: { fs, dir: "/f" } });
    expect(disk.size).toBe(0); // cleared at the start
    hello("allowed");
    disk.set("/f/tmp1", "a book");
    const _files = [{ name: "a.epub", size: 6, mime: "application/epub+zip", path: "/f/tmp1" }];
    from({ kind: "call", package: PKG, json: JSON.stringify({ id: "1", method: "keep", _files }) });
    for (let i = 0; i < 20 && !last("result"); i++) await tick();
    expect(laptop.calls).toEqual([
      { begin: { app: "nada", name: "a.epub", size: 6 } },
      { put: b64("a book") },
      expect.objectContaining({ files: [expect.objectContaining({ path: "ref1" })] }),
    ]);
    expect(disk.size).toBe(0);
    // From the laptop.
    const s = apps.services();
    const { id } = await s.upload.begin("nada", "../x.epub", 5, "Ace");
    await s.upload.put(id, b64("hello"));
    const { ref } = await s.upload.finish(id);
    const file = { name: "x.epub", size: 5, mime: "x", path: ref };
    const done = s.call(LAPTOP, { app: "nada", method: "queue", input: null, files: [file] });
    await tick();
    const inc = last("incoming") as { id: string; files: { path: string }[] };
    expect(disk.get(inc.files[0]?.path ?? "")).toBe("hello");
    expect(inc.files[0]?.path.startsWith("/f/")).toBe(true);
    from({ kind: "reply", package: PKG, json: JSON.stringify({ id: inc.id, ok: true }) });
    await done;
    expect(disk.size).toBe(0);
    await expect(
      s.call(LAPTOP, { app: "nada", method: "queue", input: null, files: [file] }),
    ).rejects.toThrow("the file x.epub didn't arrive");
  });
});

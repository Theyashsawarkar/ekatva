import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppIncoming, AppManifest } from "@ekatva/protocol";
import { describe, expect, it } from "vitest";
import { type AppsHooks, AppsService } from "../src/services/apps.js";
import { peerPid } from "../src/services/peer.js";

const ECHO = AppManifest.parse({
  id: "echo",
  name: "Echo",
  version: "1",
  methods: [
    { name: "say", why: "Says it back" },
    { name: "status", why: "Is it there", log: false },
    { name: "slow", why: "Never answers" },
    { name: "wipe", why: "Wipes everything", risk: "high" },
  ],
  events: [{ name: "note", why: "A note" }],
  rate: 5,
});
const PHONE = { key: "phone-key", name: "Pixel" };

/** Registers `m` and answers its calls with `answer`; returns what it received and how to stop. */
function run(apps: AppsService, m = ECHO, answer = (i: AppIncoming) => i) {
  const got: AppIncoming[] = [];
  const stop = new AbortController();
  const stream = apps.register(m, stop.signal, "python3 ~/echo.py");
  const done = (async () => {
    for await (const msg of stream) {
      got.push(msg);
      if (msg.kind === "call") {
        if (msg.method === "slow") continue;
        await apps.reply({ id: msg.id, ok: true, result: { echoed: answer(msg) } });
      }
    }
  })();
  const status = () => got.filter((g) => g.kind === "status").map((g) => g.status);
  return { got, status, stop: () => stop.abort(), done };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/** A hub with fake hooks: what it asked the phone, granted, notified. */
function hub(
  o: { file?: string | null; now?: () => number; timeoutMs?: number; inbox?: string } = {},
) {
  const asked: { path: string; input: unknown }[] = [];
  const grants: string[] = [];
  const notes: string[] = [];
  const phoneApps = [
    {
      id: "vagdevi",
      name: "vāgdevī",
      version: "1",
      side: "phone",
      online: true,
      granted: true,
      methods: [{ name: "addBook", why: "Add a book", risk: "low", log: true }],
      events: [],
    },
  ];
  const hooks: AppsHooks = {
    phone: async (_d, _t, path, input) => {
      asked.push({ path, input });
      if (path === "apps.list") return phoneApps;
      if (path === "apps.upload.begin") return { id: "up1" };
      if (path === "apps.upload.finish") return { ref: "ref1" };
      if (path === "apps.invoke") return { added: true };
      return null;
    },
    linked: async (id) => {
      grants.push(`+${id}`);
    },
    unlinked: async (id) => {
      grants.push(`-${id}`);
    },
    notify: (title) => notes.push(title),
  };
  const apps = new AppsService(
    o.file ?? null,
    undefined,
    o.now ?? Date.now,
    o.timeoutMs,
    o.inbox ?? null,
    200,
  );
  apps.connect(hooks);
  return { apps, asked, grants, notes };
}

/** Registers and accepts it, as you would in Darpaṇa. */
async function linked(apps: AppsService, m = ECHO, answer?: (i: AppIncoming) => unknown) {
  const r = run(apps, m, answer);
  await tick();
  if (!apps.isLinked(m.id)) await apps.accept(m.id);
  await tick();
  return r;
}

describe("linking a laptop app", () => {
  it("waits for you in Darpaṇa; accepted, it's linked for good and every phone may reach it", async () => {
    const { apps, grants, notes } = hub();
    const echo = run(apps);
    await tick();
    expect(echo.status()).toEqual(["waiting"]);
    expect(notes).toEqual(["Echo wants to link with ekatva"]);
    expect(apps.state().requests).toEqual([
      expect.objectContaining({ id: "echo", name: "Echo", program: "python3 ~/echo.py" }),
    ]);
    // Not linked yet: a phone can't reach it.
    await expect(
      apps.phoneCall(PHONE, { app: "echo", method: "say", input: 1, files: [] }),
    ).rejects.toThrow(`there's no app "echo" on the laptop`);
    await apps.accept("echo");
    await tick();
    expect(echo.status()).toEqual(["waiting", "linked"]);
    expect(grants).toEqual(["+echo"]);
    expect(apps.state().requests).toEqual([]);
    const out = await apps.phoneCall(PHONE, { app: "echo", method: "say", input: "hi", files: [] });
    expect(out).toEqual({ value: { echoed: expect.anything() }, summary: "Echo: say", log: true });
    echo.stop();
    await echo.done;
    // Linked: the next time it just attaches.
    const again = run(apps);
    await tick();
    expect(again.status()).toEqual(["linked"]);
    again.stop();
    await again.done;
  });

  it("refused, it's told so and not asked about again until you clear it", async () => {
    const { apps, notes } = hub();
    const echo = run(apps);
    await tick();
    await apps.refuse("echo");
    await echo.done;
    expect(echo.status()).toEqual(["waiting", "refused"]);
    const again = run(apps);
    await again.done;
    expect(again.status()).toEqual(["refused"]);
    expect(notes).toHaveLength(1);
    await apps.unrefuse("echo");
    const third = run(apps);
    await tick();
    expect(third.status()).toEqual(["waiting"]);
    third.stop();
    await third.done;
  });

  it("unlinking forgets it, its phones' grants and its routes", async () => {
    const { apps, grants } = hub();
    const echo = await linked(apps);
    await apps.unlink("echo");
    await echo.done;
    expect(grants).toEqual(["+echo", "-echo"]);
    await expect(
      apps.phoneCall(PHONE, { app: "echo", method: "say", input: 1, files: [] }),
    ).rejects.toThrow(`there's no app "echo" on the laptop`);
  });

  it("keeps links, refusals and routes in apps.json (0600), and asks once more after the old format", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ekatva-apps-"));
    const file = join(dir, "apps.json");
    const { apps } = hub({ file });
    const echo = await linked(apps);
    echo.stop();
    await echo.done;
    await apps.refuse("other");
    await apps.flushed();
    const later = hub({ file }).apps;
    await later.load();
    expect(later.isLinked("echo")).toBe(true);
    expect(later.list((id) => id === "echo")).toEqual([
      expect.objectContaining({ id: "echo", name: "Echo", online: false, granted: true }),
    ]);
    expect(later.state().refused).toEqual(["other"]);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    // Before links, apps.json was a list of apps seen: they ask again.
    await fs.writeFile(file, JSON.stringify([{ manifest: ECHO, seen: 1 }]));
    const old = hub({ file }).apps;
    await old.load();
    expect(old.isLinked("echo")).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("routes", () => {
  it("an agent reaching an app asks you once; Allow always is remembered", async () => {
    const { apps, notes } = hub();
    const echo = await linked(apps, ECHO, (i) => (i.kind === "call" ? i.from.app : null));
    const call = () =>
      apps.call({
        to: "laptop:echo",
        method: "say",
        input: "hi",
        files: [],
        device: null,
        caller: "agent:claude",
      });
    const first = call();
    await tick();
    const [req] = apps.state().routeRequests;
    expect(req).toMatchObject({
      caller: "agent:claude",
      callerName: "claude",
      to: "laptop:echo",
      why: "Says it back",
    });
    expect(notes.at(-1)).toBe("claude wants to use Echo on this laptop");
    await apps.decideRoute(req?.id as string, "always");
    // The app sees who called.
    expect((await first).value).toEqual({ echoed: "agent:claude" });
    expect(apps.state().routes).toEqual([
      expect.objectContaining({ caller: "agent:claude", to: "laptop:echo" }),
    ]);
    expect((await call()).value).toEqual({ echoed: "agent:claude" });
    expect(apps.state().routeRequests).toEqual([]);
    echo.stop();
    await echo.done;
  });

  it("you, and an app's own other half, need no route; high risk asks every time; refused is refused", async () => {
    const { apps } = hub();
    const echo = await linked(apps);
    const base = { to: "laptop:echo", input: null, files: [], device: null };
    await apps.call({ ...base, method: "say", caller: "you" });
    await apps.call({ ...base, method: "say", caller: "echo" });
    expect(apps.state().routeRequests).toEqual([]);
    // High risk: asked, allowed always, and asked again anyway.
    const wipe = () => apps.call({ ...base, method: "wipe", caller: "agent:claude" });
    const one = wipe();
    await tick();
    await apps.decideRoute(apps.state().routeRequests[0]?.id as string, "always");
    await one;
    const two = wipe();
    await tick();
    expect(apps.state().routeRequests).toHaveLength(1);
    await apps.decideRoute(apps.state().routeRequests[0]?.id as string, "refuse");
    await expect(two).rejects.toThrow("you didn't let claude use Echo (Darpaṇa, Apps)");
    // Unanswered for its minute (200 ms here): refused.
    await expect(apps.call({ ...base, method: "say", caller: "agent:other" })).rejects.toThrow(
      "you didn't let other use Echo",
    );
    echo.stop();
    await echo.done;
  });

  it("to the phone: asks the route, sends the files ahead, then calls with their refs", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ekatva-apps-"));
    const book = join(dir, "Monsoon Letters.epub");
    await fs.writeFile(book, "made-up book");
    const { apps, asked } = hub();
    const out = apps.call({
      to: "phone:vagdevi",
      method: "addBook",
      input: { title: "Monsoon Letters" },
      files: [book],
      device: null,
      caller: "agent:claude",
    });
    for (let i = 0; i < 20 && !apps.state().routeRequests.length; i++) await tick();
    const [req] = apps.state().routeRequests;
    expect(req).toMatchObject({
      toName: "vāgdevī",
      files: [{ name: "Monsoon Letters.epub", size: 12 }],
    });
    await apps.decideRoute(req?.id as string, "once");
    expect(await out).toEqual({
      value: { added: true },
      summary: "claude → vāgdevī (phone): addBook (Monsoon Letters.epub)",
      log: true,
    });
    expect(asked.map((a) => a.path)).toEqual([
      "apps.list",
      "apps.upload.begin",
      "apps.upload.put",
      "apps.upload.finish",
      "apps.invoke",
    ]);
    expect(asked[2]?.input).toEqual({
      id: "up1",
      data: Buffer.from("made-up book").toString("base64"),
    });
    expect(asked[4]?.input).toEqual({
      app: "vagdevi",
      method: "addBook",
      input: { title: "Monsoon Letters" },
      caller: "agent:claude",
      files: [
        { name: "Monsoon Letters.epub", size: 12, mime: "application/epub+zip", path: "ref1" },
      ],
    });
    // Once: not remembered.
    expect(apps.state().routes).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("files from the phone", () => {
  it("arrive in the app's own inbox, and the app gets their paths", async () => {
    const inbox = await fs.mkdtemp(join(tmpdir(), "ekatva-inbox-"));
    const { apps } = hub({ inbox });
    const echo = await linked(apps, ECHO, (i) => (i.kind === "call" ? i.files : null));
    const { id } = await apps.upload.begin("echo", "../../photo.jpg", 5, "Pixel");
    await apps.upload.put(id, Buffer.from("hello").toString("base64"));
    const { ref } = await apps.upload.finish(id);
    const out = await apps.phoneCall(PHONE, {
      app: "echo",
      method: "say",
      input: null,
      files: [{ name: "photo.jpg", size: 5, mime: "image/jpeg", path: ref }],
    });
    const [file] = (out.value as { echoed: { path: string; name: string }[] }).echoed;
    expect(file?.name).toBe("photo.jpg");
    expect(file?.path.startsWith(join(inbox, "echo", "inbox"))).toBe(true);
    expect(await fs.readFile(file?.path as string, "utf8")).toBe("hello");
    expect((await fs.stat(join(inbox, "echo", "inbox"))).mode & 0o777).toBe(0o700);
    // A ref is good once, and only for its own app.
    await expect(
      apps.phoneCall(PHONE, {
        app: "echo",
        method: "say",
        input: null,
        files: [{ name: "x", size: 5, mime: "x", path: ref }],
      }),
    ).rejects.toThrow("the file x didn't arrive");
    // More than announced: refused.
    const big = await apps.upload.begin("echo", "a", 2, "Pixel");
    await expect(
      apps.upload.put(big.id, Buffer.from("too long").toString("base64")),
    ).rejects.toThrow("more data than announced");
    echo.stop();
    await echo.done;
    await fs.rm(inbox, { recursive: true, force: true });
  });
});

describe("the laptop's app hub, routing", () => {
  it("fails a call in flight at once when the app stops, and times out a silent one", async () => {
    const { apps } = hub({ timeoutMs: 50 });
    const echo = await linked(apps);
    await expect(
      apps.phoneCall(PHONE, { app: "echo", method: "slow", input: null, files: [] }),
    ).rejects.toThrow("Echo didn't answer in 0 s");
    const waiting = apps.phoneCall(PHONE, { app: "echo", method: "slow", input: null, files: [] });
    echo.stop();
    await expect(waiting).rejects.toThrow("Echo stopped on the laptop");
    await echo.done;
  });

  it("keeps an event for an app that isn't running, and hands it over when it attaches", async () => {
    let now = 1_000_000;
    const { apps } = hub({ now: () => now });
    const echo = await linked(apps);
    echo.stop();
    await echo.done;
    await expect(
      apps.phoneEmit(PHONE, { app: "echo", name: "note", data: 1, keep: 0 }),
    ).rejects.toThrow("Echo isn't running on the laptop");
    await apps.phoneEmit(PHONE, { app: "echo", name: "note", data: "kept", keep: 60 });
    await apps.phoneEmit(PHONE, { app: "echo", name: "note", data: "stale", keep: 1 });
    now += 2000;
    const again = run(apps);
    await tick();
    expect(again.got).toEqual([
      { kind: "status", status: "linked" },
      { kind: "event", from: PHONE, name: "note", data: "kept", at: 1_000_000 },
    ]);
    again.stop();
    await again.done;
  });

  it("limits each device's calls a minute, and the size of what it sends", async () => {
    const { apps } = hub();
    const echo = await linked(apps);
    for (let i = 0; i < 5; i++)
      await apps.phoneCall(PHONE, { app: "echo", method: "say", input: i, files: [] });
    await expect(
      apps.phoneCall(PHONE, { app: "echo", method: "say", input: 6, files: [] }),
    ).rejects.toThrow("too many requests for Echo: at most 5 a minute");
    const other = { key: "other", name: "Tablet" };
    await expect(
      apps.phoneCall(other, {
        app: "echo",
        method: "say",
        input: "x".repeat(1024 * 1024),
        files: [],
      }),
    ).rejects.toThrow("that's over 1 MB for Echo");
    echo.stop();
    await echo.done;
  });
});

describe("who asked", () => {
  it("finds the process whose socket's peer is ours in ss's output", () => {
    const ss = [
      'u_str ESTAB 0 0 /run/user/1000/ekatva.sock 111 * 222 users:(("node",pid=10,fd=20))',
      'u_str ESTAB 0 0 * 222 * 111 users:(("python3",pid=4242,fd=3))',
    ].join("\n");
    expect(peerPid(ss, "111")).toBe(4242);
    expect(peerPid(ss, "999")).toBeNull();
  });
});

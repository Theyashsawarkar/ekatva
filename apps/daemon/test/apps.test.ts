import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppIncoming, AppManifest } from "@ekatva/protocol";
import { describe, expect, it } from "vitest";
import { AppsService } from "../src/services/apps.js";

const ECHO = AppManifest.parse({
  id: "echo",
  name: "Echo",
  version: "1",
  methods: [
    { name: "say", why: "Says it back" },
    { name: "status", why: "Is it there", log: false },
    { name: "slow", why: "Never answers" },
  ],
  events: [{ name: "note", why: "A note" }],
  rate: 5,
});
const PHONE = { key: "phone-key", name: "Pixel" };

/** Registers `m` and answers its calls with `answer`; returns what it received and how to stop. */
function run(apps: AppsService, m = ECHO, answer = (i: AppIncoming) => i) {
  const got: AppIncoming[] = [];
  const stop = new AbortController();
  const stream = apps.register(m, stop.signal);
  const done = (async () => {
    for await (const msg of stream) {
      got.push(msg);
      if (msg.kind === "call") {
        if (msg.method === "slow") continue;
        await apps.reply({ id: msg.id, ok: true, result: { echoed: answer(msg) } });
      }
    }
  })();
  return { got, stop: () => stop.abort(), done };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("the laptop's app hub", () => {
  it("routes a call to the app and its answer back, with a line for the log", async () => {
    const apps = new AppsService(null);
    const echo = run(apps, ECHO, (i) => (i.kind === "call" ? i.input : null));
    await tick();
    const out = await apps.call(PHONE, { app: "echo", method: "say", input: "hi" });
    expect(out).toEqual({ value: { echoed: "hi" }, summary: "Echo: say", log: true });
    expect(echo.got[0]).toMatchObject({ kind: "call", from: PHONE, method: "say", input: "hi" });
    // A method marked log: false stays out of the log.
    expect((await apps.call(PHONE, { app: "echo", method: "status", input: null })).log).toBe(
      false,
    );
    echo.stop();
    await echo.done;
  });

  it("says in words when the app isn't there, or has no such method", async () => {
    const apps = new AppsService(null);
    await expect(apps.call(PHONE, { app: "nada", method: "play", input: null })).rejects.toThrow(
      `there's no app "nada" on the laptop`,
    );
    const echo = run(apps);
    await tick();
    await expect(apps.call(PHONE, { app: "echo", method: "fly", input: null })).rejects.toThrow(
      `Echo has no "fly" on the laptop`,
    );
    echo.stop();
    await echo.done;
    // Seen once: now it's known by name.
    await expect(apps.call(PHONE, { app: "echo", method: "say", input: null })).rejects.toThrow(
      "Echo isn't running on the laptop",
    );
  });

  it("fails a call in flight at once when the app stops, and times out a silent one", async () => {
    const apps = new AppsService(null, undefined, Date.now, 50);
    const echo = run(apps);
    await tick();
    await expect(apps.call(PHONE, { app: "echo", method: "slow", input: null })).rejects.toThrow(
      "Echo didn't answer in 0 s",
    );
    const waiting = apps.call(PHONE, { app: "echo", method: "slow", input: null });
    echo.stop();
    await expect(waiting).rejects.toThrow("Echo stopped on the laptop");
    await echo.done;
  });

  it("a new registration replaces the old one", async () => {
    const apps = new AppsService(null);
    const first = run(apps, ECHO, () => "first");
    await tick();
    const second = run(apps, ECHO, () => "second");
    await tick();
    await first.done; // the old stream ended
    const out = await apps.call(PHONE, { app: "echo", method: "say", input: null });
    expect(out.value).toEqual({ echoed: "second" });
    second.stop();
    await second.done;
  });

  it("keeps an event for an app that isn't running, and hands it over when it registers", async () => {
    let now = 1_000_000;
    const apps = new AppsService(null, undefined, () => now);
    const echo = run(apps);
    await tick();
    echo.stop();
    await echo.done;
    // Not kept: dropped, and said so.
    await expect(apps.emit(PHONE, { app: "echo", name: "note", data: 1, keep: 0 })).rejects.toThrow(
      "Echo isn't running on the laptop",
    );
    await apps.emit(PHONE, { app: "echo", name: "note", data: "kept", keep: 60 });
    await apps.emit(PHONE, { app: "echo", name: "note", data: "stale", keep: 1 });
    now += 2000; // the second one's day is over
    const again = run(apps);
    await tick();
    expect(again.got).toEqual([
      { kind: "event", from: PHONE, name: "note", data: "kept", at: 1_000_000 },
    ]);
    again.stop();
    await again.done;
  });

  it("limits each device's calls a minute, and the size of what it sends", async () => {
    const apps = new AppsService(null);
    const echo = run(apps);
    await tick();
    for (let i = 0; i < 5; i++) await apps.call(PHONE, { app: "echo", method: "say", input: i });
    await expect(apps.call(PHONE, { app: "echo", method: "say", input: 6 })).rejects.toThrow(
      "too many requests for Echo: at most 5 a minute",
    );
    // Another device has its own count.
    const other = { key: "other", name: "Tablet" };
    await expect(
      apps.call(other, { app: "echo", method: "say", input: "x".repeat(1024 * 1024) }),
    ).rejects.toThrow("that's over 1 MB for Echo");
    echo.stop();
    await echo.done;
  });

  it("remembers the apps it has seen, so a phone can be granted one while it's off", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ekatva-apps-"));
    const file = join(dir, "apps.json");
    const apps = new AppsService(file);
    const echo = run(apps);
    await tick();
    echo.stop();
    await echo.done;
    await tick();
    const later = new AppsService(file);
    await later.load();
    expect(later.list((id) => id === "echo")).toEqual([
      expect.objectContaining({ id: "echo", name: "Echo", online: false, granted: true }),
    ]);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

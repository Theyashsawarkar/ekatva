import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaffeineService, type Host } from "../src/services/caffeine.js";

let dir: string;
let calls: string[];
let holds: { args: string[]; stopped: boolean }[];
let lid: boolean | null;
let battery: { percent: number; discharging: boolean } | null;
let swayidle: boolean;

function host(): Host {
  return {
    run: async (cmd, args) => {
      const line = [cmd.split("/").at(-1), ...args].join(" ");
      calls.push(line);
      if (line === "systemctl --user is-active --quiet swayidle.service")
        return { code: swayidle ? 0 : 3, out: "" };
      if (line === "systemctl --user stop swayidle.service") swayidle = false;
      if (line === "systemctl --user start swayidle.service") swayidle = true;
      return { code: 0, out: "" };
    },
    hold: (_cmd, args) => {
      const h = { args, stopped: false };
      holds.push(h);
      return { stop: () => (h.stopped = true), onExit: () => undefined };
    },
    lidClosed: () => lid,
    battery: () => battery,
    now: () => Date.now(),
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "ekatva-caf-"));
  calls = [];
  holds = [];
  lid = false;
  battery = { percent: 80, discharging: true };
  swayidle = true;
});
afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(dir, { recursive: true, force: true });
});

/** Fake timers fire the callbacks; the state file's writes are real I/O: let them land. */
async function settle(check: () => Promise<boolean>) {
  vi.useRealTimers();
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
}

const make = () =>
  new CaffeineService(host(), join(dir, "caffeine.json"), join(dir, "caffeine/enabled"));
const exists = (p: string) =>
  fs.access(p).then(
    () => true,
    () => false,
  );

describe("caffeine", () => {
  it("on: holds idle and sleep, stops swayidle and marks Vayu's toggle; off puts it all back", async () => {
    const c = make();
    const d = await c.set("on", null);
    expect(d.value.level).toBe("on");
    expect(holds[0]?.args).toContain("--what=idle:sleep");
    expect(swayidle).toBe(false);
    expect(await exists(join(dir, "caffeine/enabled"))).toBe(true);
    expect(d.undo).toEqual({ kind: "caffeine.set", data: { level: "off", until: null } });
    await c.set("off", null);
    expect(holds[0]?.stopped).toBe(true);
    expect(swayidle).toBe(true);
    expect(await exists(join(dir, "caffeine/enabled"))).toBe(false);
  });

  it("high: holds the lid switch too, and locks when the lid closes", async () => {
    vi.useFakeTimers();
    const c = make();
    await c.set("high", null);
    expect(holds[0]?.args).toContain("--what=idle:sleep:handle-lid-switch");
    lid = true;
    await vi.advanceTimersByTimeAsync(2100);
    expect(calls).toContain("loginctl lock-session");
    c.shutdown();
  });

  it("high drops to on when the battery runs low", async () => {
    vi.useFakeTimers();
    const c = make();
    const auto: string[] = [];
    c.onAuto = (s) => auto.push(s);
    await c.set("high", null);
    battery = { percent: 8, discharging: true };
    await vi.advanceTimersByTimeAsync(2100);
    await settle(async () => (await c.get()).level === "on");
    expect((await c.get()).level).toBe("on");
    expect(auto[0]).toMatch(/battery at 8%/);
    expect(holds.at(-1)?.args).toContain("--what=idle:sleep");
    c.shutdown();
  });

  it("a timer turns it off; undo goes back to the level before", async () => {
    vi.useFakeTimers();
    const c = make();
    await c.set("on", null);
    const d = await c.set("high", 30);
    expect(d.value.until).toBeGreaterThan(Date.now());
    await c.undo(d.undo?.data as never);
    expect((await c.get()).level).toBe("on");
    await c.set("on", 1);
    await vi.advanceTimersByTimeAsync(61_000);
    await settle(async () => (await c.get()).level === "off");
    expect((await c.get()).level).toBe("off");
    c.shutdown();
  });

  it("is remembered across a restart", async () => {
    await make().set("high", null);
    const again = make();
    await again.restore();
    expect((await again.get()).level).toBe("high");
    again.shutdown();
  });

  it("sees caffeine turned on from quick settings", async () => {
    await fs.mkdir(join(dir, "caffeine"));
    await fs.writeFile(join(dir, "caffeine/enabled"), "");
    expect((await make().get()).level).toBe("on");
  });
});

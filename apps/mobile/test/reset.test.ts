import { describe, expect, it } from "vitest";
import { MemoryKV } from "../src/core/kv";
import { MemoryLines } from "../src/core/logStore";
import type { DeviceApi } from "../src/core/services";
import { type Platform, Session } from "../src/core/session";
import { MemFs } from "./memfs";

describe("starting over (forgotten password)", () => {
  it("wipes the vault, the laptops and the files, and lets a new password in", async () => {
    const kv = new MemoryKV();
    let wiped = 0;
    const p: Platform = {
      kv,
      lines: () => new MemoryLines(),
      fs: new MemFs(),
      roots: async () => ["/sd"],
      undoDir: "/app/undo",
      device: { name: "Pixel 8" } as DeviceApi,
      open: async () => {
        throw new Error("offline");
      },
      info: {},
      wipeFiles: async () => {
        wiped++;
      },
    };
    const first = (await Session.create(p)).id;
    await kv.set("ekatva.laptops", "[]");
    expect(await Session.isSetUp(p)).toBe(true);
    await Session.reset(p);
    expect(await Session.isSetUp(p)).toBe(false);
    expect(kv.map.size).toBe(0);
    expect(wiped).toBe(1);
    const s = await Session.create(p);
    expect(s.laptops.all()).toEqual([]);
    // A new identity: not the one from before.
    expect(s.id).not.toBe(first);
  });
});

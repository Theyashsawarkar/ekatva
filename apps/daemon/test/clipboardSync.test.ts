import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClipboardSync, wlPasteEvents } from "../src/services/clipboardSync.js";
import { fakeSpawn, until } from "./fakeChild.js";

describe("one clipboard for both", () => {
  it("sends the laptop's changes to the phone, once each, never back what the phone sent", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ekatva-clip-"));
    let laptop = "first";
    let connected = true;
    const sent: string[] = [];
    const file = join(dir, "sync.json");
    const sync = new ClipboardSync(
      file,
      async () => laptop,
      async (t) => void sent.push(t),
      () => connected,
      60_000,
    );
    expect(sync.enabled).toBe(false);
    await sync.tick();
    expect(sent).toEqual([]); // off: nothing goes
    sync.set(true); // on: the laptop's clipboard goes first
    await sync.tick();
    expect(sent).toEqual(["first"]);
    await sync.tick();
    expect(sent).toEqual(["first"]); // unchanged: nothing new
    laptop = "copied on the laptop";
    await sync.tick();
    expect(sent.at(-1)).toBe("copied on the laptop");
    // The phone set the laptop's clipboard: that isn't sent back.
    sync.heard("from the phone");
    laptop = "from the phone";
    await sync.tick();
    expect(sent).toHaveLength(2);
    // No phone connected: no watching.
    connected = false;
    laptop = "later";
    await sync.tick();
    expect(sent).toHaveLength(2);
    // Remembered across restarts.
    expect(
      new ClipboardSync(
        file,
        async () => "",
        async () => {},
        () => true,
      ).enabled,
    ).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("the clipboard watched by wl-paste --watch", () => {
  it("reads it once per change, only while on with a phone connected", async () => {
    const spawn = fakeSpawn();
    let laptop = "first";
    let reads = 0;
    let connected = false;
    const sent: string[] = [];
    const events = wlPasteEvents({ WAYLAND_DISPLAY: "wayland-9" }, spawn);
    const sync = new ClipboardSync(
      null,
      async () => {
        reads++;
        return laptop;
      },
      async (t) => void sent.push(t),
      () => connected,
      20, // a poll every 20 ms would show in `reads`
      events,
    );
    sync.start();
    expect(sync.mode).toBe("idle"); // off: no child at all
    sync.set(true);
    expect(sync.mode).toBe("idle"); // on, but no phone
    expect(spawn.procs).toHaveLength(0);
    connected = true;
    sync.update(); // a phone came
    expect(sync.mode).toBe("events");
    const p = spawn.procs[0];
    expect(p?.cmd).toBe("wl-paste");
    expect(p?.args.slice(0, 2)).toEqual(["--watch", "sh"]);
    p?.say("changed"); // wl-paste reports the clipboard as it is when it starts
    await until(() => sent.length === 1);
    expect(sent).toEqual(["first"]);
    await new Promise((r) => setTimeout(r, 100));
    const quiet = reads;
    expect(quiet).toBeLessThanOrEqual(2); // no polling in between
    laptop = "copied on the laptop";
    p?.say("changed");
    await until(() => sent.length === 2);
    // What the phone set comes back as an event, and isn't sent back.
    sync.heard("from the phone");
    laptop = "from the phone";
    p?.say("changed");
    await until(() => reads === quiet + 2);
    expect(sent).toEqual(["first", "copied on the laptop"]);
    // The phone left: the child goes.
    connected = false;
    sync.update();
    expect(sync.mode).toBe("idle");
    expect(p?.killed).toBe(true);
    sync.stop();
  });

  it("polls as before without wl-paste, or without a Wayland display", async () => {
    expect(wlPasteEvents({})).toBeNull();
    const spawn = fakeSpawn(["wl-paste"]);
    const sync = new ClipboardSync(
      null,
      async () => "x",
      async () => {},
      () => true,
      20,
      wlPasteEvents({ WAYLAND_DISPLAY: "wayland-9" }, spawn),
    );
    sync.start();
    sync.set(true);
    await until(() => sync.mode === "polling");
    sync.stop();
    expect(sync.mode).toBe("idle");
  });
});

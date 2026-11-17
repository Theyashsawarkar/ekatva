import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClipboardSync } from "../src/services/clipboardSync.js";

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

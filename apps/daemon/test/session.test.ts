/**
 * The real event sources, in a private session (test/session/run.sh sets it
 * up: its own bus, a headless sway). Skipped anywhere else, so a plain
 * `pnpm test` never reads your clipboard or your players.
 */
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Media } from "@ekatva/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { ClipboardSync, wlPasteEvents } from "../src/services/clipboardSync.js";
import { MediaService, realMediaHost } from "../src/services/media.js";
import { until } from "./fakeChild.js";

const inside = process.env.EKATVA_PRIVATE_SESSION === "1" && !!process.env.WAYLAND_DISPLAY;
const here = dirname(fileURLToPath(import.meta.url));
const started: ChildProcess[] = [];
afterAll(() => {
  for (const c of started) c.kill();
});

const paste = () =>
  new Promise<string>((res) =>
    execFile("wl-paste", ["--no-newline"], (_e, out) => res(String(out ?? ""))),
  );
// wl-copy stays behind to serve the selection: never wait on its output.
const copy = (text: string) => execFileSync("wl-copy", [text], { stdio: "ignore" });

describe.skipIf(!inside)("in a private session", () => {
  it("sends each copy to the phone as it happens, from wl-paste --watch", async () => {
    const sent: string[] = [];
    let reads = 0;
    const sync = new ClipboardSync(
      null,
      () => {
        reads++;
        return paste();
      },
      async (t) => void sent.push(t),
      () => true,
      60_000,
      wlPasteEvents(),
    );
    copy("made-up first");
    sync.start();
    sync.set(true);
    await until(() => sent.includes("made-up first"));
    expect(sync.mode).toBe("events");
    copy("made-up second");
    await until(() => sent.includes("made-up second"));
    sync.heard("from the phone");
    copy("from the phone");
    const at = reads;
    await until(() => reads > at);
    await new Promise((r) => setTimeout(r, 200));
    expect(sent.filter((t) => t === "from the phone")).toEqual([]);
    sync.stop();
    expect(sync.mode).toBe("idle");
  });

  it("tells a fake MPRIS player's pause, seek and next track from D-Bus signals", async () => {
    const player = spawn("python3", ["-I", join(here, "session/fakeplayer.py"), "0"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    started.push(player);
    await new Promise<void>((res) => player.stdout?.once("data", () => res()));
    const m = new MediaService(realMediaHost, 60_000); // polling would never come in time
    const ac = new AbortController();
    const got: Media[] = [];
    const reading = (async () => {
      for await (const x of m.changes(ac.signal)) got.push(x);
    })();
    await until(() => got.length === 1 && m.watching.players === "events");
    expect(got[0]?.players[0]?.title).toBe("Made-up Song One");
    execFileSync("playerctl", ["-p", "fakeplayer", "pause"]);
    await until(() => got.at(-1)?.players[0]?.status === "Paused");
    execFileSync("playerctl", ["-p", "fakeplayer", "position", "100"]);
    await until(() => (got.at(-1)?.players[0]?.position ?? 0) >= 100_000);
    execFileSync("playerctl", ["-p", "fakeplayer", "next"]);
    await until(() => got.at(-1)?.players[0]?.title === "Made-up Song Two");
    // The player goes: the list empties.
    player.kill();
    await until(() => got.at(-1)?.players.length === 0);
    ac.abort();
    await reading;
  });
});

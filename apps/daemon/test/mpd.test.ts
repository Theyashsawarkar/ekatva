import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { mpdQueue } from "../src/services/mpd.js";

const SONGS = [
  { file: "a/Alap.flac", Title: "Alap", Artist: "Kishori Amonkar" },
  { file: "b/Alfaaz.mp3", Title: "Alfaaz", Artist: "Hamza Malik" },
  { file: "c/untitled.ogg" },
];
let state = { song: 1, repeat: "0" };

// A fake MPD: the greeting, `status`, and `playlistinfo N`.
const server = createServer((s) => {
  s.write("OK MPD 0.24.0\n");
  let buf = "";
  s.on("data", (d) => {
    buf += d.toString();
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const cmd = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (cmd === "status")
        s.write(
          `repeat: ${state.repeat}\nsong: ${state.song}\nplaylistlength: ${SONGS.length}\nOK\n`,
        );
      else if (cmd.startsWith("playlistinfo ")) {
        const n = SONGS[Number(cmd.split(" ")[1])];
        if (!n) s.write("ACK [2@0] {playlistinfo} Bad song index\n");
        else
          s.write(
            `${Object.entries(n)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n")}\nOK\n`,
          );
      }
    }
  });
});
const dir = await mkdtemp(join(tmpdir(), "ekatva-mpd-"));
const path = join(dir, "socket");
await new Promise<void>((r) => server.listen(path, r));
afterAll(() => server.close());

test("the songs either side of the one playing", async () => {
  state = { song: 1, repeat: "0" };
  expect(await mpdQueue({ path })).toEqual({
    prev: { title: "Alap", artist: "Kishori Amonkar" },
    next: { title: "untitled", artist: "" },
  });
});

test("at the end of the queue there's no next, unless it repeats", async () => {
  state = { song: 2, repeat: "0" };
  expect((await mpdQueue({ path }))?.next).toBeNull();
  state = { song: 2, repeat: "1" };
  expect((await mpdQueue({ path }))?.next).toEqual({ title: "Alap", artist: "Kishori Amonkar" });
});

test("no MPD: an error, which the media service turns into no queue", async () => {
  await expect(mpdQueue({ path: join(dir, "nothing") }, 200)).rejects.toThrow();
});

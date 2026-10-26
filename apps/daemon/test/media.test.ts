import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MediaHost, MediaService } from "../src/services/media.js";

/** A pretend desktop: two players, PipeWire and a backlight. Nothing real is touched. */
interface Fake {
  players: Record<
    string,
    { status: string; title: string; artist: string; art: string; length: number; position: number }
  >;
  volume: number;
  muted: boolean;
  brightness: number;
  calls: string[];
  tools: boolean;
}

let f: Fake;

function host(): MediaHost {
  return {
    run: async (cmd, args) => {
      f.calls.push([cmd, ...args].join(" "));
      if (!f.tools) return { code: 127, out: "" };
      if (cmd === "playerctl" && args[0] === "-l")
        return { code: 0, out: Object.keys(f.players).join("\n") };
      if (cmd === "playerctl") {
        const p = f.players[args[1] ?? ""];
        if (!p) return { code: 1, out: "" };
        const verb = args[2];
        if (verb === "metadata")
          return {
            code: 0,
            out: `${[args[1], p.status, p.title, p.artist, "", p.art, p.length * 1000, p.position * 1000].join("\u001f")}\n`,
          };
        if (verb === "play-pause") p.status = p.status === "Playing" ? "Paused" : "Playing";
        if (verb === "play") p.status = "Playing";
        if (verb === "pause") p.status = "Paused";
        if (verb === "position") p.position = Math.round(Number(args[3]) * 1000);
        return { code: 0, out: "" };
      }
      if (cmd === "wpctl" && args[0] === "get-volume")
        return { code: 0, out: `Volume: ${f.volume.toFixed(2)}${f.muted ? " [MUTED]" : ""}\n` };
      if (cmd === "wpctl" && args[0] === "set-volume") f.volume = Number(args[2]);
      if (cmd === "wpctl" && args[0] === "set-mute") f.muted = args[2] === "1";
      if (cmd === "brightnessctl" && args.includes("info"))
        return { code: 0, out: `intel_backlight,backlight,561,${f.brightness}%,937\n` };
      if (cmd === "brightnessctl" && args.includes("set"))
        f.brightness = Number.parseInt(args.at(-1) ?? "0", 10);
      return { code: 0, out: "" };
    },
    art: async (path) =>
      path.endsWith("cover.png") ? Buffer.from([0x89, 0x50, 0x4e, 0x47]) : null,
    now: () => 1000,
  };
}

let m: MediaService;
beforeEach(() => {
  f = {
    players: {
      nada: {
        status: "Paused",
        title: "Kun Faya Kun",
        artist: "A. R. Rahman",
        art: "file:///home/u/.cache/nada/cover.png",
        length: 380_000,
        position: 51_000,
      },
      drishya: {
        status: "Playing",
        title: "A video",
        artist: "Someone",
        art: "https://i.ytimg.com/vi/x/mqdefault.jpg",
        length: 90_000,
        position: 1_500,
      },
    },
    volume: 0.5,
    muted: false,
    brightness: 60,
    calls: [],
    tools: true,
  };
  m = new MediaService(host(), 20);
});
afterEach(() => m.stop());

describe("media", () => {
  it("reads players (the playing one first), volume and brightness", async () => {
    const got = await m.get();
    expect(got.players.map((p) => p.id)).toEqual(["drishya", "nada"]);
    const nada = got.players[1]!;
    expect(nada).toMatchObject({
      name: "nāda",
      status: "Paused",
      length: 380_000,
      position: 51_000,
    });
    expect(nada.art).toBe("data:image/png;base64,iVBORw==");
    expect(got.players[0]!.art).toMatch(/^https:/);
    expect(got.volume).toEqual({ percent: 50, muted: false });
    expect(got.brightness).toBe(60);
  });

  it("controls the playing player by default, and undoes a pause", async () => {
    const d = await m.control(null, "pause");
    expect(f.players.drishya!.status).toBe("Paused");
    expect(d.summary).toBe("Paused drishya (A video)");
    expect(d.undo).toEqual({ kind: "media.control", data: { player: "drishya", action: "play" } });
    await m.undo(d.undo!.kind, d.undo!.data as Record<string, unknown>);
    expect(f.players.drishya!.status).toBe("Playing");
  });

  it("names a player, and says when there's none", async () => {
    await m.control("nada", "play-pause");
    expect(f.players.nada!.status).toBe("Playing");
    await expect(m.control("vlc", "play")).rejects.toThrow(/no player called vlc/);
    f.players = {};
    await expect(m.control(null, "play")).rejects.toThrow(/nothing is playing/);
  });

  it("doesn't offer an undo it can't do", async () => {
    expect((await m.control(null, "next")).undo).toBeUndefined();
    // Pausing what's already paused changes nothing, so nothing to undo.
    expect((await m.control("nada", "pause")).undo).toBeUndefined();
  });

  it("seeks and seeks back", async () => {
    const d = await m.seek("nada", 120_000);
    expect(f.players.nada!.position).toBe(120_000);
    expect(d.summary).toBe("Moved nāda to 2:00");
    await m.undo(d.undo!.kind, d.undo!.data as Record<string, unknown>);
    expect(f.players.nada!.position).toBe(51_000);
  });

  it("sets volume and mute, undoably", async () => {
    const d = await m.volume({ percent: 80 });
    expect(f.volume).toBe(0.8);
    expect(d.summary).toBe("Set the volume to 80%");
    const mute = await m.volume({ muted: true });
    expect(f.muted).toBe(true);
    expect(mute.summary).toBe("Sound muted");
    await m.undo(mute.undo!.kind, mute.undo!.data as Record<string, unknown>);
    await m.undo(d.undo!.kind, d.undo!.data as Record<string, unknown>);
    expect(f).toMatchObject({ volume: 0.5, muted: false });
  });

  it("never turns the screen fully dark, and undoes brightness", async () => {
    const d = await m.brightness(0);
    expect(f.brightness).toBe(1);
    await m.undo(d.undo!.kind, d.undo!.data as Record<string, unknown>);
    expect(f.brightness).toBe(60);
  });

  it("says what's missing when the tools aren't there", async () => {
    f.tools = false;
    expect(await m.get()).toEqual({ players: [], volume: null, brightness: null });
    await expect(m.volume({ percent: 10 })).rejects.toThrow(/no volume control/);
    await expect(m.brightness(10)).rejects.toThrow(/no backlight/);
  });

  it("tells watchers about changes, but not about time passing", async () => {
    const ac = new AbortController();
    const seen: string[] = [];
    const done = (async () => {
      for await (const x of m.changes(ac.signal)) {
        seen.push(x.players.map((p) => `${p.id}:${p.status}`).join(","));
        if (seen.length === 2) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 80));
    f.players.nada!.position += 5000; // a track playing on: not a change
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toHaveLength(1);
    f.players.drishya!.status = "Paused";
    await done;
    ac.abort();
    expect(seen).toEqual(["drishya:Playing,nada:Paused", "nada:Paused,drishya:Paused"]);
  });
});

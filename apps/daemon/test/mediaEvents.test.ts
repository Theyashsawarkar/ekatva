import type { Media } from "@ekatva/protocol";
import { describe, expect, it } from "vitest";
import { type MediaHost, MediaService, vyomView } from "../src/services/media.js";
import { fakeSpawn, until } from "./fakeChild.js";

/** A pretend desktop whose changes are told by fake dbus-monitor / pactl / udevadm children. */
function desk(missing: string[] = []) {
  const s = {
    status: "Playing",
    title: "Made-up Song",
    position: 5000,
    volume: 0.5,
    brightness: 40,
    calls: [] as string[],
  };
  const spawn = fakeSpawn(missing);
  const host: MediaHost = {
    run: async (cmd, args) => {
      s.calls.push(cmd);
      if (cmd === "playerctl" && args[0] === "-l") return { code: 0, out: "fakeplayer\n" };
      if (cmd === "playerctl")
        return {
          code: 0,
          out: `${["fakeplayer", s.status, s.title, "Example Band", "", "", 240_000_000, s.position * 1000].join("\u001f")}\n`,
        };
      if (cmd === "wpctl") return { code: 0, out: `Volume: ${s.volume.toFixed(2)}\n` };
      if (cmd === "brightnessctl")
        return { code: 0, out: `intel_backlight,backlight,400,${s.brightness}%,1000\n` };
      return { code: 127, out: "" };
    },
    art: async () => null,
    now: () => 1000,
    spawn,
  };
  return { s, spawn, host };
}

const watch = (m: MediaService) => {
  const ac = new AbortController();
  const got: Media[] = [];
  const done = (async () => {
    for await (const x of m.changes(ac.signal)) got.push(x);
  })();
  return {
    got,
    stop: async () => {
      ac.abort();
      await done;
    },
  };
};

const proc = (spawn: ReturnType<typeof fakeSpawn>, cmd: string) =>
  spawn.procs.find((p) => p.cmd === cmd);

describe("media told by events, not polled", () => {
  it("reads only what a signal says changed, and nothing while quiet", async () => {
    const { s, spawn, host } = desk();
    const m = new MediaService(host, 20); // a poll every 20 ms would show in the calls
    const w = watch(m);
    await until(() => w.got.length === 1 && !!proc(spawn, "udevadm"));
    expect(proc(spawn, "dbus-monitor")?.args).toContain("--profile");
    expect(m.watching).toEqual({ players: "events", volume: "events", brightness: "events" });
    const before = s.calls.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(s.calls.length).toBe(before); // quiet: no polling at all

    // A pause: one PropertiesChanged; only the players are read again.
    s.status = "Paused";
    proc(spawn, "dbus-monitor")?.say(
      "sig\t1.0\t5\t:1.1\t<none>\t/org/mpris/MediaPlayer2\torg.freedesktop.DBus.Properties\tPropertiesChanged",
    );
    await until(() => w.got.length === 2);
    expect(w.got[1]?.players[0]?.status).toBe("Paused");
    expect(s.calls.slice(before)).toEqual(["playerctl", "playerctl"]);

    // A volume key: pactl says the sink changed (a stream's change is ignored).
    s.volume = 0.7;
    proc(spawn, "pactl")?.say("Event 'change' on sink-input #12");
    await new Promise((r) => setTimeout(r, 150));
    expect(w.got).toHaveLength(2);
    proc(spawn, "pactl")?.say("Event 'change' on sink #53");
    await until(() => w.got.length === 3);
    expect(w.got[2]?.volume?.percent).toBe(70);

    // The backlight: a udev change.
    s.brightness = 60;
    proc(spawn, "udevadm")?.say(
      "UDEV  [123.456] change   /devices/pci0000:00/backlight/intel_backlight (backlight)",
    );
    await until(() => w.got.length === 4);
    expect(w.got[3]?.brightness).toBe(60);
    await w.stop();
    expect(spawn.procs.every((p) => p.killed)).toBe(true);
  });

  it("tells a seek with its new position (time passing alone never is a change)", async () => {
    const { s, spawn, host } = desk();
    const m = new MediaService(host, 20);
    const w = watch(m);
    await until(() => w.got.length === 1 && !!proc(spawn, "dbus-monitor"));
    s.position = 90_000;
    proc(spawn, "dbus-monitor")?.say(
      "sig\t1.0\t8\t:1.1\t<none>\t/org/mpris/MediaPlayer2\torg.mpris.MediaPlayer2.Player\tSeeked",
    );
    await until(() => w.got.length === 2);
    expect(w.got[1]?.players[0]?.position).toBe(90_000);
    await w.stop();
  });

  it("polls a part as before when its event source isn't there", async () => {
    const { s, spawn, host } = desk(["pactl", "udevadm"]);
    const m = new MediaService(host, 20);
    const w = watch(m);
    await until(() => m.watching.volume === "polling" && m.watching.brightness === "polling");
    expect(m.watching.players).toBe("events");
    s.volume = 0.9;
    await until(() => w.got.at(-1)?.volume?.percent === 90);
    await w.stop();
    expect(spawn.procs.find((p) => p.cmd === "dbus-monitor")?.killed).toBe(true);
  });

  it("polls everything as before without any event source", async () => {
    const { s, host } = desk();
    delete host.spawn;
    const m = new MediaService(host, 20);
    const w = watch(m);
    await until(() => w.got.length === 1);
    expect(m.watching.players).toBe("polling");
    s.title = "Another Made-up Song";
    await until(() => w.got.at(-1)?.players[0]?.title === "Another Made-up Song");
    await w.stop();
    expect(m.watching.players).toBe("idle");
  });

  it("follows Vyom's state instead of pactl and udevadm while Vyom runs, and its own without it", async () => {
    const { s, spawn, host } = desk();
    const vy = {
      running: true,
      volume: { sink: "demo", volume: 50, muted: false } as unknown,
      max: 1000,
      reads: 0,
    };
    host.vyom = {
      running: async () => vy.running,
      read: async () => {
        vy.reads++;
        return vy.running
          ? vyomView(vy.volume, { brightness: s.brightness * 10, max: vy.max })
          : null;
      },
    };
    const m = new MediaService(host, 20);
    const w = watch(m);
    await until(() => m.watching.volume === "vyom" && m.watching.brightness === "vyom");
    expect(proc(spawn, "pactl")).toBeUndefined();
    expect(proc(spawn, "udevadm")).toBeUndefined();
    const mon = proc(spawn, "dbus-monitor");
    expect(mon?.args.join(" ")).toContain("path='/dev/vayu/Vyom/State'");
    const before = s.calls.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(s.calls.length).toBe(before); // quiet: nothing polled

    // A volume key: Vyom publishes, its signal comes through dbus-monitor; no wpctl.
    vy.volume = { sink: "demo", volume: 72, muted: true };
    const vyomSignal =
      "sig\t1.0\t9\t:1.7\t<none>\t/dev/vayu/Vyom/State\torg.freedesktop.DBus.Properties\tPropertiesChanged";
    mon?.say(vyomSignal);
    await until(() => w.got.at(-1)?.volume?.percent === 72);
    expect(w.got.at(-1)?.volume?.muted).toBe(true);
    s.brightness = 65;
    mon?.say(vyomSignal);
    await until(() => w.got.at(-1)?.brightness === 65);
    expect(s.calls.slice(before)).not.toContain("wpctl");
    expect(s.calls.slice(before)).not.toContain("brightnessctl");

    // Vyom goes: our own watchers start, and a change reaches the phone through them.
    vy.running = false;
    mon?.say(
      "sig\t1.0\t10\t:1.0\t<none>\t/org/freedesktop/DBus\torg.freedesktop.DBus\tNameOwnerChanged",
    );
    await until(
      () => m.watching.volume === "events" && !!proc(spawn, "pactl") && !!proc(spawn, "udevadm"),
    );
    s.volume = 0.3;
    proc(spawn, "pactl")?.say("Event 'change' on sink #53");
    await until(() => w.got.at(-1)?.volume?.percent === 30);

    // Vyom is back (it publishes everything fresh): our own stop again.
    vy.running = true;
    vy.volume = { sink: "demo", volume: 44, muted: false };
    mon?.say(vyomSignal);
    await until(() => m.watching.volume === "vyom" && w.got.at(-1)?.volume?.percent === 44);
    expect(spawn.procs.filter((p) => p.cmd === "pactl").every((p) => p.killed)).toBe(true);
    expect(spawn.procs.filter((p) => p.cmd === "udevadm").every((p) => p.killed)).toBe(true);
    await w.stop();
    expect(spawn.procs.every((p) => p.killed)).toBe(true);
  });

  it("keeps its own watchers with a Vyom that doesn't publish the output (older)", async () => {
    const { spawn, host } = desk();
    host.vyom = {
      running: async () => true,
      read: async () => vyomView({ device: "x", volume: 5 }, null),
    };
    const m = new MediaService(host, 20);
    const w = watch(m);
    await until(() => !!proc(spawn, "pactl") && !!proc(spawn, "udevadm"));
    expect(m.watching).toEqual({ players: "events", volume: "events", brightness: "events" });
    await w.stop();
  });

  it("reads Vyom's state as the phone shows it", () => {
    expect(vyomView({ sink: "a", volume: 41.6, muted: 0 }, { brightness: 937, max: 937 })).toEqual({
      volume: { percent: 42, muted: false },
      brightness: 100,
    });
    expect(vyomView({ sink: "" }, null)).toEqual({ volume: null, brightness: null });
    expect(vyomView({ sink: "a", volume: 10 }, { brightness: 5, max: 10 })?.brightness).toBe(50);
    expect(vyomView(null, null)).toBeNull();
    expect(vyomView({ volume: 10 }, null)).toBeNull();
  });
});

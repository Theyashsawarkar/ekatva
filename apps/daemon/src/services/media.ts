/**
 * What's playing, the volume and the screen's brightness: any MPRIS player
 * (nāda, drishya, browsers, mpv) through playerctl, the volume through
 * wpctl (PipeWire), the backlight through brightnessctl. Missing tools just
 * leave their part empty.
 *
 * While watched, the volume and the backlight come from Vyom's live state
 * when Vyom runs (vyom/live.py already follows the sound server and the
 * backlight for the desktop): its `PropertiesChanged` on
 * /dev/vayu/Vyom/State reaches the same dbus-monitor that follows the
 * players, and its state files are read then, so no `pactl subscribe` or
 * `udevadm monitor` of our own runs and a change costs no wpctl or
 * brightnessctl. Without Vyom (or with one older than its `sink` field)
 * they're followed here as before.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Done, Media, MediaAction, Player } from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";
import { debounce, LineChild, realSpawn, type Spawn } from "./lineChild.js";
import { mpdQueue, type Queue } from "./mpd.js";

export interface MediaHost {
  /** Runs a command; resolves with its exit code and output. */
  run(cmd: string, args: string[]): Promise<{ code: number; out: string }>;
  /** A local file's bytes, for album art; null when it's missing or too big. */
  art(path: string): Promise<Buffer | null>;
  /**
   * A cover scaled down for the phone (a local path or an https URL): a small
   * JPEG, or null when it can't be made (then the original is used).
   */
  cover?(source: string): Promise<Buffer | null>;
  /** An https cover's bytes (capped), when it can't be scaled. */
  fetchArt?(url: string): Promise<Buffer | null>;
  now(): number;
  /** The songs either side of the current one, for players that play through MPD (nāda). */
  queue?(): Promise<Queue | null>;
  /**
   * Starts long-lived helpers whose output says when something changed
   * (dbus-monitor, pactl subscribe, udevadm monitor). Without it, watching
   * polls every 1.5 s.
   */
  spawn?: Spawn;
  /** Vyom's live state (the volume and the backlight), when Vyom runs. */
  vyom?: VyomState;
}

/** What Vyom publishes that the media panel shows. */
export interface VyomView {
  volume: Media["volume"];
  brightness: number | null;
}

export interface VyomState {
  /** Whether Vyom is on the session bus now. */
  running(): Promise<boolean>;
  /** Its volume and backlight, or null when they can't be used (none, or an older Vyom). */
  read(): Promise<VyomView | null>;
}

/** Where Vyom's live state signals (ADR 12 in Vyom). */
export const VYOM_STATE_PATH = "/dev/vayu/Vyom/State";

/**
 * Vyom's state files (`volume.json`, `brightness.json`) as the phone shows
 * them. Null when the volume has no `sink` field: no sound followed, or a
 * Vyom from before it published at once (it then held changes up to 250 ms).
 */
export function vyomView(volume: unknown, brightness: unknown): VyomView | null {
  if (!volume || typeof volume !== "object" || !("sink" in volume)) return null;
  const v = volume as { sink?: unknown; volume?: unknown; muted?: unknown };
  const b = (brightness ?? null) as { brightness?: unknown; max?: unknown } | null;
  const max = Number(b?.max);
  return {
    volume:
      v.sink && Number.isFinite(Number(v.volume))
        ? { percent: Math.round(Number(v.volume)), muted: Boolean(v.muted) }
        : null,
    // brightnessctl's percent: rounded, half up
    brightness: b && max > 0 ? Math.round((Number(b.brightness) * 100) / max) : null,
  };
}

const realVyom: VyomState = {
  running: () =>
    new Promise((resolve) => {
      execFile(
        "gdbus",
        [
          "call",
          "--session",
          "--dest",
          "org.freedesktop.DBus",
          "--object-path",
          "/org/freedesktop/DBus",
          "--method",
          "org.freedesktop.DBus.NameHasOwner",
          "dev.vayu.Vyom",
        ],
        { timeout: 2_000 },
        (err, stdout) => resolve(!err && /true/.test(String(stdout))),
      );
    }),
  read: async () => {
    const dir = process.env.XDG_RUNTIME_DIR;
    if (!dir) return null;
    const json = async (name: string) => {
      try {
        return JSON.parse(await readFile(join(dir, "vayu", "state", `${name}.json`), "utf8"));
      } catch {
        return null;
      }
    };
    const [volume, brightness] = await Promise.all([json("volume"), json("brightness")]);
    return vyomView(volume, brightness);
  },
};

type Part = "players" | "volume" | "brightness";
const PARTS: readonly Part[] = ["players", "volume", "brightness"];
/** While watched, everything is read again this often, in case an event was missed. */
const SAFETY_MS = 30_000;
/**
 * MPRIS players' signals on the session bus, one line each (--profile): a
 * property changed (status, track, volume), a seek, a player came or went.
 * Positions aren't signalled: the phone moves a playing track on itself.
 */
const DBUS_ARGS = [
  "--session",
  "--profile",
  "type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='/org/mpris/MediaPlayer2'",
  "type='signal',interface='org.mpris.MediaPlayer2.Player',member='Seeked',path='/org/mpris/MediaPlayer2'",
  "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0namespace='org.mpris.MediaPlayer2'",
  // Vyom's live state changing, and Vyom coming or going
  `type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='${VYOM_STATE_PATH}'`,
  "type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='dev.vayu.Vyom'",
];

/** Players whose queue is MPD's. */
const MPD_PLAYERS = new Set(["nada", "mpd"]);

const ART_MAX = 256 * 1024;
/** Covers are scaled to this width for the phone. */
export const COVER_PX = 192;

export const realMediaHost: MediaHost = {
  run: (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 5_000 }, (err, stdout) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : 127
          : 0;
        resolve({ code, out: String(stdout ?? "") });
      });
    }),
  art: async (path) => {
    try {
      if ((await stat(path)).size > ART_MAX) return null;
      return await readFile(path);
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
  queue: () => mpdQueue().catch(() => null),
  spawn: realSpawn,
  vyom: realVyom,
  // ffmpeg reads files and https alike; 192 px wide is plenty for a 64 dp label at 3x.
  cover: (source) =>
    new Promise((resolve) => {
      execFile(
        "ffmpeg",
        [
          "-v",
          "error",
          "-nostdin",
          "-i",
          source,
          "-vf",
          `scale='min(${COVER_PX},iw)':-2`,
          "-frames:v",
          "1",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "-q:v",
          "5",
          "-",
        ],
        { encoding: "buffer", timeout: 8_000, maxBuffer: ART_MAX },
        (err, stdout) => resolve(err || !stdout?.length ? null : (stdout as Buffer)),
      );
    }),
  fetchArt: async (url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6_000) });
      if (!r.ok) return null;
      const b = Buffer.from(await r.arrayBuffer());
      return b.length <= ART_MAX ? b : null;
    } catch {
      return null;
    }
  },
};

const NAMES: Record<string, string> = {
  nada: "nāda",
  drishya: "drishya",
  chromium: "Chromium",
  firefox: "Firefox",
  mpv: "mpv",
  spotify: "Spotify",
  vlc: "VLC",
};

/** Fields a player reports, joined by a separator no title will hold. */
const SEP = "\u001f";
const FORMAT = [
  "{{playerName}}",
  "{{status}}",
  "{{title}}",
  "{{artist}}",
  "{{album}}",
  "{{mpris:artUrl}}",
  "{{mpris:length}}",
  "{{position}}",
].join(SEP);

const VERBS: Record<MediaAction, string> = {
  "play-pause": "Played or paused",
  play: "Played",
  pause: "Paused",
  next: "Skipped to the next track on",
  previous: "Went back a track on",
  stop: "Stopped",
};

function clock(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export class MediaService {
  /** Covers by id: where each lives, and the ones read already. */
  private artUrls = new Map<string, string>();
  private art_ = new Map<string, string | null>();
  private listeners = new Set<(m: Media) => void>();
  /** Polls the parts nothing reports (every `everyMs`). */
  private timer: ReturnType<typeof setInterval> | null = null;
  /** A slow look at everything while watched, in case an event was missed. */
  private safety: ReturnType<typeof setInterval> | null = null;
  private last = "";
  /** What watchers were told last, part by part. */
  private current: Media | null = null;
  /** The event source of each part, while watched. */
  private sources = new Map<Part, LineChild>();
  /** Parts whose event source runs right now. */
  private live = new Set<Part>();
  /** Parts to read again on the next look. */
  private dirty = new Set<Part>();
  /** Tell watchers on the next look even if nothing but positions moved (a seek). */
  private forced = false;
  private flushing: Promise<void> | null = null;
  private kick = debounce(() => void this.flush().catch(() => undefined), 100);
  /** The volume and the backlight come from Vyom's state right now (not our own watchers). */
  private viaVyom = false;
  /** What was there when watching started: the parts our own watchers follow. */
  private first: Media | null = null;
  private checking: Promise<void> | null = null;
  private recheck = false;

  constructor(
    private readonly host: MediaHost = realMediaHost,
    private readonly everyMs = 1500,
  ) {}

  private async players(): Promise<Player[]> {
    const ids = await this.host.run("playerctl", ["-l"]);
    if (ids.code !== 0) return [];
    const out: Player[] = [];
    for (const id of ids.out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)) {
      const r = await this.host.run("playerctl", ["-p", id, "metadata", "--format", FORMAT]);
      if (r.code !== 0) continue;
      const [, status, title, artist, album, artUrl, length, position] = r.out
        .replace(/\n$/, "")
        .split(SEP);
      const base = id.split(".")[0] ?? id;
      const us = (v: string | undefined) =>
        v && /^\d+$/.test(v) ? Math.round(Number(v) / 1000) : null;
      out.push({
        id,
        name: NAMES[base] ?? base,
        status: status === "Playing" || status === "Paused" ? status : "Stopped",
        title: title ?? "",
        artist: artist ?? "",
        album: album ?? "",
        artId: this.artIdOf(artUrl ?? ""),
        length: us(length),
        position: us(position),
        at: this.host.now(),
        ...(MPD_PLAYERS.has(base) && this.host.queue
          ? ((await this.host.queue()) ?? { prev: null, next: null })
          : {}),
      });
    }
    // The playing one first; otherwise playerctl's order.
    return out.sort((a, b) => Number(b.status === "Playing") - Number(a.status === "Playing"));
  }

  /** A cover's id: a short hash of where it lives; the bytes are fetched apart (art()). */
  private artIdOf(url: string): string | null {
    if (!/^https?:\/\//.test(url) && !url.startsWith("file://")) return null;
    const id = createHash("sha256").update(url).digest("base64url").slice(0, 16);
    if (this.artUrls.size > 64) this.artUrls.clear();
    this.artUrls.set(id, url);
    return id;
  }

  /**
   * A cover by id, always as a small data: URL the phone shows as is (never a
   * URL it would fetch itself, in the clear): scaled to 192 px when ffmpeg can,
   * else the original (at most 256 KB). Kept, at most 32.
   */
  async art(id: string): Promise<string | null> {
    const url = this.artUrls.get(id);
    if (!url) return null;
    if (this.art_.has(id)) return this.art_.get(id) ?? null;
    let source: string;
    const remote = /^https?:\/\//.test(url);
    if (remote) source = url;
    else {
      try {
        source = fileURLToPath(url);
      } catch {
        return null;
      }
    }
    let bytes = (await this.host.cover?.(source).catch(() => null)) ?? null;
    let mime = "image/jpeg";
    if (!bytes) {
      bytes = remote
        ? ((await this.host.fetchArt?.(url).catch(() => null)) ?? null)
        : await this.host.art(source);
      mime =
        bytes?.[0] === 0x89
          ? "image/png"
          : bytes?.subarray(0, 4).toString() === "RIFF"
            ? "image/webp"
            : "image/jpeg";
    }
    const value = bytes ? `data:${mime};base64,${bytes.toString("base64")}` : null;
    if (this.art_.size > 32) this.art_.clear();
    this.art_.set(id, value);
    return value;
  }

  private async volumeNow(): Promise<Media["volume"]> {
    const r = await this.host.run("wpctl", ["get-volume", "@DEFAULT_AUDIO_SINK@"]);
    const m = /Volume:\s*([\d.]+)(.*MUTED)?/.exec(r.out);
    if (r.code !== 0 || !m) return null;
    return { percent: Math.round(Number(m[1]) * 100), muted: Boolean(m[2]) };
  }

  private async brightnessNow(): Promise<number | null> {
    const r = await this.host.run("brightnessctl", ["-m", "-c", "backlight", "info"]);
    const percent = r.out.split("\n")[0]?.split(",")[3];
    if (r.code !== 0 || !percent) return null;
    return Number.parseInt(percent, 10);
  }

  async get(): Promise<Media> {
    const [players, volume, brightness] = await Promise.all([
      this.players(),
      this.volumeNow(),
      this.brightnessNow(),
    ]);
    return { players, volume, brightness };
  }

  private async pick(player: string | null): Promise<Player> {
    const players = await this.players();
    const p = player === null ? players[0] : players.find((x) => x.id === player);
    if (!p)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: player === null ? "nothing is playing" : `no player called ${player}`,
      });
    return p;
  }

  private async must(cmd: string, args: string[]): Promise<void> {
    const r = await this.host.run(cmd, args);
    if (r.code !== 0)
      throw new TRPCError({
        code: r.code === 127 ? "NOT_IMPLEMENTED" : "INTERNAL_SERVER_ERROR",
        message: r.code === 127 ? `${cmd} isn't installed` : `${cmd} failed`,
      });
  }

  async control(player: string | null, action: MediaAction): Promise<Done<null>> {
    const p = await this.pick(player);
    await this.must("playerctl", ["-p", p.id, action]);
    this.poke();
    const what = p.title ? ` (${p.title})` : "";
    // Playing and pausing undo each other; skipping and stopping can't be taken back exactly.
    const back: MediaAction | null =
      action === "play-pause"
        ? "play-pause"
        : action === "play"
          ? p.status === "Playing"
            ? null
            : "pause"
          : action === "pause"
            ? p.status === "Playing"
              ? "play"
              : null
            : null;
    return {
      value: null,
      summary: `${VERBS[action]} ${p.name}${what}`,
      ...(back ? { undo: { kind: "media.control", data: { player: p.id, action: back } } } : {}),
    };
  }

  async seek(player: string | null, position: number): Promise<Done<null>> {
    const p = await this.pick(player);
    await this.must("playerctl", ["-p", p.id, "position", String(position / 1000)]);
    this.poke();
    return {
      value: null,
      summary: `Moved ${p.name} to ${clock(position)}`,
      ...(p.position !== null
        ? { undo: { kind: "media.seek", data: { player: p.id, position: p.position } } }
        : {}),
    };
  }

  async volume(change: { percent?: number; muted?: boolean }): Promise<Done<null>> {
    const before = await this.volumeNow();
    if (!before)
      throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "no volume control (wpctl)" });
    const parts: string[] = [];
    if (change.percent !== undefined) {
      const v = Math.max(0, Math.min(100, Math.round(change.percent)));
      await this.must("wpctl", ["set-volume", "@DEFAULT_AUDIO_SINK@", (v / 100).toFixed(2)]);
      parts.push(`volume to ${v}%`);
    }
    if (change.muted !== undefined) {
      await this.must("wpctl", ["set-mute", "@DEFAULT_AUDIO_SINK@", change.muted ? "1" : "0"]);
      parts.push(change.muted ? "muted" : "unmuted");
    }
    this.poke();
    const summary = parts.join(", ");
    return {
      value: null,
      summary: summary.startsWith("volume") ? `Set the ${summary}` : `Sound ${summary}`,
      undo: { kind: "media.volume", data: { ...before } },
    };
  }

  async brightness(percent: number): Promise<Done<null>> {
    const before = await this.brightnessNow();
    if (before === null)
      throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "no backlight here" });
    // Never all the way off: a black screen you can't see to fix.
    const v = Math.max(1, Math.min(100, Math.round(percent)));
    await this.must("brightnessctl", ["-q", "-c", "backlight", "set", `${v}%`]);
    this.poke();
    return {
      value: null,
      summary: `Set the screen's brightness to ${v}%`,
      undo: { kind: "media.brightness", data: { percent: before } },
    };
  }

  async undo(kind: string, d: Record<string, unknown>): Promise<Done<null>> {
    if (kind === "media.control")
      return this.control(String(d.player), String(d.action) as MediaAction);
    if (kind === "media.seek") return this.seek(String(d.player), Number(d.position));
    if (kind === "media.volume")
      return this.volume({ percent: Number(d.percent), muted: Boolean(d.muted) });
    if (kind === "media.brightness") return this.brightness(Number(d.percent));
    throw new TRPCError({ code: "BAD_REQUEST", message: `can't undo ${kind}` });
  }

  // ---------------------------------------------------------- watching
  /** Positions move on by themselves; a change is anything else. */
  private static shape(m: Media): string {
    return JSON.stringify({ ...m, players: m.players.map(({ position: _, at: __, ...p }) => p) });
  }

  /** Reads the parts marked dirty (all of them the first time) and tells watchers of a change. */
  private flush(): Promise<void> {
    if (this.flushing) {
      // One more look once this one is done, for what changed meanwhile.
      return this.flushing.then(() => (this.dirty.size || this.forced ? this.flush() : undefined));
    }
    this.flushing = (async () => {
      if (!this.listeners.size) return;
      const parts = this.current ? [...this.dirty] : [...PARTS];
      this.dirty.clear();
      const force = this.forced;
      this.forced = false;
      if (!parts.length && !force) return;
      const m: Media = this.current
        ? { ...this.current }
        : { players: [], volume: null, brightness: null };
      // Vyom's state when it's followed (two small files, no command), except
      // after a change of ours: then straight from the source.
      const vyom =
        this.viaVyom && !force && (parts.includes("volume") || parts.includes("brightness"))
          ? await this.host.vyom?.read().catch(() => null)
          : undefined;
      if (vyom === null) this.checkVyom(); // it stopped publishing them: follow them here
      if (vyom) {
        if (parts.includes("volume")) m.volume = vyom.volume;
        if (parts.includes("brightness")) m.brightness = vyom.brightness;
      }
      await Promise.all([
        parts.includes("players") ? this.players().then((v) => (m.players = v)) : null,
        parts.includes("volume") && !vyom ? this.volumeNow().then((v) => (m.volume = v)) : null,
        parts.includes("brightness") && !vyom
          ? this.brightnessNow().then((v) => (m.brightness = v))
          : null,
      ]);
      this.current = m;
      const shape = MediaService.shape(m);
      if (!force && shape === this.last) return;
      this.last = shape;
      for (const cb of this.listeners) cb(m);
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private mark(parts: readonly Part[], force = false, now = false): void {
    for (const p of parts) this.dirty.add(p);
    if (force) this.forced = true;
    if (now) void this.flush().catch(() => undefined);
    else this.kick();
  }

  /** After a change of ours: tell watchers now, positions included. */
  private poke(): void {
    setTimeout(() => this.mark(PARTS, true, true), 150);
  }

  /** A part is polled when nothing reports its changes and it's there to report. */
  private needsPoll(part: Part): boolean {
    if (this.live.has(part)) return false;
    return part === "players" || (this.current?.[part] ?? null) !== null;
  }

  private planPoll(): void {
    const want = this.listeners.size > 0 && PARTS.some((p) => this.needsPoll(p));
    if (want && !this.timer) {
      this.timer = setInterval(
        () =>
          this.mark(
            PARTS.filter((p) => this.needsPoll(p)),
            false,
            true,
          ),
        this.everyMs,
      );
      this.timer.unref?.();
    } else if (!want && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Starts an event source for a part (a long-lived helper read line by line). */
  private source(part: Part, cmd: string, args: string[], seen: (line: string) => void): void {
    const spawn = this.host.spawn;
    if (!spawn || this.sources.has(part)) return;
    const child = new LineChild({
      cmd,
      args,
      spawn,
      onLine: seen,
      onStart: () => {
        this.live.add(part);
        this.planPoll();
        if (part === "players") this.checkVyom(); // Vyom's signals come through this one
      },
      onExit: () => {
        // Whatever changed while it was gone (Vyom's signals come through the players' one).
        this.live.delete(part);
        this.mark(part === "players" && this.viaVyom ? PARTS : [part]);
        this.planPoll();
      },
      onDown: () => {
        this.live.delete(part);
        this.sources.delete(part);
        if (part === "players") this.checkVyom();
        this.planPoll();
      },
    });
    this.sources.set(part, child);
    child.start();
  }

  /** Our own watchers of the volume and the backlight (without Vyom). */
  private ownSources(): void {
    const first = this.first;
    if (!first || !this.listeners.size) return;
    if (first.volume)
      this.source("volume", "pactl", ["subscribe"], (line) => {
        if (/^Event '(new|change|remove)' on (sink|server)( #|$)/.test(line)) this.mark(["volume"]);
      });
    if (first.brightness !== null)
      this.source(
        "brightness",
        "udevadm",
        ["monitor", "--udev", "--subsystem-match=backlight"],
        (line) => {
          if (/^(UDEV|KERNEL)\s*\[.*\bchange\b/.test(line)) this.mark(["brightness"]);
        },
      );
  }

  /**
   * Follows the volume and the backlight through Vyom's state when Vyom runs
   * and publishes them (and the players' dbus-monitor, which carries its
   * signals, is up), else with our own watchers. Asked again when Vyom (or a
   * player) comes or goes, and when Vyom's state stops being usable.
   */
  private checkVyom(): void {
    if (this.checking) {
      this.recheck = true;
      return;
    }
    const vyom = this.host.vyom;
    this.checking = (async () => {
      const usable =
        !!vyom &&
        this.live.has("players") &&
        (await vyom.running().catch(() => false)) &&
        (await vyom.read().catch(() => null)) !== null;
      if (!this.listeners.size) return;
      if (usable && !this.viaVyom) {
        this.viaVyom = true;
        for (const part of ["volume", "brightness"] as const) {
          this.sources.get(part)?.stop();
          this.sources.delete(part);
          this.live.add(part);
        }
        this.mark(["volume", "brightness"]);
      } else if (!usable) {
        if (this.viaVyom) {
          this.viaVyom = false;
          this.live.delete("volume");
          this.live.delete("brightness");
          this.mark(["volume", "brightness"]);
        }
        this.ownSources();
      }
      this.planPoll();
    })().finally(() => {
      this.checking = null;
      if (this.recheck) {
        this.recheck = false;
        this.checkVyom();
      }
    });
  }

  /** Starts the event sources: MPRIS signals (and Vyom's), then the volume's and the backlight's. */
  private watch(first: Media): void {
    this.first = first;
    if (this.host.spawn) {
      this.source("players", "dbus-monitor", DBUS_ARGS, (line) => {
        const f = line.split("\t");
        const member = f[7];
        if (f[5] === VYOM_STATE_PATH) {
          if (this.viaVyom) this.mark(["volume", "brightness"]);
          else this.checkVyom(); // a Vyom (re)started: it publishes everything fresh
        } else if (member === "Seeked") this.mark(["players"], true);
        else if (member === "NameOwnerChanged") {
          this.mark(["players"]);
          if (this.host.vyom) this.checkVyom(); // a player's, or Vyom coming or going
        } else if (member === "PropertiesChanged") this.mark(["players"]);
      });
      // Without a way to follow Vyom, our own at once; else checkVyom (when
      // dbus-monitor is up) picks one or the other.
      if (!this.host.vyom) this.ownSources();
      this.safety = setInterval(() => this.mark(PARTS), SAFETY_MS);
      this.safety.unref?.();
    }
    this.planPoll();
  }

  private unwatch(): void {
    for (const s of this.sources.values()) s.stop();
    this.sources.clear();
    this.live.clear();
    this.dirty.clear();
    this.kick.cancel();
    if (this.timer) clearInterval(this.timer);
    if (this.safety) clearInterval(this.safety);
    this.timer = null;
    this.safety = null;
    this.current = null;
    this.first = null;
    this.viaVyom = false;
  }

  /** How each part is watched right now (for tests). */
  get watching(): Record<Part, "events" | "vyom" | "polling" | "idle"> {
    const of = (p: Part) =>
      this.viaVyom && p !== "players"
        ? "vyom"
        : this.live.has(p)
          ? "events"
          : this.timer && this.needsPoll(p)
            ? "polling"
            : "idle";
    return { players: of("players"), volume: of("volume"), brightness: of("brightness") };
  }

  async *changes(signal: AbortSignal | undefined): AsyncGenerator<Media> {
    const first = await this.get();
    const queue: Media[] = [first];
    let wake: (() => void) | null = null;
    const cb = (m: Media) => {
      queue.push(m);
      wake?.();
    };
    this.listeners.add(cb);
    if (this.listeners.size === 1) {
      this.last = MediaService.shape(first);
      this.current = first;
      this.watch(first);
    }
    try {
      while (!signal?.aborted) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((res) => {
          wake = res;
          signal?.addEventListener("abort", () => res(), { once: true });
        });
      }
    } finally {
      this.listeners.delete(cb);
      if (!this.listeners.size) this.unwatch();
    }
  }

  stop(): void {
    this.listeners.clear();
    this.unwatch();
  }
}

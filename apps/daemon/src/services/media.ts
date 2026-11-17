/**
 * What's playing, the volume and the screen's brightness: any MPRIS player
 * (nāda, drishya, browsers, mpv) through playerctl, the volume through
 * wpctl (PipeWire), the backlight through brightnessctl. Missing tools just
 * leave their part empty.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Done, Media, MediaAction, Player } from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";
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
}

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
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = "";

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

  private async tick(force = false): Promise<void> {
    if (!this.listeners.size) return;
    const m = await this.get();
    const shape = MediaService.shape(m);
    if (!force && shape === this.last) return;
    this.last = shape;
    for (const cb of this.listeners) cb(m);
  }

  /** After a change of ours: tell watchers now, positions included. */
  private poke(): void {
    setTimeout(() => void this.tick(true).catch(() => undefined), 150);
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
    if (this.listeners.size === 1) this.last = MediaService.shape(first);
    this.timer ??= setInterval(() => void this.tick().catch(() => undefined), this.everyMs);
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
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

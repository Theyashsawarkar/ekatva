/**
 * One clipboard across the laptop and the phone, when you turn it on (from
 * either). The laptop's side: watch its clipboard and hand each change to
 * the connected phones. The phone sends its own changes (while ekatva is
 * open: Android keeps the clipboard from apps in the background).
 *
 * Watching is event-driven where it can be: one `wl-paste --watch` child
 * that the compositor wakes on each copy, and only while sync is on and a
 * phone is connected. Without wl-paste or a Wayland display it looks every
 * 1.5 s instead, as it always did.
 *
 * What came from the phone is remembered (by hash), so it isn't bounced back.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { LineChild, type Spawn } from "./lineChild.js";

/** Something that says "the clipboard changed" (`wl-paste --watch`). */
export interface ClipboardEvents {
  /** Starts watching; `down` when it can't (then the caller polls). */
  start(changed: () => void, down: () => void): void;
  stop(): void;
}

/**
 * The compositor's clipboard events: `wl-paste --watch` runs a tiny helper
 * on each change, which prints a line (the content itself is read apart,
 * the way it always was, with the same choice of type). Null when there's
 * no Wayland display to watch.
 */
export function wlPasteEvents(
  env: NodeJS.ProcessEnv = process.env,
  spawn?: Spawn,
): ClipboardEvents | null {
  if (!env.WAYLAND_DISPLAY) return null;
  let child: LineChild | null = null;
  return {
    start(changed, down) {
      child?.stop();
      child = new LineChild({
        cmd: "wl-paste",
        args: ["--watch", "sh", "-c", "cat >/dev/null; echo changed"],
        ...(spawn ? { spawn } : {}),
        onLine: (l) => {
          if (l.trim() === "changed") changed();
        },
        onDown: down,
      });
      child.start();
    },
    stop() {
      child?.stop();
      child = null;
    },
  };
}

const hash = (text: string) => createHash("sha256").update(text).digest("base64url");

export class ClipboardSync {
  private on = false;
  /** The hash of what the phones have (or what they gave us). */
  private last: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  /** A change came in while looking: look once more after. */
  private again = false;
  private started = false;
  private watching = false;
  /** The event source failed: poll from now on. */
  private polling: boolean;
  private listeners = new Set<(on: boolean) => void>();

  constructor(
    private readonly file: string | null,
    /** The laptop's clipboard, now. */
    private readonly read: () => Promise<string>,
    /** Hand text to every connected phone that may receive it. */
    private readonly push: (text: string) => Promise<void>,
    /** Any phone connected (no reason to watch otherwise). */
    private readonly anyone: () => boolean,
    private readonly everyMs = 1500,
    /** Clipboard events; null polls every `everyMs`. */
    private readonly events: ClipboardEvents | null = null,
  ) {
    this.polling = events === null;
    try {
      if (file) this.on = JSON.parse(readFileSync(file, "utf8")).on === true;
    } catch {
      // off until turned on
    }
  }

  get enabled(): boolean {
    return this.on;
  }

  /** How it watches right now, for tests. */
  get mode(): "events" | "polling" | "idle" {
    return this.timer ? "polling" : this.watching ? "events" : "idle";
  }

  /** Turns it on or off; turning it on sends the laptop's clipboard to the phone first. */
  set(on: boolean): void {
    this.on = on;
    this.last = null;
    try {
      if (this.file) writeFileSync(this.file, JSON.stringify({ on }), { mode: 0o600 });
    } catch {
      // still on (or off) until the daemon restarts
    }
    for (const cb of this.listeners) cb(on);
    this.update();
    if (on) void this.tick();
  }

  onChange(cb: (on: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The phone set the laptop's clipboard to this: not news to send back. */
  heard(text: string): void {
    this.last = hash(text);
  }

  start(): void {
    this.started = true;
    this.update();
  }

  stop(): void {
    this.started = false;
    this.update();
  }

  /**
   * Watches only while it's on and a phone is connected; call it when either
   * may have changed (a phone came or went).
   */
  update(): void {
    const want = this.started && this.on && this.anyone();
    if (!want) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (this.watching) this.events?.stop();
      this.watching = false;
      return;
    }
    if (this.polling) {
      if (this.watching) this.events?.stop();
      this.watching = false;
      if (!this.timer) {
        this.timer = setInterval(() => void this.tick(), this.everyMs);
        this.timer.unref?.();
      }
      return;
    }
    if (this.watching) return;
    this.watching = true;
    // wl-paste --watch reports the clipboard as it is when it starts, too.
    this.events?.start(
      () => void this.tick(),
      () => {
        this.polling = true;
        this.watching = false;
        this.update();
      },
    );
  }

  /** Looks at the clipboard; a change that comes while it looks gets one more look. */
  tick(): Promise<void> {
    if (this.inflight) {
      this.again = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      do {
        this.again = false;
        await this.once();
      } while (this.again);
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async once(): Promise<void> {
    if (!this.on || !this.anyone()) return;
    try {
      const text = await this.read();
      const h = hash(text);
      if (h === this.last) return;
      this.last = h;
      if (text) await this.push(text);
    } catch {
      // the clipboard or a phone went away: next time
    }
  }
}

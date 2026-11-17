/**
 * One clipboard across the laptop and the phone, when you turn it on (from
 * either). The laptop's side: watch its clipboard and hand each change to
 * the connected phones. The phone sends its own changes (while ekatva is
 * open: Android keeps the clipboard from apps in the background).
 *
 * What came from the phone is remembered, so it isn't bounced back.
 */
import { readFileSync, writeFileSync } from "node:fs";

export class ClipboardSync {
  private on = false;
  private last: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
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
  ) {
    try {
      if (file) this.on = JSON.parse(readFileSync(file, "utf8")).on === true;
    } catch {
      // off until turned on
    }
  }

  get enabled(): boolean {
    return this.on;
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
    if (on) void this.tick();
  }

  onChange(cb: (on: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** The phone set the laptop's clipboard to this: not news to send back. */
  heard(text: string): void {
    this.last = text;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (!this.on || this.busy || !this.anyone()) return;
    this.busy = true;
    try {
      const text = await this.read();
      if (text === this.last) return;
      this.last = text;
      if (text) await this.push(text);
    } catch {
      // the clipboard or a phone went away: next time
    } finally {
      this.busy = false;
    }
  }
}

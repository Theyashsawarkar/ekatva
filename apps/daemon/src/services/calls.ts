/**
 * The phone's call right now, from the call events it reports: what the
 * laptop's window shows as "Rupali is calling" and the timer of a call in
 * progress. Nothing is kept once the call ends.
 */
import type { CallNow, PhoneEvent } from "@ekatva/protocol";

type CallEvent = Extract<PhoneEvent, { kind: "call" }>;

export class CallState {
  private now: CallNow | null = null;
  private listeners = new Set<(c: CallNow | null) => void>();

  constructor(private clock: () => number = Date.now) {}

  get(): CallNow | null {
    return this.now;
  }

  /** A call event from a phone; anything else is ignored. */
  onEvent(device: string, name: string, e: CallEvent): void {
    let next: CallNow | null;
    if (e.state === "ringing" || e.state === "active") {
      const same = this.now?.device === device;
      next = {
        device,
        name,
        state: e.state,
        // Android leaves the number out of the "answered" event: keep the one we had.
        number: e.number || (same ? (this.now?.number ?? "") : ""),
        contact: e.contact ?? (same ? (this.now?.contact ?? null) : null),
        // The timer starts when it's answered, not when it began to ring.
        since:
          same && this.now?.state === e.state ? (this.now?.since ?? this.clock()) : this.clock(),
        app: null,
        video: false,
      };
    } else {
      // Ended or missed: only that phone's call is over.
      if (this.now && this.now.device !== device) return;
      next = null;
    }
    this.set(next);
  }

  /** How to end an app's call: its notification's hang-up button. */
  private hang: { device: string; id: string; index: number } | null = null;

  /**
   * An app's call (WhatsApp voice or video, Meet…), from its notification:
   * ringing while it offers Answer, going on once it doesn't, over when the
   * notification goes. `hangup` is the button that ends it, if any.
   */
  onApp(
    device: string,
    name: string,
    app: string,
    id: string,
    state: "ringing" | "active" | "ended",
    contact: string,
    hangup: number,
    video = false,
  ): void {
    const mine = this.now?.device === device && this.now?.app === app;
    if (state === "ended") {
      if (mine) {
        this.hang = null;
        this.set(null);
      }
      return;
    }
    // The phone's own call wins: an app's ringing doesn't replace it.
    if (this.now && !mine && this.now.app === null) return;
    this.hang = hangup !== -99 ? { device, id, index: hangup } : null; // -99: none
    this.set({
      device,
      name,
      state,
      number: "",
      contact: contact || (mine ? (this.now?.contact ?? null) : null),
      since: mine && this.now?.state === state ? (this.now?.since ?? this.clock()) : this.clock(),
      app,
      video: video || (mine && (this.now?.video ?? false)),
    });
  }

  /** The button that ends the call now, when it's an app's. */
  hangupButton(): { device: string; id: string; index: number } | null {
    return this.now?.app ? this.hang : null;
  }

  /** The phone went away: its call can't be followed any more. */
  forget(device: string): void {
    if (this.now?.device === device) this.set(null);
  }

  private set(next: CallNow | null): void {
    this.now = next;
    for (const cb of this.listeners) cb(next);
  }

  async *changes(signal: AbortSignal | undefined): AsyncGenerator<CallNow | null> {
    const queue: (CallNow | null)[] = [this.now];
    let wake: (() => void) | null = null;
    const cb = (c: CallNow | null) => {
      queue.push(c);
      wake?.();
    };
    this.listeners.add(cb);
    try {
      while (!signal?.aborted) {
        if (queue.length) {
          yield queue.shift() ?? null;
          continue;
        }
        await new Promise<void>((res) => {
          wake = res;
          signal?.addEventListener("abort", () => res(), { once: true });
        });
      }
    } finally {
      this.listeners.delete(cb);
    }
  }
}

/** How long a call has gone on, as the bar says it: 45s, 12m, 1h 20m. */
export function callFor(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

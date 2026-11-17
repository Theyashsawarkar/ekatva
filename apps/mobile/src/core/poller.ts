/**
 * Asking the laptop something again and again, without hurting: one
 * request at a time (a tick is skipped while the last one is still out), a
 * longer wait after each failure (back to normal after a success), nothing
 * while the app isn't in front, and a fresh ask as soon as it is again.
 * Plain timers, no React, so it can be tested.
 */
export interface PollerOptions<T> {
  /** The request; null when it can't be made now (no connection): skipped. */
  load: () => Promise<T> | null;
  ms: number;
  onData: (d: T) => void;
  onError: (e: unknown) => void;
  /** Is the app in front? While not, nothing is asked. */
  active: () => boolean;
  /** The longest wait after repeated failures. */
  maxBackoffMs?: number;
  /** A request still out after this long counts as failed (a dead link never answers). */
  timeoutMs?: number;
}

export interface Poller {
  /** Ask now (unless a request is out), and keep going. */
  kick(): void;
  stop(): void;
}

export function startPoller<T>(o: PollerOptions<T>): Poller {
  let stopped = false;
  let pending = false;
  let again = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const max = o.maxBackoffMs ?? 60_000;

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    const wait = failures ? Math.min(max, o.ms * 2 ** Math.min(failures, 6)) : o.ms;
    timer = setTimeout(run, wait);
  };
  const run = () => {
    timer = null;
    if (stopped) return;
    if (pending || !o.active()) return schedule();
    const req = o.load();
    if (!req) return schedule();
    pending = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const limit = o.timeoutMs ?? Math.max(10_000, o.ms * 3);
    const p = Promise.race([
      req,
      new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new Error("The laptop didn't answer")), limit);
      }),
    ]);
    p.then(
      (d) => {
        failures = 0;
        if (!stopped) o.onData(d);
      },
      (e: unknown) => {
        failures++;
        if (!stopped) o.onError(e);
      },
    ).finally(() => {
      if (t) clearTimeout(t);
      pending = false;
      // Asked for again while this one was out (after a change): now, not later.
      if (again) {
        again = false;
        run();
      } else schedule();
    });
  };
  run();
  return {
    kick() {
      if (stopped) return;
      if (pending) {
        again = true;
        return;
      }
      if (timer) clearTimeout(timer);
      run();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

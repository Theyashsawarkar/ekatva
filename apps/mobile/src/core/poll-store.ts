/**
 * Polls shared by key. Several screens asking the laptop the same thing
 * (`agents.list` for the tab's badge, Home and Agents) make one request per
 * interval between them, and all of them get the answer. An answer that
 * says the same as the last one is dropped (`same`), so nothing re-renders.
 * Asked only while at least one subscriber is active (its screen in focus,
 * the app in front). The last answer stays after everyone leaves, so a
 * screen that comes back shows it at once and refreshes. Plain timers, no
 * React, so it can be tested.
 *
 * A key can also be watched: the laptop pushes each change over a shared
 * subscription (agents.watch, media.watch…), held only while a subscriber is
 * active; meanwhile the poll slows to a fallback every WATCH_FALLBACK_MS.
 */
import { same } from "./equal";
import { type Poller, startPoller } from "./poller";

export interface Snapshot<T> {
  data: T | null;
  error: string | null;
}

/** Pushes each new value; returns how to stop, or null when it can't start now (no link). */
export type Watch<T> = (
  onData: (d: T) => void,
  onError: (e: unknown) => void,
) => (() => void) | null;

/** While a key is watched, its poll asks only this often (a safety net). */
export const WATCH_FALLBACK_MS = 30_000;

interface Sub {
  ms: number;
  active: () => boolean;
  onChange: () => void;
  /** Satisfied by the push while it runs. */
  watched: boolean;
}

interface Entry<T> {
  load: () => Promise<T> | null;
  watch: Watch<T> | null;
  /** Stops the running push, if one runs. */
  unwatch: (() => void) | null;
  equal: (a: T | null, b: T) => boolean;
  subs: Set<Sub>;
  poller: Poller | null;
  ms: number;
  snap: Snapshot<T>;
  lastAsked: number;
}

const entries = new Map<string, Entry<unknown>>();
/** Keys of polls that belong to one screen, not shared. */
export const PRIVATE = "~";
/** The last answers kept for screens that come back; beyond this, the oldest unused go. */
const KEEP = 64;

export interface Subscription<T> {
  get(): Snapshot<T>;
  /** The query changed (a new connection): use this one (and push) from now on and ask now. */
  setLoad(load: () => Promise<T> | null, watch?: Watch<T> | null): void;
  /** Ask now (a change was made, the screen came back). */
  kick(): void;
  /** Focus or the app's state changed: start or stop the push. */
  sync(): void;
  unsubscribe(): void;
}

export function subscribePoll<T>(
  key: string,
  load: () => Promise<T> | null,
  ms: number,
  active: () => boolean,
  onChange: () => void,
  errorText: (e: unknown) => string,
  opts: { watch?: Watch<T> | null; equal?: (a: T | null, b: T) => boolean } = {},
): Subscription<T> {
  let e = entries.get(key) as Entry<T> | undefined;
  if (!e) {
    e = {
      load,
      watch: null,
      unwatch: null,
      equal: same,
      subs: new Set(),
      poller: null,
      ms,
      snap: { data: null, error: null },
      lastAsked: 0,
    };
    entries.set(key, e as Entry<unknown>);
  }
  const entry = e;
  entry.load = load;
  if (opts.equal) entry.equal = opts.equal;
  if (opts.watch !== undefined) entry.watch = opts.watch;
  const sub: Sub = { ms, active, onChange, watched: !!opts.watch };
  entry.subs.add(sub);

  const notify = () => {
    for (const s of entry.subs) s.onChange();
  };
  const take = (d: T) => {
    const eq = entry.snap.data !== null && entry.equal(entry.snap.data, d);
    if (eq && entry.snap.error === null) return;
    // Keep the old reference when only the error cleared.
    entry.snap = { data: eq ? entry.snap.data : d, error: null };
    notify();
  };
  const fail = (err: unknown) => {
    const error = errorText(err);
    if (entry.snap.error === error) return;
    entry.snap = { data: entry.snap.data, error };
    notify();
  };
  const anyActive = () => [...entry.subs].some((s) => s.active());
  /** Holds the push while someone is looking, drops it otherwise. */
  const sync = () => {
    const want = !!entry.watch && anyActive();
    if (want && !entry.unwatch) {
      try {
        entry.unwatch = entry.watch?.(take, fail) ?? null;
      } catch (err) {
        fail(err);
      }
    } else if (!want && entry.unwatch) {
      entry.unwatch();
      entry.unwatch = null;
    }
  };
  const restart = () => {
    entry.poller?.stop();
    entry.ms = Math.min(...[...entry.subs].map((s) => s.ms));
    entry.poller = startPoller<T>({
      load: () => {
        entry.lastAsked = Date.now();
        return entry.load();
      },
      ms: entry.ms,
      active: () => {
        sync();
        const live = [...entry.subs].filter((s) => s.active());
        if (!live.length) return false;
        // Pushed: only screens without the push keep the fast pace; else a slow safety net.
        if (entry.unwatch && live.every((s) => s.watched))
          return Date.now() - entry.lastAsked >= WATCH_FALLBACK_MS;
        return true;
      },
      onData: take,
      onError: fail,
    });
  };
  // A faster subscriber, or the first one: (re)start at the fastest interval.
  // Otherwise it joins the running poll: the answer it has, and the next one.
  if (!entry.poller || ms < entry.ms) restart();
  sync();

  return {
    get: () => entry.snap,
    setLoad(l, w) {
      entry.load = l;
      if (w !== undefined && w !== entry.watch) {
        // A new connection: a new push on it.
        entry.unwatch?.();
        entry.unwatch = null;
        entry.watch = w;
      }
      sync();
      entry.poller?.kick();
    },
    kick() {
      sync();
      entry.poller?.kick();
    },
    sync,
    unsubscribe() {
      entry.subs.delete(sub);
      if (entry.subs.size === 0) {
        entry.poller?.stop();
        entry.poller = null;
        entry.unwatch?.();
        entry.unwatch = null;
        // A screen's own poll (no shared key) isn't worth keeping.
        if (key.startsWith(PRIVATE)) entries.delete(key);
        else trim();
      } else {
        sync();
        if (ms === entry.ms) restart(); // maybe slower now
      }
    },
  };
}

function trim() {
  if (entries.size <= KEEP) return;
  for (const [key, e] of entries) {
    if (entries.size <= KEEP) break;
    if (e.subs.size === 0) entries.delete(key);
  }
}

/** For tests: forget every entry. */
export function resetPolls(): void {
  for (const e of entries.values()) {
    e.poller?.stop();
    e.unwatch?.();
  }
  entries.clear();
}

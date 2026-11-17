/**
 * Which finished agents you've looked at, so a finish says "new" once and
 * then stops asking for you. Kept per finish: a session that finishes again
 * is new again.
 */
import { useSyncExternalStore } from "react";
import type { KV } from "../core/kv";

const KEY = "ekatva.agents.seen";
let seen: Record<string, number> = {};
let loaded: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(kv: KV): Promise<void> {
  loaded ??= kv
    .get(KEY)
    .then((raw) => {
      seen = raw ? JSON.parse(raw) : {};
      for (const cb of listeners) cb();
    })
    .catch(() => undefined);
  return loaded;
}

/** You opened it: this finish (`since`) is no longer new. */
export async function markSeen(kv: KV, id: string, since: number): Promise<void> {
  await load(kv);
  if (seen[id] === since) return;
  seen = { ...seen, [id]: since };
  // Only the latest few hundred are worth keeping.
  const keys = Object.keys(seen);
  if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete seen[k];
  for (const cb of listeners) cb();
  await kv.set(KEY, JSON.stringify(seen)).catch(() => undefined);
}

/** A finished session you haven't opened since it finished. */
export function useUnseen(
  kv: KV | null,
): (a: { id: string; state: string; since: number }) => boolean {
  if (kv) void load(kv);
  const snap = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => seen,
  );
  return (a) => a.state === "done" && snap[a.id] !== a.since;
}

/**
 * Covers, fetched once by id and kept: the laptop sends each player's
 * `artId` on every poll, and the bytes only when asked (`media.art`). A
 * small LRU of recent covers, so the image's uri stays the same while a
 * song plays and nothing is read twice.
 */
import { useEffect, useState } from "react";
import type { Client } from "./parts";

const MAX = 8;
const cache = new Map<string, string | null>();
const pending = new Map<string, Promise<string | null>>();

function remember(id: string, uri: string | null) {
  cache.delete(id);
  cache.set(id, uri);
  while (cache.size > MAX) cache.delete(cache.keys().next().value as string);
}

/** The cover for `id` (null while it loads, or when there's none). */
export function useArt(id: string | null | undefined, client: Client | null | undefined) {
  const [uri, setUri] = useState<string | null>(() => (id ? (cache.get(id) ?? null) : null));
  useEffect(() => {
    if (!id) {
      setUri(null);
      return;
    }
    if (cache.has(id)) {
      setUri(cache.get(id) ?? null);
      return;
    }
    if (!client) return;
    let live = true;
    let p = pending.get(id);
    if (!p) {
      p = client.media.art
        .query({ id })
        // Only an image the laptop sent itself: never a URL this phone would fetch in the clear.
        .then((u) => (u && /^(data:image\/|https:)/.test(u) ? u : null))
        .catch(() => null)
        .finally(() => pending.delete(id));
      pending.set(id, p);
    }
    void p.then((u) => {
      remember(id, u);
      if (live) setUri(u);
    });
    return () => {
      live = false;
    };
  }, [id, client]);
  return uri;
}

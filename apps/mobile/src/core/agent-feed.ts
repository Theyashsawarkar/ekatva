/**
 * An agent's history as the phone holds it: the latest items, pushed as they
 * come, and older pages in front as you scroll up. Pure.
 */
import type { AgentItem, AgentPage, AgentUpdate } from "@ekatva/protocol";

export interface Feed {
  epoch: string;
  total: number;
  /** Consecutive, oldest first. */
  items: AgentItem[];
  queued: string[];
  status: string | null;
}

/** What's drawn: an item, or a run of tool calls folded into one row. */
export type Row =
  | { kind: "item"; key: string; item: Exclude<AgentItem, { kind: "tool" }> }
  | { kind: "steps"; key: string; items: Extract<AgentItem, { kind: "tool" }>[] };

/** A push: the same history goes on (older pages kept), else it starts over. */
export function applyUpdate(feed: Feed | null, u: AgentUpdate): Feed {
  const rest = { epoch: u.epoch, total: u.total, queued: u.queued, status: u.status };
  const first = feed?.items[0]?.n ?? 0;
  const next = first + (feed?.items.length ?? 0);
  const from = u.items[0]?.n ?? next;
  // A gap (away for long), another session, or a rewind: only what came now.
  if (
    !feed ||
    feed.epoch !== u.epoch ||
    (u.reset && from > next) ||
    (!feed.items.length && u.reset)
  )
    return { ...rest, items: u.items };
  const items = feed.items.slice();
  for (const it of u.items) {
    const i = it.n - first;
    if (i >= 0 && i <= items.length) items[i] = it;
  }
  return { ...rest, items };
}

/** An older page, in front. */
export function prepend(feed: Feed, page: AgentPage): Feed {
  const first = feed.items[0]?.n ?? 0;
  if (page.epoch !== feed.epoch) return feed;
  const older = page.items.filter((i) => i.n < first);
  if (older.at(-1)?.n !== first - 1) return feed;
  return { ...feed, items: [...older, ...feed.items] };
}

/** True when there's more above. */
export const hasOlder = (feed: Feed | null) => (feed?.items[0]?.n ?? 0) > 0;

/** The rows, newest first (the list is drawn from the bottom). */
export function rows(items: AgentItem[]): Row[] {
  const out: Row[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.kind !== "tool") out.push({ kind: "item", key: `i${item.n}`, item });
    else if (last?.kind === "steps") last.items.push(item);
    else out.push({ kind: "steps", key: `s${item.n}`, items: [item] });
  }
  // A run is keyed by its last call, which older pages don't change.
  for (const r of out) if (r.kind === "steps") r.key = `s${r.items.at(-1)?.n}`;
  return out.reverse();
}

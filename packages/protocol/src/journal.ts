/**
 * The journal: every action either device performs, in order, as a hash
 * chain, so a changed, removed or reordered entry shows.
 *
 * Each device keeps its own chain (what happened *on* it) and a mirror of
 * the other's: the two copies anchor each other, so rewriting history
 * would mean rewriting it on both devices. Entries that can be reversed
 * carry `undo`: what the device needs to put things back.
 *
 * Secrets never enter it: `redact` replaces passwords and tokens, and file
 * contents or typed text become their length.
 */
import { toB64u, utf8 } from "@ekatva/link";
import { blake2b } from "@noble/hashes/blake2.js";

export interface Actor {
  /** The device that asked: its key (base64url), or "local" for this device's own user. */
  key: string;
  name: string;
}

export interface Undo {
  /** Which undo handler knows how: "files.restore", "jyoti.set", … */
  kind: string;
  data: unknown;
}

export interface Entry {
  v: 1;
  /** Position in this chain, from 1. */
  seq: number;
  /** When, as an ISO time. */
  at: string;
  /** The device this happened on (the chain's owner), its key. */
  host: string;
  actor: Actor;
  /** The procedure: "files.write", "jyoti.set", "agents.answer". */
  action: string;
  /** One readable line: "Wrote ~/notes/todo.md (1.2 kB)". */
  summary: string;
  /** The request, redacted. */
  input: unknown;
  ok: boolean;
  error?: string;
  /** How to reverse it; absent when it can't be (a call made, an SMS sent). */
  undo?: Undo;
  /** Set on an entry that reversed entry #undoes. */
  undoes?: number;
  /** The previous entry's hash ("" for the first). */
  prev: string;
  hash: string;
}

export type Draft = Omit<Entry, "v" | "seq" | "at" | "host" | "prev" | "hash">;

/** JSON with keys in a fixed order, so both devices hash the same bytes. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function entryHash(e: Omit<Entry, "hash">): string {
  const body = utf8.encode(`ekatva/journal/1\n${e.prev}\n${canonical(e)}`);
  return toB64u(blake2b(body, { dkLen: 32 }));
}

const SECRET = /pass(word|phrase)?|secret|token|pin|otp|private|cookie|auth/i;
const BULK = /^(content|data|text|body|bytes|clipboard|reply)$/i;

/**
 * A copy of `input` safe to keep: secrets become "[redacted]", bulk
 * content (file data, typed text, the clipboard) becomes its length.
 */
export function redact(input: unknown, depth = 0): unknown {
  if (depth > 6) return "[…]";
  if (Array.isArray(input)) return input.slice(0, 50).map((v) => redact(v, depth + 1));
  if (input === null || typeof input !== "object") {
    return typeof input === "string" && input.length > 512 ? `${input.slice(0, 512)}…` : input;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET.test(k)) out[k] = "[redacted]";
    else if (BULK.test(k)) out[k] = { redacted: true, length: lengthOf(v) };
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

function lengthOf(v: unknown): number {
  if (typeof v === "string") return v.length;
  if (v instanceof Uint8Array) return v.length;
  if (Array.isArray(v)) return v.length;
  return 0;
}

/** Where a chain lives: a file on the laptop, encrypted storage on the phone. */
export interface JournalStore {
  append(e: Entry): Promise<void>;
  last(): Promise<Entry | null>;
  /** Entries with seq > after, oldest first, at most `limit`. */
  since(after: number, limit: number): Promise<Entry[]>;
  get(seq: number): Promise<Entry | null>;
}

/**
 * The index of the first entry with seq above `after`, in entries kept in
 * rising seq order (a log is appended in order): a binary search, so reading
 * a page and checking a whole chain don't grow with the square of the log.
 */
export function firstAfter(entries: readonly Entry[], after: number): number {
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((entries[mid] as Entry).seq > after) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Entries after `after`, at most `limit` of them (in rising seq order). */
export function pageAfter(entries: readonly Entry[], after: number, limit: number): Entry[] {
  const i = firstAfter(entries, after);
  return entries.slice(i, i + limit);
}

/** The entry with this seq, or null. */
export function entryAt(entries: readonly Entry[], seq: number): Entry | null {
  const e = entries[firstAfter(entries, seq - 1)];
  return e && e.seq === seq ? e : null;
}

export class MemoryStore implements JournalStore {
  entries: Entry[] = [];
  async append(e: Entry) {
    this.entries.push(e);
  }
  async last() {
    return this.entries.at(-1) ?? null;
  }
  async since(after: number, limit: number) {
    return pageAfter(this.entries, after, limit);
  }
  async get(seq: number) {
    return entryAt(this.entries, seq);
  }
}

export type Problem = { seq: number; why: string };

/** Checks a run of entries: numbering, links and hashes. */
export function verify(entries: Entry[], after: Entry | null = null): Problem | null {
  let prev = after;
  for (const e of entries) {
    const seq = (prev?.seq ?? 0) + 1;
    if (e.v !== 1) return { seq: e.seq, why: "unknown version" };
    if (e.seq !== seq) return { seq: e.seq, why: `expected #${seq}` };
    if (e.prev !== (prev?.hash ?? ""))
      return { seq: e.seq, why: "doesn't follow the previous entry" };
    if (prev && e.host !== prev.host) return { seq: e.seq, why: "another device's entry" };
    const { hash, ...rest } = e;
    if (entryHash(rest) !== hash) return { seq: e.seq, why: "altered" };
    prev = e;
  }
  return null;
}

/** This device's own chain. Appends are serialized. */
export class Journal {
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(e: Entry) => void>();

  constructor(
    readonly store: JournalStore,
    /** This device's key, base64url. */
    readonly host: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(d: Draft): Promise<Entry> {
    const run = this.queue.then(async () => {
      const last = await this.store.last();
      const draft: Omit<Entry, "hash"> = {
        v: 1,
        seq: (last?.seq ?? 0) + 1,
        at: this.now().toISOString(),
        host: this.host,
        prev: last?.hash ?? "",
        ...d,
        input: redact(d.input),
      };
      const e: Entry = { ...draft, hash: entryHash(draft) };
      await this.store.append(e);
      for (const cb of this.listeners) cb(e);
      return e;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  onEntry(cb: (e: Entry) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  since(after: number, limit = 500): Promise<Entry[]> {
    return this.store.since(after, limit);
  }

  get(seq: number): Promise<Entry | null> {
    return this.store.get(seq);
  }

  /** Re-checks the whole stored chain. */
  async check(): Promise<Problem | null> {
    let after: Entry | null = null;
    for (;;) {
      const batch = await this.store.since(after?.seq ?? 0, 1000);
      if (!batch.length) return null;
      const p = verify(batch, after);
      if (p) return p;
      after = batch.at(-1) ?? null;
    }
  }
}

/**
 * The other device's chain, as received. A batch is kept only when it
 * continues what's already here; anything else is reported, never merged.
 */
export class Mirror {
  constructor(
    readonly store: JournalStore,
    /** The other device's key: entries from anyone else are refused. */
    readonly host: string,
  ) {}

  async head(): Promise<number> {
    return (await this.store.last())?.seq ?? 0;
  }

  private queue: Promise<unknown> = Promise.resolve();

  /** Adds entries in arrival order: concurrent calls wait their turn. */
  add(entries: Entry[]): Promise<Problem | null> {
    const run = this.queue.then(() => this.addNow(entries));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async addNow(entries: Entry[]): Promise<Problem | null> {
    if (!entries.length) return null;
    const last = await this.store.last();
    const first = entries[0] as Entry;
    if (first.host !== this.host) return { seq: first.seq, why: "another device's entry" };
    if (last && first.seq <= last.seq) {
      // A resend: what overlaps must match what we have, exactly.
      for (const e of entries) {
        const mine = await this.store.get(e.seq);
        if (mine && mine.hash !== e.hash) return { seq: e.seq, why: "history was rewritten" };
      }
      return this.addNow(entries.filter((e) => e.seq > last.seq));
    }
    const p = verify(entries, last);
    if (p) return p;
    for (const e of entries) await this.store.append(e);
    for (const cb of this.listeners) cb(entries);
    return null;
  }

  private listeners = new Set<(entries: Entry[]) => void>();
  /** New entries kept (already verified against what was here). */
  onEntries(cb: (entries: Entry[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

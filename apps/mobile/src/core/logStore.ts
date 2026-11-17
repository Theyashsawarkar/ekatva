/**
 * The phone's action logs at rest: one encrypted line per entry
 * (ChaCha20-Poly1305 under the log key from the vault), in the app's
 * private storage. Used for the phone's own log and its mirror of the
 * laptop's.
 */
import { fromB64u, toB64u, utf8 } from "@ekatva/link";
import { type Entry, entryAt, type JournalStore, pageAfter } from "@ekatva/protocol";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

/** A file of lines: appended to, read whole. */
export interface Lines {
  read(): Promise<string[]>;
  append(line: string): Promise<void>;
  /** Deletes the file (old logs this phone no longer keeps). */
  remove?(): Promise<void>;
  /** Only the last `n` lines, without reading the rest (falls back to read()). */
  tail?(n: number): Promise<string[]>;
}

export class MemoryLines implements Lines {
  lines: string[] = [];
  async read() {
    return [...this.lines];
  }
  async tail(n: number) {
    return this.lines.filter(Boolean).slice(-n);
  }
  async append(l: string) {
    this.lines.push(l);
  }
}

const AD = utf8.encode("ekatva.log/1");

/** How many of the newest entries stay in memory; older ones are read from disk when asked for. */
export const TAIL = 200;

export class EncryptedStore implements JournalStore {
  /** The newest entries only (at most TAIL), oldest first. */
  private entries: Entry[] = [];
  /** Lines that didn't decrypt: tampering, or a torn write. */
  unreadable = 0;

  private constructor(
    private readonly file: Lines,
    private readonly key: Uint8Array,
  ) {}

  private open1(line: string): Entry | null {
    try {
      const raw = fromB64u(line);
      const plain = chacha20poly1305(this.key, raw.subarray(0, 12), AD).decrypt(raw.subarray(12));
      return JSON.parse(utf8.decode(plain)) as Entry;
    } catch {
      return null;
    }
  }

  /** Opens the log, decrypting only the newest TAIL lines (not the whole history). */
  static async open(file: Lines, key: Uint8Array): Promise<EncryptedStore> {
    const s = new EncryptedStore(file, key);
    const tail = file.tail
      ? await file.tail(TAIL)
      : (await file.read()).filter(Boolean).slice(-TAIL);
    for (const line of tail) {
      const e = s.open1(line);
      if (e) s.entries.push(e);
      else s.unreadable++;
    }
    return s;
  }

  /** Every entry, read from disk (for pages older than the tail; not kept). */
  private async scan(keep: (e: Entry) => boolean, limit: number): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const line of await this.file.read()) {
      if (!line) continue;
      const e = this.open1(line);
      if (e && keep(e)) {
        out.push(e);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async append(e: Entry): Promise<void> {
    const nonce = new Uint8Array(12);
    globalThis.crypto.getRandomValues(nonce);
    const box = chacha20poly1305(this.key, nonce, AD).encrypt(utf8.encode(JSON.stringify(e)));
    const line = new Uint8Array(12 + box.length);
    line.set(nonce);
    line.set(box, 12);
    await this.file.append(toB64u(line));
    this.entries.push(e);
    if (this.entries.length > TAIL) this.entries.splice(0, this.entries.length - TAIL);
  }

  async last() {
    return this.entries.at(-1) ?? null;
  }

  async since(after: number, limit: number) {
    const first = this.entries[0];
    // The page starts inside the tail (the usual case): no disk read.
    // The page starts inside the tail, or the tail is the whole log (it starts at #1): no disk read.
    if (!first || first.seq <= after + 1 || first.seq <= 1)
      return pageAfter(this.entries, after, limit);
    return this.scan((e) => e.seq > after, limit);
  }

  async get(seq: number) {
    const first = this.entries[0];
    if (!first || seq >= first.seq) return entryAt(this.entries, seq);
    return (await this.scan((e) => e.seq === seq, 1))[0] ?? null;
  }

  /** How many entries the log holds (its seq numbers run from 1, one per entry). */
  get size(): number {
    return this.entries.at(-1)?.seq ?? 0;
  }
}

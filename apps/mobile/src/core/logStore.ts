/**
 * The phone's action logs at rest: one encrypted line per entry
 * (ChaCha20-Poly1305 under the log key from the vault), in the app's
 * private storage. Used for the phone's own log and its mirror of the
 * laptop's.
 */
import { fromB64u, toB64u, utf8 } from "@ekatva/link";
import type { Entry, JournalStore } from "@ekatva/protocol";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

/** A file of lines: appended to, read whole. */
export interface Lines {
  read(): Promise<string[]>;
  append(line: string): Promise<void>;
}

export class MemoryLines implements Lines {
  lines: string[] = [];
  async read() {
    return [...this.lines];
  }
  async append(l: string) {
    this.lines.push(l);
  }
}

const AD = utf8.encode("ekatva.log/1");

export class EncryptedStore implements JournalStore {
  private entries: Entry[] = [];
  /** Lines that didn't decrypt: tampering, or a torn write. */
  unreadable = 0;

  private constructor(
    private readonly file: Lines,
    private readonly key: Uint8Array,
  ) {}

  static async open(file: Lines, key: Uint8Array): Promise<EncryptedStore> {
    const s = new EncryptedStore(file, key);
    for (const line of await file.read()) {
      if (!line) continue;
      try {
        const raw = fromB64u(line);
        const plain = chacha20poly1305(key, raw.subarray(0, 12), AD).decrypt(raw.subarray(12));
        s.entries.push(JSON.parse(utf8.decode(plain)));
      } catch {
        s.unreadable++;
      }
    }
    return s;
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
  }

  async last() {
    return this.entries.at(-1) ?? null;
  }

  async since(after: number, limit: number) {
    return this.entries.filter((e) => e.seq > after).slice(0, limit);
  }

  async get(seq: number) {
    return this.entries.find((e) => e.seq === seq) ?? null;
  }
}

/**
 * A journal chain on disk: one JSON entry per line, appended and synced,
 * in a file only you can read. Loaded whole at start (and checked).
 */
import { mkdirSync } from "node:fs";
import { type FileHandle, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Entry, JournalStore } from "@ekatva/protocol";

export class FileStore implements JournalStore {
  private entries: Entry[] = [];
  private fh: FileHandle | null = null;

  private constructor() {}

  static async open(file: string): Promise<FileStore> {
    const s = new FileStore();
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    try {
      const text = await readFile(file, "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          s.entries.push(JSON.parse(line));
        } catch {
          // A torn last line from a crash: the chain check reports gaps.
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    s.fh = await open(file, "a", 0o600);
    return s;
  }

  async append(e: Entry): Promise<void> {
    if (!this.fh) throw new Error("journal closed");
    await this.fh.appendFile(`${JSON.stringify(e)}\n`);
    await this.fh.sync();
    this.entries.push(e);
  }

  async last() {
    return this.entries.at(-1) ?? null;
  }

  async since(after: number, limit: number) {
    // seq n sits at index n-1 in an intact chain; scan from there.
    let start = Math.max(0, Math.min(after, this.entries.length));
    if (start > 0 && this.entries[start - 1]?.seq !== after) start = 0;
    const out: Entry[] = [];
    for (let i = start; i < this.entries.length && out.length < limit; i++) {
      const e = this.entries[i] as Entry;
      if (e.seq > after) out.push(e);
    }
    return out;
  }

  async get(seq: number) {
    const guess = this.entries[seq - 1];
    return guess?.seq === seq ? guess : (this.entries.find((e) => e.seq === seq) ?? null);
  }

  async close(): Promise<void> {
    await this.fh?.close();
    this.fh = null;
  }
}

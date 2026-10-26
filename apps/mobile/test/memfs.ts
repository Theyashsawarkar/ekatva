import type { Fs, FsStat } from "../src/core/files";

/** An in-memory filesystem: files hold base64-free strings for readability. */
export class MemFs implements Fs {
  files = new Map<string, string>();
  dirs = new Set<string>(["/"]);
  private parent = (p: string) => p.replace(/\/[^/]*$/, "") || "/";

  async list(dir: string) {
    const out = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (p !== dir && this.parent(p) === dir) out.add(p.slice(dir.length + 1));
    }
    return [...out];
  }
  async stat(p: string): Promise<FsStat | null> {
    if (this.dirs.has(p)) return { isDir: true, size: 0, mtime: 0 };
    const f = this.files.get(p);
    return f === undefined ? null : { isDir: false, size: f.length, mtime: 0 };
  }
  async read(p: string, offset: number, length: number) {
    return Buffer.from((this.files.get(p) ?? "").slice(offset, offset + length)).toString("base64");
  }
  async write(p: string, data: string) {
    this.files.set(p, Buffer.from(data, "base64").toString());
  }
  async append(p: string, data: string) {
    this.files.set(p, (this.files.get(p) ?? "") + Buffer.from(data, "base64").toString());
  }
  async truncate(p: string, size: number) {
    this.files.set(p, (this.files.get(p) ?? "").slice(0, size));
  }
  async mkdir(p: string) {
    for (let d = p; d !== "/"; d = this.parent(d)) this.dirs.add(d);
  }
  async move(from: string, to: string) {
    for (const [k, v] of [...this.files]) {
      if (k === from || k.startsWith(`${from}/`)) {
        this.files.delete(k);
        this.files.set(to + k.slice(from.length), v);
      }
    }
    for (const d of [...this.dirs]) {
      if (d === from || d.startsWith(`${from}/`)) {
        this.dirs.delete(d);
        this.dirs.add(to + d.slice(from.length));
      }
    }
  }
  async copy(from: string, to: string) {
    for (const [k, v] of [...this.files])
      if (k === from || k.startsWith(`${from}/`)) this.files.set(to + k.slice(from.length), v);
  }
  async remove(p: string) {
    for (const k of [...this.files.keys()])
      if (k === p || k.startsWith(`${p}/`)) this.files.delete(k);
    for (const d of [...this.dirs]) if (d === p || d.startsWith(`${p}/`)) this.dirs.delete(d);
  }
}

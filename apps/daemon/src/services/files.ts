/**
 * Files on the laptop, for a paired phone: inside the configured roots
 * only (symlinks resolved, so a link can't lead out), private places only
 * with their own grant, and ekatva's own state never (a phone must not be
 * able to rewrite its grants or the action log).
 *
 * Nothing is destroyed: a delete, an overwrite, a move or copy over
 * something, all first put what they replace in the undo store, and each
 * returns how to reverse it.
 */
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Done, FileAccess, FileEntry, FileService, Undo } from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";
import { dirs, expand, tilde } from "../paths.js";

export interface FilesOptions {
  roots: string[];
  private: string[];
  undoDir: string;
  /** Paths no one may touch: ekatva's state, config and undo store. */
  forbidden: string[];
}

const inside = (p: string, dir: string) =>
  p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

function deny(message: string): never {
  throw new TRPCError({ code: "FORBIDDEN", message });
}

const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} kB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MB`
        : `${(n / 1024 ** 3).toFixed(2)} GB`;

export interface Kept {
  id: string;
  /** Where it was. */
  path: string;
  at: number;
  bytes: number;
}

/** What changes replaced, kept for undo, pruned by age and total size. */
export class UndoStore {
  constructor(readonly dir: string) {}

  /** Moves `path` (a file or a whole folder) into the store. */
  async keep(path: string, copy = false): Promise<Kept> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const id = `${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
    const slot = join(this.dir, id);
    await fs.mkdir(slot, { mode: 0o700 });
    const item = join(slot, "item");
    if (copy)
      await fs.cp(path, item, {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
    else await moveAcross(path, item);
    const bytes = await du(item);
    const kept: Kept = { id, path, at: Date.now(), bytes };
    await fs.writeFile(join(slot, "meta.json"), JSON.stringify(kept), { mode: 0o600 });
    return kept;
  }

  /** Puts a kept item back at `to`; fails if something is there now. */
  async restore(id: string, to: string): Promise<void> {
    if (!/^[a-z0-9]+-[a-f0-9]{12}$/.test(id)) throw new Error("bad undo id");
    const item = join(this.dir, id, "item");
    try {
      await fs.lstat(item);
    } catch {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "that version is no longer in the undo store",
      });
    }
    if (await exists(to))
      throw new TRPCError({
        code: "CONFLICT",
        message: `${tilde(to)} exists now; move it away first`,
      });
    await fs.mkdir(dirname(to), { recursive: true });
    await moveAcross(item, to);
    await fs.rm(join(this.dir, id), { recursive: true, force: true });
  }

  /** Drops items older than `days`, then the oldest until under `maxBytes`. */
  async prune(days: number, maxBytes: number): Promise<number> {
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return 0;
    }
    const items: Kept[] = [];
    for (const n of names) {
      try {
        items.push(JSON.parse(await fs.readFile(join(this.dir, n, "meta.json"), "utf8")));
      } catch {
        // half-written slot: leave it for the next round
      }
    }
    items.sort((a, b) => a.at - b.at);
    const cutoff = Date.now() - days * 86_400_000;
    let total = items.reduce((s, i) => s + i.bytes, 0);
    let dropped = 0;
    for (const i of items) {
      if (i.at >= cutoff && total <= maxBytes) break;
      await fs.rm(join(this.dir, i.id), { recursive: true, force: true });
      total -= i.bytes;
      dropped++;
    }
    return dropped;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function moveAcross(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await fs.cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await fs.rm(from, { recursive: true, force: true });
  }
}

async function du(p: string): Promise<number> {
  const st = await fs.lstat(p);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of await fs.readdir(p)) n += await du(join(p, e));
  return n;
}

const MIME: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
  zip: "application/zip",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
  py: "text/x-python",
  sh: "text/x-shellscript",
  toml: "text/plain",
  yaml: "text/yaml",
};

export class LaptopFiles implements FileService {
  readonly store: UndoStore;
  private readonly roots: string[];
  private readonly privates: string[];
  private readonly forbidden: string[];

  constructor(opts: FilesOptions) {
    this.store = new UndoStore(opts.undoDir);
    this.roots = opts.roots.map(expand);
    this.privates = opts.private.map(expand);
    this.forbidden = [...opts.forbidden, opts.undoDir].map((p) => resolve(p));
  }

  static forThisLaptop(roots: string[], privates: string[]): LaptopFiles {
    return new LaptopFiles({
      roots,
      private: privates,
      undoDir: dirs.undo(),
      forbidden: [dirs.state(), dirs.config(), dirs.undo()],
    });
  }

  /**
   * The real path for a request: inside a root, not forbidden, private only
   * when allowed. Checks the path as given and as resolved through links
   * (of its nearest existing ancestor, for paths about to be created).
   * `subtree`: the operation takes everything below (delete, move or copy
   * from), so a protected folder inside it counts too.
   */
  async resolvePath(input: string, a: FileAccess, subtree = false): Promise<string> {
    if (input.includes("\0")) deny("bad path");
    const given = expand(input);
    let real = given;
    let tail = "";
    for (;;) {
      try {
        real = join(await fs.realpath(real), tail);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        const parent = dirname(real);
        if (parent === real) break;
        tail = join(basename(real), tail);
        real = parent;
      }
    }
    for (const p of [given, real]) {
      if (!this.roots.some((r) => inside(p, r)))
        deny(`${tilde(p)} is outside the folders shared with the phone`);
      const hits = (f: string) => inside(p, f) || (subtree && inside(f, p));
      if (this.forbidden.some(hits)) deny(`${tilde(p)} holds ekatva's own keys and log`);
      if (!a.allowPrivate && this.privates.some(hits)) {
        deny(`${tilde(p)} is private; allow "Private files too" for this phone first`);
      }
    }
    return given;
  }

  private async entry(path: string): Promise<FileEntry> {
    const st = await fs.lstat(path);
    const kind = st.isFile()
      ? "file"
      : st.isDirectory()
        ? "dir"
        : st.isSymbolicLink()
          ? "link"
          : "other";
    const ext = basename(path).split(".").at(-1)?.toLowerCase() ?? "";
    const mime = kind === "file" ? MIME[ext] : undefined;
    return {
      name: basename(path),
      path: tilde(path),
      kind,
      size: st.size,
      mtime: st.mtimeMs,
      ...(mime ? { mime } : {}),
    };
  }

  async list(path: string, a: FileAccess): Promise<FileEntry[]> {
    const dir = await this.resolvePath(path, a);
    const names = await fs.readdir(dir);
    const out: FileEntry[] = [];
    for (const n of names) {
      const p = join(dir, n);
      if (this.forbidden.some((f) => inside(p, f))) continue;
      try {
        out.push(await this.entry(p));
      } catch {
        // vanished while listing
      }
    }
    return out.sort((x, y) =>
      (x.kind === "dir") !== (y.kind === "dir")
        ? x.kind === "dir"
          ? -1
          : 1
        : x.name.localeCompare(y.name),
    );
  }

  async stat(path: string, a: FileAccess): Promise<FileEntry> {
    return this.entry(await this.resolvePath(path, a));
  }

  async read(i: { path: string; offset: number; length: number }, a: FileAccess) {
    const p = await this.resolvePath(i.path, a);
    const st = await fs.stat(p);
    if (!st.isFile())
      throw new TRPCError({ code: "BAD_REQUEST", message: `${tilde(p)} isn't a file` });
    const chunks: Buffer[] = [];
    if (i.offset < st.size) {
      for await (const c of createReadStream(p, {
        start: i.offset,
        end: Math.min(st.size, i.offset + i.length) - 1,
      }))
        chunks.push(c as Buffer);
    }
    const data = Buffer.concat(chunks);
    return { data: data.toString("base64"), size: st.size, eof: i.offset + data.length >= st.size };
  }

  async write(
    i: { path: string; data: string; mode: "create" | "overwrite" | "append" },
    a: FileAccess,
  ): Promise<Done<FileEntry>> {
    const p = await this.resolvePath(i.path, a);
    const data = Buffer.from(i.data, "base64");
    const before = await fs.lstat(p).catch(() => null);
    if (before?.isDirectory())
      throw new TRPCError({ code: "BAD_REQUEST", message: `${tilde(p)} is a folder` });
    if (i.mode === "append" && before) {
      await fs.appendFile(p, data);
      const after = await this.entry(p);
      return {
        value: after,
        summary: `Added ${size(data.length)} to ${tilde(p)}`,
        undo: { kind: "files.truncate", data: { path: p, size: before.size, expect: after.size } },
      };
    }
    if (i.mode === "create" && before)
      throw new TRPCError({ code: "CONFLICT", message: `${tilde(p)} already exists` });
    await fs.mkdir(dirname(p), { recursive: true });
    // Written beside, then renamed over: never a half-written file.
    const tmp = join(dirname(p), `.${basename(p)}.ekatva-${randomBytes(4).toString("hex")}`);
    await fs.writeFile(tmp, data, { flag: "wx", mode: before ? before.mode & 0o777 : 0o644 });
    let undo: Undo;
    try {
      if (before) {
        const kept = await this.store.keep(p);
        undo = { kind: "files.restore", data: { id: kept.id, path: p } };
      } else undo = { kind: "files.trash", data: { path: p } };
      await fs.rename(tmp, p);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    return {
      value: await this.entry(p),
      summary: `${before ? "Replaced" : "Created"} ${tilde(p)} (${size(data.length)})`,
      undo,
    };
  }

  async mkdir(path: string, a: FileAccess): Promise<Done<FileEntry>> {
    const p = await this.resolvePath(path, a);
    if (await exists(p))
      throw new TRPCError({ code: "CONFLICT", message: `${tilde(p)} already exists` });
    await fs.mkdir(p, { recursive: true });
    return {
      value: await this.entry(p),
      summary: `Made the folder ${tilde(p)}`,
      undo: { kind: "files.rmdir", data: { path: p } },
    };
  }

  async move(
    i: { from: string; to: string; overwrite: boolean },
    a: FileAccess,
  ): Promise<Done<FileEntry>> {
    const from = await this.resolvePath(i.from, a, true);
    let to = await this.resolvePath(i.to, a, i.overwrite);
    if (
      (await fs.lstat(to).catch(() => null))?.isDirectory() &&
      !(await fs.lstat(from)).isDirectory()
    ) {
      to = await this.resolvePath(join(to, basename(from)), a, i.overwrite);
    }
    if (inside(to, from))
      throw new TRPCError({ code: "BAD_REQUEST", message: "can't move a folder into itself" });
    const replaced = await this.makeRoom(to, i.overwrite);
    await fs.mkdir(dirname(to), { recursive: true });
    await moveAcross(from, to);
    return {
      value: await this.entry(to),
      summary: `Moved ${tilde(from)} to ${tilde(to)}${replaced ? " (replacing it)" : ""}`,
      undo: {
        kind: "files.move",
        data: {
          from: to,
          to: from,
          ...(replaced ? { restore: { id: replaced.id, path: to } } : {}),
        },
      },
    };
  }

  async copy(
    i: { from: string; to: string; overwrite: boolean },
    a: FileAccess,
  ): Promise<Done<FileEntry>> {
    const from = await this.resolvePath(i.from, a, true);
    let to = await this.resolvePath(i.to, a, i.overwrite);
    if ((await fs.lstat(to).catch(() => null))?.isDirectory())
      to = await this.resolvePath(join(to, basename(from)), a, i.overwrite);
    if (inside(to, from))
      throw new TRPCError({ code: "BAD_REQUEST", message: "can't copy a folder into itself" });
    const replaced = await this.makeRoom(to, i.overwrite);
    await fs.cp(from, to, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    return {
      value: await this.entry(to),
      summary: `Copied ${tilde(from)} to ${tilde(to)}${replaced ? " (replacing it)" : ""}`,
      undo: {
        kind: "files.trash",
        data: { path: to, ...(replaced ? { restore: { id: replaced.id, path: to } } : {}) },
      },
    };
  }

  async remove(path: string, a: FileAccess): Promise<Done<null>> {
    const p = await this.resolvePath(path, a, true);
    if (this.roots.includes(p))
      throw new TRPCError({ code: "FORBIDDEN", message: "won't delete a whole shared folder" });
    const kept = await this.store.keep(p);
    return {
      value: null,
      summary: `Deleted ${tilde(p)} (${size(kept.bytes)}, undoable)`,
      undo: { kind: "files.restore", data: { id: kept.id, path: p } },
    };
  }

  /** Clears `to` for a move or copy: refuses, or keeps what's there. */
  private async makeRoom(to: string, overwrite: boolean): Promise<Kept | null> {
    if (!(await exists(to))) return null;
    if (!overwrite)
      throw new TRPCError({ code: "CONFLICT", message: `${tilde(to)} already exists` });
    return this.store.keep(to);
  }

  /** Reverses one of this service's undo records; returns the redo. */
  async undo(u: Undo): Promise<Done<unknown>> {
    const d = u.data as Record<string, unknown>;
    const path = String(d.path ?? "");
    const restoreAlso = d.restore as { id: string; path: string } | undefined;
    switch (u.kind) {
      case "files.restore": {
        const id = String(d.id);
        // Whatever is there now goes to the store, so this is undoable too.
        const now = (await exists(path)) ? await this.store.keep(path) : null;
        await this.store.restore(id, path);
        return {
          value: null,
          summary: `Restored ${tilde(path)}`,
          undo: now
            ? { kind: "files.restore", data: { id: now.id, path } }
            : { kind: "files.trash", data: { path } },
        };
      }
      case "files.trash": {
        const kept = await this.store.keep(path);
        if (restoreAlso) await this.store.restore(restoreAlso.id, restoreAlso.path);
        return {
          value: null,
          summary: `Removed ${tilde(path)}${restoreAlso ? " and put back what it replaced" : ""}`,
          undo: { kind: "files.restore", data: { id: kept.id, path } },
        };
      }
      case "files.move": {
        const from = String(d.from);
        const to = String(d.to);
        if (await exists(to))
          throw new TRPCError({ code: "CONFLICT", message: `${tilde(to)} exists now` });
        await fs.mkdir(dirname(to), { recursive: true });
        await moveAcross(from, to);
        if (restoreAlso) await this.store.restore(restoreAlso.id, restoreAlso.path);
        return {
          value: null,
          summary: `Moved ${tilde(from)} back to ${tilde(to)}`,
          undo: { kind: "files.move", data: { from: to, to: from } },
        };
      }
      case "files.rmdir": {
        await fs.rmdir(path).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOTEMPTY")
            throw new TRPCError({
              code: "CONFLICT",
              message: `${tilde(path)} has files in it now`,
            });
          throw e;
        });
        return {
          value: null,
          summary: `Removed the folder ${tilde(path)}`,
          undo: { kind: "files.mkdir", data: { path } },
        };
      }
      case "files.mkdir": {
        await fs.mkdir(path, { recursive: true });
        return {
          value: null,
          summary: `Made the folder ${tilde(path)}`,
          undo: { kind: "files.rmdir", data: { path } },
        };
      }
      case "files.truncate": {
        const st = await fs.stat(path);
        if (st.size !== Number(d.expect))
          throw new TRPCError({ code: "CONFLICT", message: `${tilde(path)} changed since` });
        // Keep the whole current file first, so this too can be undone.
        const kept = await this.store.keep(path, true);
        await fs.truncate(path, Number(d.size));
        return {
          value: null,
          summary: `Cut ${tilde(path)} back to ${size(Number(d.size))}`,
          undo: { kind: "files.restore-over", data: { id: kept.id, path } },
        };
      }
      case "files.restore-over": {
        const now = await this.store.keep(path);
        await this.store.restore(String(d.id), path);
        return {
          value: null,
          summary: `Restored ${tilde(path)}`,
          undo: { kind: "files.restore-over", data: { id: now.id, path } },
        };
      }
      default:
        throw new TRPCError({ code: "BAD_REQUEST", message: `don't know how to undo ${u.kind}` });
    }
  }

  get rootsForDisplay(): string[] {
    return this.roots.map(tilde);
  }
}

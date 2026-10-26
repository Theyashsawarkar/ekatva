/**
 * The phone's files, for the laptop: inside the shared roots only, and
 * nothing destroyed: deletes and overwrites go to the undo store first.
 * Over an abstract filesystem (Expo's in the app, a Map in tests).
 */
import type { Done, FileAccess, FileEntry, FileService, Undo } from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";

export interface FsStat {
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface Fs {
  list(dir: string): Promise<string[]>;
  stat(path: string): Promise<FsStat | null>;
  /** Base64. */
  read(path: string, offset: number, length: number): Promise<string>;
  /** Base64; replaces the file. */
  write(path: string, data: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
  truncate(path: string, size: number): Promise<void>;
  mkdir(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const join = (a: string, b: string) => `${a.replace(/\/+$/, "")}/${b.replace(/^\/+/, "")}`;
const dirname = (p: string) => p.replace(/\/[^/]*$/, "") || "/";
const basename = (p: string) => p.replace(/\/+$/, "").split("/").at(-1) ?? p;

/** Resolves "." and ".." without touching the disk. */
export function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

export class PhoneFiles implements FileService {
  private n = 0;

  constructor(
    private readonly fs: Fs,
    /** Shared folders; the first is "~". */
    private readonly roots: string[],
    private readonly undoDir: string,
  ) {}

  private resolve(input: string): string {
    if (input.includes("\0")) throw new TRPCError({ code: "FORBIDDEN", message: "bad path" });
    const home = this.roots[0] ?? "/";
    const p = normalize(
      input === "~"
        ? home
        : input.startsWith("~/")
          ? join(home, input.slice(2))
          : input.startsWith("/")
            ? input
            : join(home, input),
    );
    if (!this.roots.some((r) => inside(p, r)))
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `${p} is outside the folders shared with the laptop`,
      });
    if (inside(p, this.undoDir) || inside(this.undoDir, p))
      throw new TRPCError({ code: "FORBIDDEN", message: "that's ekatva's own storage" });
    return p;
  }

  private show(p: string): string {
    const home = this.roots[0] ?? "/";
    return p === home ? "~" : inside(p, home) ? `~${p.slice(home.length)}` : p;
  }

  private async entry(p: string): Promise<FileEntry> {
    const st = await this.fs.stat(p);
    if (!st) throw new TRPCError({ code: "NOT_FOUND", message: `${this.show(p)} doesn't exist` });
    return {
      name: basename(p),
      path: this.show(p),
      kind: st.isDir ? "dir" : "file",
      size: st.size,
      mtime: st.mtime,
    };
  }

  private async keep(p: string): Promise<string> {
    const id = `${Date.now().toString(36)}-${(++this.n).toString(36)}`;
    await this.fs.mkdir(this.undoDir);
    await this.fs.move(p, join(this.undoDir, id));
    return id;
  }

  private async restore(id: string, to: string): Promise<void> {
    if (!/^[a-z0-9]+-[a-z0-9]+$/.test(id)) throw new Error("bad undo id");
    if (await this.fs.stat(to))
      throw new TRPCError({ code: "CONFLICT", message: `${this.show(to)} exists now` });
    const from = join(this.undoDir, id);
    if (!(await this.fs.stat(from)))
      throw new TRPCError({ code: "NOT_FOUND", message: "no longer in the undo store" });
    await this.fs.mkdir(dirname(to));
    await this.fs.move(from, to);
  }

  async list(path: string, _a: FileAccess) {
    const dir = this.resolve(path);
    const names = await this.fs.list(dir);
    const out: FileEntry[] = [];
    for (const n of names) {
      const p = join(dir, n);
      if (inside(p, this.undoDir)) continue;
      out.push(await this.entry(p));
    }
    return out.sort((x, y) =>
      (x.kind === "dir") !== (y.kind === "dir")
        ? x.kind === "dir"
          ? -1
          : 1
        : x.name.localeCompare(y.name),
    );
  }

  async stat(path: string, _a: FileAccess) {
    return this.entry(this.resolve(path));
  }

  async read(i: { path: string; offset: number; length: number }, _a: FileAccess) {
    const p = this.resolve(i.path);
    const st = await this.fs.stat(p);
    if (!st || st.isDir)
      throw new TRPCError({ code: "BAD_REQUEST", message: `${this.show(p)} isn't a file` });
    const data = await this.fs.read(p, i.offset, i.length);
    const got =
      Math.floor((data.length * 3) / 4) - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    return { data, size: st.size, eof: i.offset + got >= st.size };
  }

  async write(
    i: { path: string; data: string; mode: "create" | "overwrite" | "append" },
    _a: FileAccess,
  ): Promise<Done<FileEntry>> {
    const p = this.resolve(i.path);
    const before = await this.fs.stat(p);
    if (before?.isDir)
      throw new TRPCError({ code: "BAD_REQUEST", message: `${this.show(p)} is a folder` });
    if (i.mode === "append" && before) {
      await this.fs.append(p, i.data);
      const after = await this.entry(p);
      return {
        value: after,
        summary: `Added to ${this.show(p)}`,
        undo: { kind: "files.truncate", data: { path: p, size: before.size, expect: after.size } },
      };
    }
    if (i.mode === "create" && before)
      throw new TRPCError({ code: "CONFLICT", message: `${this.show(p)} already exists` });
    let undo: Undo = { kind: "files.trash", data: { path: p } };
    if (before) undo = { kind: "files.restore", data: { id: await this.keep(p), path: p } };
    await this.fs.mkdir(dirname(p));
    await this.fs.write(p, i.data);
    return {
      value: await this.entry(p),
      summary: `${before ? "Replaced" : "Created"} ${this.show(p)}`,
      undo,
    };
  }

  async mkdir(path: string, _a: FileAccess): Promise<Done<FileEntry>> {
    const p = this.resolve(path);
    if (await this.fs.stat(p))
      throw new TRPCError({ code: "CONFLICT", message: `${this.show(p)} already exists` });
    await this.fs.mkdir(p);
    return {
      value: await this.entry(p),
      summary: `Made the folder ${this.show(p)}`,
      undo: { kind: "files.rmdir", data: { path: p } },
    };
  }

  async move(
    i: { from: string; to: string; overwrite: boolean },
    _a: FileAccess,
  ): Promise<Done<FileEntry>> {
    const from = this.resolve(i.from);
    let to = this.resolve(i.to);
    if ((await this.fs.stat(to))?.isDir && !(await this.fs.stat(from))?.isDir)
      to = join(to, basename(from));
    if (inside(to, from))
      throw new TRPCError({ code: "BAD_REQUEST", message: "can't move a folder into itself" });
    const replaced = (await this.fs.stat(to))
      ? i.overwrite
        ? await this.keep(to)
        : this.conflict(to)
      : null;
    await this.fs.mkdir(dirname(to));
    await this.fs.move(from, to);
    return {
      value: await this.entry(to),
      summary: `Moved ${this.show(from)} to ${this.show(to)}`,
      undo: {
        kind: "files.move",
        data: { from: to, to: from, ...(replaced ? { restore: { id: replaced, path: to } } : {}) },
      },
    };
  }

  async copy(
    i: { from: string; to: string; overwrite: boolean },
    _a: FileAccess,
  ): Promise<Done<FileEntry>> {
    const from = this.resolve(i.from);
    let to = this.resolve(i.to);
    if ((await this.fs.stat(to))?.isDir) to = join(to, basename(from));
    const replaced = (await this.fs.stat(to))
      ? i.overwrite
        ? await this.keep(to)
        : this.conflict(to)
      : null;
    await this.fs.copy(from, to);
    return {
      value: await this.entry(to),
      summary: `Copied ${this.show(from)} to ${this.show(to)}`,
      undo: {
        kind: "files.trash",
        data: { path: to, ...(replaced ? { restore: { id: replaced, path: to } } : {}) },
      },
    };
  }

  async remove(path: string, _a: FileAccess): Promise<Done<null>> {
    const p = this.resolve(path);
    if (this.roots.includes(p))
      throw new TRPCError({ code: "FORBIDDEN", message: "won't delete a whole shared folder" });
    if (!(await this.fs.stat(p)))
      throw new TRPCError({ code: "NOT_FOUND", message: `${this.show(p)} doesn't exist` });
    const id = await this.keep(p);
    return {
      value: null,
      summary: `Deleted ${this.show(p)} (undoable)`,
      undo: { kind: "files.restore", data: { id, path: p } },
    };
  }

  private conflict(p: string): never {
    throw new TRPCError({ code: "CONFLICT", message: `${this.show(p)} already exists` });
  }

  async undo(u: Undo): Promise<Done<unknown>> {
    const d = u.data as Record<string, unknown>;
    const path = String(d.path ?? "");
    const also = d.restore as { id: string; path: string } | undefined;
    switch (u.kind) {
      case "files.restore": {
        const now = (await this.fs.stat(path)) ? await this.keep(path) : null;
        await this.restore(String(d.id), path);
        return {
          value: null,
          summary: `Restored ${this.show(path)}`,
          undo: now
            ? { kind: "files.restore", data: { id: now, path } }
            : { kind: "files.trash", data: { path } },
        };
      }
      case "files.trash": {
        const id = await this.keep(path);
        if (also) await this.restore(also.id, also.path);
        return {
          value: null,
          summary: `Removed ${this.show(path)}`,
          undo: { kind: "files.restore", data: { id, path } },
        };
      }
      case "files.move": {
        const from = String(d.from);
        const to = String(d.to);
        if (await this.fs.stat(to))
          throw new TRPCError({ code: "CONFLICT", message: `${this.show(to)} exists now` });
        await this.fs.move(from, to);
        if (also) await this.restore(also.id, also.path);
        return {
          value: null,
          summary: `Moved ${this.show(from)} back to ${this.show(to)}`,
          undo: { kind: "files.move", data: { from: to, to: from } },
        };
      }
      case "files.rmdir": {
        if ((await this.fs.list(path)).length)
          throw new TRPCError({
            code: "CONFLICT",
            message: `${this.show(path)} has files in it now`,
          });
        await this.fs.remove(path);
        return {
          value: null,
          summary: `Removed the folder ${this.show(path)}`,
          undo: { kind: "files.mkdir", data: { path } },
        };
      }
      case "files.mkdir": {
        await this.fs.mkdir(path);
        return {
          value: null,
          summary: `Made the folder ${this.show(path)}`,
          undo: { kind: "files.rmdir", data: { path } },
        };
      }
      case "files.truncate": {
        const st = await this.fs.stat(path);
        if (st?.size !== Number(d.expect))
          throw new TRPCError({ code: "CONFLICT", message: `${this.show(path)} changed since` });
        await this.fs.truncate(path, Number(d.size));
        return { value: null, summary: `Cut ${this.show(path)} back` };
      }
      default:
        throw new TRPCError({ code: "BAD_REQUEST", message: `don't know how to undo ${u.kind}` });
    }
  }
}

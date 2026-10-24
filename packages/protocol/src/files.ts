/**
 * Files, the same API on both devices: browse, read, create, change, move,
 * copy, delete. Every change is undoable: what it replaces or deletes is
 * kept in the device's undo store first.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Capability } from "./capabilities.js";
import type { Undo } from "./journal.js";
import type { Act, BaseContext, createApi } from "./trpc.js";

/** "~/notes/a.md" or an absolute path; resolved on the device that has the file. */
export const FilePath = z.string().min(1).max(4096);

export const FileEntry = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(["file", "dir", "link", "other"]),
  size: z.number(),
  /** Modified, ms since the epoch. */
  mtime: z.number(),
  mime: z.string().optional(),
});
export type FileEntry = z.infer<typeof FileEntry>;

/** Up to this much per read or write call; larger files go in pieces. */
export const CHUNK = 4 * 1024 * 1024;

/** The result of a change, with what the journal needs. */
export interface Done<T> {
  value: T;
  summary: string;
  undo?: Undo;
}

export interface FileAccess {
  /** May touch ~/.ssh, ~/.gnupg, keyrings and ekatva's own state. */
  allowPrivate: boolean;
}

export interface FileService {
  list(path: string, a: FileAccess): Promise<FileEntry[]>;
  stat(path: string, a: FileAccess): Promise<FileEntry>;
  /** Base64 data. */
  read(
    i: { path: string; offset: number; length: number },
    a: FileAccess,
  ): Promise<{ data: string; size: number; eof: boolean }>;
  write(
    i: { path: string; data: string; mode: "create" | "overwrite" | "append" },
    a: FileAccess,
  ): Promise<Done<FileEntry>>;
  mkdir(path: string, a: FileAccess): Promise<Done<FileEntry>>;
  move(
    i: { from: string; to: string; overwrite: boolean },
    a: FileAccess,
  ): Promise<Done<FileEntry>>;
  copy(
    i: { from: string; to: string; overwrite: boolean },
    a: FileAccess,
  ): Promise<Done<FileEntry>>;
  remove(path: string, a: FileAccess): Promise<Done<null>>;
}

type Api<C extends BaseContext> = ReturnType<typeof createApi<C>>;

export function filesRouter<C extends BaseContext>(
  api: Api<C>,
  cap: Capability,
  privateCap: Capability | null,
  service: (ctx: C) => FileService,
) {
  const p = api.procedure;
  const access = (ctx: C): FileAccess => ({
    allowPrivate: privateCap !== null && ctx.grants.has(privateCap),
  });
  const done = <T>(ctx: unknown, d: Done<T>): T => {
    const act = (ctx as { act: Act }).act;
    act.summary = d.summary;
    if (d.undo) act.undo = d.undo;
    return d.value;
  };
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof TRPCError) throw e;
      const err = e as { code?: string; message?: string };
      const code =
        err?.code === "ENOENT"
          ? "NOT_FOUND"
          : err?.code === "EEXIST"
            ? "CONFLICT"
            : err?.code === "EACCES" || err?.code === "EPERM"
              ? "FORBIDDEN"
              : "BAD_REQUEST";
      throw new TRPCError({ code, message: err?.message ?? String(e) });
    }
  };
  return api.router({
    list: p
      .meta({ cap, audit: true, summary: (i) => `Listed ${(i as { path: string }).path}` })
      .input(z.object({ path: FilePath }))
      .query(({ ctx, input }) =>
        wrap(() => service(ctx as unknown as C).list(input.path, access(ctx as unknown as C))),
      ),
    stat: p
      .meta({ cap })
      .input(z.object({ path: FilePath }))
      .query(({ ctx, input }) =>
        wrap(() => service(ctx as unknown as C).stat(input.path, access(ctx as unknown as C))),
      ),
    read: p
      .meta({ cap, audit: true, summary: (i) => `Read ${(i as { path: string }).path}` })
      .input(
        z.object({
          path: FilePath,
          offset: z.number().int().min(0).default(0),
          length: z.number().int().min(1).max(CHUNK).default(CHUNK),
        }),
      )
      .query(({ ctx, input }) =>
        wrap(() => service(ctx as unknown as C).read(input, access(ctx as unknown as C))),
      ),
    write: p
      .meta({ cap })
      .input(
        z.object({
          path: FilePath,
          data: z.string().max(Math.ceil(CHUNK / 3) * 4),
          mode: z.enum(["create", "overwrite", "append"]),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        done(
          ctx,
          await wrap(() => service(ctx as unknown as C).write(input, access(ctx as unknown as C))),
        ),
      ),
    mkdir: p
      .meta({ cap })
      .input(z.object({ path: FilePath }))
      .mutation(async ({ ctx, input }) =>
        done(
          ctx,
          await wrap(() =>
            service(ctx as unknown as C).mkdir(input.path, access(ctx as unknown as C)),
          ),
        ),
      ),
    move: p
      .meta({ cap })
      .input(z.object({ from: FilePath, to: FilePath, overwrite: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) =>
        done(
          ctx,
          await wrap(() => service(ctx as unknown as C).move(input, access(ctx as unknown as C))),
        ),
      ),
    copy: p
      .meta({ cap })
      .input(z.object({ from: FilePath, to: FilePath, overwrite: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) =>
        done(
          ctx,
          await wrap(() => service(ctx as unknown as C).copy(input, access(ctx as unknown as C))),
        ),
      ),
    remove: p
      .meta({ cap })
      .input(z.object({ path: FilePath }))
      .mutation(async ({ ctx, input }) =>
        done(
          ctx,
          await wrap(() =>
            service(ctx as unknown as C).remove(input.path, access(ctx as unknown as C)),
          ),
        ),
      ),
  });
}

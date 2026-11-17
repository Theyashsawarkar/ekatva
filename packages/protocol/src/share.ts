/**
 * Sending to the other device, the same API on both (KDE Connect's
 * "share"): a file lands in its Downloads, a link opens in its browser,
 * other text goes on its clipboard. Lower trust than `files`: the sender
 * can't choose where a file goes or read anything back.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Capability } from "./capabilities.js";
import { CHUNK, type Done } from "./files.js";
import type { Act, BaseContext, createApi } from "./trpc.js";

type Api<C extends BaseContext> = ReturnType<typeof createApi<C>>;

/** The largest file one share takes. */
export const SHARE_MAX = 4 * 1024 ** 3;

export interface ShareService {
  /** A link opens, other text goes on the clipboard; says which. */
  text(text: string, from: string): Promise<Done<{ opened: boolean }>>;
  /** Starts receiving a file; `name` is only a suggestion (made safe and unique). */
  begin(name: string, size: number, from: string): Promise<{ id: string }>;
  /** The next piece, base64, in order. */
  put(id: string, data: string): Promise<void>;
  /** All there: where it was saved. */
  finish(id: string): Promise<Done<{ path: string }>>;
  cancel(id: string): Promise<void>;
}

/** "photo (1).jpg" stays readable; "../../.bashrc" becomes ".bashrc" in Downloads, never outside. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
  return clean || "file";
}

export function shareRouter<C extends BaseContext>(
  api: Api<C>,
  cap: Capability,
  service: (ctx: C) => ShareService,
) {
  const p = api.procedure;
  const done = <T>(ctx: unknown, d: Done<T>): T => {
    const act = (ctx as { act: Act }).act;
    act.summary = d.summary;
    if (d.undo) act.undo = d.undo;
    return d.value;
  };
  // tRPC's inferred context type isn't C to TypeScript (files.ts does the same).
  const svc = (ctx: unknown) => service(ctx as C);
  const from = (ctx: unknown) => (ctx as C).actor.name;
  const wrap = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof TRPCError) throw e;
      throw new TRPCError({ code: "BAD_REQUEST", message: (e as Error).message ?? String(e) });
    }
  };
  return api.router({
    text: p
      .meta({ cap })
      .input(z.object({ text: z.string().min(1).max(100_000) }))
      .mutation(async ({ ctx, input }) =>
        done(ctx, await wrap(() => svc(ctx).text(input.text, from(ctx)))),
      ),
    begin: p
      .meta({ cap, record: false })
      .input(
        z.object({
          name: z.string().min(1).max(1000),
          size: z.number().int().min(0).max(SHARE_MAX),
        }),
      )
      .mutation(({ ctx, input }) => wrap(() => svc(ctx).begin(input.name, input.size, from(ctx)))),
    put: p
      .meta({ cap, record: false })
      .input(z.object({ id: z.string().max(64), data: z.string().max(Math.ceil(CHUNK / 3) * 4) }))
      .mutation(async ({ ctx, input }) => {
        await wrap(() => svc(ctx).put(input.id, input.data));
        return null;
      }),
    finish: p
      .meta({ cap })
      .input(z.object({ id: z.string().max(64) }))
      .mutation(async ({ ctx, input }) => done(ctx, await wrap(() => svc(ctx).finish(input.id)))),
    cancel: p
      .meta({ cap, record: false })
      .input(z.object({ id: z.string().max(64) }))
      .mutation(async ({ ctx, input }) => {
        await wrap(() => svc(ctx).cancel(input.id));
        return null;
      }),
  });
}

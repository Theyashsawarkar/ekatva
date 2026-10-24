/**
 * The journal over the API: read this device's chain, follow it live, and
 * undo an entry. Undoing is itself an entry (with `undoes`), and is often
 * undoable in turn (a redo).
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Capability } from "./capabilities.js";
import type { Done } from "./files.js";
import type { Entry, Undo } from "./journal.js";
import type { Act, BaseContext, createApi } from "./trpc.js";

/** Puts things back: one function per undo `kind`. */
export type Undoer = (undo: Undo) => Promise<Done<unknown>>;

type Api<C extends BaseContext> = ReturnType<typeof createApi<C>>;

export function journalRouter<C extends BaseContext>(
  api: Api<C>,
  cap: Capability,
  undoer: (ctx: C) => Undoer,
  /** The capability an action needed: undoing it needs that one too. */
  capOf: (action: string) => Capability | undefined,
) {
  const p = api.procedure;
  return api.router({
    head: p.meta({ cap }).query(async ({ ctx }) => {
      const last = await ctx.journal.store.last();
      return { host: ctx.journal.host, seq: last?.seq ?? 0, hash: last?.hash ?? "" };
    }),
    since: p
      .meta({ cap })
      .input(
        z.object({
          after: z.number().int().min(0),
          limit: z.number().int().min(1).max(1000).default(500),
        }),
      )
      .query(({ ctx, input }) => ctx.journal.since(input.after, input.limit)),
    /** New entries as they happen, after `after`. */
    follow: p
      .meta({ cap })
      .input(z.object({ after: z.number().int().min(0) }))
      .subscription(async function* ({ ctx, input, signal }) {
        const queue: Entry[] = [];
        let wake: (() => void) | null = null;
        const off = ctx.journal.onEntry((e) => {
          queue.push(e);
          wake?.();
        });
        try {
          let after = input.after;
          for (const e of await ctx.journal.since(after, 1000)) {
            yield e;
            after = e.seq;
          }
          while (!signal?.aborted) {
            const e = queue.shift();
            if (e) {
              if (e.seq > after) {
                after = e.seq;
                yield e;
              }
              continue;
            }
            await new Promise<void>((res) => {
              wake = res;
              signal?.addEventListener("abort", () => res(), { once: true });
            });
            wake = null;
          }
        } finally {
          off();
        }
      }),
    undo: p
      .meta({ cap })
      .input(z.object({ seq: z.number().int().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const act = (ctx as unknown as { act: Act }).act;
        const entry = await ctx.journal.get(input.seq);
        if (!entry) throw new TRPCError({ code: "NOT_FOUND", message: `no entry #${input.seq}` });
        if (!entry.ok || !entry.undo) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `#${input.seq} can't be undone` });
        }
        const needed = capOf(entry.action);
        if (!needed || !ctx.grants.has(needed)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: `undoing ${entry.action} needs "${needed}"`,
          });
        }
        for (const later of await ctx.journal.since(input.seq, 100_000)) {
          if (later.undoes === input.seq && later.ok) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `#${input.seq} was already undone (#${later.seq})`,
            });
          }
        }
        act.undoes = input.seq;
        const d = await undoer(ctx as unknown as C)(entry.undo);
        act.summary = `Undid #${input.seq}: ${d.summary}`;
        if (d.undo) act.undo = d.undo;
        return { undid: input.seq, summary: d.summary };
      }),
  });
}

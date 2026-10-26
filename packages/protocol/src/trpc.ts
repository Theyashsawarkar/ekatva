/**
 * The one procedure builder every ekatva API uses. Each procedure names
 * its capability; the middleware refuses callers without it, and records
 * the call in the journal: every mutation, and queries marked `audit`
 * (reading a file is worth knowing about; polling the battery isn't).
 */
import { initTRPC, TRPCError } from "@trpc/server";
import type { Capability } from "./capabilities.js";
import type { Actor, Journal, Undo } from "./journal.js";

export interface Meta {
  cap: Capability;
  /** Record this query or subscription too (mutations always are). */
  audit?: boolean;
  /** Mutations are recorded unless this is false: events reported, not actions taken. */
  record?: boolean;
  /** A readable line for queries; mutations say it through `act`. */
  summary?: (input: unknown) => string;
}

/** What a handler tells the journal about what it just did. */
export interface Act {
  summary?: string;
  undo?: Undo;
  undoes?: number;
}

export interface BaseContext {
  /** Who is asking. */
  actor: Actor;
  /** Read on every call, so a revoked grant stops the very next one. */
  grants: { has(c: Capability): boolean };
  journal: Journal;
}

export function createApi<Ctx extends BaseContext>() {
  const t = initTRPC.context<Ctx>().meta<Meta>().create({
    isServer: true,
    allowOutsideOfServer: true,
    // Never send stack traces to the other device.
    isDev: false,
  });

  const guarded = t.procedure.use(async ({ ctx, meta, path, type, getRawInput, next }) => {
    if (!meta?.cap) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `${path} names no capability`,
      });
    }
    const act: Act = {};
    const log = type === "mutation" ? meta.record !== false : meta.audit === true;
    if (!ctx.grants.has(meta.cap)) {
      if (log) {
        await ctx.journal.record({
          actor: ctx.actor,
          action: path,
          summary: `Refused: ${path} needs "${meta.cap}"`,
          input: await getRawInput().catch(() => undefined),
          ok: false,
          error: "not granted",
        });
      }
      throw new TRPCError({ code: "FORBIDDEN", message: `this device may not use "${meta.cap}"` });
    }
    const result = await next({ ctx: { act } });
    if (log) {
      const input = await getRawInput().catch(() => undefined);
      const error = result.ok ? undefined : result.error.message;
      await ctx.journal.record({
        actor: ctx.actor,
        action: path,
        summary: act.summary ?? meta.summary?.(input) ?? path,
        input,
        ok: result.ok,
        ...(error ? { error } : {}),
        ...(result.ok && act.undo ? { undo: act.undo } : {}),
        ...(act.undoes ? { undoes: act.undoes } : {}),
      });
    }
    return result;
  });

  return {
    router: t.router,
    mergeRouters: t.mergeRouters,
    procedure: guarded,
    createCallerFactory: t.createCallerFactory,
  };
}

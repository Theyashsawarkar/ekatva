/**
 * The phone's API, served by the app to the laptop. The app provides
 * `PhoneServices`; the same capability checks and journal apply, on the
 * phone, with the phone's own grants for this laptop.
 */
import { z } from "zod";
import type { Capability } from "./capabilities.js";
import { type Done, type FileService, filesRouter } from "./files.js";
import { journalRouter, type Undoer } from "./journalRouter.js";
import { type Act, type BaseContext, createApi } from "./trpc.js";

export const PhoneStatus = z.object({
  name: z.string(),
  battery: z.object({ percent: z.number(), charging: z.boolean() }).nullable(),
  signal: z.object({ bars: z.number(), network: z.string() }).nullable(),
  locked: z.boolean().nullable(),
  awake: z.boolean(),
});
export type PhoneStatus = z.infer<typeof PhoneStatus>;

export const Sms = z.object({
  id: z.string(),
  thread: z.string(),
  from: z.string(),
  contact: z.string().nullable(),
  text: z.string(),
  at: z.number(),
  mine: z.boolean(),
});
export type Sms = z.infer<typeof Sms>;

export interface PhoneServices {
  status(): Promise<PhoneStatus>;
  lock(): Promise<Done<null>>;
  ring(): Promise<Done<null>>;
  /** Keep the phone's screen on (its caffeine). */
  keepAwake(on: boolean): Promise<Done<null>>;
  calls: {
    dial(number: string): Promise<Done<null>>;
    answer(): Promise<Done<null>>;
    hangUp(): Promise<Done<null>>;
  };
  sms: {
    threads(): Promise<{ thread: string; contact: string | null; last: Sms }[]>;
    read(thread: string, limit: number): Promise<Sms[]>;
    send(to: string, text: string): Promise<Done<null>>;
  };
  clipboard: { get(): Promise<string>; set(text: string): Promise<Done<null>> };
  files: FileService;
  undo: Undoer;
}

export interface PhoneContext extends BaseContext {
  services: PhoneServices;
}

const api = createApi<PhoneContext>();
const p = api.procedure;

function done<T>(ctx: unknown, d: Done<T>): T {
  const a = (ctx as { act: Act }).act;
  a.summary = d.summary;
  if (d.undo) a.undo = d.undo;
  return d.value;
}

const PhoneNumber = z.string().regex(/^[+\d][\d\s()*#-]{1,30}$/, "a phone number");

function capOf(action: string): Capability | undefined {
  const proc = (
    phoneRouter._def.procedures as unknown as Record<
      string,
      { _def: { meta?: { cap: Capability } } }
    >
  )[action];
  return proc?._def.meta?.cap;
}

export const phoneRouter = api.router({
  status: p.meta({ cap: "phone.status" }).query(({ ctx }) => ctx.services.status()),
  lock: p
    .meta({ cap: "phone.lock" })
    .mutation(async ({ ctx }) => done(ctx, await ctx.services.lock())),
  ring: p
    .meta({ cap: "phone.lock" })
    .mutation(async ({ ctx }) => done(ctx, await ctx.services.ring())),
  keepAwake: p
    .meta({ cap: "phone.lock" })
    .input(z.object({ on: z.boolean() }))
    .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.keepAwake(input.on))),
  calls: api.router({
    dial: p
      .meta({ cap: "phone.calls" })
      .input(z.object({ number: PhoneNumber }))
      .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.calls.dial(input.number))),
    answer: p
      .meta({ cap: "phone.calls" })
      .mutation(async ({ ctx }) => done(ctx, await ctx.services.calls.answer())),
    hangUp: p
      .meta({ cap: "phone.calls" })
      .mutation(async ({ ctx }) => done(ctx, await ctx.services.calls.hangUp())),
  }),
  sms: api.router({
    threads: p
      .meta({ cap: "phone.sms", audit: true, summary: () => "Listed message threads" })
      .query(({ ctx }) => ctx.services.sms.threads()),
    read: p
      .meta({
        cap: "phone.sms",
        audit: true,
        summary: (i) => `Read messages with ${(i as { thread: string }).thread}`,
      })
      .input(z.object({ thread: z.string(), limit: z.number().int().min(1).max(500).default(50) }))
      .query(({ ctx, input }) => ctx.services.sms.read(input.thread, input.limit)),
    send: p
      .meta({ cap: "phone.sms" })
      .input(z.object({ to: PhoneNumber, text: z.string().min(1).max(5000) }))
      .mutation(async ({ ctx, input }) =>
        done(ctx, await ctx.services.sms.send(input.to, input.text)),
      ),
  }),
  clipboard: api.router({
    get: p
      .meta({ cap: "phone.clipboard", audit: true, summary: () => "Read the phone's clipboard" })
      .query(({ ctx }) => ctx.services.clipboard.get()),
    set: p
      .meta({ cap: "phone.clipboard" })
      .input(z.object({ text: z.string().max(1_000_000) }))
      .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.clipboard.set(input.text))),
  }),
  files: filesRouter(api, "phone.files", null, (ctx) => ctx.services.files),
  journal: journalRouter(api, "phone.journal", (ctx) => ctx.services.undo, capOf),
});

export type PhoneRouter = typeof phoneRouter;
export const createPhoneCaller = api.createCallerFactory(phoneRouter);

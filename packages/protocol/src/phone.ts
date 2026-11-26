/**
 * The phone's API, served by the app to the laptop. The app provides
 * `PhoneServices`; the same capability checks and journal apply, on the
 * phone, with the phone's own grants for this laptop.
 */

import { z } from "zod";
import { type Appearance, AppearanceMode } from "./appearance.js";
import { AppCall, AppEvent, type AppFrom, AppId, type AppInfo, type AppOutcome } from "./apps.js";
import type { Capability } from "./capabilities.js";
import { CHUNK, type Done, type FileService, filesRouter } from "./files.js";
import { journalRouter, type Undoer } from "./journalRouter.js";
import { SHARE_MAX, type ShareService, shareRouter } from "./share.js";
import { type Act, type BaseContext, createApi } from "./trpc.js";

export const PhoneStatus = z.object({
  name: z.string(),
  battery: z.object({ percent: z.number(), charging: z.boolean() }).nullable(),
  signal: z.object({ bars: z.number(), network: z.string() }).nullable(),
  locked: z.boolean().nullable(),
  awake: z.boolean(),
  /** Find my phone is ringing it. */
  ringing: z.boolean().optional(),
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

/** One line of the phone's call history, newest first. */
export const CallRecord = z.object({
  id: z.string(),
  number: z.string(),
  contact: z.string().nullable(),
  kind: z.enum(["in", "out", "missed", "declined"]),
  at: z.number(),
  /** Seconds; 0 for a call that wasn't picked up. */
  seconds: z.number(),
});
export type CallRecord = z.infer<typeof CallRecord>;

/** One of the laptop's notifications, shown on the phone. */
export const LaptopNotification = z.object({
  id: z.string().max(64),
  app: z.string().max(200),
  title: z.string().max(1000),
  text: z.string().max(10_000),
  /** The app's icon, a PNG in base64 (so the phone shows Firefox's, not ekatva's). */
  icon: z.string().max(200_000).optional(),
  /** The notification's own picture (an avatar, a screenshot's thumbnail), PNG/JPEG in base64. */
  picture: z.string().max(400_000).optional(),
  /** 0 low, 1 normal, 2 urgent. */
  urgency: z.number().int().min(0).max(2).optional(),
});
export type LaptopNotification = z.infer<typeof LaptopNotification>;

export interface PhoneServices {
  status(): Promise<PhoneStatus>;
  lock(): Promise<Done<null>>;
  /** Rings until stopped, at full volume, through silent and Do Not Disturb. */
  ring(from: string): Promise<Done<null>>;
  stopRinging(): Promise<Done<null>>;
  /** Keep the phone's screen on (jyoti, the other way). */
  keepAwake(on: boolean): Promise<Done<null>>;
  calls: {
    dial(number: string): Promise<Done<null>>;
    answer(): Promise<Done<null>>;
    hangUp(): Promise<Done<null>>;
    /** The call history, newest first (needs the call log permission on the phone). */
    log(limit: number): Promise<CallRecord[]>;
  };
  sms: {
    threads(): Promise<{ thread: string; contact: string | null; last: Sms }[]>;
    read(thread: string, limit: number): Promise<Sms[]>;
    send(to: string, text: string): Promise<Done<null>>;
  };
  clipboard: { get(): Promise<string>; set(text: string): Promise<Done<null>> };
  appearance: {
    /** The phone's system mode now. */
    get(): Promise<Appearance>;
    set(mode: AppearanceMode): Promise<Done<Appearance>>;
  };
  notifications: {
    /** Dismissed on the laptop: gone on the phone. */
    dismiss(id: string): Promise<Done<null>>;
    /** One of its buttons; `reply` for the one that takes text. */
    act(id: string, index: number, reply: string | null): Promise<Done<null>>;
    /** The laptop's own notifications, shown on the phone. */
    show(n: LaptopNotification): Promise<Done<null>>;
    close(id: string): Promise<Done<null>>;
  };
  files: FileService;
  share: ShareService;
  /**
   * The phone's Vayu apps, for the laptop. An app is reachable only once you
   * approved it on the phone (pinned to its signing certificate).
   */
  apps: {
    list(): Promise<AppInfo[]>;
    call(from: AppFrom, call: AppCall): Promise<AppOutcome<unknown>>;
    emit(from: AppFrom, event: AppEvent): Promise<AppOutcome<null>>;
    /** A file for a call, sent ahead of it; `finish` gives the ref the call names. */
    upload: {
      begin(app: string, name: string, size: number, from: string): Promise<{ id: string }>;
      put(id: string, data: string): Promise<void>;
      finish(id: string): Promise<{ ref: string }>;
      cancel(id: string): Promise<void>;
    };
  };
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

const appFrom = (ctx: PhoneContext): AppFrom => ({ key: ctx.actor.key, name: ctx.actor.name });
/** An app's call or event: its line for the log, or none (the manifest's `log: false`). */
function logged<T>(ctx: unknown, o: AppOutcome<T>): T {
  const a = (ctx as { act: Act }).act;
  a.summary = o.summary;
  if (!o.log) a.quiet = true;
  return o.value;
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
    .mutation(async ({ ctx }) => done(ctx, await ctx.services.ring(ctx.actor.name))),
  stopRinging: p
    .meta({ cap: "phone.lock" })
    .mutation(async ({ ctx }) => done(ctx, await ctx.services.stopRinging())),
  appearance: api.router({
    get: p.meta({ cap: "phone.appearance" }).query(({ ctx }) => ctx.services.appearance.get()),
    set: p
      .meta({ cap: "phone.appearance" })
      .input(z.object({ mode: AppearanceMode }))
      .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.appearance.set(input.mode))),
  }),
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
    log: p
      .meta({ cap: "phone.calls", audit: true, summary: () => "Read the call history" })
      .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
      .query(({ ctx, input }) => ctx.services.calls.log(input.limit)),
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
  notifications: api.router({
    dismiss: p
      .meta({ cap: "phone.notifications" })
      .input(z.object({ id: z.string().max(500) }))
      .mutation(async ({ ctx, input }) =>
        done(ctx, await ctx.services.notifications.dismiss(input.id)),
      ),
    act: p
      .meta({ cap: "phone.notifications" })
      .input(
        z.object({
          id: z.string().max(500),
          // -1, -2, -3: a call-style notification's Answer, Decline, Hang up.
          index: z.number().int().min(-3).max(10),
          reply: z.string().max(5000).nullable().default(null),
        }),
      )
      .mutation(async ({ ctx, input }) =>
        done(ctx, await ctx.services.notifications.act(input.id, input.index, input.reply)),
      ),
    show: p
      .meta({ cap: "phone.notifications", record: false })
      .input(LaptopNotification)
      .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.notifications.show(input))),
    close: p
      .meta({ cap: "phone.notifications", record: false })
      .input(z.object({ id: z.string().max(64) }))
      .mutation(async ({ ctx, input }) =>
        done(ctx, await ctx.services.notifications.close(input.id)),
      ),
  }),
  share: shareRouter(api, "phone.share", (ctx) => ctx.services.share),
  files: filesRouter(api, "phone.files", null, (ctx) => ctx.services.files),
  journal: journalRouter(api, "phone.journal", (ctx) => ctx.services.undo, capOf),
  apps: api.router({
    list: p.meta({ cap: "phone.apps" }).query(({ ctx }) => ctx.services.apps.list()),
    invoke: p
      .meta({ cap: "phone.apps" })
      .input(AppCall)
      .mutation(async ({ ctx, input }) =>
        logged(ctx, await ctx.services.apps.call(appFrom(ctx), input)),
      ),
    emit: p
      .meta({ cap: "phone.apps" })
      .input(AppEvent)
      .mutation(async ({ ctx, input }) =>
        logged(ctx, await ctx.services.apps.emit(appFrom(ctx), input)),
      ),
    upload: api.router({
      begin: p
        .meta({ cap: "phone.apps", record: false })
        .input(
          z.object({
            app: AppId,
            name: z.string().min(1).max(200),
            size: z.number().int().min(0).max(SHARE_MAX),
          }),
        )
        .mutation(({ ctx, input }) =>
          ctx.services.apps.upload.begin(input.app, input.name, input.size, ctx.actor.name),
        ),
      put: p
        .meta({ cap: "phone.apps", record: false })
        .input(z.object({ id: z.string().max(64), data: z.string().max(CHUNK * 2) }))
        .mutation(async ({ ctx, input }) => {
          await ctx.services.apps.upload.put(input.id, input.data);
          return null;
        }),
      finish: p
        .meta({ cap: "phone.apps", record: false })
        .input(z.object({ id: z.string().max(64) }))
        .mutation(({ ctx, input }) => ctx.services.apps.upload.finish(input.id)),
      cancel: p
        .meta({ cap: "phone.apps", record: false })
        .input(z.object({ id: z.string().max(64) }))
        .mutation(async ({ ctx, input }) => {
          await ctx.services.apps.upload.cancel(input.id);
          return null;
        }),
    }),
  }),
});

export type PhoneRouter = typeof phoneRouter;
export const createPhoneCaller = api.createCallerFactory(phoneRouter);

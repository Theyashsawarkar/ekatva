/**
 * The laptop's API, served by the daemon to the phone (and, over a local
 * socket, to the desktop window and the CLI). The procedures here are the
 * contract; the daemon provides `LaptopServices`.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Capability } from "./capabilities.js";
import { type Done, type FileService, filesRouter } from "./files.js";
import { journalRouter, type Undoer } from "./journalRouter.js";
import { type Act, type BaseContext, createApi } from "./trpc.js";

// ------------------------------------------------------------------ shapes
export const CaffeineLevel = z.enum(["off", "on", "high"]);
export type CaffeineLevel = z.infer<typeof CaffeineLevel>;

export const Caffeine = z.object({
  level: CaffeineLevel,
  /** When it was set, ms since the epoch. */
  since: z.number().nullable(),
  /** When it turns itself off, if it does. */
  until: z.number().nullable(),
  /** Whether "high" can keep the laptop on with the lid closed here. */
  lidHold: z.boolean(),
});
export type Caffeine = z.infer<typeof Caffeine>;

export const AgentState = z.enum(["working", "waiting", "idle", "done"]);

export const Question = z.object({
  text: z.string(),
  options: z.array(z.object({ key: z.string(), label: z.string() })),
  /** Identifies this exact question, so a late answer can't hit the next one. */
  hash: z.string(),
});
export type Question = z.infer<typeof Question>;

export const AgentSession = z.object({
  /** The tmux pane: "%12". */
  id: z.string(),
  /** The tmux session: "Aura_Arena". */
  session: z.string(),
  window: z.string(),
  agent: z.enum(["claude", "codex", "aider", "gemini", "other"]),
  project: z.string(),
  state: AgentState,
  question: Question.nullable(),
  /** What it last said or is doing, one line. */
  activity: z.string(),
  /** Since when it's in this state, ms since the epoch. */
  since: z.number(),
});
export type AgentSession = z.infer<typeof AgentSession>;

export const Project = z.object({
  path: z.string(),
  name: z.string(),
  lastUsed: z.number().nullable(),
});
export type Project = z.infer<typeof Project>;

export const Status = z.object({
  name: z.string(),
  battery: z.object({ percent: z.number(), charging: z.boolean() }).nullable(),
  cpu: z.number().nullable(),
  temperature: z.number().nullable(),
  uptime: z.number(),
  caffeine: CaffeineLevel,
  waiting: z.number(),
  locked: z.boolean().nullable(),
});
export type Status = z.infer<typeof Status>;

export const RootRequest = z.object({
  id: z.string(),
  /** "anumati" (an agent's root command) or "polkit" (an app wanting admin rights). */
  via: z.enum(["anumati", "polkit"]),
  requester: z.string(),
  reason: z.string(),
  commands: z.array(z.object({ cmd: z.string(), why: z.string() })),
  at: z.number(),
  /** waiting for an answer · checking the password · wrong (try again) */
  state: z.enum(["waiting", "checking", "wrong"]),
  /** Wrong passwords so far. */
  attempts: z.number(),
});
export type RootRequest = z.infer<typeof RootRequest>;

export const PhoneEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("notification"),
    id: z.string(),
    app: z.string(),
    title: z.string(),
    text: z.string(),
    actions: z.array(z.string()),
    removed: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("call"),
    state: z.enum(["ringing", "active", "ended", "missed"]),
    number: z.string(),
    contact: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("sms"),
    from: z.string(),
    contact: z.string().nullable(),
    text: z.string(),
    at: z.number(),
  }),
  z.object({ kind: z.literal("battery"), percent: z.number(), charging: z.boolean() }),
]);
export type PhoneEvent = z.infer<typeof PhoneEvent>;

// ---------------------------------------------------------------- services
export interface LaptopServices {
  status(): Promise<Status>;
  caffeine: {
    get(): Promise<Caffeine>;
    set(level: CaffeineLevel, minutes: number | null): Promise<Done<Caffeine>>;
    changes(signal: AbortSignal | undefined): AsyncIterable<Caffeine>;
  };
  power: {
    lock(): Promise<Done<null>>;
    suspend(): Promise<Done<null>>;
  };
  agents: {
    list(): Promise<AgentSession[]>;
    changes(signal: AbortSignal | undefined): AsyncIterable<AgentSession[]>;
    projects(): Promise<Project[]>;
    tail(id: string, lines: number): Promise<string>;
    answer(id: string, option: string, questionHash: string): Promise<Done<null>>;
    reply(id: string, text: string): Promise<Done<null>>;
    interrupt(id: string): Promise<Done<null>>;
    start(
      project: string,
      prompt: string | null,
      agent: "claude" | "codex",
    ): Promise<Done<AgentSession>>;
  };
  clipboard: {
    get(): Promise<string>;
    set(text: string): Promise<Done<null>>;
  };
  files: FileService;
  root: {
    pending(): Promise<RootRequest[]>;
    changes(signal: AbortSignal | undefined): AsyncIterable<RootRequest[]>;
    /** `allow`: which commands (by index) to run; all when null. */
    respond(
      id: string,
      approve: boolean,
      password: string | null,
      allow: number[] | null,
    ): Promise<Done<null>>;
  } | null;
  /** Events the phone reports (its notifications, calls, messages, battery). */
  phoneEvent(from: string, e: PhoneEvent): Promise<void>;
  undo: Undoer;
}

export const Device = z.object({
  key: z.string(),
  name: z.string(),
  grants: z.array(z.string()),
  pairedAt: z.number(),
  lastSeen: z.number().nullable(),
  online: z.boolean(),
  /** How it's connected right now. */
  via: z.enum(["lan", "tunnel"]).nullable(),
  info: z.record(z.string(), z.string()),
});
export type Device = z.infer<typeof Device>;

export const PendingPair = z.object({
  id: z.string(),
  name: z.string(),
  sas: z.array(z.string()),
  info: z.record(z.string(), z.string()),
  at: z.number(),
});
export type PendingPair = z.infer<typeof PendingPair>;

export const Offer = z.object({
  uri: z.string(),
  expires: z.number(),
  lan: z.array(z.string()),
  url: z.string().nullable(),
});
export type Offer = z.infer<typeof Offer>;

/** What only this laptop's own user does: from the desktop window or the CLI. */
export interface LocalServices {
  pair: {
    start(away: boolean): Promise<Offer>;
    pending(signal: AbortSignal | undefined): AsyncIterable<PendingPair[]>;
    confirm(id: string, accept: boolean, grants: string[]): Promise<Done<Device | null>>;
  };
  devices: {
    list(): Promise<Device[]>;
    watch(signal: AbortSignal | undefined): AsyncIterable<Device[]>;
    grant(key: string, grants: string[]): Promise<Done<Device>>;
    rename(key: string, name: string): Promise<Done<Device>>;
    unpair(key: string): Promise<Done<null>>;
  };
  log: {
    /** "self" for this laptop's log, or a device's key for its mirrored log. */
    list(host: string, after: number, limit: number): Promise<import("./journal.js").Entry[]>;
    check(): Promise<{ host: string; name: string; seq: number; problem: string | null }[]>;
  };
  /** Ask a phone to do something (it checks its own grants and logs it too). */
  phone(
    key: string | null,
    type: "query" | "mutation",
    path: string,
    input: unknown,
  ): Promise<unknown>;
}

export interface LaptopContext extends BaseContext {
  services: LaptopServices;
  /** Present only on the local socket. */
  local?: LocalServices;
}

// ------------------------------------------------------------------ router
const api = createApi<LaptopContext>();
const p = api.procedure;

const act = (ctx: unknown) => (ctx as { act: Act }).act;
function done<T>(ctx: unknown, d: Done<T>): T {
  const a = act(ctx);
  a.summary = d.summary;
  if (d.undo) a.undo = d.undo;
  return d.value;
}

async function* stream<T>(it: AsyncIterable<T>): AsyncGenerator<T> {
  yield* it;
}

const agents = api.router({
  list: p.meta({ cap: "agents" }).query(({ ctx }) => ctx.services.agents.list()),
  watch: p
    .meta({ cap: "agents" })
    .subscription(({ ctx, signal }) => stream(ctx.services.agents.changes(signal))),
  projects: p.meta({ cap: "agents.start" }).query(({ ctx }) => ctx.services.agents.projects()),
  tail: p
    .meta({
      cap: "agents",
      audit: true,
      summary: (i) => `Read the output of ${(i as { id: string }).id}`,
    })
    .input(z.object({ id: z.string(), lines: z.number().int().min(1).max(2000).default(200) }))
    .query(({ ctx, input }) => ctx.services.agents.tail(input.id, input.lines)),
  answer: p
    .meta({ cap: "agents" })
    .input(z.object({ id: z.string(), option: z.string().max(8), questionHash: z.string() }))
    .mutation(async ({ ctx, input }) =>
      done(ctx, await ctx.services.agents.answer(input.id, input.option, input.questionHash)),
    ),
  reply: p
    .meta({ cap: "agents" })
    .input(z.object({ id: z.string(), text: z.string().min(1).max(20_000) }))
    .mutation(async ({ ctx, input }) =>
      done(ctx, await ctx.services.agents.reply(input.id, input.text)),
    ),
  interrupt: p
    .meta({ cap: "agents" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.agents.interrupt(input.id))),
  start: p
    .meta({ cap: "agents.start" })
    .input(
      z.object({
        project: z.string(),
        prompt: z.string().max(20_000).nullable().default(null),
        agent: z.enum(["claude", "codex"]).default("claude"),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      done(ctx, await ctx.services.agents.start(input.project, input.prompt, input.agent)),
    ),
});

const caffeine = api.router({
  get: p.meta({ cap: "status" }).query(({ ctx }) => ctx.services.caffeine.get()),
  watch: p
    .meta({ cap: "status" })
    .subscription(({ ctx, signal }) => stream(ctx.services.caffeine.changes(signal))),
  set: p
    .meta({ cap: "power" })
    .input(
      z.object({
        level: CaffeineLevel,
        minutes: z
          .number()
          .int()
          .min(1)
          .max(7 * 24 * 60)
          .nullable()
          .default(null),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      done(ctx, await ctx.services.caffeine.set(input.level, input.minutes)),
    ),
});

const power = api.router({
  lock: p
    .meta({ cap: "power" })
    .mutation(async ({ ctx }) => done(ctx, await ctx.services.power.lock())),
  suspend: p
    .meta({ cap: "power" })
    .mutation(async ({ ctx }) => done(ctx, await ctx.services.power.suspend())),
});

const clipboard = api.router({
  get: p
    .meta({ cap: "clipboard", audit: true, summary: () => "Read the clipboard" })
    .query(({ ctx }) => ctx.services.clipboard.get()),
  set: p
    .meta({ cap: "clipboard" })
    .input(z.object({ text: z.string().max(1_000_000) }))
    .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.clipboard.set(input.text))),
});

const rootService = (ctx: LaptopContext) => {
  if (!ctx.services.root)
    throw new TRPCError({
      code: "NOT_IMPLEMENTED",
      message: "root approvals aren't set up on this laptop",
    });
  return ctx.services.root;
};
const root = api.router({
  pending: p.meta({ cap: "root" }).query(({ ctx }) => rootService(ctx).pending()),
  watch: p
    .meta({ cap: "root" })
    .subscription(({ ctx, signal }) => stream(rootService(ctx).changes(signal))),
  respond: p
    .meta({ cap: "root" })
    .input(
      z.object({
        id: z.string(),
        approve: z.boolean(),
        password: z.string().max(1024).nullable().default(null),
        allow: z.array(z.number().int().min(0)).max(64).nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      done(
        ctx,
        await rootService(ctx).respond(input.id, input.approve, input.password, input.allow),
      ),
    ),
});

const inbox = api.router({
  report: p
    .meta({ cap: "phone.notifications", record: false })
    .input(PhoneEvent)
    .mutation(async ({ ctx, input }) => {
      act(ctx).summary = `Phone: ${input.kind}`;
      await ctx.services.phoneEvent(ctx.actor.key, input);
      return null;
    }),
});

/** Every procedure's capability, by path, for undo checks. */
function capOf(action: string): Capability | undefined {
  const proc = (
    localRouter._def.procedures as unknown as Record<
      string,
      { _def: { meta?: { cap: Capability } } }
    >
  )[action];
  return proc?._def.meta?.cap;
}

export const laptopRouter = api.router({
  status: p.meta({ cap: "status" }).query(({ ctx }) => ctx.services.status()),
  agents,
  caffeine,
  power,
  clipboard,
  files: filesRouter(api, "files", "files.private", (ctx) => ctx.services.files),
  journal: journalRouter(api, "journal", (ctx) => ctx.services.undo, capOf),
  root,
  inbox,
});

export type LaptopRouter = typeof laptopRouter;

const local = (ctx: LaptopContext) => {
  if (!ctx.local) throw new TRPCError({ code: "FORBIDDEN", message: "only on this laptop" });
  return ctx.local;
};
const Grants = z.array(z.string()).max(64);

const admin = api.router({
  pair: api.router({
    start: p
      .meta({ cap: "admin" })
      .input(z.object({ away: z.boolean().default(false) }))
      .mutation(async ({ ctx, input }) => {
        act(ctx).summary = `Showed a pairing code${input.away ? " (reachable from anywhere)" : ""}`;
        return local(ctx).pair.start(input.away);
      }),
    pending: p
      .meta({ cap: "admin" })
      .subscription(({ ctx, signal }) => stream(local(ctx).pair.pending(signal))),
    confirm: p
      .meta({ cap: "admin" })
      .input(z.object({ id: z.string(), accept: z.boolean(), grants: Grants.default([]) }))
      .mutation(async ({ ctx, input }) =>
        done(ctx, await local(ctx).pair.confirm(input.id, input.accept, input.grants)),
      ),
  }),
  devices: api.router({
    list: p.meta({ cap: "admin" }).query(({ ctx }) => local(ctx).devices.list()),
    watch: p
      .meta({ cap: "admin" })
      .subscription(({ ctx, signal }) => stream(local(ctx).devices.watch(signal))),
    grant: p
      .meta({ cap: "admin" })
      .input(z.object({ key: z.string(), grants: Grants }))
      .mutation(async ({ ctx, input }) =>
        done(ctx, await local(ctx).devices.grant(input.key, input.grants)),
      ),
    rename: p
      .meta({ cap: "admin" })
      .input(z.object({ key: z.string(), name: z.string().min(1).max(64) }))
      .mutation(async ({ ctx, input }) =>
        done(ctx, await local(ctx).devices.rename(input.key, input.name)),
      ),
    unpair: p
      .meta({ cap: "admin" })
      .input(z.object({ key: z.string() }))
      .mutation(async ({ ctx, input }) => done(ctx, await local(ctx).devices.unpair(input.key))),
  }),
  log: api.router({
    list: p
      .meta({ cap: "admin" })
      .input(
        z.object({
          host: z.string().default("self"),
          after: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(1000).default(200),
        }),
      )
      .query(({ ctx, input }) => local(ctx).log.list(input.host, input.after, input.limit)),
    check: p.meta({ cap: "admin" }).query(({ ctx }) => local(ctx).log.check()),
  }),
  phone: api.router({
    query: p
      .meta({ cap: "admin" })
      .input(
        z.object({
          key: z.string().nullable().default(null),
          path: z.string().max(100),
          input: z.unknown().optional(),
        }),
      )
      .query(({ ctx, input }) => local(ctx).phone(input.key, "query", input.path, input.input)),
    mutate: p
      .meta({ cap: "admin" })
      .input(
        z.object({
          key: z.string().nullable().default(null),
          path: z.string().max(100),
          input: z.unknown().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        act(ctx).summary = `Asked the phone: ${input.path}`;
        return local(ctx).phone(input.key, "mutation", input.path, input.input);
      }),
  }),
});

/**
 * What the local socket serves: the laptop's API (as this laptop's own
 * user, with every capability) and `admin`.
 */
export const localRouter = api.router({ ...laptopRouter._def.record, admin });
export type LocalRouter = typeof localRouter;
export const createLaptopCaller = api.createCallerFactory(laptopRouter);

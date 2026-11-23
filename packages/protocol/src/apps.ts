/**
 * Apps talking through ekatva: any Vayu app on the phone with any Vayu app
 * on the laptop, over the one encrypted link (LAN or the tunnel). An app
 * never opens a connection or holds a key; it asks ekatva.
 *
 *   phone app ⇄ ekatva (phone) ══ Noise link ══ ekatva daemon ⇄ laptop app
 *
 * Two kinds of message, addressed by app id ("nada", "vagdevi", "echo"):
 *   call    a method on the other side's app, one answer (or an error in words)
 *   event   fire-and-forget; `keep` holds it (up to a day) until the app is there
 *
 * Each app declares itself in a manifest: its methods and events, why it
 * wants each, and how risky each is. A device reaches an app only with the
 * `app:<id>` grant (off until you give it), checked on the side that runs it.
 */
import { z } from "zod";

/** "nada", "vagdevi", "echo": lower case, digits and dashes. */
export const AppId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,31}$/, "an app id is 2 to 32 lower-case letters, digits or dashes");
export type AppId = z.infer<typeof AppId>;

/** "play", "queue.add", "position.set". */
export const AppMethodName = z
  .string()
  .regex(/^[a-zA-Z][\w.-]{0,63}$/, "a method name is letters, digits, dots, dashes");

/** The grant that lets a device reach an app: "app:nada". */
export type AppGrant = `app:${string}`;
export const appGrant = (id: string): AppGrant => `app:${id}`;
export const isAppGrant = (g: string): g is AppGrant => /^app:[a-z][a-z0-9-]{1,31}$/.test(g);

export const AppMethod = z.object({
  name: AppMethodName,
  /** Why the app wants it, shown when you grant it: "Play and pause the laptop's music". */
  why: z.string().min(1).max(200),
  risk: z.enum(["low", "medium", "high"]).default("low"),
  /** Write it in the action log (false for reads polled often, like "status"). */
  log: z.boolean().default(true),
});
export type AppMethod = z.infer<typeof AppMethod>;

export const AppManifest = z.object({
  id: AppId,
  /** "nāda": how people see it. */
  name: z.string().min(1).max(40),
  version: z.string().min(1).max(20),
  /** What the other side may call on this app. */
  methods: z.array(AppMethod).max(64).default([]),
  /** Events this app accepts from the other side. */
  events: z.array(AppMethod).max(64).default([]),
  /** At most this many calls and events a minute, from each device. */
  rate: z.number().int().min(1).max(600).default(60),
});
export type AppManifest = z.infer<typeof AppManifest>;
export type AppManifestInput = z.input<typeof AppManifest>;

/** A body's largest size, as JSON: bulk data (a song, a book) goes through `share`. */
export const APP_BODY_MAX = 1024 * 1024;
/** How long a call waits for the app's answer. */
export const APP_CALL_TIMEOUT_MS = 15_000;
/** The longest an event may be kept for an app that isn't there. */
export const APP_KEEP_MAX_S = 24 * 60 * 60;
/** Kept events per app; the oldest go first. */
export const APP_KEEP_MAX = 200;

export const AppCall = z.object({
  app: AppId,
  method: AppMethodName,
  input: z.unknown(),
});
export type AppCall = z.infer<typeof AppCall>;

export const AppEvent = z.object({
  app: AppId,
  name: AppMethodName,
  data: z.unknown(),
  /** Seconds to hold it when the app isn't there (0: drop it). */
  keep: z.number().int().min(0).max(APP_KEEP_MAX_S).default(0),
});
export type AppEvent = z.infer<typeof AppEvent>;
export type AppEventInput = z.input<typeof AppEvent>;

/** One app, as the other side sees it. */
export const AppInfo = z.object({
  id: AppId,
  name: z.string(),
  version: z.string(),
  side: z.enum(["laptop", "phone"]),
  /** Running and registered right now. */
  online: z.boolean(),
  /** The asking device holds its `app:<id>` grant. */
  granted: z.boolean(),
  methods: z.array(AppMethod),
  events: z.array(AppMethod),
});
export type AppInfo = z.infer<typeof AppInfo>;

/** Who sent a message: the device (its key and name). */
export const AppFrom = z.object({ key: z.string(), name: z.string() });
export type AppFrom = z.infer<typeof AppFrom>;

/** What a registered app receives. */
export const AppIncoming = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("call"),
    /** Answer with `apps.reply` and this id. */
    id: z.string(),
    from: AppFrom,
    method: z.string(),
    input: z.unknown(),
  }),
  z.object({
    kind: z.literal("event"),
    from: AppFrom,
    name: z.string(),
    data: z.unknown(),
    /** When it was sent (ms), for a kept one that waited. */
    at: z.number(),
  }),
]);
export type AppIncoming = z.infer<typeof AppIncoming>;

export const AppReply = z.union([
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: z.string().min(1).max(500) }),
]);
export type AppReply = z.infer<typeof AppReply>;

/** The size of a body as JSON, in bytes (an unserialisable one counts as too big). */
export function bodySize(v: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(v ?? null)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** A laptop app as this laptop's own window sees it: which phones may reach it. */
export const LaptopApp = AppInfo.extend({
  /** Keys of the devices holding its `app:<id>` grant. */
  grantedTo: z.array(z.string()),
  /** When it last registered (ms), or null if it never has since the service started. */
  seen: z.number().nullable(),
});
export type LaptopApp = z.infer<typeof LaptopApp>;

/** What a call or event did, for the action log. */
export interface AppOutcome<T> {
  value: T;
  /** "nāda: play". */
  summary: string;
  /** Write it in the log (the manifest's `log` for that method). */
  log: boolean;
}

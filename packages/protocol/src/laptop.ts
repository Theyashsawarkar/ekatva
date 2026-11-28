/**
 * The laptop's API, served by the daemon to the phone (and, over a local
 * socket, to the desktop window and the CLI). The procedures here are the
 * contract; the daemon provides `LaptopServices`.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { type Appearance, AppearanceMode } from "./appearance.js";
import {
  AppCall,
  AppEvent,
  type AppFrom,
  AppId,
  type AppIncoming,
  type AppInfo,
  AppManifest,
  type AppOutcome,
  AppReply,
  type AppsState,
  appGrant,
  type LaptopApp,
} from "./apps.js";
import { CAPABILITIES, type Capability, PRESETS } from "./capabilities.js";
import { CHUNK, type Done, type FileService, filesRouter } from "./files.js";
import { journalRouter, type Undoer } from "./journalRouter.js";
import { SHARE_MAX, type ShareService, shareRouter } from "./share.js";
import { type Act, type BaseContext, createApi } from "./trpc.js";

// ------------------------------------------------------------------ shapes
/** off = Śānta; on = Akhaṇḍa; high = Nandādīpa (the wire keeps the older names). */
export const JyotiLevel = z.enum(["off", "on", "high"]);
export type JyotiLevel = z.infer<typeof JyotiLevel>;

export const Jyoti = z.object({
  level: JyotiLevel,
  /** When it was set, ms since the epoch. */
  since: z.number().nullable(),
  /** When it turns itself off, if it does. */
  until: z.number().nullable(),
  /** Whether "high" can keep the laptop on with the lid closed here. */
  lidHold: z.boolean(),
});
export type Jyoti = z.infer<typeof Jyoti>;

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
  /** How to call it: the agent's own name for the session, else the tmux session's. */
  name: z.string(),
  /** Its whole history can be read, and it can be renamed and told to send now (Claude Code). */
  rich: z.boolean().default(false),
  /** Your messages waiting for it to finish. */
  queued: z.number().default(0),
  window: z.string(),
  agent: z.enum(["claude", "codex", "aider", "gemini", "other"]),
  project: z.string(),
  state: AgentState,
  question: Question.nullable(),
  /** What it last said or is doing, one line. */
  activity: z.string(),
  /** Since when it's in this state, ms since the epoch. */
  since: z.number(),
  /** Its background agents still at work ("security-reviewer", "Reading the tests"). */
  background: z.array(z.object({ name: z.string(), activity: z.string() })).default([]),
});
export type AgentSession = z.infer<typeof AgentSession>;

/** A session's screen as a conversation (see the daemon's agentTranscript.ts). */
export const AgentBlock = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("you"), text: z.string() }),
  z.object({ kind: z.literal("says"), text: z.string() }),
  z.object({ kind: z.literal("tool"), title: z.string(), output: z.string() }),
  z.object({ kind: z.literal("note"), text: z.string() }),
]);
export type AgentBlock = z.infer<typeof AgentBlock>;
export const AgentTranscript = z.object({
  blocks: z.array(AgentBlock),
  /** What it's doing right now, when it's working. */
  status: z.string().nullable(),
});
export type AgentTranscript = z.infer<typeof AgentTranscript>;

/** One thing in a session's history (see the daemon's claudeHistory.ts). */
export const AgentItem = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("you"),
    n: z.number(),
    at: z.number(),
    text: z.string(),
    images: z.number(),
  }),
  z.object({ kind: z.literal("says"), n: z.number(), at: z.number(), text: z.string() }),
  z.object({
    kind: z.literal("tool"),
    n: z.number(),
    at: z.number(),
    name: z.string(),
    title: z.string(),
    /** What it ran or changed ("- old", "+ new" for an edit). */
    detail: z.string(),
    state: z.enum(["running", "ok", "error"]),
    output: z.string(),
    /** The output is longer: agents.output has all of it. */
    cut: z.boolean(),
  }),
  z.object({
    kind: z.literal("note"),
    n: z.number(),
    at: z.number(),
    text: z.string(),
    tone: z.enum(["plain", "error"]),
  }),
]);
export type AgentItem = z.infer<typeof AgentItem>;
/** Part of a history: items `first`… of `total`, numbered within `epoch`. */
export interface AgentPage {
  /** Item numbers hold while this stays the same (a rewind or another session changes it). */
  epoch: string;
  total: number;
  items: AgentItem[];
}
/** A history followed live: the latest items first, then what's added or changed. */
export interface AgentUpdate extends AgentPage {
  /** Start over with these items (the first update, a rewind, a new session in the pane). */
  reset: boolean;
  queued: string[];
  /** What it's doing right now, when it's working. */
  status: string | null;
}

export const Project = z.object({
  path: z.string(),
  name: z.string(),
  lastUsed: z.number().nullable(),
});
export type Project = z.infer<typeof Project>;

export const Status = z.object({
  name: z.string(),
  battery: z
    .object({
      percent: z.number(),
      charging: z.boolean(),
      /** On the charger (charging, full, or held at a charge limit). Older laptops leave it out. */
      plugged: z.boolean().optional(),
    })
    .nullable(),
  cpu: z.number().nullable(),
  temperature: z.number().nullable(),
  uptime: z.number(),
  jyoti: JyotiLevel,
  waiting: z.number(),
  locked: z.boolean().nullable(),
  /** What keeps phones on the same network out (a firewall), with the fix; null when nothing. */
  firewall: z.object({ problem: z.string(), fix: z.string() }).nullable().optional(),
});
export type Status = z.infer<typeof Status>;

export const RootRequest = z.object({
  id: z.string(),
  /** "anumati" (an agent's root command, through dvarapala: the wire keeps its old name so
   *  phones on older builds still understand it) or "polkit" (an app wanting admin rights). */
  via: z.enum(["anumati", "polkit"]),
  requester: z.string(),
  reason: z.string(),
  commands: z.array(z.object({ cmd: z.string(), why: z.string() })),
  at: z.number(),
  /** waiting for an answer · checking the password · wrong (try again) */
  state: z.enum(["waiting", "checking", "wrong"]),
  /** Wrong passwords so far. */
  attempts: z.number(),
  /** The window's own id: its entry in the history, once it ends. */
  ref: z.string().nullable().optional(),
});
export type RootRequest = z.infer<typeof RootRequest>;

/** A tmux session on the laptop (the terminal opens the first: the one used last). */
export const TerminalSession = z.object({
  name: z.string(),
  windows: z.number(),
  /** A terminal at the laptop shows it now. */
  attached: z.boolean(),
  /** Last output and last attached, ms since the epoch. */
  activity: z.number(),
  lastAttached: z.number(),
});
export type TerminalSession = z.infer<typeof TerminalSession>;

/** A terminal tab: a window of one of the laptop's tmux sessions. */
export const TerminalTab = z.object({
  /** tmux's window id: "@3". */
  id: z.string(),
  index: z.number(),
  active: z.boolean(),
  /** What runs in it now ("zsh", "nvim"). */
  command: z.string(),
  path: z.string(),
  /** tmux's window name. */
  name: z.string().default(""),
});
export type TerminalTab = z.infer<typeof TerminalTab>;

/**
 * A short hash of an answer, so a phone polling something big (a terminal's
 * screen, an agent's conversation) is told "unchanged" instead of getting it
 * all again. FNV-1a over its JSON: fast, and collisions only cost a skipped
 * refresh until the next change.
 */
export function answerHash(value: unknown): string {
  const text = JSON.stringify(value);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).slice(0, 16);
}

/** An answer with its hash, or just "unchanged" when the asker has it already. */
export type Unchanged = { unchanged: true; hash: string };
export function unlessSame<T extends object>(
  value: T,
  unless: string | undefined,
): (T & { hash: string }) | Unchanged {
  const hash = answerHash(value);
  return unless === hash ? { unchanged: true, hash } : { ...value, hash };
}

export const TerminalScreen = z.object({
  /** The screen and some history above it, with ANSI colours. */
  text: z.string(),
  cursor: z.object({ x: z.number(), y: z.number() }),
  cols: z.number(),
  rows: z.number(),
  /** Lines of history above the screen in `text`. */
  above: z.number(),
});
export type TerminalScreen = z.infer<typeof TerminalScreen>;

/** A finished root request: how it ended, who answered, each command's outcome. */
export const RootHistoryEntry = z.object({
  id: z.string(),
  requester: z.string(),
  reason: z.string(),
  at: z.number(),
  /** completed · denied · timeout · auth_failed · failed (the window's words) */
  status: z.string(),
  where: z.enum(["phone", "laptop"]),
  commands: z.array(
    z.object({
      cmd: z.string(),
      decision: z.string(),
      state: z.string(),
      exitCode: z.number().nullable(),
    }),
  ),
});
export type RootHistoryEntry = z.infer<typeof RootHistoryEntry>;

export const PlayerStatus = z.enum(["Playing", "Paused", "Stopped"]);
export const Player = z.object({
  /** The MPRIS name: "nada", "drishya", "chromium.instance42". */
  id: z.string(),
  /** For people: "nāda", "Chromium". */
  name: z.string(),
  status: PlayerStatus,
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  /**
   * The cover, by id: fetch it once with media.art({ id }) and keep it (it was sent
   * whole, as a data: URL, on every poll). Null when there's none.
   */
  artId: z.string().nullable(),
  /** Milliseconds; null when the player doesn't say. */
  length: z.number().nullable(),
  position: z.number().nullable(),
  /** When `position` was read, ms since the epoch (a playing track moves on from there). */
  at: z.number(),
  /** The songs either side of this one in its queue, when the player says (nāda, through MPD). */
  prev: z.object({ title: z.string(), artist: z.string() }).nullable().optional(),
  next: z.object({ title: z.string(), artist: z.string() }).nullable().optional(),
});
export type Player = z.infer<typeof Player>;

export const Media = z.object({
  /** The one to show first (playing, else the first), then the rest. */
  players: z.array(Player),
  volume: z.object({ percent: z.number(), muted: z.boolean() }).nullable(),
  /** The screen's brightness in percent; null without a backlight. */
  brightness: z.number().nullable(),
});
export type Media = z.infer<typeof Media>;

export const MediaAction = z.enum(["play-pause", "play", "pause", "next", "previous", "stop"]);
export type MediaAction = z.infer<typeof MediaAction>;

export const MouseButton = z.enum(["left", "right", "middle"]);
export type MouseButton = z.infer<typeof MouseButton>;
/** A key or a chord: "Return", "ctrl+c", "super+shift+q". */
export const KeyCombo = z
  .string()
  .regex(/^([a-z]+\+)*[A-Za-z0-9_]+$/, "a key like Return or ctrl+c")
  .max(60);

/** One of the laptop's notifications, as the phone's history shows it. */
export interface LaptopNoteEntry {
  id: string;
  app: string;
  title: string;
  body: string;
  /** ms since 1970. */
  at: number;
  /** 0 low, 1 normal, 2 urgent. */
  urgency: number;
  /** A key into `icons`, or null when the app has none. */
  icon: string | null;
}
export interface LaptopNoteHistory {
  items: LaptopNoteEntry[];
  /** key → PNG in base64. */
  icons: Record<string, string>;
}

export const PhoneEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("notification"),
    id: z.string(),
    app: z.string(),
    title: z.string(),
    text: z.string(),
    actions: z.array(z.string()),
    /** Which of `actions` takes typed text (Reply), if any. */
    reply: z.number().int().nullable().default(null),
    removed: z.boolean().default(false),
    /** An app's call (WhatsApp, Meet…): ringing, or going on. */
    call: z.boolean().default(false),
    /** A call-style notification says which it is (WhatsApp's video calls). */
    callState: z.enum(["ringing", "active"]).nullish(),
    /** A video call (the app marks it, or says so). */
    video: z.boolean().nullish(),
    /** Its own Answer / Decline / Hang up (pressed with index -1, -2, -3). */
    callButtons: z
      .array(z.enum(["answer", "decline", "hangup"]))
      .max(3)
      .nullish(),
    /** The app's package (com.whatsapp): its icon is cached by it. */
    // null counts as none: phone apps sent null for "no picture", and every
    // such notification was refused (and retried, blocking calls behind it).
    package: z
      .string()
      .max(200)
      .nullish()
      .transform((v) => v ?? undefined),
    /** The app's icon, a small PNG in base64 (newer phone apps send it). */
    icon: z
      .string()
      .max(200_000)
      .nullish()
      .transform((v) => v ?? undefined),
    /** The notification's own picture (a contact's photo), a PNG in base64. */
    picture: z
      .string()
      .max(400_000)
      .nullish()
      .transform((v) => v ?? undefined),
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
  link: {
    route(): Promise<Route>;
    /** The route now, then every change (the tunnel's new URL). */
    changes(signal: AbortSignal | undefined): AsyncIterable<Route>;
  };
  jyoti: {
    get(): Promise<Jyoti>;
    set(level: JyotiLevel, minutes: number | null): Promise<Done<Jyoti>>;
    changes(signal: AbortSignal | undefined): AsyncIterable<Jyoti>;
  };
  power: {
    lock(): Promise<Done<null>>;
    /**
     * Types the password into the lock screen; PAM decides. Never logged.
     * `was`: whether it was locked (an unlock of an unlocked laptop does nothing).
     */
    unlock(password: string): Promise<Done<{ was: "locked" | "unlocked" }>>;
    suspend(): Promise<Done<null>>;
  };
  agents: {
    list(): Promise<AgentSession[]>;
    changes(signal: AbortSignal | undefined): AsyncIterable<AgentSession[]>;
    projects(): Promise<Project[]>;
    tail(id: string, lines: number): Promise<string>;
    transcript(id: string, lines: number): Promise<AgentTranscript>;
    answer(id: string, option: string, questionHash: string): Promise<Done<null>>;
    /** A page of the whole history: `limit` items before item `before` (null: the latest). */
    history(id: string, before: number | null, limit: number): Promise<AgentPage>;
    follow(id: string, signal: AbortSignal | undefined): AsyncIterable<AgentUpdate>;
    /** A tool's whole output. */
    output(id: string, n: number, epoch: string): Promise<string>;
    rename(id: string, name: string): Promise<Done<null>>;
    /** What's queued goes to it at once, without waiting for it to finish. */
    sendNow(id: string): Promise<Done<null>>;
    reply(id: string, text: string, now: boolean): Promise<Done<null>>;
    interrupt(id: string): Promise<Done<null>>;
    start(
      project: string,
      prompt: string | null,
      agent: "claude" | "codex",
    ): Promise<Done<AgentSession>>;
  };
  media: {
    get(): Promise<Media>;
    changes(signal: AbortSignal | undefined): AsyncIterable<Media>;
    /** `player` null: the one shown first. */
    control(player: string | null, action: MediaAction): Promise<Done<null>>;
    seek(player: string | null, position: number): Promise<Done<null>>;
    volume(change: { percent?: number; muted?: boolean }): Promise<Done<null>>;
    brightness(percent: number): Promise<Done<null>>;
    /** A cover by its `artId`: an http(s) or data: URL (at most 256 KB), or null. */
    art(id: string): Promise<string | null>;
  };
  appearance: {
    /** The desktop's mode now (Vayu: varna's mode; else the GTK color-scheme). */
    get(): Promise<Appearance>;
    set(mode: AppearanceMode): Promise<Done<Appearance>>;
  };
  clipboard: {
    get(): Promise<string>;
    set(text: string): Promise<Done<null>>;
    /** One clipboard across both: whether it's on, and turning it on or off. */
    sync: { get(): Promise<boolean>; set(on: boolean): Promise<Done<null>> };
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
    /** The latest finished requests, newest first. */
    history(): Promise<RootHistoryEntry[]>;
  } | null;
  /** The laptop's own notifications (the phone dismisses one it shows, and reads their history). */
  notifications: {
    dismiss(id: string): Promise<Done<null>>;
    /** The latest, newest first, with their apps' icons (each once). */
    history(): Promise<LaptopNoteHistory>;
  };
  /** Keyboard and pointer, from the phone's trackpad. */
  input: {
    move(dx: number, dy: number): Promise<void>;
    click(button: MouseButton, double: boolean): Promise<void>;
    scroll(dx: number, dy: number): Promise<void>;
    type(text: string): Promise<Done<null>>;
    key(combo: string): Promise<Done<null>>;
  };
  share: ShareService;
  terminal: {
    sessions(): Promise<TerminalSession[]>;
    tabs(session: string): Promise<TerminalTab[]>;
    newTab(session: string): Promise<Done<TerminalTab[]>>;
    newSession(name: string | null, cols: number, rows: number): Promise<Done<TerminalSession[]>>;
    closeTab(id: string): Promise<Done<TerminalTab[]>>;
    screen(id: string, history: number): Promise<TerminalScreen>;
    send(id: string, text: string | null, keys: string[]): Promise<void>;
    action(id: string, what: "split" | "scroll"): Promise<void>;
  };
  /** Events the phone reports (its notifications, calls, messages, battery). */
  phoneEvent(from: string, e: PhoneEvent): Promise<void>;
  /** The laptop's Vayu apps, for a phone (each reached only with its `app:<id>` grant). */
  apps: {
    /** `granted`: whether the asking device holds an app's grant. */
    list(granted: (id: string) => boolean): Promise<AppInfo[]>;
    /** `call.files[].path` are upload refs (from `upload`), turned into the app's copies here. */
    call(from: AppFrom, call: AppCall): Promise<AppOutcome<unknown>>;
    emit(from: AppFrom, event: AppEvent): Promise<AppOutcome<null>>;
    /** A file for a call, sent ahead of it into the app's inbox; `finish` gives its ref. */
    upload: {
      begin(app: string, name: string, size: number, from: string): Promise<{ id: string }>;
      put(id: string, data: string): Promise<void>;
      finish(id: string): Promise<{ ref: string }>;
      cancel(id: string): Promise<void>;
    };
  };
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

/** The laptop's tunnel, as the phone and the window see it. */
export const TunnelInfo = z.object({
  kind: z.enum(["named", "cloudflared", "ngrok", "tailscale", "none"]),
  /** off · starting (or waiting to try again) · up · missing (not installed) */
  state: z.enum(["off", "starting", "up", "missing"]),
  url: z.string().nullable(),
  /** Kept up all the time (a phone is paired), or only on demand. */
  always: z.boolean(),
  since: z.number().nullable(),
  problem: z.string().nullable(),
  /** kind "named": its address, set in the window or config.toml, changeable while running. */
  hostname: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
});
export type TunnelInfo = z.infer<typeof TunnelInfo>;

/**
 * Every way to reach the laptop right now: its tunnel (from anywhere) and
 * its addresses on the local network. A connected phone keeps it, so it
 * can come back through the tunnel after leaving the Wi-Fi, without a QR.
 */
/** The tunnel's settings, changed while the service runs (they replace config.toml's). */
export const TunnelSettings = z
  .object({
    kind: z.enum(["named", "cloudflared", "ngrok", "tailscale", "none"]),
    /** kind "named": the address its DNS record gives, like ekatva-tunnel.example.dev. */
    hostname: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/,
        "a hostname, like ekatva-tunnel.example.dev",
      )
      .nullable()
      .default(null),
    /** kind "named": the tunnel's name in your Cloudflare account. */
    name: z
      .string()
      .regex(/^[\w.-]{1,64}$/)
      .default("ekatva"),
  })
  .refine((t) => t.kind !== "named" || !!t.hostname, {
    message: "a named tunnel needs its address",
    path: ["hostname"],
  });
export type TunnelSettings = z.infer<typeof TunnelSettings>;

export const Route = z.object({
  /** The tunnel's wss:// URL, when it is up. */
  url: z.string().nullable(),
  /** host:port on the local network. */
  lan: z.array(z.string()),
  tunnel: TunnelInfo,
});
export type Route = z.infer<typeof Route>;

export const Offer = z.object({
  uri: z.string(),
  expires: z.number(),
  lan: z.array(z.string()),
  url: z.string().nullable(),
});
export type Offer = z.infer<typeof Offer>;

/** A call on a phone right now, for the laptop's window. */
export const CallNow = z.object({
  device: z.string(),
  name: z.string(),
  state: z.enum(["ringing", "active"]),
  number: z.string(),
  contact: z.string().nullable(),
  since: z.number(),
  /** An app's call (WhatsApp, Meet…), not the phone's own. */
  app: z.string().nullable().default(null),
  /** A video call. */
  video: z.boolean().default(false),
});
export type CallNow = z.infer<typeof CallNow>;

/** What only this laptop's own user does: from the desktop window or the CLI. */
export interface LocalServices {
  /** The tunnel's settings: applied at once (the phones hear the new address). */
  tunnel: { set(t: TunnelSettings): Promise<Done<TunnelInfo>> };
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
  calls: {
    /** The phone's call right now (null when there's none), and every change. */
    watch(signal: AbortSignal | undefined): AsyncIterable<CallNow | null>;
  };
  log: {
    /** "self" for this laptop's log, or a device's key for its mirrored log. */
    list(host: string, after: number, limit: number): Promise<import("./journal.js").Entry[]>;
    check(): Promise<{ host: string; name: string; seq: number; problem: string | null }[]>;
  };
  /** This laptop's Vayu apps: they link here once, and reach the phone's apps. */
  apps: {
    /**
     * An app asks to link (or, linked, attaches) while the subscription
     * lasts: first a "status" (waiting, linked, refused), then what it
     * receives. `program` is who asked, when it could be found.
     */
    register(
      manifest: AppManifest,
      signal: AbortSignal | undefined,
      program: string | null,
    ): AsyncIterable<AppIncoming>;
    /** An app's answer to a call it received. */
    reply(reply: AppReply): Promise<void>;
    /** Laptop apps (linked), with the phones granted each. */
    list(): Promise<LaptopApp[]>;
    /** The Apps page now, then again whenever anything on it changes. */
    watch(signal: AbortSignal | undefined): AsyncIterable<LaptopAppsView>;
    /** Accept an app asking to link: linked for good, and every phone may reach it. */
    accept(id: string): Promise<Done<null>>;
    /** Refuse it: it isn't asked about again until you clear that. */
    refuse(id: string): Promise<Done<null>>;
    /** Clear a refusal: it may ask again. */
    unrefuse(id: string): Promise<Done<null>>;
    /** Unlink an app: its link, its phones' grants and its routes go. */
    unlink(id: string): Promise<Done<null>>;
    /** Your answer to a new route (the call waiting on it goes on, or fails). */
    decideRoute(id: string, answer: "always" | "once" | "refuse"): Promise<Done<null>>;
    removeRoute(caller: string, to: string): Promise<Done<null>>;
    /**
     * A call from this laptop (you, an agent, or a laptop app) to an app on
     * either side, with files (laptop paths) moved across first.
     */
    call(c: LocalAppCall): Promise<AppOutcome<unknown>>;
    emit(e: LocalAppEmit): Promise<null>;
    /** A phone's apps, as it reports them. */
    phoneApps(device: string | null): Promise<AppInfo[]>;
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
  /** Local socket: the agent this connection says it acts for ("claude"), if any. */
  agent?: string;
  /** Local socket: the program at the other end ("python3 …/bridge.py"), when it can be found. */
  peer?: () => Promise<string | null>;
}

/** A call from this laptop, addressed to an app on either side. */
export const LocalAppCall = z.object({
  /** "phone:vagdevi" or "laptop:nada". */
  to: z.string(),
  method: z.string(),
  input: z.unknown().default(null),
  /** Laptop paths, sent along (each at most 4 GB). */
  files: z.array(z.string().min(1).max(4096)).max(16).default([]),
  /** Which phone (null: the one connected last). */
  device: z.string().nullable().default(null),
  /** A laptop app calling as itself (its id); else the agent, else you. */
  as: AppId.optional(),
});
export type LocalAppCall = z.infer<typeof LocalAppCall> & { caller: string };
export const LocalAppEmit = z.object({
  to: z.string(),
  name: z.string(),
  data: z.unknown().default(null),
  keep: z.number().int().min(0).max(86_400).default(0),
  device: z.string().nullable().default(null),
  as: AppId.optional(),
});
export type LocalAppEmit = z.infer<typeof LocalAppEmit> & { caller: string };

/** This laptop's Apps page: the apps, and what's waiting for you. */
export interface LaptopAppsView extends AppsState {
  apps: LaptopApp[];
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
  transcript: p
    .meta({
      cap: "agents",
      audit: true,
      summary: (i) => `Read the conversation in ${(i as { id: string }).id}`,
    })
    .input(
      z.object({
        id: z.string(),
        lines: z.number().int().min(20).max(3000).default(500),
        /** The hash of the answer the phone has: if it's still the same, only that is said. */
        unless: z.string().max(64).optional(),
      }),
    )
    .query(async ({ ctx, input }) =>
      unlessSame(await ctx.services.agents.transcript(input.id, input.lines), input.unless),
    ),
  answer: p
    .meta({ cap: "agents" })
    .input(z.object({ id: z.string(), option: z.string().max(8), questionHash: z.string() }))
    .mutation(async ({ ctx, input }) =>
      done(ctx, await ctx.services.agents.answer(input.id, input.option, input.questionHash)),
    ),
  reply: p
    .meta({ cap: "agents" })
    .input(
      z.object({
        id: z.string(),
        text: z.string().min(1).max(20_000),
        /** Working: don't wait in its queue, take it now. */
        now: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      done(ctx, await ctx.services.agents.reply(input.id, input.text, input.now)),
    ),
  history: p
    .meta({
      cap: "agents",
      audit: true,
      summary: (i) => `Read the history of ${(i as { id: string }).id}`,
    })
    .input(
      z.object({
        id: z.string(),
        before: z.number().int().min(0).nullable().default(null),
        limit: z.number().int().min(1).max(200).default(60),
      }),
    )
    .query(({ ctx, input }) => ctx.services.agents.history(input.id, input.before, input.limit)),
  follow: p
    .meta({
      cap: "agents",
      audit: true,
      summary: (i) => `Read the conversation in ${(i as { id: string }).id}`,
    })
    .input(z.object({ id: z.string() }))
    .subscription(({ ctx, input, signal }) => stream(ctx.services.agents.follow(input.id, signal))),
  output: p
    .meta({
      cap: "agents",
      audit: true,
      summary: (i) => `Read the output of a tool in ${(i as { id: string }).id}`,
    })
    .input(z.object({ id: z.string(), n: z.number().int().min(0), epoch: z.string().max(100) }))
    .query(({ ctx, input }) => ctx.services.agents.output(input.id, input.n, input.epoch)),
  rename: p
    .meta({ cap: "agents" })
    .input(
      z.object({
        id: z.string(),
        name: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .regex(/^[^\p{C}]+$/u),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      done(ctx, await ctx.services.agents.rename(input.id, input.name)),
    ),
  sendNow: p
    .meta({ cap: "agents" })
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.agents.sendNow(input.id))),
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

const jyoti = api.router({
  get: p.meta({ cap: "status" }).query(({ ctx }) => ctx.services.jyoti.get()),
  watch: p
    .meta({ cap: "status" })
    .subscription(({ ctx, signal }) => stream(ctx.services.jyoti.changes(signal))),
  set: p
    .meta({ cap: "power" })
    .input(
      z.object({
        level: JyotiLevel,
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
      done(ctx, await ctx.services.jyoti.set(input.level, input.minutes)),
    ),
});

const appearance = api.router({
  get: p.meta({ cap: "appearance" }).query(({ ctx }) => ctx.services.appearance.get()),
  set: p
    .meta({ cap: "appearance" })
    .input(z.object({ mode: AppearanceMode }))
    .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.appearance.set(input.mode))),
});

const power = api.router({
  lock: p
    .meta({ cap: "power" })
    .mutation(async ({ ctx }) => done(ctx, await ctx.services.power.lock())),
  suspend: p
    .meta({ cap: "power" })
    .mutation(async ({ ctx }) => done(ctx, await ctx.services.power.suspend())),
  unlock: p
    .meta({ cap: "unlock" })
    .input(z.object({ password: z.string().min(1).max(1024) }))
    .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.power.unlock(input.password))),
});

const Which = z.string().max(200).nullable().default(null);
const media = api.router({
  get: p.meta({ cap: "media" }).query(({ ctx }) => ctx.services.media.get()),
  art: p
    .meta({ cap: "media" })
    .input(z.object({ id: z.string().min(1).max(64) }))
    .query(({ ctx, input }) => ctx.services.media.art(input.id)),
  watch: p
    .meta({ cap: "media" })
    .subscription(({ ctx, signal }) => stream(ctx.services.media.changes(signal))),
  control: p
    .meta({ cap: "media" })
    .input(z.object({ player: Which, action: MediaAction }))
    .mutation(async ({ ctx, input }) =>
      done(ctx, await ctx.services.media.control(input.player, input.action)),
    ),
  seek: p
    .meta({ cap: "media" })
    .input(z.object({ player: Which, position: z.number().int().min(0) }))
    .mutation(async ({ ctx, input }) =>
      done(ctx, await ctx.services.media.seek(input.player, input.position)),
    ),
  volume: p
    .meta({ cap: "media" })
    .input(
      z
        .object({
          percent: z.number().int().min(0).max(100).optional(),
          muted: z.boolean().optional(),
        })
        .refine((v) => v.percent !== undefined || v.muted !== undefined, "nothing to change"),
    )
    .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.media.volume(input))),
  brightness: p
    .meta({ cap: "media" })
    .input(z.object({ percent: z.number().int().min(1).max(100) }))
    .mutation(async ({ ctx, input }) =>
      done(ctx, await ctx.services.media.brightness(input.percent)),
    ),
});

const clipboard = api.router({
  get: p
    .meta({ cap: "clipboard", audit: true, summary: () => "Read the clipboard" })
    .query(({ ctx }) => ctx.services.clipboard.get()),
  set: p
    .meta({ cap: "clipboard" })
    .input(z.object({ text: z.string().max(1_000_000) }))
    .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.clipboard.set(input.text))),
  sync: api.router({
    get: p.meta({ cap: "clipboard" }).query(({ ctx }) => ctx.services.clipboard.sync.get()),
    set: p
      .meta({ cap: "clipboard" })
      .input(z.object({ on: z.boolean() }))
      .mutation(async ({ ctx, input }) =>
        done(ctx, await ctx.services.clipboard.sync.set(input.on)),
      ),
  }),
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
  history: p
    .meta({ cap: "root", audit: true, summary: () => "Read the root requests' history" })
    .query(({ ctx }) => rootService(ctx).history()),
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

const notifications = api.router({
  history: p
    .meta({ cap: "notifications", record: false })
    .query(({ ctx }) => ctx.services.notifications.history()),
  dismiss: p
    .meta({ cap: "notifications" })
    .input(z.object({ id: z.string().max(64) }))
    .mutation(async ({ ctx, input }) =>
      done(ctx, await ctx.services.notifications.dismiss(input.id)),
    ),
});

/** Moving the pointer is far too frequent to log; typing and keys are logged (by length). */
const input = api.router({
  move: p
    .meta({ cap: "input", record: false })
    .input(z.object({ dx: z.number().min(-5000).max(5000), dy: z.number().min(-5000).max(5000) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.input.move(input.dx, input.dy);
      return null;
    }),
  click: p
    .meta({ cap: "input", record: false })
    .input(z.object({ button: MouseButton.default("left"), double: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.input.click(input.button, input.double);
      return null;
    }),
  scroll: p
    .meta({ cap: "input", record: false })
    .input(z.object({ dx: z.number().min(-100).max(100), dy: z.number().min(-100).max(100) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.input.scroll(input.dx, input.dy);
      return null;
    }),
  type: p
    .meta({ cap: "input" })
    .input(z.object({ text: z.string().min(1).max(10_000) }))
    .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.input.type(input.text))),
  key: p
    .meta({ cap: "input" })
    .input(z.object({ combo: KeyCombo }))
    .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.input.key(input.combo))),
});

const TabId = z.string().regex(/^@\d+$/, "a terminal tab");
/** A tmux session's name: never ":" or "." (tmux's separators) or a control character. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
const SessionName = z.string().regex(/^[^:.\x00-\x1f$@%=][^:.\x00-\x1f]{0,63}$/, "a session name");

/**
 * The terminal: the laptop's own tmux sessions. Reading the screen and moving
 * about isn't logged; typing is (by length).
 */
const terminal = api.router({
  sessions: p.meta({ cap: "terminal" }).query(({ ctx }) => ctx.services.terminal.sessions()),
  tabs: p
    .meta({ cap: "terminal" })
    .input(z.object({ session: SessionName }))
    .query(({ ctx, input }) => ctx.services.terminal.tabs(input.session)),
  newTab: p
    .meta({ cap: "terminal" })
    .input(z.object({ session: SessionName }))
    .mutation(async ({ ctx, input }) =>
      done(ctx, await ctx.services.terminal.newTab(input.session)),
    ),
  newSession: p
    .meta({ cap: "terminal" })
    .input(
      z.object({
        name: SessionName.nullable().default(null),
        cols: z.number().int().min(20).max(400).default(60),
        rows: z.number().int().min(5).max(200).default(30),
      }),
    )
    .mutation(async ({ ctx, input }) =>
      done(ctx, await ctx.services.terminal.newSession(input.name, input.cols, input.rows)),
    ),
  closeTab: p
    .meta({ cap: "terminal" })
    .input(z.object({ id: TabId }))
    .mutation(async ({ ctx, input }) => done(ctx, await ctx.services.terminal.closeTab(input.id))),
  screen: p
    .meta({ cap: "terminal" })
    .input(
      z.object({
        id: TabId,
        history: z.number().int().min(0).max(2000).default(200),
        /** The hash of the screen the phone has: if it's still the same, only that is said. */
        unless: z.string().max(64).optional(),
      }),
    )
    .query(async ({ ctx, input }) =>
      unlessSame(await ctx.services.terminal.screen(input.id, input.history), input.unless),
    ),
  type: p
    .meta({ cap: "terminal" })
    .input(
      z.object({
        id: TabId,
        text: z.string().min(1).max(10_000),
        enter: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.services.terminal.send(input.id, input.text, input.enter ? ["Enter"] : []);
      act(ctx).summary =
        `Typed in the terminal (${input.text.length} characters${input.enter ? ", Enter" : ""})`;
      return null;
    }),
  keys: p
    .meta({ cap: "terminal", record: false })
    .input(z.object({ id: TabId, keys: z.array(z.string().max(12)).min(1).max(32) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.terminal.send(input.id, null, input.keys);
      return null;
    }),
  /** tmux itself: split the window, or scroll back through it (copy mode). */
  action: p
    .meta({ cap: "terminal", record: false })
    .input(z.object({ id: TabId, action: z.enum(["split", "scroll"]) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.services.terminal.action(input.id, input.action);
      return null;
    }),
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

/** The laptop's apps, for a phone: each one needs its own `app:<id>` grant too. */
const allowedApp = (ctx: LaptopContext, id: string) => {
  if (!ctx.grants.has(appGrant(id)))
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `this device may not use the app "${id}" (grant app:${id})`,
    });
};
const from = (ctx: LaptopContext): AppFrom => ({ key: ctx.actor.key, name: ctx.actor.name });
const logged = <T>(ctx: unknown, o: AppOutcome<T>): T => {
  const a = act(ctx);
  a.summary = o.summary;
  if (!o.log) a.quiet = true;
  return o.value;
};

const apps = api.router({
  list: p
    .meta({ cap: "apps" })
    .query(({ ctx }) => ctx.services.apps.list((id) => ctx.grants.has(appGrant(id)))),
  invoke: p
    .meta({ cap: "apps" })
    .input(AppCall)
    .mutation(async ({ ctx, input }) => {
      allowedApp(ctx, input.app);
      return logged(ctx, await ctx.services.apps.call(from(ctx), input));
    }),
  emit: p
    .meta({ cap: "apps" })
    .input(AppEvent)
    .mutation(async ({ ctx, input }) => {
      allowedApp(ctx, input.app);
      return logged(ctx, await ctx.services.apps.emit(from(ctx), input));
    }),
  /** Files for a call, sent ahead of it (in CHUNK pieces, base64). */
  upload: api.router({
    begin: p
      .meta({ cap: "apps", record: false })
      .input(
        z.object({
          app: AppId,
          name: z.string().min(1).max(200),
          size: z.number().int().min(0).max(SHARE_MAX),
        }),
      )
      .mutation(({ ctx, input }) => {
        allowedApp(ctx, input.app);
        return ctx.services.apps.upload.begin(input.app, input.name, input.size, ctx.actor.name);
      }),
    put: p
      .meta({ cap: "apps", record: false })
      .input(z.object({ id: z.string().max(64), data: z.string().max(CHUNK * 2) }))
      .mutation(async ({ ctx, input }) => {
        await ctx.services.apps.upload.put(input.id, input.data);
        return null;
      }),
    finish: p
      .meta({ cap: "apps", record: false })
      .input(z.object({ id: z.string().max(64) }))
      .mutation(({ ctx, input }) => ctx.services.apps.upload.finish(input.id)),
    cancel: p
      .meta({ cap: "apps", record: false })
      .input(z.object({ id: z.string().max(64) }))
      .mutation(async ({ ctx, input }) => {
        await ctx.services.apps.upload.cancel(input.id);
        return null;
      }),
  }),
});

const link = api.router({
  route: p.meta({ cap: "status" }).query(({ ctx }) => ctx.services.link.route()),
  watch: p
    .meta({ cap: "status" })
    .subscription(({ ctx, signal }) => stream(ctx.services.link.changes(signal))),
});

export const laptopRouter = api.router({
  status: p.meta({ cap: "status" }).query(({ ctx }) => ctx.services.status()),
  link,
  agents,
  jyoti,
  power,
  media,
  appearance,
  clipboard,
  files: filesRouter(api, "files", "files.private", (ctx) => ctx.services.files),
  journal: journalRouter(api, "journal", (ctx) => ctx.services.undo, capOf),
  root,
  notifications,
  input,
  terminal,
  share: shareRouter(api, "share", (ctx) => ctx.services.share),
  inbox,
  apps,
});

export type LaptopRouter = typeof laptopRouter;

const local = (ctx: LaptopContext) => {
  if (!ctx.local) throw new TRPCError({ code: "FORBIDDEN", message: "only on this laptop" });
  return ctx.local;
};
const Grants = z.array(z.string()).max(64);

const admin = api.router({
  /** What each permission is, and the presets: one source for every window. */
  capabilities: p
    .meta({ cap: "admin" })
    .query(() => ({ capabilities: CAPABILITIES, presets: PRESETS })),
  calls: api.router({
    watch: p
      .meta({ cap: "admin" })
      .subscription(({ ctx, signal }) => stream(local(ctx).calls.watch(signal))),
  }),
  /** The route (the tunnel's state) for the window: same as the phone's `link.watch`. */
  link: api.router({
    route: p.meta({ cap: "admin" }).query(({ ctx }) => ctx.services.link.route()),
    watch: p
      .meta({ cap: "admin" })
      .subscription(({ ctx, signal }) => stream(ctx.services.link.changes(signal))),
    /** The tunnel's kind and address, now (no restart). */
    set: p
      .meta({ cap: "admin" })
      .input(TunnelSettings)
      .mutation(async ({ ctx, input }) => done(ctx, await local(ctx).tunnel.set(input))),
  }),
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
 * This laptop's own Vayu apps, on the local socket: they ask to link (and,
 * linked, attach), answer calls, and reach apps on either side. The Apps
 * page (Darpaṇa) accepts links and routes here.
 */
/** Who a local call comes from: the agent (it can't pass for an app), else the app it names, else you. */
const localCaller = (ctx: LaptopContext, as?: string): string =>
  ctx.agent ? `agent:${ctx.agent}` : (as ?? "you");
const localApps = api.router({
  /** Ask to link, then stay attached while subscribed: a status first, then calls and events. */
  register: p
    .meta({ cap: "admin" })
    .input(AppManifest)
    .subscription(async function* ({ ctx, input, signal }) {
      const program = (await ctx.peer?.().catch(() => null)) ?? null;
      yield* local(ctx).apps.register(input, signal, program);
    }),
  reply: p
    .meta({ cap: "admin", record: false })
    .input(AppReply)
    .mutation(async ({ ctx, input }) => {
      await local(ctx).apps.reply(input);
      return null;
    }),
  list: p.meta({ cap: "admin" }).query(({ ctx }) => local(ctx).apps.list()),
  watch: p
    .meta({ cap: "admin" })
    .subscription(({ ctx, signal }) => stream(local(ctx).apps.watch(signal))),
  accept: p
    .meta({ cap: "admin" })
    .input(z.object({ id: AppId }))
    .mutation(async ({ ctx, input }) => done(ctx, await local(ctx).apps.accept(input.id))),
  refuse: p
    .meta({ cap: "admin" })
    .input(z.object({ id: AppId }))
    .mutation(async ({ ctx, input }) => done(ctx, await local(ctx).apps.refuse(input.id))),
  unrefuse: p
    .meta({ cap: "admin" })
    .input(z.object({ id: AppId }))
    .mutation(async ({ ctx, input }) => done(ctx, await local(ctx).apps.unrefuse(input.id))),
  /** Unlink (the old name, forget, still works). */
  forget: p
    .meta({ cap: "admin" })
    .input(z.object({ id: AppId }))
    .mutation(async ({ ctx, input }) => done(ctx, await local(ctx).apps.unlink(input.id))),
  unlink: p
    .meta({ cap: "admin" })
    .input(z.object({ id: AppId }))
    .mutation(async ({ ctx, input }) => done(ctx, await local(ctx).apps.unlink(input.id))),
  route: p
    .meta({ cap: "admin" })
    .input(z.object({ id: z.string().max(64), answer: z.enum(["always", "once", "refuse"]) }))
    .mutation(async ({ ctx, input }) =>
      done(ctx, await local(ctx).apps.decideRoute(input.id, input.answer)),
    ),
  unroute: p
    .meta({ cap: "admin" })
    .input(z.object({ caller: z.string().max(80), to: z.string().max(80) }))
    .mutation(async ({ ctx, input }) =>
      done(ctx, await local(ctx).apps.removeRoute(input.caller, input.to)),
    ),
  /** A phone's apps (`device` null: the phone connected last). */
  phone: p
    .meta({ cap: "admin" })
    .input(z.object({ device: z.string().nullable().default(null) }))
    .query(({ ctx, input }) => local(ctx).apps.phoneApps(input.device)),
  /**
   * Call an app on either side (`to`: "phone:vagdevi", "laptop:nada"; the old
   * `app` means "phone:APP"), with files sent along.
   */
  invoke: p
    .meta({ cap: "admin" })
    .input(LocalAppCall.partial({ to: true }).extend({ app: AppId.optional() }))
    .mutation(async ({ ctx, input }) => {
      const to = input.to ?? (input.app ? `phone:${input.app}` : null);
      if (!to) throw new TRPCError({ code: "BAD_REQUEST", message: "say which app (to)" });
      const caller = localCaller(ctx, input.as);
      return logged(ctx, await local(ctx).apps.call({ ...input, to, caller }));
    }),
  emit: p
    .meta({ cap: "admin", record: false })
    .input(LocalAppEmit.partial({ to: true }).extend({ app: AppId.optional() }))
    .mutation(({ ctx, input }) => {
      const to = input.to ?? (input.app ? `phone:${input.app}` : null);
      if (!to) throw new TRPCError({ code: "BAD_REQUEST", message: "say which app (to)" });
      return local(ctx).apps.emit({ ...input, to, caller: localCaller(ctx, input.as) });
    }),
});

/**
 * What the local socket serves: the laptop's API (as this laptop's own
 * user, with every capability), `admin`, and `apps` for this laptop's own
 * apps (in place of the phone's view of them).
 */
export const localRouter = api.router({
  ...laptopRouter._def.record,
  apps: localApps,
  admin,
});
export type LocalRouter = typeof localRouter;
export const createLaptopCaller = api.createCallerFactory(laptopRouter);

/**
 * What a paired device may do, one capability at a time. A new feature
 * adds a capability here; it is off on every existing pairing until you
 * grant it.
 */
export const CAPABILITIES = {
  // ---- on the laptop, asked by the phone
  status: {
    side: "laptop",
    risk: "low",
    title: "See the laptop's state",
    detail: "battery, CPU, what's playing, what's waiting",
  },
  agents: {
    side: "laptop",
    risk: "high",
    title: "Use your AI agents",
    detail: "see sessions, answer their questions, reply, interrupt",
  },
  "agents.start": {
    side: "laptop",
    risk: "high",
    title: "Start agent sessions",
    detail: "a new Claude session in one of your projects",
  },
  files: {
    side: "laptop",
    risk: "high",
    title: "Your files",
    detail: "browse, read, create, change, move and delete (undoable)",
  },
  "files.private": {
    side: "laptop",
    risk: "critical",
    title: "Private files too",
    detail: "~/.ssh, ~/.gnupg, keyrings, ekatva's own keys",
  },
  media: {
    side: "laptop",
    risk: "low",
    title: "Media, volume, brightness",
    detail: "nāda, drishya and any player",
  },
  power: {
    side: "laptop",
    risk: "medium",
    title: "Lock, sleep, caffeine",
    detail: "including staying on with the lid closed",
  },
  clipboard: { side: "laptop", risk: "medium", title: "The clipboard", detail: "read and set it" },
  input: {
    side: "laptop",
    risk: "high",
    title: "Keyboard and pointer",
    detail: "type and click on the laptop",
  },
  screen: {
    side: "laptop",
    risk: "high",
    title: "See the screen",
    detail: "the laptop's screen, live",
  },
  notifications: {
    side: "laptop",
    risk: "low",
    title: "Notifications",
    detail: "see and dismiss the laptop's",
  },
  root: {
    side: "laptop",
    risk: "critical",
    title: "Approve root",
    detail: "anumati and polkit prompts, with your password typed on the phone",
  },
  journal: {
    side: "laptop",
    risk: "medium",
    title: "The action log",
    detail: "read it and undo actions",
  },
  /** This laptop's own user (the desktop window, the CLI); never granted to a phone. */
  admin: {
    side: "laptop",
    risk: "critical",
    title: "Manage ekatva",
    detail: "pair, unpair, change what devices may do",
  },
  // ---- on the phone, asked by the laptop
  "phone.status": {
    side: "phone",
    risk: "low",
    title: "See the phone's state",
    detail: "battery, signal",
  },
  "phone.calls": {
    side: "phone",
    risk: "high",
    title: "Calls",
    detail: "place, answer and end calls",
  },
  "phone.sms": { side: "phone", risk: "high", title: "Messages", detail: "read and send SMS" },
  "phone.notifications": {
    side: "phone",
    risk: "medium",
    title: "Notifications",
    detail: "mirror them and use their actions",
  },
  "phone.files": {
    side: "phone",
    risk: "high",
    title: "The phone's files",
    detail: "browse, read, create, change, move and delete (undoable)",
  },
  "phone.lock": {
    side: "phone",
    risk: "low",
    title: "Lock and ring",
    detail: "lock the phone, ring it, keep its screen on",
  },
  "phone.clipboard": {
    side: "phone",
    risk: "medium",
    title: "The phone's clipboard",
    detail: "read and set it",
  },
  "phone.journal": {
    side: "phone",
    risk: "medium",
    title: "The phone's action log",
    detail: "read it and undo actions",
  },
} as const satisfies Record<
  string,
  {
    side: "laptop" | "phone";
    risk: "low" | "medium" | "high" | "critical";
    title: string;
    detail: string;
  }
>;

export type Capability = keyof typeof CAPABILITIES;
/** Everything a device can be granted (all but `admin`). */
export const ALL = (Object.keys(CAPABILITIES) as Capability[]).filter((c) => c !== "admin");
/** What this laptop's own user may do: everything. */
export const LOCAL = Object.keys(CAPABILITIES) as Capability[];

/** Keeps only real, grantable capabilities. */
export function grantable(list: readonly string[]): Capability[] {
  return [...new Set(list)].filter((c): c is Capability => isCapability(c) && c !== "admin");
}

export const PRESETS = {
  everything: ALL,
  "everything-but-root": ALL.filter((c) => c !== "root" && c !== "files.private"),
  "media-and-notifications": [
    "status",
    "media",
    "notifications",
    "phone.status",
    "phone.notifications",
    "phone.lock",
  ],
} as const satisfies Record<string, readonly Capability[]>;
export type Preset = keyof typeof PRESETS;

export function isCapability(c: string): c is Capability {
  return Object.hasOwn(CAPABILITIES, c);
}

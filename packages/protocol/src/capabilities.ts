/**
 * What a paired device may do, one capability at a time. A new feature
 * adds a capability here; it is off on every existing pairing until you
 * grant it.
 */
import { type AppGrant, isAppGrant } from "./apps.js";

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
    title: "Lock, sleep, jyoti",
    detail: "keeping it awake, even with the lid closed",
  },
  clipboard: { side: "laptop", risk: "medium", title: "The clipboard", detail: "read and set it" },
  appearance: {
    side: "laptop",
    risk: "low",
    title: "Light and dark",
    detail: "switch the laptop between light and dark mode",
  },
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
  terminal: {
    side: "laptop",
    risk: "critical",
    title: "A terminal on the laptop",
    detail: "a shell as you, in your tmux sessions",
  },
  share: {
    side: "laptop",
    risk: "medium",
    title: "Send files and links",
    detail: "files land in ~/Downloads, links open in the browser, text on the clipboard",
  },
  root: {
    side: "laptop",
    risk: "critical",
    title: "Approve root",
    detail: "dvarapala and polkit prompts, with your password typed on the phone",
  },
  unlock: {
    side: "laptop",
    risk: "critical",
    title: "Unlock the laptop",
    detail: "your laptop password, typed into the lock screen from the phone",
  },
  apps: {
    side: "laptop",
    risk: "medium",
    title: "Your laptop apps",
    detail: "talk to Vayu apps on the laptop (nāda…), each one only with its own app: grant",
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
  "phone.appearance": {
    side: "phone",
    risk: "low",
    title: "The phone's light and dark",
    detail: "switch the phone between light and dark mode",
  },
  "phone.clipboard": {
    side: "phone",
    risk: "medium",
    title: "The phone's clipboard",
    detail: "read and set it",
  },
  "phone.share": {
    side: "phone",
    risk: "medium",
    title: "Send files and links to the phone",
    detail: "files land in Download/ekatva, links open, text on the clipboard",
  },
  "phone.apps": {
    side: "phone",
    risk: "medium",
    title: "The phone's apps",
    detail: "talk to Vayu apps on the phone (nāda…), each one only with its own app: grant",
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

/** Keeps only real, grantable capabilities, and apps' grants ("app:nada"). */
export function grantable(list: readonly string[]): (Capability | AppGrant)[] {
  return [...new Set(list)].filter(
    (c): c is Capability | AppGrant => (isCapability(c) && c !== "admin") || isAppGrant(c),
  );
}

export const PRESETS = {
  everything: ALL,
  "everything-but-root": ALL.filter((c) => c !== "root" && c !== "files.private" && c !== "unlock"),
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

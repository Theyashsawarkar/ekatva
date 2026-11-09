/**
 * The window's keys, vim-like: Normal mode (keys are commands) and Insert
 * mode (typing in a text field), `Space` as the leader with the same groups
 * as every Vayu tool, counts (`5j`), key sequences (`gg`, `Space c o`).
 *
 * This file is the one place keys are described: `KEYS` below. The
 * components bind actions to these keys (`useBinds` in keys.tsx), the `?`
 * sheet, the which-key strip and the palette are built from it, and the
 * `# keybind:` lines (read by Vayu's keybinding search) must match it
 * (test/keys.test.ts checks).
 *
 * # keybind: Ekatva/window | j / k | Move the selection down / up (a count first repeats: 5j)
 * # keybind: Ekatva/window | g g / G | Jump to the first / last item
 * # keybind: Ekatva/window | H / L | Switch to the previous / next tab
 * # keybind: Ekatva/window | 1 / 2 / 3 / 4 | Switch to a tab (Phones, Log, Caffeine, Phone)
 * # keybind: Ekatva/window | r | Reload what this tab shows
 * # keybind: Ekatva/window | ? | Show the keys of this tab
 * # keybind: Ekatva/window | Esc | Close the pairing code, a panel or this help (in a text field: back to normal mode)
 * # keybind: Ekatva/window | Space Space | Open the palette of every key (Enter runs it)
 * # keybind: Ekatva/window | Space ? | Show the keys of this tab
 * # keybind: Ekatva/window | Space q | Close the window
 * # keybind: Ekatva/window | Space t p / t l / t c / t h | Switch to the Phones / Log / Caffeine / Phone tab
 * # keybind: Ekatva/window | Space c o / c i / c h | Set caffeine off / on / high
 * # keybind: Ekatva/window | Space p r | Start phone ring (find the phone)
 * # keybind: Ekatva/window | Space p l | Lock the phone
 * # keybind: Ekatva/window | Space p k | Toggle the phone's screen staying on
 * # keybind: Ekatva/window | Space a p | Add a phone (shows the pairing code; works from any network)
 * # keybind: Ekatva/phones | h / l | Switch between the phone list and its permissions
 * # keybind: Ekatva/phones | Enter | Toggle the selected permission (permissions side)
 * # keybind: Ekatva/phones | Space m g | Toggle the selected permission
 * # keybind: Ekatva/phones | Space d d | Remove the phone's pairing (unpair; y confirms)
 * # keybind: Ekatva/pairing | Enter | Confirm pairing request (when the emoji match)
 * # keybind: Ekatva/pairing | x | Cancel pairing request (refuse the phone)
 * # keybind: Ekatva/log | u | Undo the selected log entry (y confirms)
 * # keybind: Ekatva/phone | i | Focus the clipboard text (insert mode; Esc leaves it)
 * # keybind: Ekatva/phone | Space y c | Copy the clipboard text to the phone
 * # keybind: Ekatva/phone | Enter / l | Open the selected folder
 * # keybind: Ekatva/phone | h | Go up a folder
 * # keybind: Ekatva/caffeine | Enter | Set the selected caffeine level
 */

export type Scope = "window" | "phones" | "pairing" | "log" | "phone" | "caffeine";

/** Every key, once: what the `?` sheet, which-key, the palette and the annotations show. */
export const KEYS: { scope: Scope; keys: string; desc: string }[] = [
  { scope: "window", keys: "H", desc: "Previous tab" },
  { scope: "window", keys: "L", desc: "Next tab" },
  { scope: "window", keys: "1", desc: "Phones tab" },
  { scope: "window", keys: "2", desc: "Log tab" },
  { scope: "window", keys: "3", desc: "Caffeine tab" },
  { scope: "window", keys: "4", desc: "Phone tab" },
  { scope: "window", keys: "r", desc: "Reload" },
  { scope: "window", keys: "?", desc: "These keys" },
  { scope: "window", keys: "Space ?", desc: "These keys" },
  { scope: "window", keys: "Space Space", desc: "Palette: every key" },
  { scope: "window", keys: "Esc", desc: "Close the pairing code" },
  { scope: "window", keys: "Space q", desc: "Close the window" },
  { scope: "window", keys: "Space t p", desc: "Phones tab" },
  { scope: "window", keys: "Space t l", desc: "Log tab" },
  { scope: "window", keys: "Space t c", desc: "Caffeine tab" },
  { scope: "window", keys: "Space t h", desc: "Phone tab" },
  { scope: "window", keys: "Space c o", desc: "Caffeine off" },
  { scope: "window", keys: "Space c i", desc: "Caffeine on" },
  { scope: "window", keys: "Space c h", desc: "High caffeine" },
  { scope: "window", keys: "Space p r", desc: "Ring the phone" },
  { scope: "window", keys: "Space p l", desc: "Lock the phone" },
  { scope: "window", keys: "Space p k", desc: "Keep its screen on / let it sleep" },
  { scope: "window", keys: "Space a p", desc: "Pair a phone" },
  { scope: "phones", keys: "j", desc: "Next" },
  { scope: "phones", keys: "k", desc: "Previous" },
  { scope: "phones", keys: "g g", desc: "First" },
  { scope: "phones", keys: "G", desc: "Last" },
  { scope: "phones", keys: "h", desc: "The phone list" },
  { scope: "phones", keys: "l", desc: "Its permissions" },
  { scope: "phones", keys: "Enter", desc: "Toggle the permission" },
  { scope: "phones", keys: "Space m g", desc: "Toggle the permission" },
  { scope: "phones", keys: "Space d d", desc: "Unpair the phone" },
  { scope: "pairing", keys: "Enter", desc: "They match: pair" },
  { scope: "pairing", keys: "x", desc: "Refuse the phone" },
  { scope: "log", keys: "j", desc: "Next entry" },
  { scope: "log", keys: "k", desc: "Previous entry" },
  { scope: "log", keys: "g g", desc: "Newest" },
  { scope: "log", keys: "G", desc: "Oldest" },
  { scope: "log", keys: "u", desc: "Undo the entry" },
  { scope: "log", keys: "r", desc: "Reload the log" },
  { scope: "phone", keys: "j", desc: "Next file" },
  { scope: "phone", keys: "k", desc: "Previous file" },
  { scope: "phone", keys: "g g", desc: "First file" },
  { scope: "phone", keys: "G", desc: "Last file" },
  { scope: "phone", keys: "Enter", desc: "Open the folder" },
  { scope: "phone", keys: "l", desc: "Open the folder" },
  { scope: "phone", keys: "h", desc: "Up a folder" },
  { scope: "phone", keys: "i", desc: "Type clipboard text" },
  { scope: "phone", keys: "Space y c", desc: "Send the clipboard text" },
  { scope: "phone", keys: "r", desc: "Reload the phone" },
  { scope: "caffeine", keys: "j", desc: "Next level" },
  { scope: "caffeine", keys: "k", desc: "Previous level" },
  { scope: "caffeine", keys: "Enter", desc: "Set this level" },
];

/**
 * Keys that moved in this release: pressed where nothing else binds them,
 * they say where they went instead of doing nothing (for one release).
 */
export const MOVED: Record<string, [string, string]> = {
  p: ["Space a p", "pairing a phone"],
  o: ["Space c o", "caffeine off"],
  i: ["Space c i", "caffeine on"],
  h: ["Space c h", "high caffeine"],
};

/** The "moved" hint for a key the keymap didn't take (`Fed` "none"), or null. */
export function movedHint(t: string): string | null {
  const m = MOVED[t];
  return m ? `${t} moved: ${m[1]} is ${m[0]} now` : null;
}

/** Names of the groups after a prefix, for the which-key strip. */
export const GROUPS: Record<string, string> = {
  Space: "leader",
  "Space t": "tabs",
  "Space c": "caffeine",
  "Space p": "the phone",
  "Space a": "add",
  "Space d": "delete",
  "Space m": "mark",
  "Space y": "copy / send",
  g: "go",
};

export type Run = (count: number) => void;
export interface Bind {
  keys: string;
  desc: string;
  run: Run;
}

type KeyLike = { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean };

/** A key event as a token ("j", "G", "Space", "Enter", "Esc"), or null to leave it alone. */
export function token(e: KeyLike): string | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.key === " ") return "Space";
  if (e.key === "Escape") return "Esc";
  if (
    ["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab", "Dead", "Unidentified"].includes(e.key)
  )
    return null;
  return e.key;
}

export type Fed =
  | { kind: "ran"; bind: Bind }
  | { kind: "pending"; prefix: string }
  | { kind: "count" }
  | { kind: "cancelled" }
  | { kind: "none" };

/**
 * Turns tokens into actions. A digit is a count unless it is bound on its
 * own (the tabs' 1-4); a prefix of a longer bind waits for the next key.
 */
export class Keymap {
  pending: string[] = [];
  count = "";
  constructor(private binds: () => Bind[]) {}

  get prefix(): string {
    return this.pending.join(" ");
  }

  reset(): void {
    this.pending = [];
    this.count = "";
  }

  feed(t: string): Fed {
    const busy = this.pending.length > 0 || this.count !== "";
    if (t === "Esc" && busy) {
      this.reset();
      return { kind: "cancelled" };
    }
    const all = this.binds();
    if (!this.pending.length && /^[0-9]$/.test(t) && !(t === "0" && this.count === "")) {
      if (!(this.count === "" && all.some((b) => b.keys === t))) {
        this.count = (this.count + t).slice(-3);
        return { kind: "count" };
      }
    }
    const seq = [...this.pending, t].join(" ");
    const longer = all.some((b) => b.keys.startsWith(`${seq} `));
    const exact = all.find((b) => b.keys === seq);
    if (longer) {
      this.pending.push(t);
      return { kind: "pending", prefix: seq };
    }
    const n = Math.max(1, Number.parseInt(this.count || "1", 10));
    this.reset();
    if (exact) {
      exact.run(n);
      return { kind: "ran", bind: exact };
    }
    return busy ? { kind: "cancelled" } : { kind: "none" };
  }

  /** The keys that can follow `prefix`: [key, what it does or which group]. */
  next(prefix: string): [string, string][] {
    const seen = new Map<string, string>();
    for (const b of this.binds()) {
      if (!b.keys.startsWith(`${prefix} `)) continue;
      const rest = b.keys.slice(prefix.length + 1).split(" ");
      const k = rest[0] ?? "";
      if (seen.has(k)) continue;
      seen.set(k, rest.length === 1 ? b.desc : `${GROUPS[`${prefix} ${k}`] ?? "more"}…`);
    }
    return [...seen];
  }
}

/** The binds in force: the most specific scope wins a key; one row per key. */
export function merge(layers: Bind[][]): Bind[] {
  const out = new Map<string, Bind>();
  for (const layer of layers) for (const b of layer) if (!out.has(b.keys)) out.set(b.keys, b);
  return [...out.values()];
}

export function describe(scope: Scope, keys: string): string {
  return KEYS.find((k) => k.scope === scope && k.keys === keys)?.desc ?? keys;
}

/** The focused element, as fieldTakes needs it. */
export interface Field {
  tagName: string;
  type?: string;
  editable?: boolean;
}

/** Does the focused field take this key (insert mode)? Text boxes and
 * drop-downs do, checkboxes and buttons don't. A drop-down (the pairing
 * screen's "It may do") leaves Enter to the window's own action (pair):
 * its arrows and letters still pick an option. */
export function fieldTakes(f: Field, key: string): boolean {
  if (f.editable || f.tagName === "TEXTAREA") return true;
  if (f.tagName === "SELECT") return key !== "Enter";
  return (
    f.tagName === "INPUT" &&
    !["checkbox", "radio", "button", "submit", "range"].includes(f.type ?? "text")
  );
}

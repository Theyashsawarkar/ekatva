/**
 * Every key in the window, in one place.
 *
 * # keybind: Ekatva/window | 1 2 3 4 | Switch to tab (Phones, Log, Caffeine, Phone)
 * # keybind: Ekatva/window | j k | Move selection down or up
 * # keybind: Ekatva/window | g G | Jump to the first or last item
 * # keybind: Ekatva/window | p | Show pairing code (pair a phone, from any network)
 * # keybind: Ekatva/window | Enter | Confirm pairing request (when the emoji match)
 * # keybind: Ekatva/window | x | Cancel pairing request (refuse the phone)
 * # keybind: Ekatva/window | Esc | Close the pairing code or this help
 * # keybind: Ekatva/window | u | Undo the selected log entry
 * # keybind: Ekatva/window | o i h | Set caffeine (off, on, high)
 * # keybind: Ekatva/window | r | Start phone ring (find the phone)
 * # keybind: Ekatva/window | ? | Show the keys
 */
import { useEffect } from "react";

export type Handler = (e: KeyboardEvent) => void;

/** Calls `map[key]` (the caller names the effect's deps) for keys typed outside text fields. */
export function useKeys(map: Record<string, Handler | undefined>, deps: unknown[]): void {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) &&
        e.key !== "Escape"
      )
        return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const h = map[e.key];
      if (h) {
        e.preventDefault();
        h(e);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, deps);
}

export const HELP: [string, string][] = [
  ["1 2 3 4", "Switch tab: Phones, Log, Caffeine, Phone"],
  ["j / k", "Move down / up"],
  ["g / G", "First / last"],
  ["p", "Pair a phone"],
  ["Enter / x", "Confirm / refuse a pairing request"],
  ["u", "Undo the selected log entry"],
  ["o / i / h", "Caffeine off / on / high"],
  ["r", "Ring the phone"],
  ["Esc", "Close"],
  ["?", "These keys"],
];

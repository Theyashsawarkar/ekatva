/**
 * Asking for something big again (a terminal screen, an agent's
 * conversation) only gets it back when it changed: the last answer's hash
 * goes with the question, and "unchanged" keeps the last answer, the same
 * object, so nothing re-renders. A laptop from before `unless` simply
 * answers in full every time.
 */
import type { Unchanged } from "@ekatva/protocol";

export function cached<T extends object>() {
  let last: (T & { hash: string }) | null = null;
  return {
    /** The hash to send, if there's an answer to compare against. */
    get unless(): string | undefined {
      return last?.hash;
    },
    /** The full answer: the new one, or the last when the laptop says it's unchanged. */
    take(a: (T & { hash?: string }) | Unchanged): T | null {
      if ("unchanged" in a && a.unchanged) return last;
      const full = a as T & { hash?: string };
      last = full.hash ? (full as T & { hash: string }) : null;
      return full;
    },
    reset() {
      last = null;
    },
  };
}

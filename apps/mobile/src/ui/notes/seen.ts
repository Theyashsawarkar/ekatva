/**
 * When the laptop's notifications were last looked at (the bell's count is
 * what came after), kept on the phone.
 */
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";

const KEY = "laptop-notes-seen";
let seen: number | null = null;
const subs = new Set<(t: number) => void>();

async function load(): Promise<number> {
  if (seen === null) {
    const v = await SecureStore.getItemAsync(KEY).catch(() => null);
    seen = Number(v) || 0;
  }
  return seen;
}

export function markSeen(t: number): void {
  if (seen !== null && t <= seen) return;
  seen = t;
  for (const f of subs) f(t);
  void SecureStore.setItemAsync(KEY, String(t)).catch(() => undefined);
}

export function useSeen(): number {
  const [t, setT] = useState(seen ?? 0);
  useEffect(() => {
    void load().then(setT);
    subs.add(setT);
    return () => {
      subs.delete(setT);
    };
  }, []);
  return t;
}

/**
 * One clipboard for both, the phone's half: while it's on (turned on here or
 * on the laptop) and ekatva is open, what you copy on the phone goes to the
 * laptop. (The laptop sends its own changes here by itself.)
 *
 * No timer: whether sync is on is asked when it matters (a copy, ekatva coming
 * back, the link coming up), so nothing runs while nothing happens.
 */
import * as Clipboard from "expo-clipboard";
import { useEffect } from "react";
import { AppState } from "react-native";
import { clip } from "../core/clip";
import type { Session } from "../core/session";

export function useClipboardSync(session: Session | null): void {
  useEffect(() => {
    if (!session) return;
    let on = false;
    const send = async (known = false) => {
      const api = session.link.client;
      if (!api) return;
      // A copy: is sync on right now? (Turned on or off here or on the laptop.)
      if (!known) on = await api.clipboard.sync.get.query().catch(() => on);
      if (!on) return;
      const t = await Clipboard.getStringAsync().catch(() => "");
      if (!t || t === clip.heard || t === clip.sent) return;
      clip.sent = t;
      await api.clipboard.set.mutate({ text: t }).catch(() => undefined);
    };
    const check = async () => {
      const api = session.link.client;
      // Only while ekatva is in front (the laptop sends its own changes anyway).
      if (!api || AppState.currentState !== "active") return;
      const was = on;
      on = await api.clipboard.sync.get.query().catch(() => false);
      // Just turned on, or back in front: what's here now goes over.
      if (on && (!was || AppState.currentState === "active")) void send(true);
    };
    void check();
    const sub = Clipboard.addClipboardListener(() => void send());
    const app = AppState.addEventListener("change", (s) => s === "active" && void check());
    const link = session.link.subscribe((st) => st.status === "online" && void check());
    return () => {
      sub.remove();
      app.remove();
      link();
    };
  }, [session]);
}

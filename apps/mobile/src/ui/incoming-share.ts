/**
 * "Share → ekatva" from another app: once ekatva is unlocked, the Send
 * screen opens with what was shared (at start, or while it's running).
 */
import { router } from "expo-router";
import { useEffect } from "react";
import { phone, type Shared } from "../../modules/ekatva-phone";

const open = (s: Shared) =>
  router.push({ pathname: "/send", params: { shared: JSON.stringify(s) } });

export function useIncomingShare(ready: boolean): void {
  useEffect(() => {
    if (!ready || !phone) return;
    const native = phone;
    try {
      const s = native.takeShared();
      if (s) open(s);
    } catch {
      // an older build without sharing
    }
    const sub = native.addListener("onShare", open);
    return () => sub.remove();
  }, [ready]);
}

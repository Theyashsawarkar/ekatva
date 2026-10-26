/**
 * The phone's own events, to the laptop: incoming calls, new messages and
 * notifications (each only if the laptop may receive them, which it
 * checks), and the foreground service that keeps the link up in the
 * background while a laptop is paired.
 */
import { useEffect } from "react";
import { phone } from "../../modules/ekatva-phone";
import type { Session } from "../core/session";

export function usePhoneBridge(session: Session | null): void {
  useEffect(() => {
    if (!session || !phone) return;
    const native = phone;
    const report = (
      e: Parameters<NonNullable<typeof session.link.client>["inbox"]["report"]["mutate"]>[0],
    ) => {
      void session.link.client?.inbox.report.mutate(e).catch(() => undefined);
    };
    const subs = [
      native.addListener("onNotification", (n) => report({ kind: "notification", ...n })),
      native.addListener("onCall", (c) =>
        report({ kind: "call", state: c.state, number: c.number, contact: c.contact }),
      ),
      native.addListener("onSms", (m) =>
        report({ kind: "sms", from: m.from, contact: m.contact, text: m.text, at: m.at }),
      ),
    ];
    try {
      if (native.status().calls) native.watchCalls();
      if (native.status().sms) native.watchSms();
    } catch {
      // a permission went away: the Settings screen shows it
    }
    // Stay linked in the background while a laptop is paired.
    const sync = () => {
      const l = session.laptops.current();
      try {
        if (l) native.startLink(`Linked with ${l.name}`);
        else native.stopLink();
      } catch {
        // notifications not allowed yet: the link still works while the app is open
      }
    };
    sync();
    const off = session.laptops.onChange(sync);
    return () => {
      off();
      for (const s of subs) s.remove();
    };
  }, [session]);
}

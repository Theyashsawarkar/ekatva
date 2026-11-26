/**
 * The phone's own events, to the laptop: incoming calls, new messages and
 * notifications (each only if the laptop may receive them, which it
 * checks), and the foreground service that keeps the link up in the
 * background while a laptop is paired.
 */

import { useEffect } from "react";
import { AppRegistry } from "react-native";
import { phone } from "../../modules/ekatva-phone";
import { APP_REQUEST } from "../core/apps";
import type { Session } from "../core/session";

// Held by the link service while a laptop is paired (EkatvaPhoneModule.holdJs):
// a task that never ends, so React Native keeps JS timers running with the app
// in the background. Without it the link can't reconnect and events wait in
// the outbox until the app is opened: an incoming call never reached the
// laptop with the phone away.
AppRegistry.registerHeadlessTask(
  "ekatvaStayLinked",
  () => () => new Promise<void>(() => undefined),
);

export function usePhoneBridge(session: Session | null): void {
  useEffect(() => {
    if (!session || !phone) return;
    const native = phone;
    // Every event goes through an outbox: sent at once when the link is up,
    // else kept until it is (the link is woken to find out). In the background
    // a dead connection can go unnoticed for minutes; nothing is dropped
    // meanwhile, except what's stale by then: a "ringing" older than 45 s
    // (the call has ended), anything older than an hour.
    type Ev = Parameters<NonNullable<typeof session.link.client>["inbox"]["report"]["mutate"]>[0];
    const outbox: { e: Ev; at: number }[] = [];
    let flushing = false;
    const fresh = (q: { e: Ev; at: number }) =>
      Date.now() - q.at < (q.e.kind === "call" && q.e.state === "ringing" ? 45_000 : 3_600_000);
    const flush = async () => {
      if (flushing) return;
      flushing = true;
      try {
        while (outbox.length) {
          const q = outbox[0] as { e: Ev; at: number };
          if (!fresh(q)) {
            outbox.shift();
            continue;
          }
          const client = session.link.client;
          if (!client || session.link.state.status !== "online") break;
          // Sent; refused (the laptop answered no: it won't take it later
          // either, so it's dropped, never left to block what's behind it, a
          // call included); or failed (no answer: the link is checked and the
          // outbox tried again once it's back).
          const how = await Promise.race([
            client.inbox.report.mutate(q.e).then(
              () => "sent" as const,
              (err: unknown) =>
                (err as { data?: { code?: string } } | null)?.data?.code
                  ? ("refused" as const)
                  : ("failed" as const),
            ),
            new Promise<"failed">((r) => setTimeout(() => r("failed"), 10_000)),
          ]);
          console.log(`[ekatva bridge] ${q.e.kind}: ${how}`);
          if (how === "failed") {
            session.link.wake(); // dead: check it, reconnect; online again flushes
            break;
          }
          outbox.shift();
        }
      } finally {
        flushing = false;
      }
    };
    const report = (e: Ev) => {
      // What happened, never who: the log can be read with adb.
      console.log(
        `[ekatva bridge] ${e.kind}${e.kind === "call" ? ` ${e.state}` : ""}: to the laptop (${session.link.state.status})`,
      );
      // A call goes first (after other calls, and after the one being sent):
      // a ringing phone can't wait behind a backlog of notifications.
      if (e.kind === "call") {
        let at = flushing && outbox.length ? 1 : 0;
        while (at < outbox.length && outbox[at]?.e.kind === "call") at++;
        outbox.splice(at, 0, { e, at: Date.now() });
      } else outbox.push({ e, at: Date.now() });
      if (outbox.length > 200)
        outbox.splice(
          outbox.findIndex((q) => q.e.kind !== "call"),
          1,
        );
      // A call or a text can't wait for a dead link to time out: check it now, alongside.
      if (session.link.state.status !== "online" || e.kind !== "notification") session.link.wake();
      void flush();
    };
    const offOutbox = session.link.subscribe((st) => {
      if (st.status === "online") void flush();
    });
    const subs = [
      // No picture is left out, not null: older laptops refused null.
      native.addListener("onNotification", (n) =>
        report({
          kind: "notification",
          ...n,
          icon: n.icon ?? undefined,
          picture: n.picture ?? undefined,
          package: n.package ?? undefined,
        }),
      ),
      native.addListener("onCall", (c) =>
        report({ kind: "call", state: c.state, number: c.number, contact: c.contact }),
      ),
      native.addListener("onSms", (m) =>
        report({ kind: "sms", from: m.from, contact: m.contact, text: m.text, at: m.at }),
      ),
      // A laptop notification swiped away here: gone on the laptop too.
      native.addListener("onLaptopNotificationDismissed", ({ id }) => {
        // ekatva's own (an app asking to use it) aren't the laptop's.
        if (id.startsWith(APP_REQUEST)) return;
        void session.link.client?.notifications.dismiss.mutate({ id }).catch(() => undefined);
      }),
    ];
    try {
      if (native.status().calls) native.watchCalls();
      if (native.status().sms) native.watchSms();
    } catch {
      // a permission went away: the Settings screen shows it
    }
    // Stay linked in the background while a laptop is paired; the notification
    // says what the link is really doing (only rewritten when that changes).
    let said = "";
    const sync = () => {
      const l = session.laptops.current();
      const st = session.link.state.status;
      const text = !l
        ? ""
        : st === "online"
          ? `Linked with ${l.name}`
          : st === "connecting"
            ? `Reaching ${l.name}…`
            : `Waiting for ${l.name}`;
      if (text === said) return;
      said = text;
      try {
        if (text) native.startLink(text);
        else native.stopLink();
      } catch {
        // notifications not allowed yet: the link still works while the app is open
      }
    };
    sync();
    const off = session.laptops.onChange(sync);
    const offLink = session.link.subscribe(sync);
    return () => {
      off();
      offLink();
      offOutbox();
      for (const s of subs) s.remove();
    };
  }, [session]);
}

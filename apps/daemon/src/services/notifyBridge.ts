/**
 * Notifications, both ways.
 *
 * Phone → laptop: its notifications, calls and messages become desktop
 * notifications with their buttons (Reply, Mark as read…; Answer and
 * Reject for a call; Reply for an SMS). Dismissed on the laptop, gone on
 * the phone; gone on the phone, gone here.
 *
 * Laptop → phone: the desktop's notifications show on phones that may see
 * them (the `notifications` capability); dismissed on one, gone on both.
 */
import type { PhoneEvent, PhoneRouter } from "@ekatva/protocol";
import type { TRPCClient } from "@trpc/client";
import { CLOSED, type DesktopNotifications, type Posted } from "./desktopNotifications.js";
import { LaptopHistory } from "./laptopHistory.js";
import { laptopIcon, laptopPicture } from "./laptopIcons.js";
import { saveImage } from "./phoneImages.js";

export interface BridgePeer {
  key: string;
  name: string;
  /** May see the laptop's notifications. */
  seesLaptop: boolean;
  phone: TRPCClient<PhoneRouter>;
}

type Origin =
  | { kind: "notification"; device: string; id: string; reply: number | null; actions: number }
  | { kind: "call"; device: string }
  | { kind: "missed"; device: string; number: string }
  | { kind: "sms"; device: string; from: string; who: string };

/** Asks for a line of text on the laptop (a reply); null when cancelled. */
export type Prompt = (title: string, text: string) => Promise<string | null>;

export class NotificationBridge {
  /** Desktop id → what it shows from a phone. */
  private fromPhone = new Map<number, Origin>();
  /** The missed call shown here, per phone: cleared when the phone's own
   *  missed-call notification is (you saw it there). */
  private missedNote = new Map<string, number>();
  /** The phone dialer's missed-call notifications, per phone (by its id). */
  private dialerMissed = new Map<string, Set<string>>();
  /** device|phone notification key → desktop id. */
  private byPhoneKey = new Map<string, number>();
  /** device → the desktop id of its ringing call. */
  private ringing = new Map<string, number>();
  /** Who's ringing, per phone, until it's answered or ends: an end while still
   *  here is a missed call (the phone only says "ended"). */
  private unanswered = new Map<string, { contact: string | null; number: string }>();
  /** Declined from here (Reject): its end isn't a missed call. */
  private declined = new Set<string>();
  /** device → its call events, one after another. */
  private callChain = new Map<string, Promise<void>>();
  /** Desktop notifications sent to phones. */
  private toPhone = new Set<number>();
  /** The laptop's notifications, for the phone's history. */
  readonly history = new LaptopHistory();
  private offs: (() => void)[] = [];

  constructor(
    private readonly desktop: DesktopNotifications,
    private readonly peers: () => BridgePeer[],
    private readonly prompt: Prompt,
    private readonly log: (m: string) => void = () => undefined,
  ) {}

  start(): void {
    this.offs.push(
      this.desktop.onPosted((n) => void this.toPhones(n)),
      this.desktop.onClosed((id, reason) => void this.closed(id, reason)),
      this.desktop.onAction((id, key) => void this.action(id, key)),
    );
    this.desktop.start();
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.desktop.stop();
  }

  private peer(key: string): BridgePeer | undefined {
    return this.peers().find((p) => p.key === key);
  }

  private quiet<T>(p: Promise<T>, what: string): Promise<T | undefined> {
    return p.catch((e: Error) => {
      this.log(`${what}: ${e.message}`);
      return undefined;
    });
  }

  // ---------------------------------------------------------- phone → laptop
  async fromPhoneEvent(device: string, name: string, e: PhoneEvent): Promise<void> {
    if (e.kind === "notification" && isDialer(e.package, e.app)) {
      // The phone's own dialer: ekatva shows calls itself (ringing, missed),
      // so its copies would be a second card for one call. Its missed-call
      // notification still counts: cleared there (seen on the phone), the
      // missed call here goes too. (Its "ongoing call" one ends with every
      // call: only the missed one clears.)
      const seen = this.dialerMissed.get(device) ?? new Set<string>();
      this.dialerMissed.set(device, seen);
      if (!e.removed) {
        if (/missed/i.test(`${e.title} ${e.text}`)) seen.add(e.id);
        return;
      }
      if (!seen.delete(e.id)) return;
      const mine = this.missedNote.get(device);
      if (mine !== undefined) {
        this.missedNote.delete(device);
        this.fromPhone.delete(mine);
        await this.desktop.close(mine);
      }
      return;
    }
    if (e.kind === "notification") {
      const k = `${device}|${e.id}`;
      const had = this.byPhoneKey.get(k);
      if (e.removed) {
        if (had !== undefined) {
          this.byPhoneKey.delete(k);
          this.fromPhone.delete(had);
          await this.desktop.close(had);
        }
        return;
      }
      const icon = saveImage("app", e.package ?? e.app, e.icon);
      const picture = saveImage("pic", "", e.picture);
      const id = await this.quiet(
        this.desktop.notify({
          app: name,
          ...(icon ? { icon } : {}),
          title: e.title ? `${e.app}: ${e.title}` : e.app,
          body: e.text,
          actions: e.actions.slice(0, 6).map((label, i) => [`a${i}`, label]),
          hints: {
            "x-ekatva-kind": "phone",
            "x-ekatva-device": name,
            "x-ekatva-app": e.app,
            ...(icon ? { "x-ekatva-icon": icon } : {}),
            ...(picture ? { "image-path": picture } : {}),
          },
          ...(had !== undefined ? { replaces: had } : {}),
        }),
        "showing a phone notification",
      );
      if (id === undefined) return;
      this.byPhoneKey.set(k, id);
      this.fromPhone.set(id, {
        kind: "notification",
        device,
        id: e.id,
        reply: e.reply ?? null,
        actions: e.actions.length,
      });
      return;
    }
    if (e.kind === "call") {
      // One device's call events in order: Android often reports a ringing
      // call twice (without the number, then with it), and the second must
      // find the first one's notification to replace it, not post another.
      const prev = this.callChain.get(device) ?? Promise.resolve();
      const next = prev.then(() => this.onCall(device, name, e));
      this.callChain.set(
        device,
        next.catch(() => undefined),
      );
      return next;
    }
    if (e.kind === "sms") {
      const who = e.contact ?? e.from;
      const id = await this.quiet(
        this.desktop.notify({
          app: name,
          title: who,
          body: e.text,
          icon: "mail-message-new",
          actions: [["reply", "Reply"]],
          hints: callHints("sms", name, e.contact, e.from),
        }),
        "showing a message",
      );
      if (id !== undefined) this.fromPhone.set(id, { kind: "sms", device, from: e.from, who });
    }
  }

  private async onCall(
    device: string,
    name: string,
    e: Extract<PhoneEvent, { kind: "call" }>,
  ): Promise<void> {
    const who = e.contact ?? e.number;
    const was = this.ringing.get(device);
    if (e.state === "ringing") {
      const before = this.unanswered.get(device);
      this.unanswered.set(device, {
        contact: e.contact ?? before?.contact ?? null,
        number: e.number || before?.number || "",
      });
      const id = await this.quiet(
        this.desktop.notify({
          app: name,
          title: `Incoming call: ${who}`,
          body: `on ${name}`,
          icon: "call-start",
          urgency: 2,
          hints: callHints("call", name, e.contact, e.number),
          actions: [
            ["answer", "Answer"],
            ["reject", "Reject"],
          ],
          ...(was !== undefined ? { replaces: was } : {}),
        }),
        "showing a call",
      );
      if (id !== undefined) {
        this.ringing.set(device, id);
        this.fromPhone.set(id, { kind: "call", device });
      }
      return;
    }
    if (was !== undefined) {
      this.ringing.delete(device);
      this.fromPhone.delete(was);
      await this.desktop.close(was);
    }
    // Rang and ended without being answered (or declined here): missed. It
    // stays until dismissed: the call itself may have rung for 5 seconds
    // while you looked away.
    const rang = this.unanswered.get(device);
    this.unanswered.delete(device); // answered, or ended
    const declined = this.declined.delete(device);
    const missed = e.state === "missed" || (e.state === "ended" && rang !== undefined && !declined);
    if (missed) {
      const contact = e.contact ?? rang?.contact ?? null;
      const number = e.number || rang?.number || "";
      const old = this.missedNote.get(device);
      const id = await this.quiet(
        this.desktop.notify({
          app: name,
          ...(number ? { actions: [["callback", "Call back"]] as [string, string][] } : {}),
          ...(old !== undefined ? { replaces: old } : {}),
          title: `Missed call: ${contact ?? (number || "Unknown")}`,
          body: "",
          icon: "call-missed",
          hints: callHints("missed", name, contact, number),
        }),
        "showing a missed call",
      );
      if (id !== undefined) {
        this.missedNote.set(device, id);
        this.fromPhone.set(id, { kind: "missed", device, number });
      }
    }
  }

  private async action(id: number, key: string): Promise<void> {
    const o = this.fromPhone.get(id);
    if (!o) return;
    const p = this.peer(o.device);
    if (!p) {
      this.log("the phone isn't connected: can't do that now");
      return;
    }
    if (o.kind === "call") {
      if (key === "answer") await this.quiet(p.phone.calls.answer.mutate(), "answering");
      if (key === "reject") {
        this.declined.add(o.device);
        await this.quiet(p.phone.calls.hangUp.mutate(), "rejecting");
      }
      return;
    }
    if (o.kind === "missed") {
      if (key === "callback" && o.number) {
        await this.quiet(p.phone.calls.dial.mutate({ number: o.number }), "calling back");
        this.fromPhone.delete(id);
        if (this.missedNote.get(o.device) === id) this.missedNote.delete(o.device);
        await this.desktop.close(id);
      }
      return;
    }
    if (o.kind === "sms" && key === "reply") {
      const text = await this.prompt(`Reply to ${o.who}`, `A text message from ${p.name}`);
      if (text)
        await this.quiet(p.phone.sms.send.mutate({ to: o.from, text }), "sending the reply");
      return;
    }
    if (o.kind === "notification") {
      const m = /^a(\d+)$/.exec(key);
      if (!m) return;
      const index = Number(m[1]);
      let reply: string | null = null;
      if (index === o.reply) {
        reply = await this.prompt("Reply", `From ${p.name}`);
        if (!reply) return;
      }
      await this.quiet(
        p.phone.notifications.act.mutate({ id: o.id, index, reply }),
        "using the notification's button",
      );
    }
  }

  // ---------------------------------------------------------- laptop → phone
  private async toPhones(n: Posted): Promise<void> {
    if (n.app === "ekatva") return; // its own (pairing requests…) are for this screen
    const icon = laptopIcon(n.icon, n.desktopEntry, n.app);
    this.history.add(
      {
        id: String(n.id),
        app: n.app.slice(0, 200),
        title: n.title.slice(0, 1000),
        body: n.body.slice(0, 2000),
        at: Date.now(),
        urgency: n.urgency,
        icon: icon?.key ?? null,
      },
      icon,
      [n.icon, n.desktopEntry, n.app],
    );
    const to = this.peers().filter((p) => p.seesLaptop);
    if (!to.length) return;
    const picture = n.image ? laptopPicture(n.image) : undefined;
    this.toPhone.add(n.id);
    if (this.toPhone.size > 500) this.toPhone.delete(this.toPhone.values().next().value as number);
    for (const p of to)
      await this.quiet(
        p.phone.notifications.show.mutate({
          id: String(n.id),
          app: n.app.slice(0, 200),
          title: n.title.slice(0, 1000),
          text: n.body.slice(0, 10_000),
          urgency: n.urgency,
          ...(icon ? { icon: icon.png } : {}),
          ...(picture ? { picture } : {}),
        }),
        `sending a notification to ${p.name}`,
      );
  }

  /** The phone dismissed one of the laptop's. */
  async dismissLaptop(id: string): Promise<boolean> {
    const n = Number(id);
    if (!this.toPhone.has(n)) return false;
    await this.desktop.close(n);
    return true;
  }

  private async closed(id: number, reason: number): Promise<void> {
    const o = this.fromPhone.get(id);
    if (o) {
      this.fromPhone.delete(id);
      if (o.kind === "missed") {
        if (this.missedNote.get(o.device) === id) this.missedNote.delete(o.device);
        // Dismissed here: seen, so the phone's own missed-call notice goes too.
        const p = this.peer(o.device);
        const seen = this.dialerMissed.get(o.device);
        if (reason === CLOSED.dismissed && p && seen)
          for (const pid of [...seen]) {
            seen.delete(pid);
            await this.quiet(
              p.phone.notifications.dismiss.mutate({ id: pid }),
              "dismissing on the phone",
            );
          }
        return;
      }
      if (o.kind === "notification") {
        this.byPhoneKey.delete(`${o.device}|${o.id}`);
        // You dismissed it here: gone on the phone too (not when it merely timed out).
        if (reason === CLOSED.dismissed) {
          const p = this.peer(o.device);
          if (p)
            await this.quiet(
              p.phone.notifications.dismiss.mutate({ id: o.id }),
              "dismissing on the phone",
            );
        }
      }
      return;
    }
    if (this.toPhone.has(id) && reason !== CLOSED.expired) {
      this.toPhone.delete(id);
      for (const p of this.peers().filter((x) => x.seesLaptop))
        await this.quiet(
          p.phone.notifications.close.mutate({ id: String(id) }),
          "closing on the phone",
        );
    }
  }
}

/** What a notification server needs to draw a call or a text as one (akashvani). */
function callHints(
  kind: "call" | "missed" | "sms",
  device: string,
  contact?: string | null,
  number?: string | null,
): Record<string, string> {
  const h: Record<string, string> = { "x-ekatva-kind": kind, "x-ekatva-device": device };
  if (contact) h["x-ekatva-contact"] = contact;
  if (number) h["x-ekatva-number"] = number;
  return h;
}

/** The phone's dialer, by package (or its app name, from older phone apps). */
const DIALERS = new Set([
  "com.google.android.dialer",
  "com.android.dialer",
  "com.android.incallui",
  "com.android.server.telecom",
  "com.samsung.android.dialer",
  "com.samsung.android.incallui",
  "com.nothing.dialer",
  "com.oneplus.dialer",
  "com.oplus.dialer",
  "com.coloros.dialer",
]);

export function isDialer(pkg: string | undefined, app: string): boolean {
  return pkg ? DIALERS.has(pkg) : app === "Phone";
}

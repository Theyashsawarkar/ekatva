/**
 * What the laptop can ask of the phone, over the device's abilities.
 * Calls, SMS and locking need small native modules; until a build has
 * them, those answer "not implemented" with a clear message.
 */
import type {
  Appearance,
  AppearanceMode,
  CallRecord,
  Done,
  LaptopNotification,
  PhoneServices,
  PhoneStatus,
  ShareService,
  Sms,
  Undo,
} from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";
import type { PhoneFiles } from "./files";

export interface DeviceApi {
  name: string;
  battery(): Promise<{ percent: number; charging: boolean } | null>;
  signal(): Promise<{ bars: number; network: string } | null>;
  locked(): Promise<boolean | null>;
  /** Until stopped: full volume, through silent and Do Not Disturb. */
  ring(from: string): Promise<void>;
  stopRinging(): Promise<void>;
  ringing(): boolean;
  keepAwake(on: boolean): Promise<void>;
  awake(): boolean;
  clipboardGet(): Promise<string>;
  clipboardSet(text: string): Promise<void>;
  lock: (() => Promise<void>) | null;
  /** Light and dark: null when this build can't read it. */
  appearance?: {
    get(): Promise<Appearance>;
    set(mode: AppearanceMode): Promise<AppearanceMode>;
  } | null;
  calls: {
    dial(number: string): Promise<void>;
    answer(): Promise<void>;
    hangUp(): Promise<void>;
    log(limit: number): Promise<CallRecord[]>;
  } | null;
  sms: {
    threads(): Promise<{ thread: string; contact: string | null; last: Sms }[]>;
    read(thread: string, limit: number): Promise<Sms[]>;
    send(to: string, text: string): Promise<void>;
  } | null;
  notifications: {
    dismiss(id: string): Promise<boolean>;
    act(id: string, index: number, reply: string | null): Promise<boolean>;
    show(n: LaptopNotification): Promise<void>;
    close(id: string): Promise<void>;
  } | null;
}

const notYet = (what: string): never => {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: `${what} needs a newer build of the phone app`,
  });
};

const noApps: PhoneServices["apps"] = {
  list: async () => [],
  call: async () => notYet("Reaching the phone's apps"),
  emit: async () => notYet("Reaching the phone's apps"),
  upload: {
    begin: async () => notYet("Reaching the phone's apps"),
    put: async () => notYet("Reaching the phone's apps"),
    finish: async () => notYet("Reaching the phone's apps"),
    cancel: async () => undefined,
  },
};

export function phoneServices(
  device: DeviceApi,
  files: PhoneFiles,
  share: ShareService,
  /** The phone's Vayu apps (core/apps.ts); none: the laptop is told there are none. */
  apps: PhoneServices["apps"] = noApps,
): PhoneServices {
  const setAppearance = async (mode: AppearanceMode): Promise<Done<Appearance>> => {
    if (!device.appearance) return notYet("Switching light and dark");
    const before = (await device.appearance.get()).mode;
    const now = await device.appearance.set(mode);
    return {
      value: { mode: now, settable: true, why: null },
      summary: `Switched the phone to ${now} mode`,
      undo: { kind: "appearance.set", data: { mode: before } },
    };
  };
  const undo = async (u: Undo): Promise<Done<unknown>> => {
    if (u.kind.startsWith("files.")) return files.undo(u);
    const d = u.data as Record<string, unknown>;
    if (u.kind === "clipboard.set") {
      const before = await device.clipboardGet();
      await device.clipboardSet(String(d.text ?? ""));
      return {
        value: null,
        summary: "Put the phone's clipboard back",
        undo: { kind: "clipboard.set", data: { text: before } },
      };
    }
    if (u.kind === "appearance.set") return setAppearance(d.mode === "light" ? "light" : "dark");
    if (u.kind === "keepAwake") {
      const was = device.awake();
      await device.keepAwake(Boolean(d.on));
      return {
        value: null,
        summary: d.on ? "Kept the phone's screen on" : "Let the phone's screen sleep",
        undo: { kind: "keepAwake", data: { on: was } },
      };
    }
    throw new TRPCError({ code: "BAD_REQUEST", message: `don't know how to undo ${u.kind}` });
  };

  return {
    apps,
    async status(): Promise<PhoneStatus> {
      const [battery, signal, locked] = await Promise.all([
        device.battery(),
        device.signal(),
        device.locked(),
      ]);
      return {
        name: device.name,
        battery,
        signal,
        locked,
        awake: device.awake(),
        ringing: device.ringing(),
      };
    },
    async lock() {
      if (!device.lock) return notYet("Locking the phone");
      await device.lock();
      return { value: null, summary: "Locked the phone" };
    },
    async ring(from) {
      await device.ring(from);
      return { value: null, summary: "Started ringing the phone (until stopped)" };
    },
    async stopRinging() {
      await device.stopRinging();
      return { value: null, summary: "Stopped ringing the phone" };
    },
    async keepAwake(on) {
      const was = device.awake();
      await device.keepAwake(on);
      return {
        value: null,
        summary: on ? "Kept the phone's screen on" : "Let the phone's screen sleep",
        undo: { kind: "keepAwake", data: { on: was } },
      };
    },
    calls: {
      async dial(number) {
        if (!device.calls) return notYet("Placing calls");
        await device.calls.dial(number);
        return { value: null, summary: `Called ${number}` };
      },
      async answer() {
        if (!device.calls) return notYet("Answering calls");
        await device.calls.answer();
        return { value: null, summary: "Answered the call" };
      },
      async hangUp() {
        if (!device.calls) return notYet("Ending calls");
        await device.calls.hangUp();
        return { value: null, summary: "Ended the call" };
      },
      log: async (limit) => (device.calls ? device.calls.log(limit) : notYet("The call history")),
    },
    sms: {
      threads: async () => (device.sms ? device.sms.threads() : notYet("Messages")),
      read: async (thread, limit) =>
        device.sms ? device.sms.read(thread, limit) : notYet("Messages"),
      async send(to, text) {
        if (!device.sms) return notYet("Sending messages");
        await device.sms.send(to, text);
        return { value: null, summary: `Texted ${to} (${text.length} characters)` };
      },
    },
    appearance: {
      get: async () =>
        device.appearance
          ? device.appearance.get()
          : { mode: "dark", settable: false, why: "This build can't read the phone's mode" },
      set: setAppearance,
    },
    clipboard: {
      get: () => device.clipboardGet(),
      async set(text) {
        const before = await device.clipboardGet();
        await device.clipboardSet(text);
        return {
          value: null,
          summary: `Set the phone's clipboard (${text.length} characters)`,
          undo: { kind: "clipboard.set", data: { text: before } },
        };
      },
    },
    notifications: {
      async dismiss(id) {
        if (!device.notifications) return notYet("Notifications");
        const ok = await device.notifications.dismiss(id);
        return { value: null, summary: ok ? "Dismissed a notification" : "It was already gone" };
      },
      async act(id, index, reply) {
        if (!device.notifications) return notYet("Notifications");
        const ok = await device.notifications.act(id, index, reply);
        if (!ok) throw new TRPCError({ code: "NOT_FOUND", message: "that notification is gone" });
        return {
          value: null,
          summary: reply === null ? "Used a notification's button" : "Replied to a notification",
        };
      },
      async show(n) {
        if (!device.notifications) return notYet("Notifications");
        await device.notifications.show(n);
        return { value: null, summary: `Showed a laptop notification from ${n.app}` };
      },
      async close(id) {
        await device.notifications?.close(id);
        return { value: null, summary: "Closed a laptop notification" };
      },
    },
    share,
    files,
    undo,
  };
}

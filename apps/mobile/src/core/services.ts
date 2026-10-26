/**
 * What the laptop can ask of the phone, over the device's abilities.
 * Calls, SMS and locking need small native modules; until a build has
 * them, those answer "not implemented" with a clear message.
 */
import type { Done, PhoneServices, PhoneStatus, Sms, Undo } from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";
import type { PhoneFiles } from "./files";

export interface DeviceApi {
  name: string;
  battery(): Promise<{ percent: number; charging: boolean } | null>;
  signal(): Promise<{ bars: number; network: string } | null>;
  locked(): Promise<boolean | null>;
  ring(): Promise<void>;
  keepAwake(on: boolean): Promise<void>;
  awake(): boolean;
  clipboardGet(): Promise<string>;
  clipboardSet(text: string): Promise<void>;
  lock: (() => Promise<void>) | null;
  calls: {
    dial(number: string): Promise<void>;
    answer(): Promise<void>;
    hangUp(): Promise<void>;
  } | null;
  sms: {
    threads(): Promise<{ thread: string; contact: string | null; last: Sms }[]>;
    read(thread: string, limit: number): Promise<Sms[]>;
    send(to: string, text: string): Promise<void>;
  } | null;
}

const notYet = (what: string): never => {
  throw new TRPCError({
    code: "NOT_IMPLEMENTED",
    message: `${what} needs a newer build of the phone app`,
  });
};

export function phoneServices(device: DeviceApi, files: PhoneFiles): PhoneServices {
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
    async status(): Promise<PhoneStatus> {
      const [battery, signal, locked] = await Promise.all([
        device.battery(),
        device.signal(),
        device.locked(),
      ]);
      return { name: device.name, battery, signal, locked, awake: device.awake() };
    },
    async lock() {
      if (!device.lock) return notYet("Locking the phone");
      await device.lock();
      return { value: null, summary: "Locked the phone" };
    },
    async ring() {
      await device.ring();
      return { value: null, summary: "Rang the phone" };
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
    files,
    undo,
  };
}

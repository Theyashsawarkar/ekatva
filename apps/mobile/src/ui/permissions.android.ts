/**
 * Everything ekatva may use on this phone, in one list: what each is for,
 * whether Android has granted it, and how to grant it (Android's dialog, one
 * of its settings pages, or once over USB). The Permissions screen, the
 * Settings row and Home's reminder all read it from here.
 */
import { useEffect, useState } from "react";
import { AppState, PermissionsAndroid, Platform } from "react-native";
import { phone } from "../../modules/ekatva-phone";
import type { IconName } from "./icon";

const P = PermissionsAndroid.PERMISSIONS;

export type NativeStatus = ReturnType<NonNullable<typeof phone>["status"]>;

export interface Perm {
  id: string;
  title: string;
  /** What it lets ekatva do, in a line. */
  why: string;
  icon: IconName;
  /** Needed for ekatva to work as it should (Home reminds you); else an extra. */
  essential: boolean;
  /** "ask": Android's own dialog; "settings": one of Android's settings pages; "usb": a command, once. */
  how: "ask" | "settings" | "usb";
  /** Android's runtime permissions it asks for ("ask"). */
  perms?: string[];
  on: boolean;
}

/** The command that grants light and dark switching (run on the laptop, phone on USB). */
export const USB_COMMAND =
  "adb shell pm grant io.github.theyashsawarkar.ekatva android.permission.WRITE_SECURE_SETTINGS";

const CALLS = [
  P.CALL_PHONE,
  P.READ_PHONE_STATE,
  P.ANSWER_PHONE_CALLS,
  P.READ_CALL_LOG,
  P.READ_CONTACTS,
];
const SMS = [P.READ_SMS, P.SEND_SMS, P.RECEIVE_SMS, P.READ_CONTACTS];

function list(st: NativeStatus, notify: boolean): Perm[] {
  return [
    {
      id: "calls",
      title: "Calls",
      why: "See incoming calls on the laptop, answer and end them, call from there",
      icon: "call",
      essential: true,
      how: "ask",
      perms: CALLS,
      on: st.calls,
    },
    {
      id: "sms",
      title: "Messages",
      why: "New texts on the laptop; read and send SMS from there",
      icon: "chat",
      essential: true,
      how: "ask",
      perms: SMS,
      on: st.sms,
    },
    {
      id: "post",
      title: "Show notifications",
      why: "The laptop's notifications here, and the one that keeps ekatva linked",
      icon: "bell",
      essential: true,
      how: "ask",
      perms: Number(Platform.Version) >= 33 ? [P.POST_NOTIFICATIONS] : [],
      on: notify,
    },
    {
      id: "listener",
      title: "Read notifications",
      why: "This phone's notifications, on the laptop",
      icon: "phone",
      essential: true,
      how: "settings",
      on: st.notifications,
    },
    {
      id: "background",
      title: "Work with the screen off",
      why: "Calls, texts and notifications reach the laptop while the phone sleeps",
      icon: "moon",
      essential: true,
      how: "settings",
      on: st.background,
    },
    {
      id: "dnd",
      title: "Ring through Do Not Disturb",
      why: "Find my phone rings at full volume even in total silence",
      icon: "ring",
      essential: false,
      how: "settings",
      on: st.dnd,
    },
    {
      id: "admin",
      title: "Lock from the laptop",
      why: "The laptop can lock this phone (nothing else of device admin)",
      icon: "lock",
      essential: false,
      how: "settings",
      on: st.admin,
    },
    {
      id: "files",
      title: "All files",
      why: "The laptop reaches all of this phone's storage, not only ekatva's folder",
      icon: "folder",
      essential: false,
      how: "settings",
      on: st.allFiles,
    },
    {
      id: "appearance",
      title: "Light and dark from the laptop",
      why: "The laptop switches this phone's dark mode with its own",
      icon: "sun",
      essential: false,
      how: "usb",
      on: st.appearance,
    },
  ];
}

/** Android 13+ asks before an app may show notifications; older ones always let it. */
const canNotify = () =>
  Number(Platform.Version) < 33
    ? Promise.resolve(true)
    : PermissionsAndroid.check(P.POST_NOTIFICATIONS);

function readStatus(): NativeStatus | null {
  try {
    return phone?.status() ?? null;
  } catch {
    return null;
  }
}

/**
 * The list, read again when the app comes back to the front (most are granted
 * on Android's own pages) and every 2 s while `live` (a screen showing it).
 */
export function usePermissions(live = false): { perms: Perm[] | null; refresh: () => void } {
  // In state, not read during render: the React Compiler memoizes a render-time
  // `phone.status()` (its inputs never change), and nothing would ever move.
  const [st, setSt] = useState<NativeStatus | null>(readStatus);
  const [notify, setNotify] = useState(true);
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` asks for a fresh read (refresh)
  useEffect(() => {
    const again = () => {
      const next = readStatus();
      setSt((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next));
      void canNotify().then(setNotify);
    };
    again();
    const sub = AppState.addEventListener("change", (s) => s === "active" && again());
    const timer = live
      ? setInterval(() => AppState.currentState === "active" && again(), 2000)
      : null;
    return () => {
      sub.remove();
      if (timer) clearInterval(timer);
    };
  }, [live, tick]);
  return { perms: st ? list(st, notify) : null, refresh: () => setTick((t) => t + 1) };
}

/** Grants one: Android's dialog, or opens its settings page (you come back here after). */
export async function grant(p: Perm): Promise<void> {
  const native = phone;
  if (!native) return;
  switch (p.id) {
    case "calls":
      await PermissionsAndroid.requestMultiple(CALLS as never[]);
      if (readStatus()?.calls) native.watchCalls();
      return;
    case "sms":
      await PermissionsAndroid.requestMultiple(SMS as never[]);
      if (readStatus()?.sms) native.watchSms();
      return;
    case "post":
      if (p.perms?.length) await PermissionsAndroid.requestMultiple(p.perms as never[]);
      return;
    case "listener":
      return native.openNotificationAccess();
    case "background":
      return native.requestBackground();
    case "dnd":
      return native.openDndAccess();
    case "admin":
      return native.requestAdmin();
    case "files":
      return native.requestAllFiles();
    default:
      return;
  }
}

/** The ones Android's dialogs grant, all in one go (it shows them one after another). */
export async function grantDialogs(perms: Perm[]): Promise<void> {
  const all = [
    ...new Set(perms.filter((p) => !p.on && p.how === "ask").flatMap((p) => p.perms ?? [])),
  ];
  if (all.length) await PermissionsAndroid.requestMultiple(all as never[]);
  const st = readStatus();
  if (st?.calls) phone?.watchCalls();
  if (st?.sms) phone?.watchSms();
}

export const available = () => !!phone;

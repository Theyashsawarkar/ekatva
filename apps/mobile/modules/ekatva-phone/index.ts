/**
 * The phone's native side (android/…/EkatvaPhoneModule.kt), typed. Null
 * when the build doesn't have it (Expo Go, tests): callers then say so.
 */
import { requireOptionalNativeModule } from "expo";

export interface CallRecord {
  id: string;
  number: string;
  contact: string | null;
  kind: "in" | "out" | "missed" | "declined";
  at: number;
  seconds: number;
}
export interface CallEvent {
  state: "ringing" | "active" | "ended";
  number: string;
  contact: string | null;
}
export interface SmsEvent {
  from: string;
  contact: string | null;
  text: string;
  at: number;
}
export interface NotificationEvent {
  id: string;
  app: string;
  title: string;
  text: string;
  actions: string[];
  /** The action that takes typed text, if any. */
  reply: number | null;
  removed: boolean;
  /** The app's package, its icon and the notification's picture (PNG, base64). */
  package?: string;
  icon?: string;
  picture?: string;
}
/** Shared from another app: text or links, and files copied into the app's cache. */
export interface Shared {
  text: string | null;
  files: { uri: string; name: string; size: number }[];
}
export interface SmsMessage {
  id: string;
  thread: string;
  from: string;
  contact: string | null;
  text: string;
  at: number;
  mine: boolean;
}

interface Native {
  /** Reads a QR code with Google's code scanner (Play services); rejects E_CANCELLED if closed. */
  scanQr(): Promise<string>;
  status(): {
    admin: boolean;
    notifications: boolean;
    allFiles: boolean;
    calls: boolean;
    sms: boolean;
    /** May change Do Not Disturb (ringing gets through "total silence"). */
    dnd: boolean;
    /** Exempt from the battery saver: calls and texts get through with the screen off. */
    background: boolean;
    /** May switch light and dark (WRITE_SECURE_SETTINGS, granted once over USB). */
    appearance: boolean;
  };
  requestAdmin(): void;
  openNotificationAccess(): void;
  requestAllFiles(): void;
  requestBackground(): void;
  lock(): void;
  /** Rings until stopped (`from`: who's asking, on the notification). */
  ring(from: string): void;
  stopRinging(): void;
  ringing(): boolean;
  /** A folder's entries in one call (sizes in bytes, times in ms). */
  listDir(path: string): Promise<{ name: string; isDir: boolean; size: number; mtime: number }[]>;
  openDndAccess(): void;
  /** The system's light or dark mode; switching needs WRITE_SECURE_SETTINGS (granted over USB). */
  appearance(): { mode: "light" | "dark"; settable: boolean; why: string | null };
  /** Rejects with E_NEEDS_GRANT without that permission; resolves with the mode now. */
  setAppearance(dark: boolean): Promise<"light" | "dark">;
  dismissNotification(key: string): boolean;
  notificationAction(key: string, index: number, reply: string | null): boolean;
  showLaptopNotification(
    id: string,
    app: string,
    title: string,
    text: string,
    icon: string | null,
    picture: string | null,
    urgency: number | null,
  ): void;
  closeLaptopNotification(id: string): void;
  /** The vault (VaultKey.kt): sealed text behind the fingerprint or the screen lock. */
  vaultExists(): boolean;
  vaultWipe(): void;
  /** Rejects with code E_CANCELLED (you backed out) or E_KEY_GONE (the screen lock went). */
  vaultSeal(text: string, title: string): Promise<void>;
  vaultOpen(title: string): Promise<string | null>;
  /** What the app was opened to share ("Share → ekatva"), once; null when nothing. */
  takeShared(): Shared | null;
  startLink(text: string): void;
  stopLink(): void;
  dial(number: string): void;
  answer(): void;
  hangUp(): void;
  watchCalls(): void;
  callLog(limit: number): CallRecord[];
  smsThreads(limit: number): { thread: string; contact: string | null; last: SmsMessage }[];
  smsRead(thread: string, limit: number): SmsMessage[];
  smsSend(to: string, text: string): void;
  watchSms(): void;
  /** Listens for the laptop's beacons on UDP `port`, datagrams of exactly `size` bytes. */
  listenBeacons(port: number, size: number): void;
  stopBeacons(): void;
  addListener(event: "onCall", cb: (e: CallEvent) => void): { remove(): void };
  addListener(event: "onSms", cb: (e: SmsEvent) => void): { remove(): void };
  addListener(event: "onNotification", cb: (e: NotificationEvent) => void): { remove(): void };
  addListener(event: "onRing", cb: (e: { ringing: boolean }) => void): { remove(): void };
  addListener(event: "onShare", cb: (e: Shared) => void): { remove(): void };
  addListener(
    event: "onLaptopNotificationDismissed",
    cb: (e: { id: string }) => void,
  ): {
    remove(): void;
  };
  /** `data`: unpadded base64url. */
  addListener(
    event: "onBeacon",
    cb: (e: { from: string; data: string }) => void,
  ): {
    remove(): void;
  };
}

export const phone = requireOptionalNativeModule<Native>("EkatvaPhone");

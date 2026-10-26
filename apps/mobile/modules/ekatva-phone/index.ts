/**
 * The phone's native side (android/…/EkatvaPhoneModule.kt), typed. Null
 * when the build doesn't have it (Expo Go, tests): callers then say so.
 */
import { requireOptionalNativeModule } from "expo";

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
  removed: boolean;
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
  status(): {
    admin: boolean;
    notifications: boolean;
    allFiles: boolean;
    calls: boolean;
    sms: boolean;
  };
  requestAdmin(): void;
  openNotificationAccess(): void;
  requestAllFiles(): void;
  lock(): void;
  ring(seconds: number): void;
  stopRinging(): void;
  startLink(text: string): void;
  stopLink(): void;
  dial(number: string): void;
  answer(): void;
  hangUp(): void;
  watchCalls(): void;
  smsThreads(limit: number): { thread: string; contact: string | null; last: SmsMessage }[];
  smsRead(thread: string, limit: number): SmsMessage[];
  smsSend(to: string, text: string): void;
  watchSms(): void;
  addListener(event: "onCall", cb: (e: CallEvent) => void): { remove(): void };
  addListener(event: "onSms", cb: (e: SmsEvent) => void): { remove(): void };
  addListener(event: "onNotification", cb: (e: NotificationEvent) => void): { remove(): void };
}

export const phone = requireOptionalNativeModule<Native>("EkatvaPhone");

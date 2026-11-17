/** Phone permissions exist on Android only (permissions.android.ts). */
import type { IconName } from "./icon";

export interface Perm {
  id: string;
  title: string;
  why: string;
  icon: IconName;
  essential: boolean;
  how: "ask" | "settings" | "usb";
  perms?: string[];
  on: boolean;
}
export const USB_COMMAND = "";
export function usePermissions(_live = false): { perms: Perm[] | null; refresh: () => void } {
  return { perms: null, refresh: () => undefined };
}
export async function grant(_p: Perm): Promise<void> {}
export async function grantDialogs(_p: Perm[]): Promise<void> {}
export const available = () => false;

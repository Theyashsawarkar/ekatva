/**
 * Light and dark on both devices, for Home's lamp: each one's mode (the
 * laptop's over the link, the phone's from Android), which follow a tap
 * (remembered), and the tap itself. The phone's own switch goes through
 * the phone's log like any action, as you.
 */
import { type AppearanceMode, createPhoneCaller } from "@ekatva/protocol";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import type { Session } from "../../core/session";
import { errorText } from "../errors";
import { toast } from "../lac";
import { usePoll } from "../state";
import type { Who } from "./appearance-tile";
import type { Client } from "./parts";

const FOLLOW_KEY = "ekatva.appearance.follow";

export function useAppearance(
  client: Client | null | undefined,
  session: Session | null,
  name: string,
) {
  const laptop = usePoll(() => client?.appearance.get.query() ?? null, [client], 5000);
  // The phone's own mode can't be heard (the app is always dark, so React Native's
  // Appearance never changes): read it when Home comes into focus or the app comes
  // back (usePoll does both), after a tap, and once a minute otherwise.
  const phone = usePoll(() => session?.services.appearance.get() ?? null, [session], 60_000);
  const [follow, setFollow] = useState<Record<Who, boolean>>({ ace: true, phone: true });
  // Set right away on a tap; the next reading replaces it.
  const [mine, setMine] = useState<Partial<Record<Who, AppearanceMode>>>({});

  useEffect(() => {
    void SecureStore.getItemAsync(FOLLOW_KEY).then((v) => {
      if (!v) return;
      try {
        const f = JSON.parse(v) as Record<Who, boolean>;
        setFollow({ ace: f.ace !== false, phone: f.phone !== false });
      } catch {
        // an old value: keep both
      }
    });
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reading clears what was set by hand
  useEffect(() => setMine((m) => ({ ...m, ace: undefined })), [laptop.data?.mode]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reading clears what was set by hand
  useEffect(() => setMine((m) => ({ ...m, phone: undefined })), [phone.data?.mode]);

  // Why the laptop can't be read or switched from here, if it can't.
  const aceBlocked = !client
    ? `${name} isn't connected`
    : laptop.error
      ? /may not|not allowed|forbidden|permission/i.test(laptop.error)
        ? `Allow "Light and dark" for this phone in ${name}'s ekatva window`
        : errorText(new Error(laptop.error))
      : laptop.data && !laptop.data.settable
        ? (laptop.data.why ?? `${name} can't be switched from here`)
        : null;
  const ace = aceBlocked && !laptop.data ? null : (mine.ace ?? laptop.data?.mode ?? null);
  const own = mine.phone ?? phone.data?.mode ?? null;

  const toggleFollow = (w: Who) => {
    const next = { ...follow, [w]: !follow[w] };
    setFollow(next);
    void SecureStore.setItemAsync(FOLLOW_KEY, JSON.stringify(next)).catch(() => undefined);
  };

  const tap = async () => {
    if (!follow.ace && !follow.phone) {
      toast(`Pick ${name}, the phone, or both`);
      return;
    }
    const lead = (follow.ace && ace) || (follow.phone && own) || ace || own;
    const to: AppearanceMode = lead === "light" ? "dark" : "light";
    const failed: string[] = [];
    await Promise.all([
      follow.ace
        ? (async () => {
            if (aceBlocked) throw new Error(aceBlocked);
            if (!client) throw new Error("The laptop isn't connected");
            setMine((m) => ({ ...m, ace: to }));
            await client.appearance.set.mutate({ mode: to });
          })().catch((e: unknown) => {
            setMine((m) => ({ ...m, ace: undefined }));
            failed.push(errorText(e));
          })
        : null,
      follow.phone
        ? (async () => {
            if (!session) throw new Error("ekatva is locked");
            setMine((m) => ({ ...m, phone: to }));
            await createPhoneCaller({
              actor: { key: "local", name: "you" },
              grants: { has: () => true },
              journal: session.journal,
              services: session.services,
            }).appearance.set({ mode: to });
          })().catch((e: unknown) => {
            setMine((m) => ({ ...m, phone: undefined }));
            failed.push(errorText(e));
          })
        : null,
    ]);
    laptop.reload();
    phone.reload();
    toast(
      failed.length
        ? (failed[0] ?? "")
        : `${follow.ace && follow.phone ? "Both" : follow.ace ? name : "This phone"}: ${to}`,
    );
  };

  return { ace, aceBlocked, phone: own, follow, toggleFollow, tap };
}

/**
 * The app's state: set up or not, locked or not, the session once open,
 * and the link's state, for every screen.
 *
 * Opening needs the app password (and the fingerprint, which the keystore
 * asks for) once per start; after 5 minutes in the background the app
 * locks again and needs the fingerprint.
 */
import { createPhoneCaller } from "@ekatva/protocol";
import * as LocalAuthentication from "expo-local-authentication";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AppState } from "react-native";
import type { LinkState } from "../core/link";
import { Session } from "../core/session";
import { platform } from "../platform";

type Phase = "loading" | "setup" | "password" | "locked" | "ready";

interface App {
  phase: Phase;
  session: Session | null;
  alerts: string[];
  dismissAlert(i: number): void;
  create(password: string): Promise<void>;
  unlock(password: string): Promise<void>;
  unlockWithFingerprint(): Promise<void>;
  lock(): void;
  /** Asks for the fingerprint before something risky; false if declined. */
  confirm(reason: string): Promise<boolean>;
  /** Undo an entry of this phone's own log, as you. */
  undoHere(seq: number): Promise<string>;
}

const Ctx = createContext<App | null>(null);
const LOCK_AFTER_MS = 5 * 60_000;

export function AppProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [alerts, setAlerts] = useState<string[]>([]);
  const p = useMemo(() => platform((m) => setAlerts((a) => [...a, m])), []);
  const backgroundAt = useRef<number | null>(null);

  useEffect(() => {
    void Session.isSetUp(p).then((yes) => setPhase(yes ? "password" : "setup"));
  }, [p]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "background") backgroundAt.current = Date.now();
      if (s === "active") {
        if (backgroundAt.current && Date.now() - backgroundAt.current > LOCK_AFTER_MS && session)
          setPhase("locked");
        backgroundAt.current = null;
        session?.link.wake();
      }
    });
    return () => sub.remove();
  }, [session]);

  const open = (s: Session) => {
    setSession(s);
    setPhase("ready");
    s.link.start();
  };

  const app: App = {
    phase,
    session,
    alerts,
    dismissAlert: (i) => setAlerts((a) => a.filter((_, j) => j !== i)),
    create: async (pw) => open(await Session.create(p, pw)),
    unlock: async (pw) => open(await Session.unlock(p, pw)),
    async unlockWithFingerprint() {
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock ekatva",
        disableDeviceFallback: false,
      });
      if (r.success) setPhase("ready");
    },
    lock: () => setPhase(session ? "locked" : "password"),
    async confirm(reason) {
      const has = await LocalAuthentication.hasHardwareAsync();
      if (!has) return true;
      return (await LocalAuthentication.authenticateAsync({ promptMessage: reason })).success;
    },
    async undoHere(seq) {
      if (!session) throw new Error("locked");
      const caller = createPhoneCaller({
        actor: { key: "local", name: "you" },
        grants: { has: () => true },
        journal: session.journal,
        services: session.services,
      });
      return (await caller.journal.undo({ seq })).summary;
    },
  };
  return <Ctx.Provider value={app}>{children}</Ctx.Provider>;
}

export function useApp(): App {
  const a = useContext(Ctx);
  if (!a) throw new Error("useApp outside AppProvider");
  return a;
}

/** The link's state, live. */
export function useLink(): LinkState {
  const { session } = useApp();
  return useSyncExternalStore(
    (cb) => session?.link.subscribe(cb) ?? (() => undefined),
    () => session?.link.state ?? { status: "unpaired" },
  );
}

/** Polls `load` every `ms` while mounted (and once at once). */
export function usePoll<T>(
  load: () => Promise<T> | null,
  deps: unknown[],
  ms = 4000,
): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller names the deps
  useEffect(() => {
    let live = true;
    const run = () => {
      const p = load();
      if (!p) return;
      p.then(
        (d) => {
          if (live) {
            setData(d);
            setError(null);
          }
        },
        (e: Error) => live && setError(e.message),
      );
    };
    run();
    const t = setInterval(run, ms);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((n) => n + 1) };
}

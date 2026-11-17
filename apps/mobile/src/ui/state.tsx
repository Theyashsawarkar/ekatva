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
import * as Network from "expo-network";
import { useIsFocused } from "expo-router";
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
import type { LaptopRecord } from "../core/laptops";
import type { LinkState } from "../core/link";
import {
  PRIVATE,
  type Snapshot,
  type Subscription,
  subscribePoll,
  WATCH_FALLBACK_MS,
  type Watch,
} from "../core/poll-store";
import { runtime } from "../core/runtime";
import { Session } from "../core/session";
import { platform } from "../platform";
import { usePhoneBridge } from "./bridge";
import { useClipboardSync } from "./clipboard-sync";
import { errorText } from "./errors";

type Phase = "loading" | "setup" | "password" | "locked" | "ready";

interface App {
  phase: Phase;
  session: Session | null;
  alerts: string[];
  dismissAlert(i: number): void;
  /** First run: keys behind the fingerprint. */
  create(): Promise<void>;
  /** The fingerprint; throws NeedsPassword for a vault from before (then `unlockWithPassword`). */
  unlock(): Promise<void>;
  unlockWithPassword(password: string): Promise<void>;
  unlockWithFingerprint(): Promise<void>;
  lock(): void;
  /** Forgot the password: wipe this phone's ekatva and set it up again. */
  reset(): Promise<void>;
  /** Asks for the fingerprint before something risky; false if declined. */
  confirm(reason: string): Promise<boolean>;
  /** Undo an entry of this phone's own log, as you. */
  undoHere(seq: number): Promise<string>;
}

const Ctx = createContext<App | null>(null);
const LOCK_AFTER_MS = 5 * 60_000;

/** Alerts from the session, to whichever AppProvider is mounted now. */
let alertTo: ((m: string) => void) | null = null;
/** One platform for the runtime (the session keeps the one it was opened with). */
let shared: ReturnType<typeof platform> | null = null;
const platformOnce = () => {
  shared ??= platform((m) => alertTo?.(m));
  return shared;
};

export function AppProvider({ children }: { children: ReactNode }) {
  // Remounted with a session still open (Android recreated the activity):
  // carry on with it, locked if it was away long enough. Never a second one.
  const [phase, setPhase] = useState<Phase>(() => {
    if (!runtime.session) return "loading";
    const away = runtime.backgroundAt;
    return away && Date.now() - away > LOCK_AFTER_MS ? "locked" : "ready";
  });
  const session = useSyncExternalStore(runtime.subscribe, () => runtime.session);
  const [alerts, setAlerts] = useState<string[]>([]);
  const p = useMemo(() => platformOnce(), []);
  useEffect(() => {
    const to = (m: string) => setAlerts((a) => (a.includes(m) ? a : [...a, m].slice(-5)));
    alertTo = to;
    return () => {
      if (alertTo === to) alertTo = null;
    };
  }, []);
  usePhoneBridge(session);
  useClipboardSync(session);

  useEffect(() => {
    if (runtime.session) return;
    void Session.isSetUp(p).then(
      (yes) => setPhase((now) => (now === "loading" ? (yes ? "password" : "setup") : now)),
      () => setPhase((now) => (now === "loading" ? "password" : now)),
    );
  }, [p]);

  // In front or not, and the network: read at the moment, from the runtime.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      const link = runtime.session?.link;
      if (s === "background") {
        runtime.backgroundAt = Date.now();
        link?.setForeground(false);
      }
      if (s === "active") {
        const away = runtime.backgroundAt;
        if (away && Date.now() - away > LOCK_AFTER_MS && runtime.session) setPhase("locked");
        runtime.backgroundAt = null;
        link?.setForeground(true);
      }
    });
    // A new network (Wi-Fi back, a hotspot): try now, don't wait for the backoff.
    const net = Network.addNetworkStateListener((st) => {
      if (st.isConnected) runtime.session?.link.wake();
    });
    return () => {
      sub.remove();
      net.remove();
    };
  }, []);

  /** One unlock at a time, one session for the runtime: never a second link. */
  const once = async (f: () => Promise<Session>) => {
    await runtime.open(f);
    setPhase("ready");
  };

  const app: App = {
    phase,
    session,
    alerts,
    dismissAlert: (i) => setAlerts((a) => a.filter((_, j) => j !== i)),
    create: () => once(() => Session.create(p)),
    unlock: () => once(() => Session.unlock(p)),
    unlockWithPassword: (pw) => once(() => Session.unlockWithPassword(p, pw)),
    async unlockWithFingerprint() {
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock ekatva",
        disableDeviceFallback: false,
      });
      if (r.success) setPhase("ready");
    },
    lock: () => setPhase(session ? "locked" : "password"),
    async reset() {
      runtime.close();
      await Session.reset(p);
      setPhase("setup");
    },
    // Risky actions: the fingerprint itself, never the screen lock instead.
    async confirm(reason) {
      const has = await LocalAuthentication.hasHardwareAsync();
      if (!has) return true;
      return (
        await LocalAuthentication.authenticateAsync({
          promptMessage: reason,
          disableDeviceFallback: true,
          biometricsSecurityLevel: "strong",
          cancelLabel: "Cancel",
        })
      ).success;
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

/**
 * The laptop this phone connects to, live. Never read `laptops.current()` during render:
 * the React Compiler memoizes it on `session` and the screen keeps the first answer.
 */
export function useLaptop(): LaptopRecord | undefined {
  const { session } = useApp();
  return useSyncExternalStore(
    (cb) => session?.laptops.onChange(cb) ?? (() => undefined),
    () => session?.laptops.current(),
  );
}

/** The link's state, live. */
export function useLink(): LinkState {
  const { session } = useApp();
  const real = useSyncExternalStore(
    (cb) => session?.link.subscribe(cb) ?? (() => undefined),
    () => session?.link.state ?? UNPAIRED,
  );
  // Calm under flapping: a link that drops and comes back within a moment
  // keeps reading as online (screens keep their last values meanwhile); only
  // a drop that lasts says "Connecting…".
  const [shown, setShown] = useState<LinkState>(real);
  useEffect(() => {
    if (real.status === "online" || shown.status !== "online") {
      setShown(real);
      return;
    }
    const t = setTimeout(() => setShown(real), CALM_MS);
    return () => clearTimeout(t);
  }, [real, shown.status]);
  return real.status === "online" ? real : shown;
}

/** The same object every time (a new one per read would re-render forever). */
const UNPAIRED: LinkState = { status: "unpaired" };

/** How long a dropped link still reads as online. */
const CALM_MS = 2500;

/** Is the app in front? One listener for every poll. */
let appActive = AppState.currentState === "active";
const activeSubs = new Set<() => void>();
AppState.addEventListener("change", (st) => {
  const now = st === "active";
  if (now === appActive) return;
  appActive = now;
  for (const f of activeSubs) f();
});

/**
 * Asks `load` every `ms` while mounted and the app is in front (and at once,
 * and again the moment it comes back to the front). One request at a time,
 * a longer wait after failures, and the last good answer kept meanwhile: a
 * dropped connection never blanks a screen.
 */
let privateKeys = 0;
/** A key for a screen's own poll (a function, so the React Compiler can memoize the hook). */
function nextKey(): string {
  privateKeys += 1;
  return `${PRIVATE}${privateKeys}`;
}

/**
 * Polls `load` every `ms` while this screen is in focus and the app in front
 * (and once at once). With a `key`, screens asking the same thing share one
 * request and its answer (core/poll-store.ts). An answer equal to the last
 * one keeps the old object, so nothing re-renders; the last answer stays
 * while the link is down or after an error (stale-while-revalidate).
 */
export function usePoll<T>(
  load: () => Promise<T> | null,
  deps: unknown[],
  ms = 4000,
  opts: {
    key?: string;
    /** The laptop pushes changes (a tRPC subscription): held while in focus, the poll a slow fallback. */
    watch?: Watch<T> | null;
    /** When two answers count as the same (default: deep equality). */
    equal?: (a: T | null, b: T) => boolean;
  } = {},
): { data: T | null; error: string | null; reload: () => void } {
  const focused = useIsFocused();
  const focusedRef = useRef(focused);
  const [key] = useState(() => opts.key ?? nextKey());
  const [snap, setSnap] = useState<Snapshot<T>>({ data: null, error: null });
  const sub = useRef<Subscription<T> | null>(null);

  // The query is set again by the effect below whenever the caller's deps change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: load is replaced through setLoad
  useEffect(() => {
    const s = subscribePoll<T>(
      key,
      load,
      ms,
      () => appActive && focusedRef.current,
      () => setSnap(s.get()),
      errorText,
      { watch: opts.watch, equal: opts.equal },
    );
    sub.current = s;
    setSnap(s.get());
    // The app came forward (ask now) or went away (drop the push).
    const wake = () => (appActive && focusedRef.current ? s.kick() : s.sync());
    activeSubs.add(wake);
    return () => {
      activeSubs.delete(wake);
      s.unsubscribe();
      if (sub.current === s) sub.current = null;
    };
  }, [key, ms]);
  // A new connection (the caller's deps): ask with the new query now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller names the deps
  useEffect(() => {
    sub.current?.setLoad(load, opts.watch);
  }, [...deps]);
  // Back in focus: ask now. Out of focus: drop the push.
  useEffect(() => {
    focusedRef.current = focused;
    if (focused) sub.current?.kick();
    else sub.current?.sync();
  }, [focused]);
  return { data: snap.data, error: snap.error, reload: () => sub.current?.kick() };
}

/** A tRPC subscription as a Watch (null without a connection). */
export function watchOf<T>(
  sub:
    | ((
        input: undefined,
        opts: { onData: (d: T) => void; onError: (e: unknown) => void },
      ) => { unsubscribe(): void })
    | null
    | undefined,
): Watch<T> | null {
  if (!sub) return null;
  return (onData, onError) => {
    const s = sub(undefined, { onData, onError });
    return () => s.unsubscribe();
  };
}

/**
 * What the laptop pushes as it changes (agents, jyoti, media, root
 * requests), shared by key like usePoll: the first value from `load`, then
 * each change over one subscription held while a screen showing it is in
 * focus and the app in front, and a poll every 30 s as a safety net.
 */
export function useWatch<T>(
  key: string,
  load: () => Promise<T> | null,
  watch: Watch<T> | null,
  deps: unknown[],
  opts: { equal?: (a: T | null, b: T) => boolean } = {},
) {
  return usePoll<T>(load, deps, WATCH_FALLBACK_MS, { key, watch, ...opts });
}

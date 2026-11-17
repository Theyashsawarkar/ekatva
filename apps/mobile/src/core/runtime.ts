/**
 * The app's one session, for the whole JS runtime, outside React.
 *
 * Android can destroy and recreate the activity while the JS keeps running:
 * the React tree (and AppProvider's state) is rebuilt from scratch, but a
 * session's link from before is still connected. Kept in React, a second
 * unlock then made a second session and a second link from the same phone,
 * and the two kept replacing each other at the laptop (and leaked until the
 * app ran out of memory). Here there is at most one session and one link,
 * whatever the screens do; a remounted AppProvider finds it again.
 */
import type { Session } from "./session";

export interface Runtime {
  /** The open session, if any. */
  session: Session | null;
  /** When the app last went to the background (null while in front). */
  backgroundAt: number | null;
}

const rt: Runtime = { session: null, backgroundAt: null };
let opening: Promise<Session> | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const f of listeners) f();
};

export const runtime = {
  get session(): Session | null {
    return rt.session;
  },
  get backgroundAt(): number | null {
    return rt.backgroundAt;
  },
  set backgroundAt(v: number | null) {
    rt.backgroundAt = v;
  },

  /**
   * Opens a session with `make`, unless one is open (then that one) or being
   * opened (then the same attempt): never two, however often it's called.
   */
  open(make: () => Promise<Session>): Promise<Session> {
    if (rt.session) return Promise.resolve(rt.session);
    opening ??= make()
      .then((s) => {
        runtime.adopt(s);
        return s;
      })
      .finally(() => {
        opening = null;
      });
    return opening;
  },

  /** Makes `s` the one session, stopping any other's link, and starts its link. */
  adopt(s: Session): void {
    const old = rt.session;
    if (old && old !== s) old.link.stop();
    rt.session = s;
    s.link.start();
    emit();
  },

  /** Closes the session (starting over): its link stops. */
  close(): void {
    rt.session?.link.stop();
    rt.session = null;
    emit();
  },

  subscribe(f: () => void): () => void {
    listeners.add(f);
    return () => listeners.delete(f);
  },
};

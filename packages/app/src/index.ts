/**
 * For a laptop app to talk to the phone's apps through ekatva.
 *
 *   const app = connectApp({ id: "nada", name: "nāda", version: "1",
 *     methods: [{ name: "play", why: "Play the laptop's music" }] });
 *   app.on("play", async (input, from) => { …; return { playing: true } });
 *   app.onEvent("handoff", (data, from) => { … });
 *   await app.call({ app: "nada", method: "queue", input: null });  // the phone's nāda
 *
 * It registers over ekatva's local socket (yours alone) and stays
 * registered: when the service restarts it reconnects and registers again
 * by itself. A phone reaches it only with its `app:<id>` grant.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AppEventInput,
  type AppFrom,
  type AppInfo,
  AppManifest,
  type AppManifestInput,
  type LaptopApp,
  type LocalRouter,
} from "@ekatva/protocol";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import WebSocket from "ws";

export type { AppFrom, AppInfo, AppManifestInput, LaptopApp };

/** ekatva's local socket: $EKATVA_SOCKET, else $XDG_RUNTIME_DIR/ekatva.sock. */
export function ekatvaSocket(): string {
  return (
    process.env.EKATVA_SOCKET ??
    join(process.env.XDG_RUNTIME_DIR ?? join(homedir(), ".local/state"), "ekatva.sock")
  );
}

type Handler = (input: unknown, from: AppFrom) => unknown | Promise<unknown>;
type EventHandler = (data: unknown, from: AppFrom, at: number) => void | Promise<void>;

export interface ConnectOptions {
  /** The socket (default: `ekatvaSocket()`). */
  socket?: string;
  /** Something went wrong outside a handler (the service went away…). */
  onError?: (e: Error) => void;
  /** Registered (again): after a start, or after the service came back. */
  onReady?: () => void;
}

export interface EkatvaApp {
  /** Answer the phone's calls to `method` (it must be in the manifest). */
  on(method: string, handler: Handler): EkatvaApp;
  /** Take the phone's `name` events (it must be in the manifest's events). */
  onEvent(name: string, handler: EventHandler): EkatvaApp;
  /** Call the phone's app (`device`: a phone's name or key; default the one connected last). */
  call(c: { app?: string; method: string; input?: unknown; device?: string }): Promise<unknown>;
  /** Send the phone's app an event; `keep` seconds holds it until that app is open. */
  emit(e: Omit<AppEventInput, "app"> & { app?: string; device?: string }): Promise<void>;
  /** The phone's apps. */
  phoneApps(device?: string): Promise<AppInfo[]>;
  close(): void;
}

export function connectApp(manifest: AppManifestInput, opts: ConnectOptions = {}): EkatvaApp {
  const m = AppManifest.parse(manifest);
  const handlers = new Map<string, Handler>();
  const events = new Map<string, EventHandler>();
  const fail = (e: unknown) => opts.onError?.(e instanceof Error ? e : new Error(String(e)));
  const ws = createWSClient({
    url: `ws+unix://${opts.socket ?? ekatvaSocket()}:/`,
    WebSocket: WebSocket as never,
    // The service restarting: come back, a little slower each time.
    retryDelayMs: (n) => Math.min(10_000, 500 * 2 ** n),
    onError: (e) => fail(e ?? new Error("ekatva's socket failed")),
    onOpen: () => opts.onReady?.(),
  });
  const api = createTRPCClient<LocalRouter>({ links: [wsLink({ client: ws })] });

  const answer = async (msg: { id: string; method: string; input?: unknown; from: AppFrom }) => {
    const h = handlers.get(msg.method);
    try {
      if (!h) throw new Error(`${m.name} doesn't answer "${msg.method}" yet`);
      const result = await h(msg.input, msg.from);
      await api.apps.reply.mutate({ id: msg.id, ok: true, result: result ?? null });
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 500) || "failed";
      await api.apps.reply.mutate({ id: msg.id, ok: false, error }).catch(fail);
    }
  };

  const sub = api.apps.register.subscribe(m, {
    onData: (msg) => {
      if (msg.kind === "call") void answer(msg);
      else void Promise.resolve(events.get(msg.name)?.(msg.data, msg.from, msg.at)).catch(fail);
    },
    onError: fail,
  });

  const self: EkatvaApp = {
    on(method, handler) {
      if (!m.methods.some((x) => x.name === method))
        throw new Error(`"${method}" isn't in ${m.name}'s manifest`);
      handlers.set(method, handler);
      return self;
    },
    onEvent(name, handler) {
      if (!m.events.some((x) => x.name === name))
        throw new Error(`"${name}" isn't in ${m.name}'s manifest events`);
      events.set(name, handler);
      return self;
    },
    call: ({ app, method, input, device }) =>
      api.apps.invoke.mutate({
        app: app ?? m.id,
        method,
        input: input ?? null,
        device: device ?? null,
      }),
    emit: async ({ app, name, data, keep, device }) => {
      await api.apps.emit.mutate({
        app: app ?? m.id,
        name,
        data: data ?? null,
        keep: keep ?? 0,
        device: device ?? null,
      });
    },
    phoneApps: (device) => api.apps.phone.query({ device: device ?? null }),
    close() {
      sub.unsubscribe();
      ws.close();
    },
  };
  return self;
}

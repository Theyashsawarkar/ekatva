/**
 * For a laptop app to talk to the phone's apps through ekatva.
 *
 *   const app = connectApp({ id: "nada", name: "nāda", version: "1",
 *     methods: [{ name: "play", why: "Play the laptop's music" }] });
 *   app.on("play", async (input, from, files) => { …; return { playing: true } });
 *   app.onEvent("handoff", (data, from) => { … });
 *   await app.call({ method: "queue" });                          // the phone's nāda
 *   await app.call({ to: "phone:vagdevi", method: "addBook", files: ["/tmp/a.epub"] });
 *
 * The first time, it asks to link: you accept it in Darpaṇa (Apps), once,
 * and it's linked for good (`onStatus` says where it stands: waiting,
 * linked, refused). It stays connected over ekatva's local socket (yours
 * alone): when the service restarts it reconnects by itself. Calling an
 * app other than its own other half asks you once in Darpaṇa (a route).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AppEventInput,
  type AppFile,
  type AppFrom,
  type AppInfo,
  AppManifest,
  type AppManifestInput,
  type LaptopApp,
  type LocalRouter,
} from "@ekatva/protocol";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import WebSocket from "ws";

export type { AppFile, AppFrom, AppInfo, AppManifestInput, LaptopApp };

/** Where the app's link stands. */
export type LinkStatus = "connecting" | "waiting" | "linked" | "refused";

/** ekatva's local socket: $EKATVA_SOCKET, else $XDG_RUNTIME_DIR/ekatva.sock. */
export function ekatvaSocket(): string {
  return (
    process.env.EKATVA_SOCKET ??
    join(process.env.XDG_RUNTIME_DIR ?? join(homedir(), ".local/state"), "ekatva.sock")
  );
}

/** `files`: what came with the call (each a path of its own copy). */
type Handler = (input: unknown, from: AppFrom, files: AppFile[]) => unknown | Promise<unknown>;
type EventHandler = (data: unknown, from: AppFrom, at: number) => void | Promise<void>;

export interface ConnectOptions {
  /** The socket (default: `ekatvaSocket()`). */
  socket?: string;
  /** Something went wrong outside a handler (the service went away…). */
  onError?: (e: Error) => void;
  /** Connected (again): after a start, or after the service came back. */
  onReady?: () => void;
  /** The link's status changed (waiting for you in Darpaṇa, linked, refused). */
  onStatus?: (status: LinkStatus, why?: string) => void;
}

export interface EkatvaApp {
  /** Answer the phone's calls to `method` (it must be in the manifest). */
  on(method: string, handler: Handler): EkatvaApp;
  /** Take the phone's `name` events (it must be in the manifest's events). */
  onEvent(name: string, handler: EventHandler): EkatvaApp;
  /**
   * Call an app: `to` "phone:APP" or "laptop:APP" (default: this app's half
   * on the phone). `files` are paths, sent along. `device`: a phone's name
   * or key (default the one connected last).
   */
  call(c: {
    to?: string;
    /** The old way to say `to: "phone:APP"`. */
    app?: string;
    method: string;
    input?: unknown;
    files?: string[];
    device?: string;
  }): Promise<unknown>;
  /** Send the phone's app an event; `keep` seconds holds it until that app is open. */
  emit(e: Omit<AppEventInput, "app"> & { app?: string; device?: string }): Promise<void>;
  /** The phone's apps. */
  phoneApps(device?: string): Promise<AppInfo[]>;
  /** Where the link stands now. */
  status(): LinkStatus;
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

  let status: LinkStatus = "connecting";
  const answer = async (msg: {
    id: string;
    method: string;
    input?: unknown;
    from: AppFrom;
    files?: AppFile[];
  }) => {
    const h = handlers.get(msg.method);
    try {
      if (!h) throw new Error(`${m.name} doesn't answer "${msg.method}" yet`);
      const result = await h(msg.input, msg.from, msg.files ?? []);
      await api.apps.reply.mutate({ id: msg.id, ok: true, result: result ?? null });
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 500) || "failed";
      await api.apps.reply.mutate({ id: msg.id, ok: false, error }).catch(fail);
    }
  };

  const sub = api.apps.register.subscribe(m, {
    onData: (msg) => {
      if (msg.kind === "status") {
        status = msg.status;
        opts.onStatus?.(msg.status, msg.why);
      } else if (msg.kind === "call") void answer(msg);
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
    call: ({ to, app, method, input, files, device }) =>
      api.apps.invoke.mutate({
        to: to ?? `phone:${app ?? m.id}`,
        method,
        input: input ?? null,
        files: files ?? [],
        device: device ?? null,
        as: m.id,
      }),
    emit: async ({ app, name, data, keep, device }) => {
      await api.apps.emit.mutate({
        to: `phone:${app ?? m.id}`,
        name,
        data: data ?? null,
        keep: keep ?? 0,
        device: device ?? null,
        as: m.id,
      });
    },
    status: () => status,
    phoneApps: (device) => api.apps.phone.query({ device: device ?? null }),
    close() {
      sub.unsubscribe();
      ws.close();
    },
  };
  return self;
}

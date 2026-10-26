/**
 * tRPC over an ekatva channel port, both halves, in portable JS.
 *
 * tRPC's own WebSocket server adapter needs node:http and Buffer, so it
 * can't run on the phone. This speaks the same wire protocol (tRPC v11's
 * WebSocket messages: query, mutation, subscription, subscription.stop)
 * using tRPC's own procedure caller, so validation, middleware and error
 * shapes are tRPC's. The client side is tRPC's real wsLink, given a
 * WebSocket look-alike that rides on the port.
 */
import { type Channel, utf8 } from "@ekatva/link";
import type { AnyRouter, inferRouterContext } from "@trpc/server";
import {
  callProcedure,
  getErrorShape,
  getTRPCErrorFromUnknown,
  isTrackedEnvelope,
  parseTRPCMessage,
  TRPCError,
  transformTRPCResponse,
} from "@trpc/server/unstable-core-do-not-import";

type Id = string | number | null;

export interface ServeOptions<R extends AnyRouter> {
  router: R;
  channel: Channel;
  port: number;
  /** Built once per channel: who the peer is and what it may do. */
  createContext: () => inferRouterContext<R> | Promise<inferRouterContext<R>>;
  onError?: (e: { error: TRPCError; path: string | undefined }) => void;
}

/** Serves `router` to the peer on `port` until the channel closes. */
export function serveRouter<R extends AnyRouter>(opts: ServeOptions<R>): () => void {
  const { router, channel, port } = opts;
  const config = router._def._config;
  const subs = new Map<Id, AbortController>();
  const ctxPromise = Promise.resolve().then(opts.createContext);

  const respond = (msg: unknown) => {
    if (!channel.isOpen) return;
    channel.sendText(port, JSON.stringify(transformTRPCResponse(config, msg as never)));
  };

  const fail = (id: Id, error: TRPCError, path?: string, type?: string, input?: unknown) => {
    opts.onError?.({ error, path });
    respond({
      id,
      error: getErrorShape({
        config,
        error,
        type: (type ?? "unknown") as never,
        path,
        input,
        ctx: undefined,
      }),
    });
  };

  const handle = async (raw: unknown) => {
    let msg: ReturnType<typeof parseTRPCMessage>;
    try {
      msg = parseTRPCMessage(raw, config.transformer);
    } catch (cause) {
      const id = (raw as { id?: Id })?.id ?? null;
      fail(id, new TRPCError({ code: "PARSE_ERROR", message: "bad message", cause }));
      return;
    }
    const { id } = msg;
    if (msg.method === "subscription.stop") {
      subs.get(id)?.abort();
      subs.delete(id);
      return;
    }
    if (msg.method !== "query" && msg.method !== "mutation" && msg.method !== "subscription") {
      return; // connectionParams and the like: not used
    }
    const type = msg.method;
    const { path, lastEventId } = msg.params;
    let input = msg.params.input;
    if (lastEventId !== undefined) {
      input =
        input && typeof input === "object" ? { ...input, lastEventId } : (input ?? { lastEventId });
    }
    const abort = new AbortController();
    try {
      const ctx = await ctxPromise;
      if (type === "subscription") {
        if (subs.has(id))
          throw new TRPCError({ code: "BAD_REQUEST", message: `duplicate id ${id}` });
        subs.set(id, abort);
      }
      const result = await callProcedure({
        router,
        path,
        getRawInput: async () => input,
        ctx,
        type,
        signal: abort.signal,
        batchIndex: 0,
      });
      const iterable = result && typeof result[Symbol.asyncIterator] === "function";
      if (type !== "subscription") {
        if (iterable)
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "not a subscription" });
        respond({ id, result: { type: "data", data: result } });
        return;
      }
      if (!iterable) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `${path} isn't a stream` });
      }
      respond({ id, result: { type: "started" } });
      const it = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      const aborted = new Promise<"abort">((res) =>
        abort.signal.addEventListener("abort", () => res("abort")),
      );
      try {
        while (true) {
          const next = await Promise.race([it.next(), aborted]);
          if (next === "abort") break;
          if (next.done) break;
          if (isTrackedEnvelope(next.value)) {
            const [eventId, data] = next.value;
            respond({ id, result: { type: "data", id: eventId, data: { id: eventId, data } } });
          } else respond({ id, result: { type: "data", data: next.value } });
        }
      } finally {
        await it.return?.();
        subs.delete(id);
      }
      respond({ id, result: { type: "stopped" } });
    } catch (e) {
      subs.delete(id);
      fail(id, getTRPCErrorFromUnknown(e), path, type, input);
    }
  };

  const offPort = channel.onPort(port, (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(utf8.decode(data));
    } catch {
      fail(null, new TRPCError({ code: "PARSE_ERROR", message: "not JSON" }));
      return;
    }
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) void handle(m);
  });
  const stop = () => {
    offPort();
    for (const a of subs.values()) a.abort();
    subs.clear();
  };
  channel.onClose(stop);
  return stop;
}

type Handler = (ev: never) => void;

/**
 * A WebSocket class whose sockets ride on `port` of `channel`, for tRPC's
 * `createWSClient({ url: "ekatva:", WebSocket: channelWebSocket(ch, port) })`.
 * Each instance opens at once while the channel is open; when the channel
 * closes, so do they (make a new client for the next channel).
 */
export function channelWebSocket(channel: Channel, port: number): typeof WebSocket {
  class ChannelSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readyState = 0;
    binaryType = "arraybuffer";
    readonly url: string;
    private listeners = new Map<string, Set<Handler>>();
    private offs: (() => void)[] = [];

    constructor(url: string) {
      this.url = url;
      // Open on a later task, as a real socket does: tRPC attaches its
      // listeners a few microtasks after constructing it.
      setTimeout(() => {
        if (this.readyState === 3) return;
        if (!channel.isOpen) return this.shut(1006, "link closed");
        this.readyState = 1;
        this.offs.push(
          channel.onPort(port, (d) => this.emit("message", { data: utf8.decode(d) })),
          channel.onClose((reason) => this.shut(1006, reason)),
        );
        this.emit("open", {});
      }, 0);
    }

    send(data: string): void {
      if (this.readyState !== 1) throw new Error("socket not open");
      // The link can drop between tRPC's check and its send: close, don't throw.
      if (!channel.isOpen) {
        this.shut(1006, "link closed");
        return;
      }
      channel.sendText(port, data);
    }

    close(code = 1000, reason = ""): void {
      this.shut(code, reason);
    }

    addEventListener(type: string, cb: Handler): void {
      let set = this.listeners.get(type);
      if (!set) {
        set = new Set();
        this.listeners.set(type, set);
      }
      set.add(cb);
    }

    removeEventListener(type: string, cb: Handler): void {
      this.listeners.get(type)?.delete(cb);
    }

    private emit(type: string, ev: object): void {
      for (const cb of this.listeners.get(type) ?? []) (cb as (e: object) => void)({ type, ...ev });
    }

    private shut(code: number, reason: string): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      for (const off of this.offs) off();
      this.offs = [];
      this.emit("close", { code, reason, wasClean: code === 1000 });
    }
  }
  return ChannelSocket as unknown as typeof WebSocket;
}

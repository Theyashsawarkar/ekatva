/**
 * An encrypted, multiplexed channel over any message transport (a
 * WebSocket, directly or through a tunnel).
 *
 * The phone connects (Noise initiator) and checks the laptop's key against
 * the one it trusts (from the QR, or saved at pairing). The laptop accepts
 * (responder) and asks its `authorize` callback whether this phone key may
 * in: a paired phone, or a pairing token plus your confirmation.
 *
 * After the handshake every frame is `[channel][flags][payload]`,
 * encrypted. Channel 0 is control (JSON); the others are ports, each a
 * stream of messages, for example tRPC each way. Messages larger than one
 * Noise message are fragmented and reassembled, up to MAX_ASSEMBLED.
 */
import { utf8 } from "./bytes.js";
import { Handshake, type KeyPair, keysEqual, MAX_MESSAGE, type Session } from "./noise.js";
import { sas } from "./sas.js";

export const PROLOGUE = utf8.encode("ekatva/1");
export const CONTROL = 0;
/** The laptop's API: the phone is the client. */
export const PORT_LAPTOP = 1;
/** The phone's API: the laptop is the client. */
export const PORT_PHONE = 2;

const HEADER = 2;
const TAG = 16;
const CHUNK = MAX_MESSAGE - TAG - HEADER;
const MORE = 1;
/** The largest message a port accepts once reassembled. */
export const MAX_ASSEMBLED = 16 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** A message transport: what a WebSocket provides. */
export interface Transport {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
}

/** Wraps a standard WebSocket (browsers, React Native, Node's, or `ws`'s). */
export function webSocketTransport(ws: {
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, cb: (ev: never) => void): void;
}): Transport {
  ws.binaryType = "arraybuffer";
  return {
    send: (d) => ws.send(d),
    close: (code, reason) => ws.close(code, reason),
    onMessage: (cb) =>
      ws.addEventListener("message", ((ev: { data: unknown }) => {
        if (ev.data instanceof ArrayBuffer) cb(new Uint8Array(ev.data));
        else if (ArrayBuffer.isView(ev.data))
          cb(new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength));
      }) as (ev: never) => void),
    onClose: (cb) =>
      ws.addEventListener("close", ((ev: { code: number; reason: string }) =>
        cb(ev.code, ev.reason)) as (ev: never) => void),
  };
}

/** What each side tells the other inside the handshake. */
export interface Hello {
  v: 1;
  /** A human name: "Pixel 8", "ace". */
  name: string;
  /** The phone's pairing token (base64url), only when pairing. */
  token?: string;
  /** Free-form details: app version, platform. */
  info?: Record<string, string>;
}

/** What the laptop's `authorize` gets to decide on. */
export interface Candidate {
  remoteStatic: Uint8Array;
  hello: Hello;
  /** The four emoji: show them when pairing. */
  sas: string[];
}

export type Decision = { ok: true; welcome?: unknown } | { ok: false; reason: string };

/** Close codes (WebSocket's private range). */
export const CLOSE = {
  denied: 4001,
  wrongKey: 4002,
  protocol: 4003,
  timeout: 4004,
  bye: 4000,
} as const;

export class LinkError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

type Listener<T> = (v: T) => void;

/** One end of an open link. */
export class Channel {
  private ports = new Map<number, Set<Listener<Uint8Array>>>();
  private partial = new Map<number, Uint8Array[]>();
  private partialSize = new Map<number, number>();
  private controlListeners = new Set<Listener<Record<string, unknown>>>();
  private closeListeners = new Set<(reason: string) => void>();
  private closed = false;
  private lastSeen = Date.now();
  private keepalive: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly t: Transport,
    private readonly session: Session,
    /** The other side's hello. */
    readonly peer: Hello,
    opts: { keepaliveMs?: number } = {},
  ) {
    t.onMessage((d) => this.receive(d));
    t.onClose((code, reason) => this.finish(reason || `closed (${code})`));
    const every = opts.keepaliveMs ?? 20_000;
    if (every > 0) {
      this.keepalive = setInterval(() => {
        if (Date.now() - this.lastSeen > every * 3) this.close("timed out", CLOSE.timeout);
        else this.control({ t: "ping" });
      }, every);
    }
  }

  get remoteStatic(): Uint8Array {
    return this.session.remoteStatic;
  }

  /** Unique to this session; equal on both ends. */
  get handshakeHash(): Uint8Array {
    return this.session.hash;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  send(port: number, data: Uint8Array): void {
    if (port <= CONTROL || port > 255) throw new Error("bad port");
    this.write(port, data);
  }

  sendText(port: number, text: string): void {
    this.send(port, utf8.encode(text));
  }

  onPort(port: number, cb: Listener<Uint8Array>): () => void {
    let set = this.ports.get(port);
    if (!set) {
      set = new Set();
      this.ports.set(port, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  control(msg: Record<string, unknown>): void {
    this.write(CONTROL, utf8.encode(JSON.stringify(msg)));
  }

  onControl(cb: Listener<Record<string, unknown>>): () => void {
    this.controlListeners.add(cb);
    return () => this.controlListeners.delete(cb);
  }

  onClose(cb: (reason: string) => void): () => void {
    if (this.closed) queueMicrotask(() => cb("closed"));
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  close(reason = "bye", code: number = CLOSE.bye): void {
    if (this.closed) return;
    try {
      this.t.close(code, reason);
    } catch {
      // already gone
    }
    this.finish(reason);
  }

  private write(port: number, data: Uint8Array): void {
    if (this.closed) throw new LinkError("link closed", CLOSE.bye);
    if (data.length > MAX_ASSEMBLED) throw new Error("message too large");
    let off = 0;
    do {
      const piece = data.subarray(off, off + CHUNK);
      off += piece.length;
      const frame = new Uint8Array(HEADER + piece.length);
      frame[0] = port;
      frame[1] = off < data.length ? MORE : 0;
      frame.set(piece, HEADER);
      this.t.send(this.session.send.encrypt(frame));
    } while (off < data.length);
  }

  private receive(data: Uint8Array): void {
    if (this.closed) return;
    let frame: Uint8Array;
    try {
      frame = this.session.recv.decrypt(data);
    } catch {
      // A frame that fails to decrypt means tampering or a lost frame: the
      // nonces are out of step for good, so the session can't continue.
      this.close("bad frame", CLOSE.protocol);
      return;
    }
    this.lastSeen = Date.now();
    if (frame.length < HEADER) {
      this.close("bad frame", CLOSE.protocol);
      return;
    }
    const port = frame[0] as number;
    const more = ((frame[1] as number) & MORE) !== 0;
    const body = frame.subarray(HEADER);
    const parts = this.partial.get(port) ?? [];
    const size = (this.partialSize.get(port) ?? 0) + body.length;
    if (size > MAX_ASSEMBLED) {
      this.close("message too large", CLOSE.protocol);
      return;
    }
    parts.push(body);
    if (more) {
      this.partial.set(port, parts);
      this.partialSize.set(port, size);
      return;
    }
    this.partial.delete(port);
    this.partialSize.delete(port);
    const whole = parts.length === 1 ? (parts[0] as Uint8Array) : join(parts, size);
    if (port === CONTROL) {
      this.handleControl(whole);
      return;
    }
    for (const cb of this.ports.get(port) ?? []) cb(whole);
  }

  private handleControl(data: Uint8Array): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(utf8.decode(data));
    } catch {
      this.close("bad control message", CLOSE.protocol);
      return;
    }
    if (msg.t === "ping") {
      this.control({ t: "pong" });
      return;
    }
    if (msg.t === "pong") return;
    for (const cb of this.controlListeners) cb(msg);
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) clearInterval(this.keepalive);
    for (const cb of this.closeListeners) cb(reason);
    this.closeListeners.clear();
  }
}

function join(parts: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Reads transport messages one at a time, for the handshake. */
function reader(t: Transport) {
  const queue: Uint8Array[] = [];
  let waiting: { resolve: (d: Uint8Array) => void; reject: (e: Error) => void } | null = null;
  let ended: Error | null = null;
  let active = true;
  t.onMessage((d) => {
    if (!active) return;
    if (waiting) {
      const w = waiting;
      waiting = null;
      w.resolve(d);
    } else queue.push(d);
  });
  t.onClose((code, reason) => {
    if (!active) return;
    ended = new LinkError(reason || "closed during the handshake", code);
    waiting?.reject(ended);
    waiting = null;
  });
  return {
    next(timeoutMs: number): Promise<Uint8Array> {
      const d = queue.shift();
      if (d) return Promise.resolve(d);
      if (ended) return Promise.reject(ended);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting = null;
          reject(new LinkError("the other side stopped answering", CLOSE.timeout));
        }, timeoutMs);
        waiting = {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        };
      });
    },
    /** Messages that arrived after the handshake, before the Channel took over. */
    drain(): Uint8Array[] {
      active = false;
      return queue.splice(0);
    },
  };
}

function parseHello(data: Uint8Array): Hello {
  const h = JSON.parse(utf8.decode(data));
  if (h?.v !== 1 || typeof h.name !== "string") throw new Error("bad hello");
  return {
    v: 1,
    name: h.name.slice(0, 64),
    ...(typeof h.token === "string" ? { token: h.token } : {}),
    ...(h.info && typeof h.info === "object" ? { info: h.info } : {}),
  };
}

/** Feeds messages that arrived during the handshake to the new channel. */
function handOver(t: Transport, early: Uint8Array[]): Transport {
  let cbMessage: ((d: Uint8Array) => void) | null = null;
  const closeCbs: ((c: number, r: string) => void)[] = [];
  t.onMessage((d) => cbMessage?.(d));
  t.onClose((c, r) => {
    for (const cb of closeCbs) cb(c, r);
  });
  return {
    send: (d) => t.send(d),
    close: (c, r) => t.close(c, r),
    onMessage(cb) {
      cbMessage = cb;
      for (const d of early) cb(d);
    },
    onClose: (cb) => closeCbs.push(cb),
  };
}

export interface ConnectOptions {
  me: KeyPair;
  /** The laptop's key this phone trusts (from the QR or saved at pairing). */
  expect: Uint8Array;
  hello: Hello;
  /** Called once the laptop's key checks out, with the emoji to show. */
  onSas?: (emoji: string[]) => void;
  /** How long to wait for the laptop's answer (pairing waits for a person). */
  decisionTimeoutMs?: number;
  keepaliveMs?: number;
}

/** The phone's side: connect, prove both keys, wait to be let in. */
export async function connect(
  t: Transport,
  opts: ConnectOptions,
): Promise<{ channel: Channel; welcome: unknown }> {
  const r = reader(t);
  const hs = new Handshake(true, opts.me, PROLOGUE);
  try {
    t.send(hs.write());
    const peer = parseHello(hs.read(await r.next(HANDSHAKE_TIMEOUT_MS)));
    const rs = hs.remoteStatic;
    if (!rs || !keysEqual(rs, opts.expect)) {
      throw new LinkError("this isn't the laptop you paired with", CLOSE.wrongKey);
    }
    t.send(hs.write(utf8.encode(JSON.stringify(opts.hello))));
    const session = hs.session as Session;
    opts.onSas?.(sas(session.hash));
    // The laptop's first transport message is its decision.
    const first = session.recv.decrypt(await r.next(opts.decisionTimeoutMs ?? 150_000));
    const decision = JSON.parse(utf8.decode(first.subarray(HEADER)));
    if (first[0] !== CONTROL || decision.t !== "decision") {
      throw new LinkError("unexpected answer", CLOSE.protocol);
    }
    if (!decision.ok) throw new LinkError(decision.reason ?? "not allowed", CLOSE.denied);
    const channel = new Channel(handOver(t, r.drain()), session, peer, opts);
    return { channel, welcome: decision.welcome };
  } catch (e) {
    const code = e instanceof LinkError ? e.code : CLOSE.protocol;
    try {
      t.close(code, e instanceof Error ? e.message : "error");
    } catch {}
    throw e instanceof LinkError ? e : new LinkError(String((e as Error)?.message ?? e), code);
  }
}

export interface AcceptOptions {
  me: KeyPair;
  hello: Hello;
  authorize: (c: Candidate) => Promise<Decision> | Decision;
  keepaliveMs?: number;
}

/** The laptop's side: prove its key, learn the phone's, decide. */
export async function accept(t: Transport, opts: AcceptOptions): Promise<Channel> {
  const r = reader(t);
  const hs = new Handshake(false, opts.me, PROLOGUE);
  try {
    hs.read(await r.next(HANDSHAKE_TIMEOUT_MS));
    t.send(hs.write(utf8.encode(JSON.stringify(opts.hello))));
    const hello = parseHello(hs.read(await r.next(HANDSHAKE_TIMEOUT_MS)));
    const session = hs.session as Session;
    const decision = await opts.authorize({
      remoteStatic: session.remoteStatic,
      hello,
      sas: sas(session.hash),
    });
    const frame = utf8.encode(JSON.stringify({ t: "decision", ...decision }));
    const out = new Uint8Array(HEADER + frame.length);
    out[0] = CONTROL;
    out.set(frame, HEADER);
    t.send(session.send.encrypt(out));
    if (!decision.ok) {
      t.close(CLOSE.denied, decision.reason);
      throw new LinkError(decision.reason, CLOSE.denied);
    }
    return new Channel(handOver(t, r.drain()), session, hello, opts);
  } catch (e) {
    const code = e instanceof LinkError ? e.code : CLOSE.protocol;
    try {
      t.close(code, e instanceof LinkError ? e.message : "handshake failed");
    } catch {}
    throw e instanceof LinkError ? e : new LinkError(String((e as Error)?.message ?? e), code);
  }
}

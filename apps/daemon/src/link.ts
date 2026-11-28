/**
 * The session's side of ekatva-link (apps/link): the always-on system service
 * that holds the laptop's identity, the paired phones and their Noise
 * sessions. The daemon attaches to its socket (/run/ekatva/session.sock) and
 * gets each connected phone as a `PortChannel`, its ports already decrypted,
 * so `laptopRouter` serves it exactly as before.
 *
 * Messages, both ways: `[u32 total][u32 header length][header JSON][payload]`,
 * big-endian (apps/link/src/wire.rs).
 *
 *   link → session  hello {key, name, port, url} · devices {list} · pending {list}
 *                   open {conn, key, name, via, info} · data {conn, port}+bytes
 *                   control {conn, msg} · closed {conn, reason} · reply {id, ok, value|error}
 *   session → link  data {conn, port}+bytes · control {conn, msg} · close {conn, reason, code?}
 *                   call {id, m, p}: devices.list|put|remove, online, pair.token, pair.decide
 */
import { createConnection, type Socket } from "node:net";
import { fromB64u, type Hello, type PortChannel, utf8 } from "@ekatva/link";
import type { DeviceRecord } from "./devices.js";

/** Where the link listens for the session (ekatva-link.service's RuntimeDirectory). */
export const LINK_SOCKET = process.env.EKATVA_LINK_SOCKET ?? "/run/ekatva/session.sock";
/** Present once the link is installed: the daemon then never listens itself. */
export const LINK_UNIT = "/etc/systemd/system/ekatva-link.service";

type Header = Record<string, unknown> & { t: string };

export interface LinkHello {
  key: string;
  name: string;
  port: number;
  url: string | null;
}

export interface LinkPending {
  id: string;
  key: string;
  name: string;
  sas: string[];
  info: Record<string, string>;
  at: number;
}

export interface LinkEvents {
  open(channel: SplicedChannel, via: "lan" | "tunnel"): void;
  devices(list: DeviceRecord[]): void;
  pending(list: LinkPending[]): void;
  /** The link went away (it restarted, or was stopped). */
  lost(): void;
}

export class LinkClient {
  private buf: Buffer = Buffer.alloc(0);
  private conns = new Map<number, SplicedChannel>();
  private calls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextCall = 0;
  private gone = false;
  hello: LinkHello | null = null;
  devices: DeviceRecord[] = [];

  private constructor(
    private readonly socket: Socket,
    private readonly on: LinkEvents,
  ) {
    socket.on("data", (d: Buffer) => this.receive(d));
    socket.on("close", () => this.lost());
    socket.on("error", () => this.lost());
  }

  /** Attaches, and waits for the link's hello and its paired phones. */
  static connect(on: LinkEvents, path = LINK_SOCKET, timeoutMs = 3000): Promise<LinkClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      let client: LinkClient | null = null;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("ekatva-link didn't answer"));
      }, timeoutMs);
      socket.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      socket.once("connect", () => {
        client = new LinkClient(socket, {
          ...on,
          devices: (list) => {
            on.devices(list);
            if (client?.hello) {
              clearTimeout(timer);
              resolve(client);
            }
          },
        });
      });
    });
  }

  get attached(): boolean {
    return !this.gone;
  }

  call<T = unknown>(m: string, p: unknown = null): Promise<T> {
    if (this.gone) return Promise.reject(new Error("ekatva-link isn't running"));
    const id = ++this.nextCall;
    return new Promise<T>((resolve, reject) => {
      this.calls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ t: "call", id, m, p });
    });
  }

  close(): void {
    this.socket.destroy();
  }

  /** @internal what a spliced channel sends. */
  send(h: Header, payload: Uint8Array = new Uint8Array(0)): void {
    if (this.gone) return;
    const head = Buffer.from(JSON.stringify(h));
    const out = Buffer.alloc(8 + head.length + payload.length);
    out.writeUInt32BE(4 + head.length + payload.length, 0);
    out.writeUInt32BE(head.length, 4);
    head.copy(out, 8);
    Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(out, 8 + head.length);
    this.socket.write(out);
  }

  private receive(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 4) {
      const total = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + total) return;
      const hlen = this.buf.readUInt32BE(4);
      let h: Header;
      try {
        h = JSON.parse(this.buf.subarray(8, 8 + hlen).toString("utf8")) as Header;
      } catch {
        this.socket.destroy();
        return;
      }
      const payload = new Uint8Array(this.buf.subarray(8 + hlen, 4 + total));
      this.buf = this.buf.subarray(4 + total);
      this.handle(h, payload);
    }
  }

  private handle(h: Header, payload: Uint8Array): void {
    const conn = typeof h.conn === "number" ? h.conn : -1;
    switch (h.t) {
      case "hello":
        this.hello = h as unknown as LinkHello;
        break;
      case "devices":
        this.devices = (h.list as DeviceRecord[]) ?? [];
        this.on.devices(this.devices);
        break;
      case "pending":
        this.on.pending((h.list as LinkPending[]) ?? []);
        break;
      case "open": {
        const c = new SplicedChannel(this, conn, String(h.key), {
          v: 1,
          name: String(h.name ?? "phone"),
          info: (h.info as Record<string, string>) ?? {},
        });
        this.conns.set(conn, c);
        this.on.open(c, h.via === "tunnel" ? "tunnel" : "lan");
        break;
      }
      case "data":
        this.conns.get(conn)?.deliver(Number(h.port), payload);
        break;
      case "control":
        this.conns.get(conn)?.deliverControl(h.msg as Record<string, unknown>);
        break;
      case "closed":
        this.conns.get(conn)?.ended(String(h.reason ?? "closed"));
        this.conns.delete(conn);
        break;
      case "reply": {
        const c = this.calls.get(Number(h.id));
        this.calls.delete(Number(h.id));
        if (h.ok) c?.resolve(h.value);
        else c?.reject(new Error(String(h.error ?? "ekatva-link refused")));
        break;
      }
    }
  }

  private lost(): void {
    if (this.gone) return;
    this.gone = true;
    for (const c of this.conns.values()) c.ended("ekatva-link went away");
    this.conns.clear();
    for (const c of this.calls.values()) c.reject(new Error("ekatva-link went away"));
    this.calls.clear();
    this.on.lost();
  }
}

/** A phone's link as the session sees it: ekatva-link holds the keys and the socket. */
export class SplicedChannel implements PortChannel {
  readonly remoteStatic: Uint8Array;
  private ports = new Map<number, Set<(d: Uint8Array) => void>>();
  private controls = new Set<(m: Record<string, unknown>) => void>();
  private closes = new Set<(reason: string) => void>();
  private open = true;

  constructor(
    private readonly link: LinkClient,
    private readonly conn: number,
    readonly key: string,
    readonly peer: Hello,
  ) {
    this.remoteStatic = fromB64u(key);
  }

  get isOpen(): boolean {
    return this.open;
  }

  send(port: number, data: Uint8Array): void {
    if (port <= 0 || port > 255) throw new Error("bad port");
    if (!this.open) throw new Error("link closed");
    this.link.send({ t: "data", conn: this.conn, port }, data);
  }

  sendText(port: number, text: string): void {
    this.send(port, utf8.encode(text));
  }

  onPort(port: number, cb: (data: Uint8Array) => void): () => void {
    let set = this.ports.get(port);
    if (!set) {
      set = new Set();
      this.ports.set(port, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  }

  control(msg: Record<string, unknown>): void {
    if (this.open) this.link.send({ t: "control", conn: this.conn, msg });
  }

  onControl(cb: (msg: Record<string, unknown>) => void): () => void {
    this.controls.add(cb);
    return () => this.controls.delete(cb);
  }

  onClose(cb: (reason: string) => void): () => void {
    if (!this.open) queueMicrotask(() => cb("closed"));
    this.closes.add(cb);
    return () => this.closes.delete(cb);
  }

  close(reason = "bye", code?: number): void {
    if (!this.open) return;
    this.link.send({ t: "close", conn: this.conn, reason, ...(code ? { code } : {}) });
    this.ended(reason);
  }

  /** @internal */
  deliver(port: number, data: Uint8Array): void {
    for (const cb of this.ports.get(port) ?? []) cb(data);
  }

  /** @internal */
  deliverControl(msg: Record<string, unknown>): void {
    for (const cb of this.controls) cb(msg);
  }

  /** @internal */
  ended(reason: string): void {
    if (!this.open) return;
    this.open = false;
    for (const cb of this.closes) cb(reason);
    this.closes.clear();
  }
}

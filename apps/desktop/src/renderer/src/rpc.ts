/** tRPC to the daemon, over a MessagePort the preload hands us. */
import type { LocalRouter } from "@ekatva/protocol";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";

const waiting: ((p: MessagePort) => void)[] = [];
window.addEventListener("message", (e) => {
  if (e.data === "ekatva:port" && e.ports[0]) waiting.shift()?.(e.ports[0]);
});

function requestPort(): Promise<MessagePort> {
  return new Promise((resolve) => {
    waiting.push(resolve);
    window.postMessage("ekatva:connect", "*");
  });
}

type Listener = (ev: never) => void;

/** A WebSocket look-alike over the relayed port, for tRPC's wsLink. */
class PortSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType = "arraybuffer";
  private port: MessagePort | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string) {
    void requestPort().then((port) => {
      this.port = port;
      port.onmessage = (e) => {
        const m = e.data as {
          t: string;
          data?: string;
          code?: number;
          reason?: string;
          message?: string;
        };
        if (m.t === "open") {
          this.readyState = 1;
          this.emit("open", {});
        } else if (m.t === "message") this.emit("message", { data: m.data });
        else if (m.t === "error") {
          lastError = m.message ?? "error";
          this.emit("error", { message: m.message });
        } else if (m.t === "close") this.shut(m.code ?? 1006, m.reason ?? "");
      };
      port.start();
    });
  }

  send(data: string): void {
    this.port?.postMessage({ t: "send", data });
  }

  close(): void {
    this.port?.postMessage({ t: "close" });
    this.shut(1000, "");
  }

  addEventListener(type: string, cb: Listener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.listeners.get(type)?.delete(cb);
  }

  private emit(type: string, ev: object): void {
    for (const cb of this.listeners.get(type) ?? []) (cb as (e: object) => void)({ type, ...ev });
  }

  private shut(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", { code, reason });
  }
}

export let lastError: string | null = null;

const ws = createWSClient({
  url: "ekatva:local",
  WebSocket: PortSocket as unknown as typeof WebSocket,
  retryDelayMs: (n) => Math.min(10_000, 500 * 2 ** n),
});
export const api = createTRPCClient<LocalRouter>({ links: [wsLink({ client: ws })] });

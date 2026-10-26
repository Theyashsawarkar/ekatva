/**
 * The phone's end of the link: pairing from a QR code, connecting (the
 * laptop's LAN addresses first, then its tunnel), reconnecting with
 * backoff, serving the phone's API, and keeping a verified copy of the
 * laptop's action log.
 */
import {
  type Channel,
  CLOSE,
  connect,
  fromB64u,
  LinkError,
  PORT_LAPTOP,
  PORT_PHONE,
  parseOffer,
  type Transport,
  toB64u,
} from "@ekatva/link";
import {
  channelWebSocket,
  type Entry,
  type Journal,
  type LaptopRouter,
  type Mirror,
  type PhoneServices,
  phoneRouter,
  serveRouter,
} from "@ekatva/protocol";
import { createTRPCClient, createWSClient, type TRPCClient, wsLink } from "@trpc/client";
import { type LaptopRecord, type Laptops, PHONE_DEFAULT } from "./laptops.js";
import type { Secrets } from "./vault.js";

/** Opens a WebSocket to `url`, as a transport, or fails within `timeoutMs`. */
export type Opener = (url: string, timeoutMs: number) => Promise<Transport>;

export type LinkState =
  | { status: "unpaired" }
  | { status: "offline"; laptop: string; error: string | null; retryAt: number | null }
  | { status: "connecting"; laptop: string }
  | { status: "online"; laptop: string; via: "lan" | "tunnel"; grants: string[] };

export interface LinkDeps {
  secrets: Secrets;
  laptops: Laptops;
  journal: Journal;
  mirror: (laptopKey: string) => Promise<Mirror>;
  services: PhoneServices;
  open: Opener;
  hello: { name: string; info: Record<string, string> };
  onAlert?: (message: string) => void;
  now?: () => number;
}

const MAX_BACKOFF_MS = 30_000;

export class LinkManager {
  state: LinkState = { status: "unpaired" };
  client: TRPCClient<LaptopRouter> | null = null;
  private channel: Channel | null = null;
  private cleanup: (() => void) | null = null;
  private wanted = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private busy: Promise<void> | null = null;
  private listeners = new Set<(s: LinkState) => void>();

  constructor(private readonly d: LinkDeps) {}

  private now() {
    return (this.d.now ?? Date.now)();
  }

  subscribe(cb: (s: LinkState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(s: LinkState): void {
    this.state = s;
    for (const cb of this.listeners) cb(s);
  }

  private urls(lan: string[], url: string | null): { url: string; via: "lan" | "tunnel" }[] {
    return [
      ...lan.map((h) => ({ url: `ws://${h}/link`, via: "lan" as const })),
      ...(url ? [{ url: `${url.replace(/\/+$/, "")}/link`, via: "tunnel" as const }] : []),
    ];
  }

  /** Pairs with the laptop in the QR code; `onSas` gets the four emoji to show. */
  async pair(uri: string, onSas: (emoji: string[]) => void): Promise<LaptopRecord> {
    const offer = parseOffer(uri);
    let last: unknown = new Error("the code has no address to reach the laptop at");
    for (const { url, via } of this.urls(offer.lan, offer.url ?? null)) {
      let t: Transport;
      try {
        t = await this.d.open(url, 4000);
      } catch (e) {
        last = e;
        continue;
      }
      const { channel, welcome } = await connect(t, {
        me: this.d.secrets.identity,
        expect: offer.key,
        hello: {
          v: 1,
          name: this.d.hello.name,
          token: toB64u(offer.token),
          info: this.d.hello.info,
        },
        onSas,
        decisionTimeoutMs: 150_000,
      });
      const record: LaptopRecord = {
        key: toB64u(offer.key),
        name: channel.peer.name,
        lan: offer.lan,
        url: offer.url ?? null,
        pairedAt: this.now(),
        lastSeen: this.now(),
        grants: [...PHONE_DEFAULT],
      };
      await this.d.laptops.put(record);
      this.attach(channel, record, via, welcome);
      this.wanted = true;
      return record;
    }
    throw last;
  }

  /** Keep connected from now on. */
  start(): void {
    this.wanted = true;
    void this.connectNow();
  }

  /** Try again right away (the app came forward, the network changed). */
  wake(): void {
    if (this.wanted && this.state.status === "offline") void this.connectNow();
  }

  stop(): void {
    this.wanted = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.channel?.close("bye");
  }

  private connectNow(): Promise<void> {
    this.busy ??= this.tryConnect().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async tryConnect(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.channel?.isOpen) return;
    const laptop = this.d.laptops.current();
    if (!laptop) {
      this.set({ status: "unpaired" });
      return;
    }
    this.set({ status: "connecting", laptop: laptop.key });
    let error = "can't reach the laptop";
    for (const { url, via } of this.urls(laptop.lan, laptop.url)) {
      try {
        const t = await this.d.open(url, 4000);
        const { channel, welcome } = await connect(t, {
          me: this.d.secrets.identity,
          expect: fromB64u(laptop.key),
          hello: { v: 1, name: this.d.hello.name, info: this.d.hello.info },
        });
        this.attempts = 0;
        this.attach(channel, laptop, via, welcome);
        return;
      } catch (e) {
        if (e instanceof LinkError && e.code === CLOSE.denied) {
          // The laptop doesn't know this phone any more: don't keep knocking.
          this.set({
            status: "offline",
            laptop: laptop.key,
            error: `${laptop.name} no longer knows this phone; pair again`,
            retryAt: null,
          });
          return;
        }
        if (e instanceof LinkError && e.code === CLOSE.wrongKey)
          error = "something else answered at the laptop's address";
        else error = (e as Error).message || error;
      }
    }
    this.scheduleRetry(laptop.key, error);
  }

  private scheduleRetry(laptop: string, error: string | null): void {
    if (!this.wanted) {
      this.set({ status: "offline", laptop, error, retryAt: null });
      return;
    }
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts++);
    this.set({ status: "offline", laptop, error, retryAt: this.now() + delay });
    this.retryTimer = setTimeout(() => void this.connectNow(), delay);
  }

  private attach(
    channel: Channel,
    laptop: LaptopRecord,
    via: "lan" | "tunnel",
    welcome: unknown,
  ): void {
    this.cleanup?.();
    this.channel = channel;
    const stopServing = serveRouter({
      router: phoneRouter,
      channel,
      port: PORT_PHONE,
      createContext: () => ({
        actor: { key: laptop.key, name: this.d.laptops.get(laptop.key)?.name ?? laptop.name },
        grants: this.d.laptops.grantsOf(laptop.key),
        journal: this.d.journal,
        services: this.d.services,
      }),
    });
    const wsClient = createWSClient({
      url: "ekatva:",
      WebSocket: channelWebSocket(channel, PORT_LAPTOP),
      retryDelayMs: () => 60_000,
    });
    const client = createTRPCClient<LaptopRouter>({ links: [wsLink({ client: wsClient })] });
    this.client = client;
    let follow: { unsubscribe(): void } | null = null;
    let stopped = false;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      follow?.unsubscribe();
      stopServing();
      void wsClient.close();
    };
    this.cleanup = cleanup;
    void this.d.laptops.update(laptop.key, { lastSeen: this.now(), name: channel.peer.name });
    const grants = ((welcome as { grants?: string[] } | null)?.grants ?? []).slice();
    this.set({ status: "online", laptop: laptop.key, via, grants });
    // Keep a verified copy of the laptop's log.
    void this.d.mirror(laptop.key).then(async (mirror) => {
      if (stopped) return;
      follow = client.journal.follow.subscribe(
        { after: await mirror.head() },
        {
          onData: (e) => {
            void mirror.add([e as Entry]).then((p) => {
              if (p)
                this.d.onAlert?.(
                  `${laptop.name}'s action log doesn't match the copy on this phone (#${p.seq}: ${p.why})`,
                );
            });
          },
          onError: () => undefined,
        },
      );
    });
    channel.onClose((reason) => {
      cleanup();
      if (this.channel === channel) {
        this.channel = null;
        this.client = null;
        this.scheduleRetry(laptop.key, reason === "bye" ? null : reason);
      }
    });
  }

  /** Forget a laptop on this phone. */
  async forget(key: string): Promise<void> {
    if (this.state.status !== "unpaired" && "laptop" in this.state && this.state.laptop === key)
      this.stop();
    await this.d.laptops.remove(key);
    this.set(
      this.d.laptops.current()
        ? {
            status: "offline",
            laptop: this.d.laptops.current()?.key ?? "",
            error: null,
            retryAt: null,
          }
        : { status: "unpaired" },
    );
  }
}

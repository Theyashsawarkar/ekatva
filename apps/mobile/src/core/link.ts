/**
 * The phone's end of the link: pairing from a QR code, connecting (where
 * the laptop's beacon says it is on this network, then its saved LAN
 * addresses, then its tunnel), reconnecting with backoff, moving to the
 * direct path as soon as the laptop is heard on the same network, serving
 * the phone's API, and keeping a verified copy of the laptop's action log.
 */
import {
  ANNOUNCE,
  beaconKey,
  type Channel,
  CLOSE,
  connect,
  fromB64u,
  LinkError,
  mailbox,
  type Ntfy,
  nonce,
  openBeacon,
  PORT_LAPTOP,
  PORT_PHONE,
  parseOffer,
  type Transport,
  toB64u,
} from "@ekatva/link";
import {
  channelWebSocket,
  type Journal,
  type LaptopRouter,
  type PhoneServices,
  phoneRouter,
  type Route,
  serveRouter,
} from "@ekatva/protocol";
import { createTRPCClient, createWSClient, type TRPCClient, wsLink } from "@trpc/client";
import { type LaptopRecord, type Laptops, PHONE_DEFAULT } from "./laptops";
import type { Secrets } from "./vault";

/** Opens a WebSocket to `url`, as a transport, or fails within `timeoutMs`. */
/**
 * How long to wait for a socket to open: a few seconds on this network; more
 * through the tunnel, which on mobile data is a DNS lookup, TLS and a hop
 * through Cloudflare before the laptop even sees it.
 */
const openWait = (via: "lan" | "tunnel") => (via === "tunnel" ? 10_000 : 4000);

export type Opener = (url: string, timeoutMs: number) => Promise<Transport>;

/** Listens for datagrams on the beacon port; returns a function that stops listening. */
export type Beacons = (cb: (from: string, data: Uint8Array) => void) => () => void;

/** A beacon's address is trusted for this long (it's sent every 3 s). */
const NEAR_FOR_MS = 30_000;
/** Beacons can't make the phone knock more often than this. */
const NEAR_RETRY_MS = 5_000;

export type LinkState =
  | { status: "unpaired" }
  | { status: "offline"; laptop: string; error: string | null; retryAt: number | null }
  | { status: "connecting"; laptop: string }
  | { status: "online"; laptop: string; via: "lan" | "tunnel"; grants: string[] };

export interface LinkDeps {
  secrets: Secrets;
  laptops: Laptops;
  journal: Journal;
  services: PhoneServices;
  open: Opener;
  hello: { name: string; info: Record<string, string> };
  onAlert?: (message: string) => void;
  now?: () => number;
  /** The rendezvous, for finding the laptop when it's not on this network. */
  ntfy?: Ntfy;
  /** How long to wait for the laptop's answer in the mailbox. */
  rendezvousWaitMs?: number;
  /** The laptop's beacons on this network. */
  beacons?: Beacons;
  /** Is there any network at all? (No: skip the rendezvous.) */
  online?: () => Promise<boolean>;
}

/** Retrying while the app is in front: quick, never more than this apart. */
const FOREGROUND_MAX_MS = 5_000;
/** In the background (the foreground service keeps it linked): gentler. */
const BACKGROUND_MAX_MS = 60_000;
/** Replaced by another connection from this phone: wait it out, don't fight. */
const REPLACED_WAIT_MS = 30_000;
/** While in front, the laptop must answer a status call this often… */
const HEARTBEAT_MS = 15_000;
/** Linked through the tunnel and in the background this long: stop listening for beacons. */
const BEACONS_BACKGROUND_MS = 3 * 60_000;
/** …within this long, or the connection counts as dead. */
const HEARTBEAT_TIMEOUT_MS = 8_000;
/** The channel's own ping; it gives up after three silent ones. Often in front… */
const KEEPALIVE_MS = 15_000;
/** …rarely in the background, so the radio can sleep. */
const BACKGROUND_KEEPALIVE_MS = 50_000;
/** Ask the rendezvous at most this often in front… */
const RENDEZVOUS_FG_MS = 2 * 60_000;
/** …and in the background (each ask is a minute of polling over the internet). */
const RENDEZVOUS_BG_MS = 20 * 60_000;
/** How long the laptop may take to let a known phone in. */
const DECISION_MS = 15_000;

export class LinkManager {
  /**
   * The one link running in this JS runtime. Starting another stops it: two
   * links from one phone keep replacing each other at the laptop.
   */
  static active: LinkManager | null = null;
  state: LinkState = { status: "unpaired" };
  client: TRPCClient<LaptopRouter> | null = null;
  private channel: Channel | null = null;
  private cleanup: (() => void) | null = null;
  private wanted = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private busy: Promise<void> | null = null;
  private listeners = new Set<(s: LinkState) => void>();
  private stopBeacons: (() => void) | null = null;
  private beaconKeys = new Map<string, Uint8Array>();
  /** Where a laptop was last heard on this network. */
  private near = new Map<string, { addr: string; at: number }>();
  private lastNearTry = 0;
  private switching = false;
  private via: "lan" | "tunnel" | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private beaconTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the app went to the background (null while in front). */
  private backgroundSince: number | null = null;
  private foreground = true;
  /** When the rendezvous was last asked; 0: ask whenever needed. */
  private lastAsk = 0;

  constructor(private readonly d: LinkDeps) {}

  private now() {
    return (this.d.now ?? Date.now)();
  }

  subscribe(cb: (s: LinkState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(s: LinkState): void {
    // To logcat (ReactNativeJS), for finding out why a link won't come up. Never keys or tokens.
    if (s.status !== this.state?.status || ("error" in s && s.error))
      console.info(`[ekatva link] ${s.status}${"error" in s && s.error ? `: ${s.error}` : ""}`);
    this.state = s;
    this.tuneBeacons();
    for (const cb of this.listeners) cb(s);
  }

  /**
   * Beacons (and Android's Wi-Fi multicast lock, which costs battery) only
   * while they can help: not while linked directly on this network.
   */
  private tuneBeacons(): void {
    const s = this.state;
    const online = s.status === "online";
    const direct = online && this.via === "lan";
    // Linked through the tunnel and in the background for a while: the laptop
    // isn't coming onto this Wi-Fi soon enough to keep the lock for it.
    const settled =
      online &&
      !this.foreground &&
      this.backgroundSince !== null &&
      this.now() - this.backgroundSince >= BEACONS_BACKGROUND_MS;
    if (this.wanted && !direct && !settled) this.listen();
    else this.unlisten();
  }

  /** The heartbeat runs only in front (a timer that ticks in the background for nothing costs wakeups). */
  private startHeartbeat(): void {
    if (this.heartbeat || !this.foreground || !this.channel?.isOpen) return;
    this.heartbeat = setInterval(() => void this.check(), HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private unlisten(): void {
    this.stopBeacons?.();
    this.stopBeacons = null;
  }

  /**
   * Where to try, in order. `tunnelFirst`: the laptop wasn't heard on this
   * network, so its saved LAN addresses are probably elsewhere (each costs
   * a timeout): the tunnel first, then them.
   */
  private urls(
    lan: string[],
    url: string | null,
    tunnelFirst = false,
  ): { url: string; via: "lan" | "tunnel" }[] {
    const direct = lan.map((h) => ({ url: `ws://${h}/link`, via: "lan" as const }));
    const tunnel = url ? [{ url: `${url.replace(/\/+$/, "")}/link`, via: "tunnel" as const }] : [];
    return tunnelFirst ? [...tunnel, ...direct] : [...direct, ...tunnel];
  }

  /** Pairs with the laptop in the QR code; `onSas` gets the four emoji to show. */
  async pair(uri: string, onSas: (emoji: string[]) => void): Promise<LaptopRecord> {
    if (LinkManager.active && LinkManager.active !== this) LinkManager.active.stop();
    LinkManager.active = this;
    const offer = parseOffer(uri);
    // A laptop this phone already knows: the code is only its route. Save
    // it and connect with the keys we have, no emoji (Noise proves it's the
    // same laptop). If it doesn't know this phone any more, pair afresh.
    const known = this.d.laptops.get(toB64u(offer.key));
    if (known) {
      const lan = [...offer.lan, ...known.lan.filter((a) => !offer.lan.includes(a))].slice(0, 4);
      await this.d.laptops.update(known.key, { lan, url: offer.url ?? known.url });
      const laptop = this.d.laptops.get(known.key) as LaptopRecord;
      this.wanted = true;
      this.listen();
      const old = this.channel;
      // Not heard on this network (mobile data, another Wi-Fi): the tunnel first.
      const result = await this.tryAll(
        laptop,
        offer.lan,
        offer.url ?? null,
        !this.nearOf(known.key),
      );
      if (result === "ok") {
        if (old !== this.channel) old?.close("moved to the code's route");
        return laptop;
      }
      if (result !== "stop")
        throw new Error(
          `Can't reach ${known.name}: ${result}. ${offer.url ? "Is the phone online?" : "Is the phone on the same Wi-Fi as the laptop?"}`,
        );
    }
    const urls = this.urls(offer.lan, offer.url ?? null, !this.nearOf(toB64u(offer.key)));
    if (!urls.length) throw new Error("the code has no address to reach the laptop at");
    for (const { url, via } of urls) {
      let t: Transport;
      try {
        t = await this.d.open(url, openWait(via));
      } catch {
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
      this.listen();
      return record;
    }
    throw new Error(
      `Can't reach ${offer.name} at ${offer.lan.join(", ") || "its tunnel"}. Is the phone on the same Wi-Fi as the laptop?` +
        (offer.url ? "" : " (Or pair without `--lan`, to go through a tunnel.)"),
    );
  }

  /** Keep connected from now on. */
  start(): void {
    if (LinkManager.active && LinkManager.active !== this) LinkManager.active.stop();
    LinkManager.active = this;
    this.wanted = true;
    this.listen();
    void this.connectNow();
  }

  private listen(): void {
    if (this.stopBeacons || !this.d.beacons) return;
    this.stopBeacons = this.d.beacons((from, data) => this.onBeacon(from, data));
  }

  /** A datagram on the beacon port: if one of our laptops sent it, go to it directly. */
  private onBeacon(from: string, data: Uint8Array): void {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(from)) return;
    for (const l of this.d.laptops.all()) {
      let key = this.beaconKeys.get(l.key);
      if (!key) {
        key = beaconKey(this.d.secrets.identity, fromB64u(l.key));
        this.beaconKeys.set(l.key, key);
      }
      const b = openBeacon(key, data, this.now());
      if (!b) continue;
      const addr = `${from}:${b.port}`;
      const was = this.near.get(l.key);
      this.near.set(l.key, { addr, at: this.now() });
      if (was?.addr !== addr) console.info("[ekatva link] heard the laptop on this network");
      this.onNear(l, addr);
      return;
    }
  }

  private onNear(laptop: LaptopRecord, addr: string): void {
    if (!this.wanted) return;
    const s = this.state;
    if (s.status === "online") {
      if (s.laptop === laptop.key && this.via === "tunnel") void this.goDirect(laptop, addr);
      return;
    }
    // Offline and waiting to retry: try now, where it is (but not on every beacon).
    if (s.status === "offline" && this.now() - this.lastNearTry > NEAR_RETRY_MS) {
      if (s.retryAt === null && s.error && /pair again/.test(s.error)) return;
      this.lastNearTry = this.now();
      void this.connectNow();
    }
    // Connecting: the attempt in progress picks it up (see ask()).
  }

  /** Connected through the tunnel, and the laptop is right here: move to the direct path. */
  private async goDirect(laptop: LaptopRecord, addr: string): Promise<void> {
    if (this.switching || this.now() - this.lastNearTry < NEAR_RETRY_MS) return;
    this.switching = true;
    this.lastNearTry = this.now();
    try {
      const t = await this.d.open(`ws://${addr}/link`, 4000);
      const { channel, welcome } = await connect(t, {
        me: this.d.secrets.identity,
        expect: fromB64u(laptop.key),
        hello: { v: 1, name: this.d.hello.name, info: this.d.hello.info },
        decisionTimeoutMs: DECISION_MS,
        keepaliveMs: this.foreground ? KEEPALIVE_MS : BACKGROUND_KEEPALIVE_MS,
      });
      if (!this.wanted) {
        channel.close("bye");
        return;
      }
      const old = this.channel;
      this.attach(channel, laptop, "lan", welcome);
      old?.close("moved to the direct link");
      await this.remember(laptop.key, addr);
      console.info("[ekatva link] moved to the direct link");
    } catch (e) {
      console.info(`[ekatva link] the direct link didn't come up: ${(e as Error).message}`);
    } finally {
      this.switching = false;
    }
  }

  /** Where the laptop was heard lately, if it was. */
  private nearOf(key: string): string | null {
    const n = this.near.get(key);
    return n && this.now() - n.at < NEAR_FOR_MS ? n.addr : null;
  }

  /** Puts a working direct address first in the laptop's record. */
  private async remember(key: string, addr: string): Promise<void> {
    const l = this.d.laptops.get(key);
    if (l && l.lan[0] !== addr)
      await this.d.laptops.update(key, {
        lan: [addr, ...l.lan.filter((a) => a !== addr)].slice(0, 4),
      });
  }

  /**
   * The app came forward or the network changed: online, make sure the
   * connection still answers; offline, try again now, quickly from here on.
   */
  wake(): void {
    if (!this.wanted) return;
    this.attempts = 0;
    // Back in front, or on a new network: the laptop may be anywhere now.
    this.lastAsk = 0;
    this.tuneBeacons();
    if (this.state.status === "online") void this.check();
    else if (this.state.status === "offline") void this.connectNow();
  }

  /** In front: quick retries and a heartbeat. In the background: gentler. */
  setForeground(fg: boolean): void {
    this.foreground = fg;
    this.channel?.setKeepalive(fg ? KEEPALIVE_MS : BACKGROUND_KEEPALIVE_MS);
    if (this.beaconTimer) clearTimeout(this.beaconTimer);
    this.beaconTimer = null;
    if (fg) {
      this.backgroundSince = null;
      this.startHeartbeat();
      this.tuneBeacons();
      this.wake();
    } else {
      this.backgroundSince = this.now();
      this.stopHeartbeat();
      // Look again once it has been in the background a while.
      this.beaconTimer = setTimeout(() => this.tuneBeacons(), BEACONS_BACKGROUND_MS);
    }
  }

  /** Asks the laptop something cheap; no answer in time and the connection is dead. */
  private async check(): Promise<void> {
    const channel = this.channel;
    const client = this.client;
    if (!channel?.isOpen || !client) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const dead = await Promise.race([
      // Any answer counts, even a refusal: the laptop is there.
      client.status.query().then(
        () => false,
        (e: unknown) =>
          /timed out|closed|not connected|socket/i.test(String((e as Error)?.message)),
      ),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), HEARTBEAT_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (dead && this.channel === channel && channel.isOpen) {
      console.info("[ekatva link] the laptop stopped answering; reconnecting");
      channel.close("the laptop stopped answering");
    }
  }

  stop(): void {
    if (LinkManager.active === this) LinkManager.active = null;
    this.wanted = false;
    this.stopHeartbeat();
    if (this.beaconTimer) clearTimeout(this.beaconTimer);
    this.beaconTimer = null;
    this.stopBeacons?.();
    this.stopBeacons = null;
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
    const near = this.nearOf(laptop.key);
    const lan = near ? [near, ...laptop.lan.filter((a) => a !== near)] : laptop.lan;
    // Heard here: straight to it. Not heard: the tunnel first (it works from
    // any network), the saved LAN addresses after it.
    let result = await this.tryAll(laptop, lan, laptop.url, !near);
    if (result === "ok" || result === "stop") return;
    // Not where it was: ask the pair's mailbox where it is now (not too often).
    const found = (await this.mayAsk(laptop.key)) ? await this.ask(laptop) : null;
    if (found) {
      await this.d.laptops.update(laptop.key, { lan: found.lan, url: found.url });
      result = await this.tryAll(laptop, found.lan, found.url, !this.nearOf(laptop.key));
      if (result === "ok" || result === "stop") return;
    }
    this.scheduleRetry(laptop.key, result);
  }

  /** Tries each address in turn: "ok", "stop" (don't retry), or the last error. */
  private async tryAll(
    laptop: LaptopRecord,
    lan: string[],
    url: string | null,
    tunnelFirst = false,
  ): Promise<string> {
    let error = "can't reach the laptop";
    for (const { url: u, via } of this.urls(lan, url, tunnelFirst)) {
      try {
        const t = await this.d.open(u, openWait(via));
        const { channel, welcome } = await connect(t, {
          me: this.d.secrets.identity,
          expect: fromB64u(laptop.key),
          hello: { v: 1, name: this.d.hello.name, info: this.d.hello.info },
          decisionTimeoutMs: DECISION_MS,
          keepaliveMs: this.foreground ? KEEPALIVE_MS : BACKGROUND_KEEPALIVE_MS,
        });
        this.attempts = 0;
        this.attach(channel, laptop, via, welcome);
        if (via === "lan")
          await this.remember(laptop.key, u.replace(/^ws:\/\//, "").replace(/\/link$/, ""));
        return "ok";
      } catch (e) {
        if (e instanceof LinkError && e.code === CLOSE.denied) {
          // The laptop doesn't know this phone any more: don't keep knocking.
          this.set({
            status: "offline",
            laptop: laptop.key,
            error: `${laptop.name} no longer knows this phone; pair again`,
            retryAt: null,
          });
          return "stop";
        }
        if (e instanceof LinkError && e.code === CLOSE.wrongKey)
          error = "something else answered at the laptop's address";
        else error = (e as Error).message || error;
      }
    }
    return error;
  }

  /**
   * Whether to ask the rendezvous now: not when the laptop was heard on this
   * network lately (the direct try covers it), not without a network, and at
   * most every 2 minutes in front, 20 in the background.
   */
  private async mayAsk(key: string): Promise<boolean> {
    if (!this.d.ntfy || this.nearOf(key)) return false;
    const gap = this.foreground ? RENDEZVOUS_FG_MS : RENDEZVOUS_BG_MS;
    if (this.lastAsk && this.now() - this.lastAsk < gap) return false;
    if (this.d.online && !(await this.d.online().catch(() => true))) return false;
    this.lastAsk = this.now();
    return true;
  }

  /** Posts "where are you?" to the pair's mailbox and waits for the laptop's answer. */
  private async ask(laptop: LaptopRecord): Promise<{ url: string | null; lan: string[] } | null> {
    if (!this.d.ntfy) return null;
    const mb = mailbox(this.d.secrets.identity, fromB64u(laptop.key));
    const n = nonce();
    try {
      // The laptop says each new tunnel address unasked: a newer one than
      // ours needs no question (and no wait).
      let latest: { url: string | null; lan: string[]; at: number } | null = null;
      for (const m of await this.d.ntfy.poll(mb.topic, "12h")) {
        const msg = mb.open(m.message, this.now());
        if (msg?.t === "here" && msg.n === ANNOUNCE && msg.url && (!latest || msg.at > latest.at))
          latest = { url: msg.url, lan: msg.lan, at: msg.at };
      }
      if (latest && latest.url !== laptop.url) {
        console.info("[ekatva link] the laptop's mailbox has its new address");
        return { url: latest.url, lan: latest.lan };
      }
      console.info("[ekatva link] asking the rendezvous where the laptop is");
      await this.d.ntfy.publish(mb.topic, mb.seal({ t: "where", at: this.now(), n }));
      const until = this.now() + (this.d.rendezvousWaitMs ?? 45_000);
      while (this.now() < until && this.wanted) {
        await new Promise((r) => setTimeout(r, this.foreground ? 1500 : 5000));
        // Heard on this network meanwhile: no need for the mailbox.
        const near = this.nearOf(laptop.key);
        if (near) return { url: laptop.url, lan: [near] };
        for (const m of await this.d.ntfy.poll(mb.topic, "5m")) {
          const msg = mb.open(m.message, this.now());
          if (msg?.t === "here" && (msg.n === n || (msg.n === ANNOUNCE && msg.url !== laptop.url)))
            return { url: msg.url, lan: msg.lan };
        }
      }
    } catch (e) {
      // no internet either
      console.info(`[ekatva link] rendezvous failed: ${(e as Error).message}`);
    }
    console.info("[ekatva link] the laptop didn't answer the rendezvous");
    return null;
  }

  private scheduleRetry(laptop: string, error: string | null): void {
    if (!this.wanted) {
      this.set({ status: "offline", laptop, error, retryAt: null });
      return;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    // Replaced by another connection from this phone: wait it out. Otherwise
    // quick while you're looking at the app, gentler in the background, with
    // a little jitter so a phone and a restarted laptop don't keep colliding.
    const replaced = !!error && /replaced by a new connection/.test(error);
    const cap = this.foreground ? FOREGROUND_MAX_MS : BACKGROUND_MAX_MS;
    const base = replaced ? REPLACED_WAIT_MS : Math.min(cap, 600 * 2 ** this.attempts++);
    const delay = Math.round(base * (0.85 + Math.random() * 0.3));
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
    // Keep the laptop's route (its tunnel's URL) up to date while linked,
    // on the same Wi-Fi too: leaving it, the phone comes back through the
    // tunnel by itself, no QR. An older laptop has no link.watch: no matter.
    const route = client.link.watch.subscribe(undefined, {
      onData: (r) => void this.onRoute(laptop.key, r),
      onError: () => undefined,
    });
    let stopped = false;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      route.unsubscribe();
      stopServing();
      void wsClient.close();
    };
    this.cleanup = cleanup;
    // While in front, the laptop must keep answering (a half-open socket can
    // look connected for minutes otherwise).
    this.stopHeartbeat();
    void this.d.laptops.update(laptop.key, { lastSeen: this.now(), name: channel.peer.name });
    this.via = via;
    const grants = ((welcome as { grants?: string[] } | null)?.grants ?? []).slice();
    this.set({ status: "online", laptop: laptop.key, via, grants });
    this.startHeartbeat();
    channel.onClose((reason) => {
      cleanup();
      if (this.channel === channel) {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        this.channel = null;
        this.client = null;
        this.scheduleRetry(laptop.key, reason === "bye" ? null : reason);
      }
    });
  }

  /** The laptop's route changed (or the link just came up): save it. */
  private async onRoute(key: string, r: Route): Promise<void> {
    const l = this.d.laptops.get(key);
    if (!l) return;
    const lan = [...l.lan, ...r.lan.filter((a) => !l.lan.includes(a))].slice(0, 4);
    // A tunnel restarting has no URL for a moment: keep the last one until a new one comes.
    const url = r.url ?? (r.tunnel.state === "starting" ? l.url : null);
    const away: LaptopRecord["away"] = {
      state: r.tunnel.state,
      kind: r.tunnel.kind,
      problem: r.tunnel.problem,
      at: this.now(),
    };
    if (url !== l.url)
      console.info(
        `[ekatva link] ${url ? "learnt the laptop's tunnel" : "the laptop's tunnel is off"}`,
      );
    await this.d.laptops.update(key, { lan, url, away });
  }

  /** Forget a laptop on this phone. */
  async forget(key: string): Promise<void> {
    if (this.state.status !== "unpaired" && "laptop" in this.state && this.state.laptop === key)
      this.stop();
    await this.d.laptops.remove(key);
    this.beaconKeys.delete(key);
    this.near.delete(key);
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

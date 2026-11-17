/**
 * The daemon: the link for phones (on the LAN, and through a tunnel when
 * allowed), the local socket for this laptop's own user (the Vyom
 * popup, the CLI), and everything they reach.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, renameSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { networkInterfaces, userInfo } from "node:os";
import { dirname, join } from "node:path";
import {
  accept,
  type Candidate,
  type Channel,
  type Decision,
  formatOffer,
  fromB64u,
  type KeyPair,
  LinkError,
  Ntfy,
  PAIR_TTL_MS,
  PORT_LAPTOP,
  PORT_PHONE,
  TokenBook,
  toB64u,
  webSocketTransport,
} from "@ekatva/link";
import {
  type Capability,
  channelWebSocket,
  type Device,
  type Done,
  type Entry,
  grantable,
  Journal,
  type LaptopContext,
  type LaptopServices,
  type LocalServices,
  laptopRouter,
  localRouter,
  Mirror,
  type Offer,
  type PendingPair,
  type PhoneRouter,
  PRESETS,
  serveRouter,
  type Undo,
  verify,
} from "@ekatva/protocol";
import { createTRPCClient, createWSClient, type TRPCClient, wsLink } from "@trpc/client";
import { TRPCError } from "@trpc/server";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { type WebSocket, WebSocketServer } from "ws";
import type { Config } from "./config.js";
import { type DeviceRecord, Devices } from "./devices.js";
import { FileStore } from "./journalFile.js";
import { AgentsService, type Tmux } from "./services/agents.js";
import { type AppearanceHost, AppearanceService } from "./services/appearance.js";
import { BeaconSender, VIRTUAL } from "./services/beacon.js";
import { CallState } from "./services/calls.js";
import { ClipboardSync } from "./services/clipboardSync.js";
import { DesktopNotifications } from "./services/desktopNotifications.js";
import { LaptopFiles } from "./services/files.js";
import { type FirewallProblem, firewallProblem } from "./services/firewall.js";
import { InputService, type Runner } from "./services/input.js";
import { type Host, JyotiService } from "./services/jyoti.js";
import { type MediaHost, MediaService } from "./services/media.js";
import { NotificationBridge, type Prompt } from "./services/notifyBridge.js";
import { Rendezvous } from "./services/rendezvous.js";
import { RootBridge } from "./services/root.js";
import { type ShareHost, ShareInbox } from "./services/share.js";
import { SystemService } from "./services/system.js";
import { TerminalService } from "./services/terminal.js";
import { Tunnel } from "./services/tunnel.js";

const VERSION = "0.1.0";
/** A peer that fails this many handshakes in the window is shut out for it. */
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 10 * 60_000;

export interface DaemonOptions {
  /**
   * How often the laptop checks a phone is still there (a ping over the link); a phone
   * silent for three of these is dropped, so one that walked out of range comes back
   * cleanly. 10 s (dropped after 30 s), like the phone's own; 0 turns it off (tests).
   */
  keepaliveMs?: number;
  config: Config;
  key: KeyPair;
  stateDir: string;
  socketPath: string;
  /** dvarapala's log of finished requests (tests: a file of their own). */
  dvarapalaLog?: string;
  /** Where dvarapala and pramana hand over root requests; default beside socketPath. */
  rootSocketPath?: string;
  undoDir: string;
  configDir: string;
  /** 0 picks a free port (tests). */
  port?: number;
  host?: string;
  /** Broadcast the encrypted beacon for phones on the same network (default: config.advertise). */
  beacon?: boolean;
  /** Where beacons go (tests); default each real network's broadcast address. */
  beaconTargets?: () => string[];
  beaconPort?: number;
  beaconEveryMs?: number;
  /** Look at the firewall (default: true). */
  checkFirewall?: boolean;
  /** Bridge notifications with the desktop (default: true). */
  desktopNotifications?: DesktopNotifications | false;
  /** Runs ydotool and wtype (tests: a fake). */
  inputRunner?: Runner;
  /** Where files sent from a phone land (default ~/Downloads). */
  shareDir?: string;
  /** Opens links, sets the clipboard, tells you (tests: a fake). */
  shareHost?: ShareHost;
  /** Asks for a reply on the laptop (default: a zenity entry). */
  prompt?: Prompt;
  jyotiHost?: Host;
  /** Reads and switches light and dark (tests: a fake). */
  appearanceHost?: AppearanceHost;
  mediaHost?: MediaHost;
  tmux?: Tmux;
  log?: (msg: string) => void;
  /** The addresses phones are told (default: this machine's IPv4 addresses). */
  lan?: (port: number) => string[];
  /** Watch the rendezvous mailboxes (default: when a tunnel kind is set). */
  rendezvous?: boolean;
  rendezvousEveryMs?: number;
  /** Desktop notifications (pairing requests, log mismatches). */
  /** `open`: a window tab to show when the notification is clicked. */
  notify?: (title: string, body: string, urgent?: boolean, open?: string) => void;
}

interface Peer {
  key: string;
  channel: Channel;
  phone: TRPCClient<PhoneRouter>;
  close: (reason: string) => void;
  via: "lan" | "tunnel";
}

interface Pending extends PendingPair {
  key: string;
  decide: (d: Decision) => void;
}

/** A queue of values for an async generator, woken on push. */
function feed<T>(
  signal: AbortSignal | undefined,
  subscribe: (push: (v: T) => void) => () => void,
  first: () => Promise<T>,
) {
  return (async function* () {
    const queue: T[] = [await first()];
    let wake: (() => void) | null = null;
    const off = subscribe((v) => {
      queue.push(v);
      wake?.();
    });
    try {
      while (!signal?.aborted) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((res) => {
          wake = res;
          signal?.addEventListener("abort", () => res(), { once: true });
        });
        wake = null;
      }
    } finally {
      off();
    }
  })();
}

export class Daemon {
  readonly devices: Devices;
  journal!: Journal;
  private mirrors = new Map<string, Mirror>();
  private peers = new Map<string, Peer>();
  private tokens = new TokenBook();
  private pendings = new Map<string, Pending>();
  private pendingListeners = new Set<(p: PendingPair[]) => void>();
  private failures = new Map<string, { n: number; since: number }>();
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private local: Server | null = null;
  private localWss: WebSocketServer | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stores: FileStore[] = [];
  private beacon: BeaconSender | null = null;
  /** What blocks phones on the same network, if anything does. */
  firewall: FirewallProblem | null = null;
  readonly files: LaptopFiles;
  readonly jyoti: JyotiService;
  /** The phone's call right now, for the window. */
  readonly calls = new CallState();
  readonly appearance: AppearanceService;
  readonly agents: AgentsService;
  readonly system: SystemService;
  readonly media: MediaService;
  readonly root: RootBridge;
  readonly tunnel: Tunnel;
  readonly input: InputService;
  readonly share: ShareInbox;
  private bridge: NotificationBridge | null = null;
  private stopRootWatch: (() => void) | null = null;
  readonly clipSync: ClipboardSync;
  readonly terminal: TerminalService;

  /** Connected phones that may answer root requests. */
  private rootPhones(): Peer[] {
    return [...this.peers.values()].filter((p) => this.devices.grantsOf(p.key).has("root"));
  }
  private rendezvous: Rendezvous | null = null;
  readonly id: string;
  port = 0;

  constructor(private readonly o: DaemonOptions) {
    this.id = toB64u(o.key.publicKey);
    this.devices = new Devices(join(o.stateDir, "devices.json"));
    this.files = new LaptopFiles({
      roots: o.config.files.roots,
      private: o.config.files.private,
      undoDir: o.undoDir,
      forbidden: [o.stateDir, o.configDir],
    });
    this.jyoti = new JyotiService(o.jyotiHost, join(o.stateDir, "jyoti.json"));
    this.appearance = new AppearanceService(o.appearanceHost);
    this.agents = new AgentsService(o.tmux, o.config.agents.roots);
    this.media = new MediaService(o.mediaHost);
    this.input = new InputService(o.inputRunner);
    this.terminal = new TerminalService(o.tmux);
    this.clipSync = new ClipboardSync(
      join(o.stateDir, "clipboard-sync.json"),
      () => this.system.clipboardGet(),
      async (text) => {
        await Promise.all(
          [...this.peers.values()].map((p) =>
            p.phone.clipboard.set.mutate({ text }).catch(() => undefined),
          ),
        );
      },
      () => this.peers.size > 0,
    );
    this.share = new ShareInbox(
      o.shareHost ?? {
        openUrl: (url) => runQuiet("xdg-open", [url]),
        setClipboard: async (text) => {
          await this.system.clipboardSet(text);
        },
        notify: (title, body) => this.notify(title, body),
      },
      o.shareDir,
    );
    this.tunnel = new Tunnel(
      o.config.tunnel.kind,
      () => this.port,
      (m) => this.log(m),
      o.config.tunnel.idle_minutes,
    );
    this.root = new RootBridge(
      o.rootSocketPath ?? join(dirname(o.socketPath), "ekatva-root.sock"),
      (m) => this.log(m),
      () => undefined,
      join(o.stateDir, "root-answers.json"),
      ...(o.dvarapalaLog ? [o.dvarapalaLog] : []),
    );
    this.system = new SystemService(o.config.name, async () => ({
      jyoti: (await this.jyoti.get()).level,
      waiting: (await this.agents.list()).filter((s) => s.state === "waiting" || s.state === "done")
        .length,
      firewall: this.firewall,
    }));
    this.system.whileAsleep = (sleep) => this.jyoti.whileAsleep(sleep);
  }

  private log(msg: string): void {
    (this.o.log ?? ((m) => console.error(m)))(msg);
  }

  private notify(title: string, body: string, urgent = false, open?: string): void {
    this.o.notify?.(title, body, urgent, open);
  }

  async start(): Promise<void> {
    await this.devices.load();
    const self = await FileStore.open(join(this.o.stateDir, "journal", "self.jsonl"));
    this.stores.push(self);
    this.journal = new Journal(self, this.id);
    const problem = await this.journal.check();
    if (problem) {
      this.log(`the action log fails its check at #${problem.seq}: ${problem.why}`);
      this.notify(
        "ekatva: the action log was changed",
        `Entry #${problem.seq} ${problem.why}. Run \`ekatva check\`.`,
        true,
      );
    }
    for (const d of this.devices.all()) await this.mirrorOf(d.key);
    this.jyoti.onAuto = (summary) =>
      void this.journal.record({
        actor: { key: "local", name: "ekatva" },
        action: "jyoti.auto",
        summary,
        input: null,
        ok: true,
      });
    // Its state was caffeine.json, then jagaran.json, before it was named jyoti.
    for (const old of ["jagaran.json", "caffeine.json"]) {
      const was = join(this.o.stateDir, old);
      if (existsSync(was) && !existsSync(join(this.o.stateDir, "jyoti.json")))
        renameSync(was, join(this.o.stateDir, "jyoti.json"));
    }
    await this.jyoti.restore();
    await this.files.store
      .prune(this.o.config.undo.days, this.o.config.undo.max_gb * 1024 ** 3)
      .catch(() => undefined);
    this.timers.push(
      setInterval(
        () =>
          void this.files.store
            .prune(this.o.config.undo.days, this.o.config.undo.max_gb * 1024 ** 3)
            .catch(() => undefined),
        3_600_000,
      ),
    );
    await this.listen();
    await this.listenLocal();
    await this.root.listen();
    // Watch the mailboxes when phones may reach the laptop from outside.
    if (this.o.config.tunnel.kind !== "none" && this.o.rendezvous !== false) {
      this.rendezvous = new Rendezvous(
        this.o.key,
        () => this.devices.all(),
        this.tunnel,
        () => this.lanAddresses(),
        new Ntfy(this.o.config.tunnel.server),
        (m) => this.log(m),
      );
      this.rendezvous.start(this.o.rendezvousEveryMs);
    }
    if (this.o.desktopNotifications !== false) {
      this.bridge = new NotificationBridge(
        this.o.desktopNotifications ?? new DesktopNotifications((m) => this.log(m)),
        () =>
          [...this.peers.values()].map((p) => ({
            key: p.key,
            name: this.devices.get(p.key)?.name ?? "phone",
            seesLaptop: this.devices.grantsOf(p.key).has("notifications"),
            phone: p.phone,
          })),
        this.o.prompt ?? zenityPrompt,
        (m) => this.log(m),
      );
      this.bridge.start();
    }
    // A root request (dvarapala, pramana): a notification on every phone that may answer it,
    // gone once it's answered (here or there) or expired. The phone answers with the laptop's
    // password; whichever side answers first wins.
    const told = new Set<string>();
    this.stopRootWatch = this.root.watch((list) => {
      const now = new Set(list.map((r) => r.id));
      for (const r of list) {
        if (told.has(r.id)) continue;
        told.add(r.id);
        for (const p of this.rootPhones())
          void p.phone.notifications.show
            .mutate({
              id: `root-${r.id}`,
              app: "ekatva",
              title: `Root access: ${r.requester}`,
              text: `wants to run ${r.commands.length} command${r.commands.length === 1 ? "" : "s"} as root${r.reason ? `: ${r.reason}` : ""}. Open ekatva to answer with the laptop's password.`,
            })
            .catch(() => undefined);
      }
      for (const id of [...told])
        if (!now.has(id)) {
          told.delete(id);
          for (const p of this.rootPhones())
            void p.phone.notifications.close.mutate({ id: `root-${id}` }).catch(() => undefined);
        }
    });
    this.clipSync.start();
    if (this.o.beacon ?? this.o.config.advertise) {
      this.beacon = new BeaconSender(
        this.o.key,
        () =>
          this.devices
            .all()
            .map((d) => ({ key: d.key, direct: this.peers.get(d.key)?.via === "lan" })),
        () => this.port,
        {
          log: (m) => this.log(m),
          ...(this.o.beaconTargets ? { targets: this.o.beaconTargets } : {}),
          ...(this.o.beaconPort ? { beaconPort: this.o.beaconPort } : {}),
          ...(this.o.beaconEveryMs ? { everyMs: this.o.beaconEveryMs } : {}),
        },
      );
      await this.beacon.start();
    }
    if (this.o.checkFirewall !== false) {
      const check = async () => {
        const was = this.firewall;
        this.firewall = await firewallProblem(this.port).catch(() => null);
        if (this.firewall && this.firewall.problem !== was?.problem)
          this.log(`${this.firewall.problem}; fix: ${this.firewall.fix}`);
        else if (was && !this.firewall)
          this.log("the firewall lets phones on the same network in now");
      };
      await check();
      this.timers.push(setInterval(() => void check(), 60_000));
    }
    this.log(
      `ekatva ${VERSION}: listening on port ${this.port}, ${this.devices.all().length} paired device(s)`,
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const p of this.peers.values()) p.close("the laptop's service stopped");
    this.peers.clear();
    for (const p of this.pendings.values()) p.decide({ ok: false, reason: "the laptop stopped" });
    this.beacon?.stop();
    this.clipSync.stop();
    this.stopRootWatch?.();
    this.bridge?.stop();
    this.rendezvous?.stop();
    this.tunnel.stop();
    this.media.stop();
    this.jyoti.shutdown();
    this.agents.shutdown();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
    for (const c of this.localWss?.clients ?? []) c.terminate();
    await new Promise<void>((r) => (this.localWss ? this.localWss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.local ? this.local.close(() => r()) : r()));
    rmSync(this.o.socketPath, { force: true });
    await this.root.close();
    for (const s of this.stores) await s.close();
  }

  // ------------------------------------------------------------- the link
  private async listen(): Promise<void> {
    this.http = createServer((_req, res) => {
      res.writeHead(404).end();
    });
    // A Noise message is at most 64 KiB; nothing bigger is ever valid.
    this.wss = new WebSocketServer({ server: this.http, path: "/link", maxPayload: 65_535 });
    this.wss.on("connection", (ws, req) => {
      // Only a tunnel running on this laptop may say who it forwards for: from the
      // network, a header is anyone's to write (and would dodge the rate limit).
      const peer = req.socket.remoteAddress ?? "?";
      const local = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
      const forwarded = local
        ? (req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"])
        : undefined;
      const ip =
        String(forwarded ?? peer)
          .split(",")[0]
          ?.trim() ?? peer;
      const via = forwarded ? "tunnel" : "lan";
      if (this.shutOut(ip)) {
        ws.close(4005, "too many attempts; try again later");
        return;
      }
      void this.onConnection(ws, ip, via);
    });
    await new Promise<void>((resolve, reject) => {
      this.http?.once("error", reject);
      this.http?.listen(this.o.port ?? this.o.config.port, this.o.host ?? "0.0.0.0", () =>
        resolve(),
      );
    });
    const addr = this.http.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
  }

  private shutOut(ip: string): boolean {
    const f = this.failures.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > FAILURE_WINDOW_MS) {
      this.failures.delete(ip);
      return false;
    }
    return f.n >= MAX_FAILURES;
  }

  private failed(ip: string): void {
    const f = this.failures.get(ip);
    if (!f || Date.now() - f.since > FAILURE_WINDOW_MS)
      this.failures.set(ip, { n: 1, since: Date.now() });
    else f.n++;
  }

  private async onConnection(ws: WebSocket, ip: string, via: "lan" | "tunnel"): Promise<void> {
    let channel: Channel;
    try {
      channel = await accept(webSocketTransport(ws as never), {
        // Every 20 s, dropped after 60 s of silence: a vanished phone goes
        // within a minute, and a phone in the background (which answers each
        // ping) isn't woken more often than that.
        keepaliveMs: this.o.keepaliveMs ?? 20_000,
        me: this.o.key,
        hello: { v: 1, name: this.o.config.name, info: { version: VERSION } },
        authorize: (c) => this.authorize(c, ip),
      });
    } catch (e) {
      this.failed(ip);
      this.log(`refused a connection from ${ip}: ${(e as Error).message}`);
      return;
    }
    // A link that ended (timed out, replaced, unpaired) frees its socket at once: a
    // half-open TCP connection from a phone that left would otherwise linger.
    channel.onClose(() => setTimeout(() => ws.terminate(), 1000).unref?.());
    this.onPeer(channel, via);
  }

  private async authorize(c: Candidate, ip: string): Promise<Decision> {
    const key = toB64u(c.remoteStatic);
    if (c.hello.token) {
      let token: Uint8Array;
      try {
        token = fromB64u(c.hello.token);
      } catch {
        return { ok: false, reason: "damaged pairing code" };
      }
      if (!this.tokens.redeem(token))
        return { ok: false, reason: "this pairing code was used or has expired; show a new one" };
      return this.waitForConfirmation(key, c, ip);
    }
    const d = this.devices.get(key);
    if (!d)
      return {
        ok: false,
        reason: "this phone isn't paired with this laptop; scan its pairing code",
      };
    return { ok: true, welcome: { grants: d.grants, name: this.o.config.name } };
  }

  /** Pairing waits for you to confirm the emoji on the laptop. */
  private waitForConfirmation(key: string, c: Candidate, ip: string): Promise<Decision> {
    return new Promise((resolve) => {
      const id = randomBytes(6).toString("hex");
      const timer = setTimeout(
        () => finish({ ok: false, reason: "nobody confirmed on the laptop in time" }),
        PAIR_TTL_MS,
      );
      const finish = (d: Decision) => {
        clearTimeout(timer);
        if (!this.pendings.delete(id)) return;
        this.emitPending();
        resolve(d);
      };
      this.pendings.set(id, {
        id,
        key,
        name: c.hello.name,
        sas: c.sas,
        info: { ...(c.hello.info ?? {}), address: ip },
        at: Date.now(),
        decide: finish,
      });
      this.emitPending();
      this.notify(
        `${c.hello.name} wants to pair`,
        `Check that it shows ${c.sas.join(" ")}. Click to answer in the ekatva window.`,
        true,
        "pair",
      );
    });
  }

  private emitPending(): void {
    const list = this.pendingList();
    for (const cb of this.pendingListeners) cb(list);
  }

  private pendingList(): PendingPair[] {
    return [...this.pendings.values()].map(({ id, name, sas, info, at }) => ({
      id,
      name,
      sas,
      info,
      at,
    }));
  }

  private onPeer(channel: Channel, via: "lan" | "tunnel"): void {
    const key = toB64u(channel.remoteStatic);
    const device = this.devices.get(key);
    if (!device) {
      channel.close("not paired");
      return;
    }
    this.peers.get(key)?.close("replaced by a new connection");
    const stopServing = serveRouter({
      router: laptopRouter,
      channel,
      port: PORT_LAPTOP,
      createContext: (): LaptopContext => ({
        actor: { key, name: this.devices.get(key)?.name ?? channel.peer.name },
        grants: this.devices.grantsOf(key),
        journal: this.journal,
        services: this.services,
      }),
      onError: ({ error, path }) => {
        // A refused event from the phone is said too (which field, why; never
        // its content): it used to fail silently, and the phone kept retrying.
        if (error.code === "INTERNAL_SERVER_ERROR" || path === "inbox.report")
          this.log(`${path}: ${error.code} ${error.message.slice(0, 300)}`);
      },
    });
    const wsClient = createWSClient({
      url: "ekatva:",
      WebSocket: channelWebSocket(channel, PORT_PHONE),
      retryDelayMs: () => 60_000,
    });
    const phone = createTRPCClient<PhoneRouter>({ links: [wsLink({ client: wsClient })] });
    let follow: { unsubscribe(): void } | null = null;
    const close = (reason: string) => {
      follow?.unsubscribe();
      stopServing();
      void wsClient.close();
      if (channel.isOpen) channel.close(reason);
    };
    const peer: Peer = { key, channel, phone, close, via };
    this.peers.set(key, peer);
    if (via === "tunnel") {
      this.tunnel.touch();
      const keep = setInterval(() => this.tunnel.touch(), 60_000);
      channel.onClose(() => clearInterval(keep));
    }
    void this.devices.seen(key, channel.peer.info);
    this.log(`${device.name} connected (${via})`);
    channel.onClose((reason) => {
      if (this.peers.get(key) === peer) this.peers.delete(key);
      follow?.unsubscribe();
      stopServing();
      void wsClient.close();
      void this.devices.seen(key);
      this.log(`${device.name} disconnected: ${reason}`);
      this.calls.forget(key);
      this.emitDevices();
    });
    this.emitDevices();
    // Mirror the phone's log as it grows.
    void this.mirrorOf(key).then(async (mirror) => {
      follow = phone.journal.follow.subscribe(
        { after: await mirror.head() },
        {
          onData: (e) => void this.mirrorEntry(mirror, device.name, e as Entry),
          onError: () => undefined, // not granted on the phone, or gone
        },
      );
    });
  }

  private async mirrorEntry(mirror: Mirror, name: string, e: Entry): Promise<void> {
    const problem = await mirror.add([e]);
    if (!problem) return;
    this.log(`${name}'s log doesn't match its copy here at #${problem.seq}: ${problem.why}`);
    this.notify(
      `${name}'s action log doesn't match`,
      `#${problem.seq}: ${problem.why}. Its copy here is kept as it was.`,
      true,
    );
    await this.journal.record({
      actor: { key: "local", name: "ekatva" },
      action: "log.mismatch",
      summary: `${name}'s log: #${problem.seq} ${problem.why}`,
      input: { device: mirror.host },
      ok: false,
      error: problem.why,
    });
  }

  private async mirrorOf(key: string): Promise<Mirror> {
    let m = this.mirrors.get(key);
    if (!m) {
      const store = await FileStore.open(join(this.o.stateDir, "journal", `${key}.jsonl`));
      this.stores.push(store);
      m = new Mirror(store, key);
      this.mirrors.set(key, m);
    }
    return m;
  }

  // ---------------------------------------------------- what phones reach
  private _services: LaptopServices | null = null;
  get services(): LaptopServices {
    this._services ??= this.makeServices();
    return this._services;
  }

  private makeServices(): LaptopServices {
    return {
      status: () => this.system.status(),
      jyoti: {
        get: () => this.jyoti.get(),
        set: (level, minutes) => this.jyoti.set(level, minutes),
        changes: (signal) => this.jyoti.changes(signal),
      },
      power: { lock: () => this.system.lock(), suspend: () => this.system.suspend() },
      appearance: {
        get: () => this.appearance.get(),
        set: (mode) => this.appearance.set(mode),
      },
      agents: {
        list: () => this.agents.list(),
        changes: (signal) => this.agents.changes(signal),
        projects: () => this.agents.projects(),
        tail: (id, lines) => this.agents.tail(id, lines),
        transcript: (id, lines) => this.agents.transcript(id, lines),
        answer: (id, option, hash) => this.agents.answer(id, option, hash),
        reply: (id, text) => this.agents.reply(id, text),
        interrupt: (id) => this.agents.interrupt(id),
        start: (project, prompt, agent) => this.agents.start(project, prompt, agent),
      },
      media: {
        get: () => this.media.get(),
        changes: (signal) => this.media.changes(signal),
        control: (player, action) => this.media.control(player, action),
        seek: (player, position) => this.media.seek(player, position),
        volume: (change) => this.media.volume(change),
        brightness: (percent) => this.media.brightness(percent),
        art: (id) => this.media.art(id),
      },
      clipboard: {
        get: () => this.system.clipboardGet(),
        set: async (text) => {
          this.clipSync.heard(text);
          return this.system.clipboardSet(text);
        },
        sync: {
          get: async () => this.clipSync.enabled,
          set: async (on) => {
            this.clipSync.set(on);
            return {
              value: null,
              summary: on ? "Turned on one clipboard for both" : "Turned off the shared clipboard",
              undo: { kind: "clipboard.sync", data: { on: !on } },
            };
          },
        },
      },
      files: this.files,
      root: {
        pending: async () => this.root.list(),
        changes: (signal) => this.root.changes(signal),
        respond: (id, approve, password, allow) => this.root.respond(id, approve, password, allow),
        history: () => this.root.history(),
      },
      notifications: {
        history: async () => this.bridge?.history.list() ?? { items: [], icons: {} },
        dismiss: async (id) => {
          const ok = (await this.bridge?.dismissLaptop(id)) ?? false;
          return {
            value: null,
            summary: ok ? "Dismissed a laptop notification" : "No such laptop notification",
          };
        },
      },
      input: this.input,
      terminal: this.terminal,
      share: this.share,
      phoneEvent: async (from, e) => {
        const name = this.devices.get(from)?.name ?? "phone";
        // What, never who: a call's or a text's arrival in the journal.
        if (e.kind === "call" || e.kind === "sms")
          this.log(`${name}: ${e.kind}${e.kind === "call" ? ` ${e.state}` : ""}`);
        if (e.kind === "call") this.calls.onEvent(from, name, e);
        if (this.bridge && e.kind !== "battery") await this.bridge.fromPhoneEvent(from, name, e);
        else await this.system.showPhoneEvent(name, e);
      },
      undo: (u) => this.undo(u),
    };
  }

  private async undo(u: Undo): Promise<Done<unknown>> {
    const d = u.data as Record<string, unknown>;
    if (u.kind.startsWith("files.")) return this.files.undo(u);
    if (u.kind.startsWith("media.")) return this.media.undo(u.kind, d);
    // "caffeine.set", "jagaran.set": entries from before it was named jyoti.
    if (u.kind === "jyoti.set" || u.kind === "jagaran.set" || u.kind === "caffeine.set")
      return this.jyoti.undo(d as never);
    if (u.kind === "appearance.set")
      return this.appearance.set(d.mode === "light" ? "light" : "dark");
    if (u.kind === "clipboard.set") return this.system.clipboardSet(String(d.text ?? ""));
    if (u.kind === "clipboard.sync") return this.services.clipboard.sync.set(Boolean(d.on));
    if (u.kind === "devices.restore") {
      const rec = d.record as DeviceRecord;
      await this.devices.put(rec);
      this.emitDevices();
      return {
        value: null,
        summary: `Paired ${rec.name} again`,
        undo: { kind: "devices.remove", data: { key: rec.key } },
      };
    }
    if (u.kind === "devices.remove") {
      const rec = await this.devices.remove(String(d.key));
      this.peers.get(String(d.key))?.close("unpaired");
      this.emitDevices();
      return {
        value: null,
        summary: `Unpaired ${rec?.name ?? "it"}`,
        ...(rec ? { undo: { kind: "devices.restore", data: { record: rec } } } : {}),
      };
    }
    if (u.kind === "devices.grants") {
      const key = String(d.key);
      return this.localServices.devices.grant(key, d.grants as string[]);
    }
    throw new TRPCError({ code: "BAD_REQUEST", message: `don't know how to undo ${u.kind}` });
  }

  // ------------------------------------------------- this laptop's own user
  private deviceListeners = new Set<(d: Device[]) => void>();

  private emitDevices(): void {
    const list = this.deviceList();
    for (const cb of this.deviceListeners) cb(list);
  }

  private deviceList(): Device[] {
    return this.devices.all().map((d) => ({
      ...d,
      online: this.peers.has(d.key),
      via: this.peers.get(d.key)?.via ?? null,
    }));
  }

  private findDevice(keyOrName: string): DeviceRecord {
    const all = this.devices.all();
    const d =
      all.find((x) => x.key === keyOrName) ??
      all.find((x) => x.name.toLowerCase() === keyOrName.toLowerCase());
    if (!d) throw new TRPCError({ code: "NOT_FOUND", message: `no paired device "${keyOrName}"` });
    return d;
  }

  lanAddresses(): string[] {
    if (this.o.lan) return this.o.lan(this.port);
    const out: string[] = [];
    for (const [name, list] of Object.entries(networkInterfaces())) {
      // Containers and VPNs: no phone is there, and each dead address costs it a timeout.
      if (VIRTUAL.test(name)) continue;
      for (const a of list ?? []) {
        if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."))
          out.push(`${a.address}:${this.port}`);
      }
    }
    return out;
  }

  readonly localServices: LocalServices = {
    pair: {
      start: async (away): Promise<Offer> => {
        const token = this.tokens.issue();
        const lan = this.lanAddresses();
        let url: string | null = null;
        if (away) {
          const reach = await this.tunnel.start();
          url = reach.url;
          lan.push(...reach.lan);
          if (!url && !reach.lan.length) {
            const kind = this.o.config.tunnel.kind;
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: `no way in from outside: ${kind === "none" ? "set [tunnel] kind in config.toml" : `install ${kind}`}, or pair on the same Wi-Fi`,
            });
          }
        }
        return {
          uri: formatOffer({
            key: this.o.key.publicKey,
            token,
            name: this.o.config.name,
            lan,
            ...(url ? { url } : {}),
          }),
          expires: Date.now() + PAIR_TTL_MS,
          lan,
          url,
        };
      },
      pending: (signal) =>
        feed(
          signal,
          (push) => {
            this.pendingListeners.add(push);
            return () => this.pendingListeners.delete(push);
          },
          async () => this.pendingList(),
        ),
      confirm: async (id, ok, grants) => {
        const p = this.pendings.get(id);
        if (!p)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "that request has gone (it timed out or was answered)",
          });
        if (!ok) {
          p.decide({ ok: false, reason: "refused on the laptop" });
          return { value: null, summary: `Refused to pair ${p.name}` };
        }
        const chosen = grantable(grants.length ? grants : PRESETS["everything-but-root"]);
        const record: DeviceRecord = {
          key: p.key,
          name: p.name,
          grants: chosen,
          pairedAt: Date.now(),
          lastSeen: Date.now(),
          info: p.info,
        };
        await this.devices.put(record);
        await this.mirrorOf(p.key);
        p.decide({ ok: true, welcome: { grants: chosen, name: this.o.config.name } });
        const device = this.deviceList().find((d) => d.key === p.key) as Device;
        return {
          value: device,
          summary: `Paired ${p.name} (${chosen.length} capabilities)`,
          undo: { kind: "devices.remove", data: { key: p.key } },
        };
      },
    },
    devices: {
      list: async () => this.deviceList(),
      watch: (signal) =>
        feed(
          signal,
          (push) => {
            this.deviceListeners.add(push);
            return () => this.deviceListeners.delete(push);
          },
          async () => this.deviceList(),
        ),
      grant: async (keyOrName, grants) => {
        const d = this.findDevice(keyOrName);
        const next = grantable(grants);
        await this.devices.put({ ...d, grants: next });
        this.emitDevices();
        const added = next.filter((g) => !d.grants.includes(g));
        const removed = d.grants.filter((g) => !next.includes(g));
        return {
          value: this.deviceList().find((x) => x.key === d.key) as Device,
          summary: `${d.name} may now${added.length ? ` also: ${added.join(", ")}` : ""}${removed.length ? `${added.length ? ";" : ""} no longer: ${removed.join(", ")}` : ""}${!added.length && !removed.length ? " do the same as before" : ""}`,
          undo: { kind: "devices.grants", data: { key: d.key, grants: d.grants } },
        };
      },
      rename: async (keyOrName, name) => {
        const d = this.findDevice(keyOrName);
        await this.devices.put({ ...d, name });
        this.emitDevices();
        return {
          value: this.deviceList().find((x) => x.key === d.key) as Device,
          summary: `Renamed ${d.name} to ${name}`,
        };
      },
      unpair: async (keyOrName) => {
        const d = this.findDevice(keyOrName);
        await this.devices.remove(d.key);
        this.peers.get(d.key)?.close("unpaired");
        this.emitDevices();
        return {
          value: null,
          summary: `Unpaired ${d.name}`,
          undo: { kind: "devices.restore", data: { record: d } },
        };
      },
    },
    calls: {
      watch: (signal) => this.calls.changes(signal),
    },
    log: {
      list: async (host, after, limit) => {
        if (host === "self") return this.journal.since(after, limit);
        const d = this.findDevice(host);
        return (await this.mirrorOf(d.key)).store.since(after, limit);
      },
      check: async () => {
        const out = [];
        const self = await this.journal.check();
        out.push({
          host: "self",
          name: this.o.config.name,
          seq: (await this.journal.store.last())?.seq ?? 0,
          problem: self ? `#${self.seq}: ${self.why}` : null,
        });
        for (const d of this.devices.all()) {
          const m = await this.mirrorOf(d.key);
          const all = await m.store.since(0, 1_000_000);
          const p = verify(all);
          out.push({
            host: d.key,
            name: d.name,
            seq: all.at(-1)?.seq ?? 0,
            problem: p ? `#${p.seq}: ${p.why}` : null,
          });
        }
        return out;
      },
    },
    phone: async (keyOrName, type, path, input) => {
      const online = [...this.peers.values()];
      const peer = keyOrName ? this.peers.get(this.findDevice(keyOrName).key) : online.at(-1);
      if (!peer) throw new TRPCError({ code: "NOT_FOUND", message: "no phone is connected" });
      let target: unknown = peer.phone;
      for (const part of path.split(".")) {
        if (!/^\w+$/.test(part)) throw new TRPCError({ code: "BAD_REQUEST", message: "bad path" });
        target = (target as Record<string, unknown>)[part];
      }
      const fn = (target as Record<string, (i: unknown) => Promise<unknown>>)[
        type === "query" ? "query" : "mutate"
      ];
      if (typeof fn !== "function")
        throw new TRPCError({ code: "NOT_FOUND", message: `the phone has no ${path}` });
      const out = await fn(input);
      // Answered or hung up from here: follow it at once. The phone's own call
      // events can come late or not at all (Android holds broadcasts back from
      // an app it has put in its background cache), and the banner would stay.
      const key = keyOrName ? this.findDevice(keyOrName).key : [...this.peers.keys()].at(-1);
      if (type !== "query" && key) {
        const name = this.devices.get(key)?.name ?? "phone";
        if (path === "calls.hangUp") this.calls.forget(key);
        // Dialled from here: it's on the phone now, show it (its own event may lag).
        if (path === "calls.dial") {
          const number = String((input as { number?: unknown } | null)?.number ?? "");
          this.calls.onEvent(key, name, { kind: "call", state: "active", number, contact: null });
        }
        if (path === "calls.answer" && this.calls.get()?.device === key)
          this.calls.onEvent(key, name, {
            kind: "call",
            state: "active",
            number: "",
            contact: null,
          });
      }
      return out;
    },
  };

  // ------------------------------------------------------- the local socket
  private async listenLocal(): Promise<void> {
    rmSync(this.o.socketPath, { force: true });
    this.local = createServer((_req, res) => res.writeHead(404).end());
    this.localWss = new WebSocketServer({ server: this.local });
    const me = userInfo().username;
    applyWSSHandler({
      wss: this.localWss,
      router: localRouter,
      createContext: ({ info }): LaptopContext => ({
        // `ekatva mcp` names its agent, so the log says who did it.
        actor: { key: "local", name: agentLabel(me, info.connectionParams?.agent) },
        grants: { has: (_c: Capability) => true },
        journal: this.journal,
        services: this.services,
        local: this.localServices,
      }),
    });
    const old = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        this.local?.once("error", reject);
        this.local?.listen(this.o.socketPath, () => resolve());
      });
    } finally {
      process.umask(old);
    }
    chmodSync(this.o.socketPath, 0o600);
  }
}

export { LinkError, VERSION };

/** "yash" or "yash via claude": the local user, and the agent acting for them if one said so. */
export function agentLabel(user: string, agent: unknown): string {
  const name =
    typeof agent === "string"
      ? agent
          .replace(/[^\w .@-]/g, "")
          .trim()
          .slice(0, 40)
      : "";
  return name ? `${user} via ${name}` : user;
}

/** Runs a command, ignoring how it ends (opening a link). */
function runQuiet(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, () => resolve());
  });
}

/** A line of text typed on the laptop (a reply), or null when cancelled. */
const zenityPrompt: Prompt = (title, text) =>
  new Promise((resolve) => {
    execFile(
      "zenity",
      ["--entry", `--title=${title}`, `--text=${text}`, "--width=420"],
      { timeout: 10 * 60_000 },
      (err, out) => resolve(err ? null : String(out).replace(/\n$/, "") || null),
    );
  });

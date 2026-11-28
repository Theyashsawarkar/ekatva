/**
 * The daemon: the link for phones (on the LAN, and through a tunnel when
 * allowed), the local socket for this laptop's own user (the Vyom
 * popup, the CLI), and everything they reach.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, renameSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
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
  type PortChannel,
  TokenBook,
  toB64u,
  webSocketTransport,
} from "@ekatva/link";
import {
  appGrant,
  type Capability,
  channelWebSocket,
  type Device,
  type Done,
  type Entry,
  grantable,
  Journal,
  type LaptopApp,
  type LaptopContext,
  type LaptopServices,
  type LocalRouter,
  type LocalServices,
  laptopRouter,
  localRouter,
  Mirror,
  type Offer,
  type PendingPair,
  type PhoneRouter,
  PRESETS,
  type Route,
  serveRouter,
  type TunnelInfo,
  TunnelSettings,
  type Undo,
  verify,
} from "@ekatva/protocol";
import {
  createTRPCClient,
  createWSClient,
  type TRPCClient,
  unstable_localLink,
  wsLink,
} from "@trpc/client";
import { TRPCError } from "@trpc/server";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { type WebSocket, WebSocketServer } from "ws";
import type { Config } from "./config.js";
import { type DeviceRecord, Devices } from "./devices.js";
import { FileStore } from "./journalFile.js";
import { LinkClient, type LinkPending } from "./link.js";
import type { Approve, StreamSession } from "./mcp.js";
import {
  displayEnv,
  HELLO_MAX,
  HELLO_OK,
  HELLO_TIMEOUT_MS,
  type Hello,
  helloRefused,
  parseHello,
  prepareSocketDir,
  socketIsDead,
} from "./mcpSocket.js";
import { AgentsService, type Tmux } from "./services/agents.js";
import { type AppearanceHost, AppearanceService } from "./services/appearance.js";
import { AppsService } from "./services/apps.js";
import { BeaconSender, VIRTUAL } from "./services/beacon.js";
import { CallState } from "./services/calls.js";
import { type ClipboardEvents, ClipboardSync, wlPasteEvents } from "./services/clipboardSync.js";
import { DesktopNotifications } from "./services/desktopNotifications.js";
import { LaptopFiles } from "./services/files.js";
import { type FirewallProblem, firewallProblem } from "./services/firewall.js";
import { InputService, type Runner } from "./services/input.js";
import { type Host, JyotiService } from "./services/jyoti.js";
import { type MediaHost, MediaService } from "./services/media.js";
import { appCall, isDialer, NotificationBridge, type Prompt } from "./services/notifyBridge.js";
import { programOf } from "./services/peer.js";
import { Rendezvous } from "./services/rendezvous.js";
import { RootBridge } from "./services/root.js";
import { type ShareHost, ShareInbox } from "./services/share.js";
import { SystemService } from "./services/system.js";
import { TerminalService } from "./services/terminal.js";
import { ALIVE_BODY, ALIVE_PATH, Tunnel } from "./services/tunnel.js";

const VERSION = "0.3.0";
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
  /**
   * ekatva-link's socket: attach to it (the link holds the identity, the
   * paired phones and their connections) instead of listening here. Only the
   * real service passes it; tests and a laptop without the link don't.
   */
  link?: string;
  stateDir: string;
  socketPath: string;
  /**
   * The MCP socket: one agent session per connection (`pranali ekatva`).
   * Default: `ekatva/mcp.sock` beside socketPath; null: none.
   */
  mcpSocketPath?: string | null;
  /**
   * The MCP socket's listener, already bound, handed over by systemd
   * (`ekatva-mcp.socket`, fd 3). The path is then neither bound nor
   * removed here: it outlives this process.
   */
  mcpListenFd?: number;
  /** How long stopping waits for agents' calls in flight (default 20 s). */
  mcpDrainMs?: number;
  /**
   * Asks the user to allow an agent's SMS or call (default: a zenity dialog
   * on the agent's display, from its hello).
   */
  approve?: Approve;
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
  /** The clipboard's change events (default `wl-paste --watch`); null polls. */
  clipboardEvents?: ClipboardEvents | null;
  log?: (msg: string) => void;
  /** The addresses phones are told (default: this machine's IPv4 addresses). */
  lan?: (port: number) => string[];
  /** Watch the rendezvous mailboxes (default: when a tunnel kind is set). */
  rendezvous?: boolean;
  /**
   * Keep the tunnel up all the time while a phone is paired (the service:
   * `[tunnel] mode = "always"`, the default). Off unless set: tests never
   * open a real tunnel.
   */
  keepTunnel?: boolean;
  /** Starts the tunnel's program (tests: a fake cloudflared). */
  tunnelSpawner?: (cmd: string, args: string[]) => import("node:child_process").ChildProcess;
  rendezvousEveryMs?: number;
  /** Desktop notifications (pairing requests, log mismatches). */
  /** `open`: a window tab to show when the notification is clicked. */
  notify?: (title: string, body: string, urgent?: boolean, open?: string) => void;
}

interface Peer {
  key: string;
  channel: PortChannel;
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
  /** Attached to ekatva-link: phones come through it (docs/plans/link-and-session.md). */
  private link: LinkClient | null = null;
  private relink: ReturnType<typeof setInterval> | null = null;
  /** Set by stop(): the link closing then is ours, not a reason to reattach. */
  private stopping = false;
  private pendingListeners = new Set<(p: PendingPair[]) => void>();
  private failures = new Map<string, { n: number; since: number }>();
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private local: Server | null = null;
  private localWss: WebSocketServer | null = null;
  private mcp: NetServer | null = null;
  /** Whether this process bound the MCP socket's path (and so may remove it). */
  private mcpBound = false;
  private mcpConns = new Set<McpConn>();
  /** Aborted when stopping: approvals still open are declined. */
  private mcpStopping = new AbortController();
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
  /** This laptop's Vayu apps, and how phones reach them. */
  readonly apps: AppsService;
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
    this.apps = new AppsService(
      join(o.stateDir, "apps.json"),
      (m) => this.log(m),
      Date.now,
      undefined,
      join(o.stateDir, "apps"),
    );
    this.apps.connect({
      phone: (device, type, path, input) => this.localServices.phone(device, type, path, input),
      linked: (id) => this.grantApp(id, true),
      unlinked: (id) => this.grantApp(id, false),
      notify: (title, body) => this.notify(title, body, false, "apps"),
    });
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
      1500,
      o.clipboardEvents === undefined ? wlPasteEvents() : o.clipboardEvents,
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
      ...(o.tunnelSpawner ? [o.tunnelSpawner] : []),
    );
    if (o.config.tunnel.kind === "named" && o.config.tunnel.hostname)
      this.tunnel.useNamed(o.config.tunnel.name, o.config.tunnel.hostname);
    this.tunnelFile = join(o.stateDir, "tunnel.json");
    // A new tunnel URL: tell the connected phones (link.watch), the window,
    // and every paired phone's mailbox, for the ones away right now.
    let lastUrl: string | null = null;
    this.tunnel.onChange((info) => {
      this.emitRoute();
      if (info.url && info.url !== lastUrl) void this.rendezvous?.announce(info.url);
      lastUrl = info.url;
    });
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
    await this.apps.load();
    await this.savedTunnel();
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
    const attached = await this.attachLink();
    if (!attached) await this.listen();
    await this.listenLocal();
    await this.listenMcp();
    await this.root.listen();
    // Watch the mailboxes when phones may reach the laptop from outside.
    if (!attached && this.o.config.tunnel.kind !== "none" && this.o.rendezvous !== false) {
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
    if (!attached) this.keepTunnel();
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
    if (!attached && (this.o.beacon ?? this.o.config.advertise)) {
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
    if (!attached && this.o.checkFirewall !== false) {
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
      attached && this.link
        ? `ekatva ${VERSION}: attached to ekatva-link (port ${this.port}), ${this.devices.all().length} paired device(s)`
        : attached
          ? `ekatva ${VERSION}: waiting for ekatva-link (it holds the phones)`
          : `ekatva ${VERSION}: listening on port ${this.port}, ${this.devices.all().length} paired device(s)`,
    );
  }

  // ---------------------------------------------------------- ekatva-link
  /** Attaches to ekatva-link when the service was told where it is. */
  private async attachLink(): Promise<boolean> {
    const path = this.o.link;
    if (!path) return false;
    // Phones reach the link on its port (the same setting as before the link).
    this.port = this.o.port ?? this.o.config.port;
    if (!existsSync(path)) {
      this.log("ekatva-link isn't up yet; waiting for it");
      this.waitForLink();
      return true;
    }
    let link: LinkClient;
    try {
      link = await LinkClient.connect(
        {
          open: (c, via) => this.onPeer(c, via),
          devices: (list) => {
            this.devices.replace(list);
            this.emitDevices();
          },
          pending: (list) => this.linkPending(list),
          lost: () => this.linkLost(),
        },
        path,
      );
    } catch (e) {
      this.log(`ekatva-link didn't answer (${(e as Error).message}); waiting for it`);
      this.waitForLink();
      return true;
    }
    this.link = link;
    this.devices.attach(link);
    this.port = link.hello?.port ?? this.port;
    return true;
  }

  /** The link restarted or stopped: phones come back through it once it's there. */
  private linkLost(): void {
    if (!this.link || this.stopping) return;
    this.link = null;
    this.devices.attach(null);
    for (const p of this.pendings.values())
      p.decide({ ok: false, reason: "ekatva-link went away" });
    this.log("ekatva-link went away; waiting for it");
    this.waitForLink();
  }

  private waitForLink(): void {
    if (this.relink || this.stopping) return;
    this.relink = setInterval(() => {
      if (this.link) return;
      void this.attachLink().then(() => {
        if (this.link && this.relink) {
          clearInterval(this.relink);
          this.relink = null;
          this.log("attached to ekatva-link again");
        }
      });
    }, 2000);
  }

  /** Pairings waiting on the desktop, as the link has them. */
  private linkPending(list: LinkPending[]): void {
    const ids = new Set(list.map((p) => p.id));
    for (const id of [...this.pendings.keys()]) if (!ids.has(id)) this.pendings.delete(id);
    for (const p of list) {
      if (this.pendings.has(p.id)) continue;
      this.pendings.set(p.id, {
        ...p,
        decide: (d: Decision) => {
          this.pendings.delete(p.id);
          this.emitPending();
          void this.link
            ?.call(
              "pair.decide",
              d.ok
                ? { id: p.id, ok: true, welcome: d.welcome }
                : { id: p.id, ok: false, reason: d.reason },
            )
            .catch((e: Error) => this.log(`pairing ${p.name}: ${e.message}`));
        },
      });
      this.notify(
        `${p.name} wants to pair`,
        `Check that it shows ${p.sas.join(" ")}. Click to answer in the ekatva window.`,
        true,
        "pair",
      );
    }
    this.emitPending();
  }

  async stop(): Promise<void> {
    // Agents' calls in flight finish first, while the phones are still here.
    await this.drainMcp();
    for (const t of this.timers) clearInterval(t);
    for (const p of this.peers.values()) p.close("the laptop's service stopped");
    this.peers.clear();
    this.clipSync.update();
    for (const p of this.pendings.values()) p.decide({ ok: false, reason: "the laptop stopped" });
    this.stopping = true;
    if (this.relink) clearInterval(this.relink);
    this.relink = null;
    this.link?.close();
    this.link = null;
    this.beacon?.stop();
    this.clipSync.stop();
    this.stopRootWatch?.();
    this.bridge?.stop();
    this.rendezvous?.stop();
    this.tunnel.stop();
    this.media.stop();
    this.jyoti.shutdown();
    this.agents.shutdown();
    this.apps.shutdown();
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
    this.http = createServer((req, res) => {
      // The tunnel asks itself whether it still reaches the laptop (services/tunnel.ts).
      if (req.method === "GET" && req.url === ALIVE_PATH) {
        res.writeHead(200, { "content-type": "text/plain" }).end(ALIVE_BODY);
        return;
      }
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

  private onPeer(channel: PortChannel, via: "lan" | "tunnel"): void {
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
    this.clipSync.update();
    if (via === "tunnel") {
      this.tunnel.touch();
      const keep = setInterval(() => this.tunnel.touch(), 60_000);
      channel.onClose(() => clearInterval(keep));
    }
    void this.devices.seen(key, channel.peer.info);
    this.log(`${device.name} connected (${via})`);
    channel.onClose((reason) => {
      if (this.peers.get(key) === peer) this.peers.delete(key);
      this.clipSync.update();
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
      link: {
        route: async () => this.route(),
        changes: (signal) =>
          feed(
            signal,
            (push) => {
              this.routeListeners.add(push);
              return () => this.routeListeners.delete(push);
            },
            async () => this.route(),
          ),
      },
      jyoti: {
        get: () => this.jyoti.get(),
        set: (level, minutes) => this.jyoti.set(level, minutes),
        changes: (signal) => this.jyoti.changes(signal),
      },
      power: {
        lock: () => this.system.lock(),
        unlock: (password) => this.system.unlock(password),
        suspend: () => this.system.suspend(),
      },
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
        history: (id, before, limit) => this.agents.history(id, before, limit),
        follow: (id, signal) => this.agents.follow(id, signal),
        output: (id, n, epoch) => this.agents.output(id, n, epoch),
        rename: (id, name) => this.agents.rename(id, name),
        sendNow: (id) => this.agents.sendNow(id),
        reply: (id, text, now) => this.agents.reply(id, text, now),
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
        // An app's call (WhatsApp…): the call in progress, for the bar and the popup.
        if (e.kind === "notification" && e.call && !isDialer(e.package, e.app)) {
          const c = appCall(e);
          this.log(`${name}: ${e.app} call ${c.state}`);
          const video = e.video === true || /video/i.test(`${e.title} ${e.text}`);
          this.calls.onApp(from, name, e.app, e.id, c.state, e.title, c.reject, video);
        }
        if (this.bridge && e.kind !== "battery") await this.bridge.fromPhoneEvent(from, name, e);
        else await this.system.showPhoneEvent(name, e);
      },
      apps: {
        list: async (granted) => this.apps.list(granted),
        call: (from, c) => this.apps.phoneCall(from, c),
        emit: (from, e) => this.apps.phoneEmit(from, e),
        upload: this.apps.upload,
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
  private routeListeners = new Set<(r: Route) => void>();

  /** Every way to reach the laptop now. */
  route(): Route {
    const hello = this.link?.hello;
    if (hello) {
      // ekatva-link's tunnel (ekatva-tunnel.service) keeps the address; it's always up.
      const url = hello.url;
      const tunnel = {
        kind: url ? ("named" as const) : ("none" as const),
        state: url ? ("up" as const) : ("off" as const),
        url,
        always: true,
        since: null,
        problem: null,
        hostname: url ? new URL(url).host : null,
        name: null,
      };
      return { url, lan: this.lanAddresses(), tunnel };
    }
    const tunnel = this.tunnel.info();
    return { url: tunnel.url, lan: this.lanAddresses(), tunnel };
  }

  private emitRoute(): void {
    const r = this.route();
    for (const cb of this.routeListeners) cb(r);
  }

  /** Always-up tunnel while a phone is paired (when the service asks for it). */
  private keepTunnel(): void {
    this.tunnel.keep(!!this.o.keepTunnel && this.devices.all().length > 0);
  }

  private emitDevices(): void {
    this.rendezvous?.refresh();
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
    tunnel: {
      set: async (t) => {
        await mkdir(dirname(this.tunnelFile), { recursive: true, mode: 0o700 });
        await writeFile(this.tunnelFile, JSON.stringify(t, null, 1), { mode: 0o600 });
        const was = this.tunnel.info();
        const info = await this.applyTunnel(t);
        const where = t.kind === "named" ? t.hostname : t.kind;
        return {
          value: info,
          summary: `Reached from anywhere through ${where} (was ${was.hostname ?? was.kind})`,
        };
      },
    },
    pair: {
      start: async (away): Promise<Offer> => {
        const link = this.link;
        const token = link
          ? fromB64u((await link.call<{ token: string }>("pair.token")).token)
          : this.tokens.issue();
        const lan = this.lanAddresses();
        let url: string | null = null;
        if (away && link) {
          url = link.hello?.url ?? null;
          if (!url && !lan.length)
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "no way in from outside: ekatva-link has no tunnel; pair on the same Wi-Fi",
            });
        } else if (away) {
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
        this.keepTunnel();
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
        this.keepTunnel();
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
    apps: {
      register: (manifest, signal, program) => this.apps.register(manifest, signal, program),
      reply: (r) => this.apps.reply(r),
      list: async () => this.laptopApps(),
      watch: (signal) =>
        feed(
          signal,
          (push) => {
            const view = () => push({ apps: this.laptopApps(), ...this.apps.state() });
            const offApps = this.apps.onChange(view);
            const offDevices = this.devices.onChange(view);
            return () => {
              offApps();
              offDevices();
            };
          },
          async () => ({ apps: this.laptopApps(), ...this.apps.state() }),
        ),
      accept: (id) => this.apps.accept(id),
      refuse: (id) => this.apps.refuse(id),
      unrefuse: (id) => this.apps.unrefuse(id),
      unlink: (id) => this.apps.unlink(id),
      decideRoute: (id, answer) => this.apps.decideRoute(id, answer),
      removeRoute: (caller, to) => this.apps.removeRoute(caller, to),
      call: (c) => this.apps.call(c),
      emit: (e) => this.apps.emit(e),
      phoneApps: (device) => this.apps.phoneApps(device),
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
      // An app's call (WhatsApp…) ends with its own Hang up button, not the phone's.
      const button = path === "calls.hangUp" ? this.calls.hangupButton() : null;
      if (button) {
        const end = await peer.phone.notifications.act.mutate({
          id: button.id,
          index: button.index,
          reply: null,
        });
        this.calls.onApp(
          button.device,
          this.devices.get(button.device)?.name ?? "phone",
          this.calls.get()?.app ?? "",
          button.id,
          "ended",
          "",
          -1,
        );
        return end;
      }
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

  /** A linked app: every paired phone may reach it (or, unlinked, none may). */
  private async grantApp(id: string, on: boolean): Promise<void> {
    for (const d of this.devices.all()) {
      const set = new Set(d.grants);
      if (on) {
        set.add("apps");
        set.add(appGrant(id));
      } else set.delete(appGrant(id));
      await this.devices.put({ ...d, grants: grantable([...set]) });
    }
    this.emitDevices();
  }

  private readonly tunnelFile: string;

  /** The tunnel as set in the window (tunnel.json), over config.toml's. */
  private async savedTunnel(): Promise<void> {
    try {
      const t = TunnelSettings.parse(JSON.parse(await readFile(this.tunnelFile, "utf8")));
      await this.applyTunnel(t);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log(`tunnel.json: ${e}`);
    }
  }

  private applyTunnel(t: TunnelSettings): Promise<TunnelInfo> {
    const named = t.kind === "named" && t.hostname ? { name: t.name, hostname: t.hostname } : null;
    return this.tunnel.reconfigure(t.kind, named);
  }

  /** This laptop's apps, with the devices granted each. */
  private laptopApps(): LaptopApp[] {
    return this.apps.laptopApps((id) =>
      this.devices
        .all()
        .filter((d) => d.grants.includes(appGrant(id)))
        .map((d) => d.key),
    );
  }

  // ------------------------------------------------------- the local socket
  private async listenLocal(): Promise<void> {
    rmSync(this.o.socketPath, { force: true });
    this.local = createServer((_req, res) => res.writeHead(404).end());
    this.localWss = new WebSocketServer({ server: this.local });
    applyWSSHandler({
      wss: this.localWss,
      router: localRouter,
      // `ekatva mcp` names its agent, so the log says who did it.
      createContext: ({ info, req }) => this.localContext(info.connectionParams?.agent, req.socket),
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

  /** What a call on the local router runs as: this laptop's user, or an agent acting for them. */
  private localContext(agent: unknown, socket: unknown): LaptopContext {
    return {
      actor: { key: "local", name: agentLabel(userInfo().username, agent) },
      agent: agentName(agent) || undefined,
      peer: () => programOf(socket),
      grants: { has: (_c: Capability) => true },
      journal: this.journal,
      services: this.services,
      local: this.localServices,
    };
  }

  // --------------------------------------------------------- the MCP socket
  private mcpPath(): string {
    return this.o.mcpSocketPath ?? join(dirname(this.o.socketPath), "ekatva", "mcp.sock");
  }

  /**
   * AI agents' sessions, served here instead of a Node process each:
   * `pranali ekatva` pipes an agent's stdio to this socket (the pranali
   * protocol, ~/personal/pranali/docs/PROTOCOL.md). A connection says hello
   * (`{"pranali":1,"agent":…,"env":…}`, answered `{"pranali":1,"ok":true}`),
   * then speaks MCP as on stdio. The tools are `ekatva mcp`'s, calling the
   * local router in this process with the context the local socket gives
   * that agent, so the log and the grants are the same. The socket is the
   * user's own (0600 in a 0700 directory), as the local socket is.
   *
   * Taken from systemd when it was socket-activated (`mcpListenFd`); bound
   * here otherwise (dev runs, tests), and then only over a dead socket.
   */
  private async listenMcp(): Promise<void> {
    if (this.o.mcpSocketPath === null) return;
    const server = createNetServer({ allowHalfOpen: true }, (socket) => this.mcpSession(socket));
    const listen = (how: string | { fd: number }) =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(how as never, () => {
          server.off("error", reject);
          resolve();
        });
      });
    if (this.o.mcpListenFd !== undefined) {
      await listen({ fd: this.o.mcpListenFd });
      this.mcp = server;
      return;
    }
    const path = this.mcpPath();
    const wrong = prepareSocketDir(path);
    if (wrong) {
      this.log(`no MCP socket: ${wrong}`);
      return;
    }
    if (existsSync(path)) {
      // Only a dead daemon's leftover (connecting is refused) is removed.
      if (!(await socketIsDead(path))) {
        this.log(`no MCP socket: ${path} is in use (or can't be checked); not replacing it`);
        return;
      }
      rmSync(path, { force: true });
    }
    const old = process.umask(0o177);
    try {
      await listen(path);
    } finally {
      process.umask(old);
    }
    chmodSync(path, 0o600);
    this.mcp = server;
    this.mcpBound = true;
  }

  /** A connection: the hello first (5 s), then its MCP session. */
  private mcpSession(socket: Socket): void {
    const conn: McpConn = { socket, session: null, closed: false };
    this.mcpConns.add(conn);
    socket.on("error", () => undefined);
    // Before anything async: a socket that closes during the import doesn't leak a session.
    socket.on("close", () => {
      conn.closed = true;
      this.mcpConns.delete(conn);
      void conn.session?.server.close().catch(() => undefined);
    });
    if (this.mcpStopping.signal.aborted) {
      socket.destroy();
      return;
    }
    const timer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    let head = Buffer.alloc(0);
    const hello = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(10);
      if (nl < 0) {
        if (head.length > HELLO_MAX) socket.destroy();
        return;
      }
      clearTimeout(timer);
      socket.off("data", hello);
      socket.pause();
      const said = parseHello(head.subarray(0, nl).toString("utf8"));
      if ("error" in said) {
        if (said.pranali) socket.end(helloRefused(said.error));
        else socket.destroy();
        return;
      }
      const rest = head.subarray(nl + 1);
      if (rest.length) socket.unshift(rest);
      if (said.pranali) socket.write(HELLO_OK);
      void this.serveMcpOn(conn, said).catch((e: Error) => {
        this.log(`an MCP session failed: ${e.message}`);
        socket.destroy();
      });
    };
    socket.on("data", hello);
  }

  private async serveMcpOn(conn: McpConn, hello: Hello): Promise<void> {
    // Loaded with the first session: the daemon doesn't carry the MCP SDK until an agent comes.
    const { serveMcpStream, approve } = await import("./mcp.js");
    if (conn.closed) return;
    const { socket } = conn;
    const ctx = this.localContext(hello.agent, socket);
    const api = createTRPCClient<LocalRouter>({
      links: [unstable_localLink({ router: localRouter, createContext: async () => ctx })],
    });
    conn.session = await serveMcpStream(socket, api, hello.agent, this.o.approve ?? approve, {
      env: displayEnv(hello.env),
      cwd: hello.cwd,
      signal: this.mcpStopping.signal,
    });
    if (conn.closed) {
      await conn.session.server.close().catch(() => undefined);
      return;
    }
    if (this.mcpStopping.signal.aborted) conn.session.transport.refusing = RESTARTING;
    // The agent is done sending (pranali's stdin ended): answer what it asked, then end.
    // Up to 10 s: then it ends anyway.
    socket.on("end", () => {
      const cut = setTimeout(() => socket.end(), HALF_OPEN_MS);
      void conn.session?.transport.idle().then(() => {
        clearTimeout(cut);
        socket.end();
      });
    });
    socket.resume();
  }

  /**
   * Stopping (SIGTERM): take no new connections (systemd keeps the socket,
   * so they wait in its backlog for the next daemon), refuse new calls on
   * the open ones, decline approvals still waiting, and give the calls in
   * flight up to `mcpDrainMs` to answer. Then each connection is ended.
   */
  private async drainMcp(): Promise<void> {
    const server = this.mcp;
    if (!server) return;
    this.mcp = null;
    this.mcpStopping.abort();
    const closed = new Promise<void>((r) => server.close(() => r()));
    const conns = [...this.mcpConns];
    for (const c of conns) if (c.session) c.session.transport.refusing = RESTARTING;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(conns.map((c) => c.session?.transport.idle())),
      new Promise<void>((r) => (timer = setTimeout(r, this.o.mcpDrainMs ?? 20_000))),
    ]);
    clearTimeout(timer);
    for (const c of conns) c.socket.end();
    // A client that doesn't close its side gets a second to, then is cut.
    await Promise.race([closed, new Promise((r) => setTimeout(r, 1_000).unref())]);
    for (const c of this.mcpConns) c.socket.destroy();
    await closed;
    if (this.mcpBound) rmSync(this.mcpPath(), { force: true });
  }
}

const RESTARTING = "ekatva is restarting; this call was not run, retry it";
/** After an agent's half-close, how long its owed answers may take. */
const HALF_OPEN_MS = 10_000;

/** A connection to the MCP socket, and its session once it said hello. */
interface McpConn {
  socket: Socket;
  session: StreamSession | null;
  closed: boolean;
}

export { LinkError, VERSION };

/** The agent a local connection says it acts for, made safe ("" for none). */
export function agentName(agent: unknown): string {
  return typeof agent === "string"
    ? agent
        .replace(/[^\w .@-]/g, "")
        .trim()
        .slice(0, 40)
    : "";
}

/** "yash" or "yash via claude": the local user, and the agent acting for them if one said so. */
export function agentLabel(user: string, agent: unknown): string {
  const name = agentName(agent);
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

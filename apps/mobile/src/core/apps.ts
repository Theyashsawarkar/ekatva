/**
 * The phone's side of the app hub: the phone's other Vayu apps (nāda,
 * vāgdevī…) talk to their laptop halves through ekatva.
 *
 *   phone app ⇄ AppBridgeService (Android, native) ⇄ this ⇄ the link ⇄ the laptop
 *
 * The native side decides who an app is (its package and signing
 * certificate, from Android itself) and enforces your approval: an app you
 * haven't allowed, or one whose certificate changed, never gets past it.
 * Here: the approvals waiting for you, routing both ways (the shared
 * AppHub's rules: timeouts, kept events, rate limits, sizes), and the
 * laptop's side of each call.
 *
 * An app links once: it asks from its own settings (its hello says `link`),
 * you allow it, and that's permanent. Until it asks it is only "unlinked":
 * opening an app never asks you anything.
 *
 * Its own half on the laptop needs nothing more (nāda reaches nāda; the
 * laptop checks its `app:<id>` grant as well). Another app, on the laptop
 * or here, is a *route*: you allow it once, and a method marked high risk
 * asks every time. Files come and go as descriptors the native side hands
 * over, so an app gets the files of its own calls and nothing else.
 */
import {
  APP_FILES_MAX,
  type AppFile,
  AppHub,
  type AppIncoming,
  type AppInfo,
  AppManifest,
  type AppMethod,
  type AppRoute,
  type KnownApp,
  type PhoneServices,
  parseAddress,
} from "@ekatva/protocol";
import type { Fs } from "./files";
import type { KV } from "./kv";
import { PhoneShareInbox } from "./share";

/** What Android says about an app that knocked: who it is, and where your approval stands. */
export type AppStatus = "allowed" | "pending" | "denied" | "refused";

export interface Approval {
  package: string;
  /** The SHA-256 of its signing certificate, hex. */
  cert: string;
  id: string;
  name: string;
  state: "allowed" | "denied";
}

/** A message from a phone app, as the native bridge hands it over. */
export type NativeAppMessage =
  | { kind: "hello"; package: string; cert: string; status: AppStatus; json: string }
  | { kind: "call" | "emit" | "status" | "reply"; package: string; json: string }
  | { kind: "bye"; package: string };

/** The native bridge (AppBridgeService); absent in Expo Go and tests without it. */
export interface NativeApps {
  onMessage(cb: (m: NativeAppMessage) => void): () => void;
  /** To a phone app: "welcome" (where it stands), "result" (an answer), "incoming" (a call or event). */
  send(pkg: string, what: "welcome" | "result" | "incoming", json: string): void;
  /** Your decision, pinned to the app's certificate. */
  decide(a: Approval): Promise<void>;
  approvals(): Promise<Approval[]>;
  /** Take an approval back: the app is cut off at once. */
  revoke(pkg: string): Promise<void>;
  /** A notification that opens ekatva (an app is asking while you're in it), and taking it away. */
  notify?(id: string, title: string, text: string): void;
  unnotify?(id: string): void;
}

/** An app waiting for your approval. */
export interface AppRequest {
  package: string;
  cert: string;
  manifest: AppManifest;
  at: number;
}

/** The laptop's API, when linked (only what the hub uses). */
export interface LaptopApps {
  name: string;
  invoke(c: {
    app: string;
    method: string;
    input: unknown;
    caller: string;
    files: AppFile[];
  }): Promise<unknown>;
  upload: {
    begin(c: { app: string; name: string; size: number }): Promise<{ id: string }>;
    put(c: { id: string; data: string }): Promise<unknown>;
    finish(c: { id: string }): Promise<{ ref: string }>;
    cancel(c: { id: string }): Promise<unknown>;
  };
  emit(e: { app: string; name: string; data: unknown; keep: number }): Promise<unknown>;
  list(): Promise<AppInfo[]>;
}

/** A new route waiting for you: the call waits with it. */
export interface RouteRequest {
  id: string;
  caller: string;
  callerName: string;
  to: string;
  toName: string;
  method: AppMethod;
  files: { name: string; size: number }[];
}
export type RouteAnswer = "always" | "once" | "refuse";

/** Where files for calls wait, and how to read them; absent: calls carry none. */
export interface AppFiles {
  fs: Fs;
  /** Private to ekatva. */
  dir: string;
}

export interface PhoneAppsOptions {
  now?: () => number;
  timeoutMs?: number;
  routeWaitMs?: number;
  files?: AppFiles;
  /** An app was linked: the laptop may reach the phone's apps. */
  linked?: () => Promise<void>;
}

const READ = 1024 * 1024;
const KNOWN = "ekatva.apps.known";
const ROUTES = "ekatva.apps.routes";
const CLOSED = "ekatva.apps.closed";
/** How long a call waits for your answer to its route. */
export const ROUTE_WAIT_MS = 60_000;
/** The id of the notification for an app asking to use ekatva: this, then its package. */
export const APP_REQUEST = "app-request:";

const errorOf = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^TRPCClientError:\s*/, "").slice(0, 500) ||
  "failed";

export class PhoneApps {
  readonly hub: AppHub;
  /** Package → the app's id and how to let it go. */
  private attached = new Map<string, { id: string; detach: () => void }>();
  private requests = new Map<string, AppRequest>();
  private listeners = new Set<() => void>();
  private off: (() => void) | null = null;
  private routes: AppRoute[] = [];
  private routeWaits = new Map<
    string,
    { request: RouteRequest; settle: (a: RouteAnswer) => void }
  >();
  /** Apps the laptop may not reach (their switch is off). */
  private closed = new Set<string>();
  private inbox: PhoneShareInbox | null = null;
  private uploads = new Map<string, { app: string; name: string; size: number }>();
  private received = new Map<string, { app: string; file: AppFile; path: string }>();
  private ids = 0;
  private readonly now: () => number;

  constructor(
    private readonly native: NativeApps | null,
    private readonly kv: KV,
    /** The laptop's apps API, or null while not linked. */
    private readonly laptop: () => LaptopApps | null,
    private readonly o: PhoneAppsOptions = {},
  ) {
    this.now = o.now ?? Date.now;
    if (o.files) {
      const dir = o.files.dir;
      this.inbox = new PhoneShareInbox(
        o.files.fs,
        {
          dir: async () => dir,
          openUrl: async () => undefined,
          setClipboard: async () => undefined,
          notify: () => undefined,
        },
        this.now,
      );
    }
    this.hub = new AppHub({
      side: "phone",
      now: this.now,
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      save: (known) => void this.kv.set(KNOWN, JSON.stringify(known)),
    });
    this.hub.onChange(() => this.changed());
  }

  async start(): Promise<void> {
    try {
      const raw = await this.kv.get(KNOWN);
      if (raw) this.hub.restore(JSON.parse(raw) as KnownApp[]);
      this.routes = JSON.parse((await this.kv.get(ROUTES)) ?? "[]");
      this.closed = new Set(JSON.parse((await this.kv.get(CLOSED)) ?? "[]"));
    } catch {
      // a broken list: start empty
    }
    // Files of calls cut short before: nobody will ask for them again.
    const f = this.o.files;
    if (f)
      for (const name of await f.fs.list(f.dir).catch(() => [] as string[]))
        await f.fs.remove(`${f.dir}/${name}`).catch(() => undefined);
    this.off = this.native?.onMessage((m) => this.handle(m)) ?? null;
  }

  stop(): void {
    this.off?.();
    this.off = null;
    for (const w of [...this.routeWaits.values()]) w.settle("refuse");
    for (const { detach } of this.attached.values()) detach();
    this.attached.clear();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }

  /** Apps waiting for your approval, oldest first. */
  waiting(): AppRequest[] {
    return [...this.requests.values()].sort((a, b) => a.at - b.at);
  }

  approvals(): Promise<Approval[]> {
    return this.native?.approvals() ?? Promise.resolve([]);
  }

  /** Allow or refuse an app that asked: pinned to the certificate it asked with. */
  async decide(pkg: string, allow: boolean): Promise<void> {
    const r = this.requests.get(pkg);
    if (!r || !this.native) return;
    this.requests.delete(pkg);
    this.native.unnotify?.(`${APP_REQUEST}${pkg}`);
    if (allow) await this.o.linked?.();
    await this.native.decide({
      package: pkg,
      cert: r.cert,
      id: r.manifest.id,
      name: r.manifest.name,
      state: allow ? "allowed" : "denied",
    });
    this.changed();
  }

  async revoke(pkg: string): Promise<void> {
    const a = (await this.approvals()).find((x) => x.package === pkg);
    await this.native?.revoke(pkg);
    this.attached.get(pkg)?.detach();
    this.attached.delete(pkg);
    if (a) {
      this.hub.forget(a.id);
      this.routes = this.routes.filter((r) => r.caller !== a.id && r.to !== `phone:${a.id}`);
      this.closed.delete(a.id);
      await this.save();
    }
    this.changed();
  }

  private async save(): Promise<void> {
    await this.kv.set(ROUTES, JSON.stringify(this.routes));
    await this.kv.set(CLOSED, JSON.stringify([...this.closed]));
  }

  // --------------------------------------------------------------- routes
  /** Whether the laptop may reach this app (its switch; on once linked). */
  reachable(id: string): boolean {
    return !this.closed.has(id);
  }

  async setReachable(id: string, on: boolean): Promise<void> {
    if (on) this.closed.delete(id);
    else this.closed.add(id);
    await this.save();
    this.changed();
  }

  /** Routes you allowed always. */
  allowedRoutes(): AppRoute[] {
    return [...this.routes];
  }

  async removeRoute(caller: string, to: string): Promise<void> {
    this.routes = this.routes.filter((r) => !(r.caller === caller && r.to === to));
    await this.save();
    this.changed();
  }

  /** New routes waiting for you, oldest first. */
  waitingRoutes(): RouteRequest[] {
    return [...this.routeWaits.values()].map((w) => w.request);
  }

  decideRoute(id: string, answer: RouteAnswer): void {
    this.routeWaits.get(id)?.settle(answer);
  }

  /** Asks you about a new route; throws if you refuse, or don't answer in a minute. */
  private async checkRoute(
    caller: AppManifest,
    to: string,
    toName: string,
    method: AppMethod,
    files: { name: string; size: number }[],
  ): Promise<void> {
    if (parseAddress(to).app === caller.id) return;
    if (method.risk !== "high" && this.routes.some((r) => r.caller === caller.id && r.to === to))
      return;
    const id = `route-${this.now().toString(36)}-${(++this.ids).toString(36)}`;
    const answer = await new Promise<RouteAnswer>((resolve) => {
      const settle = (a: RouteAnswer) => {
        clearTimeout(timer);
        if (!this.routeWaits.delete(id)) return;
        this.native?.unnotify?.(`${APP_REQUEST}${id}`);
        this.changed();
        resolve(a);
      };
      const timer = setTimeout(() => settle("refuse"), this.o.routeWaitMs ?? ROUTE_WAIT_MS);
      const request = { id, caller: caller.id, callerName: caller.name, to, toName, method, files };
      this.routeWaits.set(id, { request, settle });
      this.native?.notify?.(
        `${APP_REQUEST}${id}`,
        `${caller.name} wants to use ${toName}`,
        `${method.why}. Tap to answer.`,
      );
      this.changed();
    });
    if (answer === "refuse") throw new Error(`you didn't let ${caller.name} use ${toName}`);
    if (answer === "always" && method.risk !== "high") {
      this.routes = [
        ...this.routes.filter((r) => !(r.caller === caller.id && r.to === to)),
        { caller: caller.id, to, at: this.now() },
      ];
      await this.save();
      this.changed();
    }
  }

  /** The phone's apps, for the laptop's router. */
  services(): PhoneServices["apps"] {
    return {
      // Every app here was approved on the phone: that is its grant on this side.
      list: async () => this.hub.list((id) => this.reachable(id)),
      call: async (from, c) => {
        this.open(c.app);
        const got = (c.files ?? []).map((f) => {
          const r = f.path ? this.received.get(f.path) : undefined;
          if (!r || r.app !== c.app) throw new Error(`the file ${f.name} didn't arrive`);
          return { ref: f.path as string, ...r };
        });
        for (const g of got) this.received.delete(g.ref);
        try {
          return await this.hub.call(from, {
            ...c,
            files: got.map((g) => ({ ...g.file, path: g.path })),
          });
        } finally {
          // The app holds its own descriptors by now.
          for (const g of got) await this.o.files?.fs.remove(g.path).catch(() => undefined);
        }
      },
      emit: async (from, e) => {
        this.open(e.app);
        return this.hub.emit(from, e);
      },
      upload: {
        begin: async (app, name, size, from) => {
          this.open(app);
          if (!this.inbox) throw new Error("this phone can't take files for apps");
          if (!this.hub.online(app)) throw new Error(`${app} isn't open on the phone`);
          const { id } = await this.inbox.begin(name, size, from);
          this.uploads.set(id, { app, name, size });
          return { id };
        },
        put: async (id, data) => {
          if (!this.inbox) throw new Error("no such upload");
          await this.inbox.put(id, data);
        },
        finish: async (id) => {
          const u = this.uploads.get(id);
          this.uploads.delete(id);
          if (!u || !this.inbox) throw new Error("no such upload");
          const { value } = await this.inbox.finish(id);
          const ref = `f-${id}`;
          this.received.set(ref, {
            app: u.app,
            file: { name: u.name, size: u.size, mime: "application/octet-stream" },
            path: value.path,
          });
          return { ref };
        },
        cancel: async (id) => {
          this.uploads.delete(id);
          await this.inbox?.cancel(id);
        },
      },
    };
  }

  /** Throws when the laptop may not reach this app. */
  private open(id: string): void {
    if (!this.reachable(id)) throw new Error(`the laptop may not use "${id}" on this phone`);
  }

  // -------------------------------------------------- from the phone's apps
  private handle(m: NativeAppMessage): void {
    switch (m.kind) {
      case "hello":
        this.hello(m);
        return;
      case "bye":
        this.attached.get(m.package)?.detach();
        this.attached.delete(m.package);
        return;
      case "reply": {
        const r = parse(m.json) as { id?: string; ok?: boolean; result?: unknown; error?: string };
        if (typeof r?.id !== "string") return;
        this.hub.reply(
          r.ok
            ? { id: r.id, ok: true, result: r.result ?? null }
            : { id: r.id, ok: false, error: String(r.error || "failed").slice(0, 500) },
        );
        return;
      }
      default:
        void this.request(m.package, m.kind, parse(m.json));
    }
  }

  private hello(m: Extract<NativeAppMessage, { kind: "hello" }>): void {
    const manifest = AppManifest.safeParse(parse(m.json));
    const welcome = (status: string, why?: string) =>
      this.native?.send(m.package, "welcome", JSON.stringify({ status, ...(why ? { why } : {}) }));
    if (!manifest.success) {
      welcome("refused", "its manifest isn't valid");
      return;
    }
    const app = manifest.data;
    const asks = (parse(m.json) as { link?: unknown } | null)?.link === true;
    if (m.status === "pending" && !asks && !this.requests.has(m.package)) {
      welcome("unlinked", "link this app with ekatva first");
      return;
    }
    if (m.status === "pending") {
      this.requests.set(m.package, {
        package: m.package,
        cert: m.cert,
        manifest: app,
        at: this.requests.get(m.package)?.at ?? this.now(),
      });
      this.changed();
      this.native?.notify?.(
        `${APP_REQUEST}${m.package}`,
        `${app.name} wants to use ekatva`,
        "Tap to answer: it talks to your laptop through ekatva only if you allow it",
      );
      welcome("pending", "allow it in ekatva on this phone");
      return;
    }
    if (m.status !== "allowed") {
      welcome(m.status);
      return;
    }
    this.attached.get(m.package)?.detach();
    const detach = this.hub.attach(
      app,
      (inc: AppIncoming) => this.native?.send(m.package, "incoming", JSON.stringify(inc)),
      () => welcome("replaced"),
    );
    this.attached.set(m.package, { id: app.id, detach });
    welcome("allowed");
  }

  /** A phone app's request: answered with "result" and its id. */
  private async request(pkg: string, kind: string, body: unknown): Promise<void> {
    const b = (body ?? {}) as {
      id?: string;
      method?: string;
      name?: string;
      input?: unknown;
      to?: string;
      keep?: number;
      /** Copies the native side made of the files handed over; never the app's own words. */
      _files?: AppFile[];
    };
    const files = kind === "call" ? (b._files ?? []).slice(0, APP_FILES_MAX) : [];
    const answer = (out: { ok: true; result: unknown } | { ok: false; error: string }) =>
      this.native?.send(pkg, "result", JSON.stringify({ id: b.id ?? null, ...out }));
    try {
      const own = this.attached.get(pkg);
      const me = own ? this.hub.apps().find((a) => a.manifest.id === own.id)?.manifest : null;
      if (!own || !me) throw new Error("allow this app in ekatva on the phone first");
      const laptop = this.laptop();
      if (kind === "status") {
        const app = laptop ? ((await laptop.list()).find((a) => a.id === own.id) ?? null) : null;
        answer({ ok: true, result: { laptop: laptop?.name ?? null, app } });
        return;
      }
      const to = b.to ?? `laptop:${own.id}`;
      const { side, app } = parseAddress(to);
      if (side === "laptop" && !laptop) throw new Error("the laptop isn't connected");
      const name = kind === "call" ? b.method : b.name;
      if (!name)
        throw new Error(`a${kind === "call" ? " call needs a method" : "n event needs a name"}`);
      // Another app than its own half: a route, asked about once.
      if (app !== own.id) {
        const known =
          side === "laptop" ? await (laptop as LaptopApps).list() : this.hub.list(() => true);
        const target = known.find((a) => a.id === app);
        if (!target) throw new Error(`there's no app "${app}" on the ${side}`);
        const m = (kind === "call" ? target.methods : target.events).find((x) => x.name === name);
        if (!m) throw new Error(`${target.name} has no "${name}" on the ${side}`);
        await this.checkRoute(me, to, target.name, m, files);
      }
      if (kind === "call") {
        answer({ ok: true, result: await this.forward(me.id, side, app, name, b.input, files) });
      } else if (kind === "emit") {
        const keep = Math.max(0, Math.min(86_400, Math.floor(Number(b.keep) || 0)));
        const e = { app, name, data: b.input ?? null, keep };
        if (side === "laptop") await (laptop as LaptopApps).emit(e);
        else await this.hub.emit({ key: "phone", name: "this phone", app: me.id }, e);
        answer({ ok: true, result: null });
      } else throw new Error(`ekatva doesn't know "${kind}"`);
    } catch (e) {
      answer({ ok: false, error: errorOf(e) });
    } finally {
      for (const f of files)
        if (f.path) await this.o.files?.fs.remove(f.path).catch(() => undefined);
    }
  }

  /** A call from an app here, to the laptop (its files first) or to another app here. */
  private async forward(
    caller: string,
    side: "laptop" | "phone",
    app: string,
    method: string,
    input: unknown,
    files: AppFile[],
  ): Promise<unknown> {
    if (side === "phone") {
      const from = { key: "phone", name: "this phone" };
      const call = { app, method, input: input ?? null, caller, files };
      return (await this.hub.call(from, call)).value;
    }
    const laptop = this.laptop();
    if (!laptop) throw new Error("the laptop isn't connected");
    const sent: AppFile[] = [];
    for (const f of files) sent.push(await this.sendFile(laptop, app, f));
    return laptop.invoke({ app, method, input: input ?? null, caller, files: sent });
  }

  private async sendFile(laptop: LaptopApps, app: string, f: AppFile): Promise<AppFile> {
    const fs = this.o.files?.fs;
    if (!fs || !f.path) throw new Error("this phone can't send files for apps");
    const { id } = await laptop.upload.begin({ app, name: f.name, size: f.size });
    try {
      for (let at = 0; at < f.size; ) {
        const data = await fs.read(f.path, at, Math.min(READ, f.size - at));
        const n = b64Length(data);
        if (!n) throw new Error(`${f.name} ended early`);
        await laptop.upload.put({ id, data });
        at += n;
      }
      const { ref } = await laptop.upload.finish({ id });
      return { name: f.name, size: f.size, mime: f.mime, path: ref };
    } catch (e) {
      await laptop.upload.cancel({ id }).catch(() => undefined);
      throw e;
    }
  }
}

const b64Length = (b64: string) => {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
};

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * The laptop's app hub: this laptop's Vayu apps link here, and phones (and
 * agents, and other apps) reach them; and from here, the phone's apps.
 *
 * Linking: an app asks (`register`) over the local socket; until you accept
 * it in Darpaṇa it waits, told "waiting". Accepted, the link is kept for
 * good (apps.json) and every paired phone may reach it (`app:<id>`, which
 * Darpaṇa can take back per phone). Refused, it isn't asked about again
 * until you clear that. Unlinking forgets it, its grants and its routes.
 *
 * Routes: a call from a different app (or an agent) than the one it reaches
 * asks you once in Darpaṇa ("Claude wants to use vāgdevī on your phone"):
 * Allow always (remembered), just this once, or refuse. A method marked
 * high risk asks every time. You (ekatva's CLI) and an app's own other half
 * (nāda to nāda) need no route.
 *
 * Files: a call can carry laptop paths; they go to the phone first (its
 * apps.upload), and the call names them. From the phone, files arrive in
 * the app's inbox here (stateDir/apps/<id>/inbox, 0700) and the app gets
 * their paths; files nobody took are deleted after a day.
 *
 * Trust on the laptop: the local socket is this user's alone (0600), and any
 * program running as you can already do what ekatva can. Who asked to link
 * (the program) is shown so you know what you're accepting; it isn't a
 * defence against your own user.
 */
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  APP_CALL_TIMEOUT_MS,
  type AppCall,
  type AppEvent,
  type AppFile,
  type AppFrom,
  AppHub,
  type AppIncoming,
  type AppInfo,
  type AppLinkRecord,
  type AppLinkRequest,
  type AppManifest,
  type AppMethod,
  type AppOutcome,
  type AppReply,
  type AppRoute,
  type AppRouteRequest,
  type AppsState,
  CHUNK,
  type KnownApp,
  type LaptopApp,
  type LocalAppCall,
  type LocalAppEmit,
  parseAddress,
  SHARE_MAX,
  safeName,
} from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";

/** What the hub needs from the rest of the service. */
export interface AppsHooks {
  /** Ask a phone (null: the one connected last). */
  phone(
    device: string | null,
    type: "query" | "mutation",
    path: string,
    input: unknown,
  ): Promise<unknown>;
  /** An app was linked: every phone may reach it. */
  linked(id: string): Promise<void>;
  /** An app was unlinked: no phone may. */
  unlinked(id: string): Promise<void>;
  /** A desktop notification; clicking it opens Darpaṇa's Apps page. */
  notify(title: string, body: string): void;
}

const noHooks: AppsHooks = {
  phone: async () => {
    throw new TRPCError({ code: "NOT_FOUND", message: "no phone is connected" });
  },
  linked: async () => undefined,
  unlinked: async () => undefined,
  notify: () => undefined,
};

/** How long a call waits for your answer to its new route. */
export const ROUTE_WAIT_MS = 60_000;
/** Files nobody took leave an inbox after this. */
const INBOX_KEEP_MS = 24 * 60 * 60 * 1000;
const UPLOAD_STALL_MS = 2 * 60_000;

interface Saved {
  version: 2;
  known: KnownApp[];
  links: AppLinkRecord[];
  refused: string[];
  routes: AppRoute[];
}

interface Waiting {
  request: AppLinkRequest;
  settle: (linked: boolean) => void;
}

interface RouteWait {
  request: AppRouteRequest;
  settle: (answer: "always" | "once" | "refuse") => void;
}

interface Upload {
  app: string;
  path: string;
  name: string;
  size: number;
  got: number;
  at: number;
}

const b64Length = (b64: string) => {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
};
const token = () => randomBytes(12).toString("hex");

export class AppsService {
  private readonly hub: AppHub;
  private saving: Promise<void> = Promise.resolve();
  private links = new Map<string, AppLinkRecord>();
  private refused = new Set<string>();
  private routes: AppRoute[] = [];
  private waiting = new Map<string, Waiting>();
  private routeWaits = new Map<string, RouteWait>();
  private uploads = new Map<string, Upload>();
  /** Finished uploads: ref → the file in an app's inbox. */
  private received = new Map<string, { app: string; file: AppFile; at: number }>();
  private listeners = new Set<() => void>();
  private hooks: AppsHooks = noHooks;

  constructor(
    /** apps.json in the state dir; null keeps nothing (tests). */
    private readonly file: string | null,
    private readonly log: (m: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
    timeoutMs = APP_CALL_TIMEOUT_MS,
    /** Where inboxes live (stateDir/apps); null: a temporary folder. */
    private readonly inboxRoot: string | null = null,
    private readonly routeWaitMs = ROUTE_WAIT_MS,
  ) {
    this.hub = new AppHub({
      side: "laptop",
      now,
      timeoutMs,
      log,
      save: () => this.persist(),
    });
    this.hub.onChange(() => this.changed());
  }

  /** The rest of the service, once it exists. */
  connect(hooks: AppsHooks): void {
    this.hooks = hooks;
  }

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Saved | KnownApp[];
      // Before links (an array of known apps): they ask once more.
      const saved: Saved = Array.isArray(raw)
        ? { version: 2, known: [], links: [], refused: [], routes: [] }
        : raw;
      this.links = new Map(saved.links.map((l) => [l.id, l]));
      this.refused = new Set(saved.refused);
      this.routes = saved.routes ?? [];
      this.hub.restore(saved.known.filter((k) => this.links.has(k.manifest.id)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log(`apps.json: ${e}`);
    }
  }

  /** Something changed (an app came or went, a request, a route): for the window. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }

  // ------------------------------------------------------------- linking
  /**
   * An app asks to link (or, linked, attaches) while the returned stream is
   * read: a status first, then everything for it.
   */
  register(
    manifest: AppManifest,
    signal: AbortSignal | undefined,
    program: string | null,
  ): AsyncIterable<AppIncoming> {
    const self = this;
    return (async function* () {
      if (self.refused.has(manifest.id)) {
        yield { kind: "status", status: "refused", why: "you refused it in Darpaṇa" };
        return;
      }
      if (!self.links.has(manifest.id)) {
        yield {
          kind: "status",
          status: "waiting",
          why: "accept it in Darpaṇa (Apps)",
        } satisfies AppIncoming;
        const linked = await self.ask(manifest, program, signal);
        if (!linked) {
          if (!signal?.aborted)
            yield { kind: "status", status: "refused", why: "you refused it in Darpaṇa" };
          return;
        }
      } else if (program) {
        const l = self.links.get(manifest.id) as AppLinkRecord;
        if (l.program !== program) {
          self.links.set(manifest.id, { ...l, program });
          self.persist();
        }
      }
      yield { kind: "status", status: "linked" };
      yield* self.attached(manifest, signal);
    })();
  }

  /** Waits for your answer in Darpaṇa (or the app going away). */
  private ask(
    manifest: AppManifest,
    program: string | null,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const prev = this.waiting.get(manifest.id);
      // The same app asking again (restarted): the newer one waits instead.
      prev?.settle(false);
      const w: Waiting = {
        request: {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          program,
          at: prev?.request.at ?? this.now(),
          methods: manifest.methods,
          events: manifest.events,
        },
        settle: (linked) => {
          if (this.waiting.get(manifest.id) === w) this.waiting.delete(manifest.id);
          signal?.removeEventListener("abort", gone);
          this.changed();
          resolve(linked);
        },
      };
      const gone = () => w.settle(false);
      signal?.addEventListener("abort", gone, { once: true });
      this.waiting.set(manifest.id, w);
      this.changed();
      if (!prev)
        this.hooks.notify(
          `${manifest.name} wants to link with ekatva`,
          "Click to answer in Darpaṇa (Apps).",
        );
    });
  }

  private attached(
    manifest: AppManifest,
    signal: AbortSignal | undefined,
  ): AsyncIterable<AppIncoming> {
    const queue: AppIncoming[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const detach = this.hub.attach(
      manifest,
      (m) => {
        queue.push(m);
        wake?.();
      },
      () => {
        ended = true;
        wake?.();
      },
    );
    return (async function* () {
      try {
        while (!signal?.aborted && !ended) {
          const next = queue.shift();
          if (next) {
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
        detach();
      }
    })();
  }

  async accept(id: string): Promise<AppOutcomeLike> {
    const w = this.waiting.get(id);
    if (!w) throw new TRPCError({ code: "NOT_FOUND", message: `no app "${id}" is asking` });
    this.links.set(id, { id, name: w.request.name, program: w.request.program, at: this.now() });
    this.refused.delete(id);
    this.persist();
    await this.hooks.linked(id);
    w.settle(true);
    return { value: null, summary: `Linked ${w.request.name}: your phones may reach it` };
  }

  async refuse(id: string): Promise<AppOutcomeLike> {
    const w = this.waiting.get(id);
    this.refused.add(id);
    this.persist();
    w?.settle(false);
    this.changed();
    return { value: null, summary: `Refused the app "${w?.request.name ?? id}"` };
  }

  async unrefuse(id: string): Promise<AppOutcomeLike> {
    this.refused.delete(id);
    this.persist();
    this.changed();
    return { value: null, summary: `The app "${id}" may ask to link again` };
  }

  async unlink(id: string): Promise<AppOutcomeLike> {
    const name = this.links.get(id)?.name ?? id;
    this.links.delete(id);
    this.routes = this.routes.filter((r) => r.caller !== id && !r.to.endsWith(`:${id}`));
    this.hub.forget(id);
    this.persist();
    await this.hooks.unlinked(id);
    this.changed();
    return { value: null, summary: `Unlinked ${name}` };
  }

  /** Whether an app is linked here. */
  isLinked(id: string): boolean {
    return this.links.has(id);
  }

  // -------------------------------------------------------------- routes
  /** Allowed without asking: you, an app's own other half, or a route you allowed always. */
  private routeAllowed(caller: string, to: string, method: AppMethod): boolean {
    if (caller === "you") return true;
    const { app } = parseAddress(to);
    if (caller === app) return true;
    if (method.risk === "high") return false;
    return this.routes.some((r) => r.caller === caller && r.to === to);
  }

  /** Asks you about a new route in Darpaṇa; throws if you refuse (or don't answer in a minute). */
  async checkRoute(
    caller: string,
    to: string,
    toName: string,
    method: AppMethod,
    files: { name: string; size: number }[],
  ): Promise<void> {
    if (this.routeAllowed(caller, to, method)) return;
    const callerName = caller.startsWith("agent:")
      ? caller.slice(6)
      : (this.links.get(caller)?.name ?? caller);
    const id = token();
    const request: AppRouteRequest = {
      id,
      caller,
      callerName,
      to,
      toName,
      method: method.name,
      why: method.why,
      risk: method.risk,
      files,
      at: this.now(),
    };
    const answer = await new Promise<"always" | "once" | "refuse">((resolve) => {
      const timer = setTimeout(() => settle("refuse"), this.routeWaitMs);
      const settle = (a: "always" | "once" | "refuse") => {
        clearTimeout(timer);
        if (!this.routeWaits.delete(id)) return;
        this.changed();
        resolve(a);
      };
      this.routeWaits.set(id, { request, settle });
      this.changed();
      const where = to.startsWith("phone:") ? "on your phone" : "on this laptop";
      this.hooks.notify(
        `${callerName} wants to use ${toName} ${where}`,
        `${method.why}. Click to answer in Darpaṇa (Apps).`,
      );
    });
    if (answer === "refuse")
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `you didn't let ${callerName} use ${toName} (Darpaṇa, Apps)`,
      });
    if (answer === "always" && method.risk !== "high") {
      this.routes = [
        ...this.routes.filter((r) => !(r.caller === caller && r.to === to)),
        { caller, to, at: this.now() },
      ];
      this.persist();
    }
  }

  async decideRoute(id: string, answer: "always" | "once" | "refuse"): Promise<AppOutcomeLike> {
    const w = this.routeWaits.get(id);
    if (!w)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "that request is gone (it waited a minute)",
      });
    w.settle(answer);
    const r = w.request;
    const said = answer === "always" ? "always" : answer === "once" ? "this once" : "not";
    return { value: null, summary: `${r.callerName} may ${said} use ${r.toName} (${r.to})` };
  }

  async removeRoute(caller: string, to: string): Promise<AppOutcomeLike> {
    this.routes = this.routes.filter((r) => !(r.caller === caller && r.to === to));
    this.persist();
    this.changed();
    return { value: null, summary: `${caller} may no longer use ${to} without asking` };
  }

  /** The Apps page's requests and routes. */
  state(): AppsState {
    return {
      requests: [...this.waiting.values()].map((w) => w.request).sort((a, b) => a.at - b.at),
      routeRequests: [...this.routeWaits.values()]
        .map((w) => w.request)
        .sort((a, b) => a.at - b.at),
      refused: [...this.refused].sort(),
      routes: [...this.routes],
    };
  }

  // ------------------------------------------------------- calls from here
  /** A call from this laptop (you, an agent, an app) to an app on either side. */
  async call(c: LocalAppCall): Promise<AppOutcome<unknown>> {
    const { side, app } = parseAddress(c.to);
    const files = await Promise.all(c.files.map((p) => this.describe(p)));
    if (side === "laptop") {
      const m = this.manifestOf(app);
      const method = methodOf(m, c.method);
      await this.checkRoute(c.caller, c.to, m.name, method, files);
      return this.hub.call(
        { key: "local", name: "this laptop" },
        { app, method: c.method, input: c.input, caller: c.caller, files },
      );
    }
    const phoneApp = (await this.phoneApps(c.device)).find((a) => a.id === app);
    if (!phoneApp)
      throw new TRPCError({ code: "NOT_FOUND", message: `there's no app "${app}" on the phone` });
    const method = phoneApp.methods.find((x) => x.name === c.method);
    if (!method)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `${phoneApp.name} has no "${c.method}" on the phone`,
      });
    await this.checkRoute(c.caller, c.to, phoneApp.name, method, files);
    const sent: AppFile[] = [];
    for (const f of files) sent.push({ ...f, path: await this.sendFile(c.device, app, f) });
    const call = { app, method: c.method, input: c.input, caller: c.caller, files: sent };
    const value = await this.hooks.phone(c.device, "mutation", "apps.invoke", call);
    const who = c.caller === app ? "" : `${c.caller.replace(/^agent:/, "")} → `;
    const names = files.length ? ` (${files.map((f) => f.name).join(", ")})` : "";
    return {
      value,
      summary: `${who}${phoneApp.name} (phone): ${c.method}${names}`,
      log: method.log,
    };
  }

  async emit(e: LocalAppEmit): Promise<null> {
    const { side, app } = parseAddress(e.to);
    if (side === "laptop") {
      const m = this.manifestOf(app);
      const event = m.events.find((x) => x.name === e.name);
      if (!event)
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `${m.name} takes no "${e.name}" on the laptop`,
        });
      await this.checkRoute(e.caller, e.to, m.name, event, []);
      await this.hub.emit(
        { key: "local", name: "this laptop", app: e.caller },
        { app, name: e.name, data: e.data, keep: e.keep },
      );
      return null;
    }
    const phoneApp = (await this.phoneApps(e.device)).find((a) => a.id === app);
    const event = phoneApp?.events.find((x) => x.name === e.name);
    if (phoneApp && event) await this.checkRoute(e.caller, e.to, phoneApp.name, event, []);
    await this.hooks.phone(e.device, "mutation", "apps.emit", {
      app,
      name: e.name,
      data: e.data,
      keep: e.keep,
    });
    return null;
  }

  phoneApps(device: string | null): Promise<AppInfo[]> {
    return this.hooks.phone(device, "query", "apps.list", undefined) as Promise<AppInfo[]>;
  }

  private manifestOf(id: string): AppManifest {
    const a = this.hub.apps().find((x) => x.manifest.id === id);
    if (!a || !this.links.has(id))
      throw new TRPCError({ code: "NOT_FOUND", message: `there's no app "${id}" on the laptop` });
    return a.manifest;
  }

  private async describe(path: string): Promise<AppFile & { path: string }> {
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(path);
    } catch {
      throw new TRPCError({ code: "NOT_FOUND", message: `no file ${path}` });
    }
    if (!s.isFile()) throw new TRPCError({ code: "BAD_REQUEST", message: `${path} isn't a file` });
    if (s.size > SHARE_MAX)
      throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: `${basename(path)} is over 4 GB` });
    return { name: basename(path), size: s.size, mime: mimeOf(path), path };
  }

  /** A file to the phone ahead of a call (its apps.upload): the phone's ref for it. */
  private async sendFile(
    device: string | null,
    app: string,
    f: AppFile & { path?: string },
  ): Promise<string> {
    const { id } = (await this.hooks.phone(device, "mutation", "apps.upload.begin", {
      app,
      name: f.name,
      size: f.size,
    })) as { id: string };
    try {
      const stream = createReadStream(f.path as string, { highWaterMark: CHUNK });
      for await (const chunk of stream)
        await this.hooks.phone(device, "mutation", "apps.upload.put", {
          id,
          data: (chunk as Buffer).toString("base64"),
        });
      const { ref } = (await this.hooks.phone(device, "mutation", "apps.upload.finish", {
        id,
      })) as {
        ref: string;
      };
      return ref;
    } catch (e) {
      await this.hooks
        .phone(device, "mutation", "apps.upload.cancel", { id })
        .catch(() => undefined);
      throw e;
    }
  }

  // -------------------------------------------------------- calls to here
  list(granted: (id: string) => boolean): AppInfo[] {
    return this.hub.list(granted).filter((a) => this.links.has(a.id));
  }

  /** Every linked app, for this laptop's window: with the phones granted each. */
  laptopApps(grantedTo: (id: string) => string[]): LaptopApp[] {
    return this.hub
      .apps()
      .filter(({ manifest: m }) => this.links.has(m.id))
      .map(({ manifest: m, online, seen }) => ({
        id: m.id,
        name: m.name,
        version: m.version,
        side: "laptop",
        online,
        granted: false,
        methods: m.methods,
        events: m.events,
        grantedTo: grantedTo(m.id),
        seen,
        program: this.links.get(m.id)?.program ?? null,
      }));
  }

  /** A phone's call (its route was checked on the phone): its files' refs become inbox paths. */
  async phoneCall(from: AppFrom, c: AppCall): Promise<AppOutcome<unknown>> {
    if (!this.links.has(c.app))
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `there's no app "${c.app}" on the laptop`,
      });
    const files = (c.files ?? []).map((f) => {
      const got = f.path ? this.received.get(f.path) : undefined;
      if (!got || got.app !== c.app)
        throw new TRPCError({ code: "BAD_REQUEST", message: `the file ${f.name} didn't arrive` });
      this.received.delete(f.path as string);
      return got.file;
    });
    return this.hub.call(from, { ...c, files });
  }

  async phoneEmit(from: AppFrom, e: AppEvent): Promise<AppOutcome<null>> {
    if (!this.links.has(e.app))
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `there's no app "${e.app}" on the laptop`,
      });
    return this.hub.emit(from, e);
  }

  async reply(r: AppReply): Promise<void> {
    this.hub.reply(r);
  }

  // ------------------------------------------------- files from the phone
  private async inbox(app: string): Promise<string> {
    const root =
      this.inboxRoot ?? join(process.env.TMPDIR ?? "/tmp", `ekatva-apps-${process.getuid?.()}`);
    const dir = join(root, app, "inbox");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  readonly upload = {
    begin: async (
      app: string,
      name: string,
      size: number,
      _from: string,
    ): Promise<{ id: string }> => {
      if (!this.links.has(app))
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `there's no app "${app}" on the laptop`,
        });
      if (size > SHARE_MAX)
        throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "over 4 GB" });
      await this.sweep();
      const dir = await this.inbox(app);
      const safe = safeName(name);
      const path = join(dir, `${token().slice(0, 8)}-${safe}`);
      await writeFile(path, "", { mode: 0o600 });
      const id = token();
      this.uploads.set(id, { app, path, name: safe, size, got: 0, at: this.now() });
      return { id };
    },
    put: async (id: string, data: string): Promise<void> => {
      const u = this.uploads.get(id);
      if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "no such upload (it timed out?)" });
      const n = b64Length(data);
      if (u.got + n > u.size) {
        await this.upload.cancel(id);
        throw new TRPCError({ code: "BAD_REQUEST", message: "more data than announced" });
      }
      await appendFile(u.path, Buffer.from(data, "base64"));
      u.got += n;
      u.at = this.now();
    },
    finish: async (id: string): Promise<{ ref: string }> => {
      const u = this.uploads.get(id);
      if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "no such upload (it timed out?)" });
      this.uploads.delete(id);
      if (u.got !== u.size) {
        await rm(u.path, { force: true });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `incomplete: ${u.got} of ${u.size} bytes`,
        });
      }
      const ref = token();
      this.received.set(ref, {
        app: u.app,
        file: { name: u.name, size: u.size, mime: mimeOf(u.name), path: u.path },
        at: this.now(),
      });
      return { ref };
    },
    cancel: async (id: string): Promise<void> => {
      const u = this.uploads.get(id);
      if (!u) return;
      this.uploads.delete(id);
      await rm(u.path, { force: true });
    },
  };

  /** Stalled uploads, refs never used, and files left in inboxes over a day: gone. */
  private async sweep(): Promise<void> {
    const now = this.now();
    for (const [id, u] of this.uploads)
      if (now - u.at > UPLOAD_STALL_MS) await this.upload.cancel(id);
    for (const [ref, r] of this.received) if (now - r.at > INBOX_KEEP_MS) this.received.delete(ref);
    const root = this.inboxRoot;
    if (!root) return;
    for (const app of await readdir(root).catch(() => [] as string[])) {
      const dir = join(root, app, "inbox");
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        const p = join(dir, f);
        const s = await stat(p).catch(() => null);
        if (s && now - s.mtimeMs > INBOX_KEEP_MS) await rm(p, { force: true });
      }
    }
  }

  // ------------------------------------------------------------ keeping
  private persist(): void {
    const saved: Saved = {
      version: 2,
      known: this.hub
        .apps()
        .filter((a) => this.links.has(a.manifest.id))
        .map((a) => ({ manifest: a.manifest, seen: a.seen ?? this.now() })),
      links: [...this.links.values()],
      refused: [...this.refused],
      routes: this.routes,
    };
    this.saving = this.saving.then(() => this.write(saved));
    this.changed();
  }

  /** Written (tests wait for it). */
  flushed(): Promise<void> {
    return this.saving;
  }

  private async write(saved: Saved): Promise<void> {
    if (!this.file) return;
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(saved, null, 1), { mode: 0o600 });
      await rename(tmp, this.file);
    } catch (e) {
      this.log(`apps.json: ${e}`);
    }
  }

  /** The service is stopping: every app's stream ends, every call in flight fails. */
  shutdown(): void {
    for (const w of this.waiting.values()) w.settle(false);
    for (const w of this.routeWaits.values()) w.settle("refuse");
    this.hub.shutdown("the laptop's service stopped");
  }
}

type AppOutcomeLike = { value: null; summary: string };

function methodOf(m: AppManifest, name: string): AppMethod {
  const method = m.methods.find((x) => x.name === name);
  if (!method)
    throw new TRPCError({ code: "NOT_FOUND", message: `${m.name} has no "${name}" on the laptop` });
  return method;
}

const MIME: Record<string, string> = {
  epub: "application/epub+zip",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
  apk: "application/vnd.android.package-archive",
};
export function mimeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

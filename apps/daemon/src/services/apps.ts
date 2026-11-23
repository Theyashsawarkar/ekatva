/**
 * The laptop's side of the app hub: this laptop's Vayu apps register here
 * (over the local socket, as their own user), and phones reach them through
 * the link.
 *
 * - An app is registered while its `apps.register` subscription lasts; a new
 *   registration under the same id replaces the old one (a restarted app
 *   whose old connection hasn't closed yet).
 * - A call waits for the app's `apps.reply` up to 15 s; an app that stops
 *   fails its calls in flight at once, in words ("nāda stopped on the laptop").
 * - An event for an app that isn't there is dropped, or kept for `keep`
 *   seconds (at most a day, 200 per app) and delivered when it registers.
 * - Every device has a rate limit per app (the manifest's `rate` a minute).
 * - Apps seen once are remembered (apps.json), so you can grant one to a
 *   phone while it isn't running.
 *
 * Trust on the laptop: the local socket is this user's alone (0600), and any
 * program running as you can already do anything ekatva can. So a laptop
 * app is trusted as you are; what a *phone* may reach is the `app:<id>`
 * grant, checked by the router before anything here runs.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  APP_BODY_MAX,
  APP_CALL_TIMEOUT_MS,
  APP_KEEP_MAX,
  type AppCall,
  type AppEvent,
  type AppFrom,
  type AppIncoming,
  type AppInfo,
  type AppManifest,
  type AppOutcome,
  type AppReply,
  bodySize,
  type LaptopApp,
} from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";

/** At most this many apps registered at once. */
const MAX_APPS = 32;

interface Registration {
  manifest: AppManifest;
  push: (m: AppIncoming) => void;
  end: () => void;
}

interface Pending {
  app: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Kept {
  from: AppFrom;
  name: string;
  data: unknown;
  at: number;
  until: number;
}

interface Known {
  manifest: AppManifest;
  seen: number;
}

export class AppsService {
  private live = new Map<string, Registration>();
  private known = new Map<string, Known>();
  private pending = new Map<string, Pending>();
  private kept = new Map<string, Kept[]>();
  private recent = new Map<string, number[]>();
  private listeners = new Set<() => void>();

  constructor(
    /** apps.json in the state dir; null keeps nothing (tests). */
    private readonly file: string | null,
    private readonly log: (m: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs = APP_CALL_TIMEOUT_MS,
  ) {}

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as Known[];
      for (const k of raw) this.known.set(k.manifest.id, k);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.log(`apps.json: ${e}`);
    }
  }

  /** Something changed (an app came or went): for the window. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }

  private nameOf(id: string): string {
    return this.live.get(id)?.manifest.name ?? this.known.get(id)?.manifest.name ?? id;
  }

  // ------------------------------------------------- the laptop's own apps
  /** Registered while the returned stream is read; everything for the app arrives on it. */
  register(manifest: AppManifest, signal: AbortSignal | undefined): AsyncIterable<AppIncoming> {
    if (!this.live.has(manifest.id) && this.live.size >= MAX_APPS)
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `at most ${MAX_APPS} apps` });
    const queue: AppIncoming[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const reg: Registration = {
      manifest,
      push: (m) => {
        queue.push(m);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    };
    // A restarted app replaces its old registration.
    const old = this.live.get(manifest.id);
    if (old) old.end();
    this.live.set(manifest.id, reg);
    this.known.set(manifest.id, { manifest, seen: this.now() });
    void this.save();
    this.log(`${manifest.name} (${manifest.id} ${manifest.version}) registered`);
    // What waited for it.
    for (const k of this.takeKept(manifest.id))
      queue.push({ kind: "event", from: k.from, name: k.name, data: k.data, at: k.at });
    this.changed();

    const self = this;
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
        if (self.live.get(manifest.id) === reg) {
          self.live.delete(manifest.id);
          self.failPending(manifest.id, `${manifest.name} stopped on the laptop`);
          self.log(`${manifest.name} unregistered`);
          self.changed();
        }
      }
    })();
  }

  /** An app's answer; a late one (its call already timed out) is ignored. */
  async reply(r: AppReply): Promise<void> {
    const p = this.pending.get(r.id);
    if (!p) return;
    this.pending.delete(r.id);
    clearTimeout(p.timer);
    if (!r.ok) {
      p.reject(new TRPCError({ code: "BAD_REQUEST", message: r.error }));
      return;
    }
    if (bodySize(r.result) > APP_BODY_MAX) {
      p.reject(
        new TRPCError({
          code: "PAYLOAD_TOO_LARGE",
          message: `${this.nameOf(p.app)}'s answer is over 1 MB: send big things through share`,
        }),
      );
      return;
    }
    p.resolve(r.result);
  }

  private failPending(app: string, why: string): void {
    for (const [id, p] of this.pending) {
      if (p.app !== app) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new TRPCError({ code: "NOT_FOUND", message: why }));
    }
  }

  // ------------------------------------------------------- what phones reach
  list(granted: (id: string) => boolean): AppInfo[] {
    return this.all().map((m) => this.info(m, granted(m.id)));
  }

  /** Every app, for this laptop's window: with the phones granted each. */
  laptopApps(grantedTo: (id: string) => string[]): LaptopApp[] {
    return this.all().map((m) => ({
      ...this.info(m, false),
      grantedTo: grantedTo(m.id),
      seen: this.known.get(m.id)?.seen ?? null,
    }));
  }

  private all(): AppManifest[] {
    const ids = new Set([...this.known.keys(), ...this.live.keys()]);
    return [...ids]
      .map((id) => this.live.get(id)?.manifest ?? (this.known.get(id) as Known).manifest)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private info(m: AppManifest, granted: boolean): AppInfo {
    return {
      id: m.id,
      name: m.name,
      version: m.version,
      side: "laptop",
      online: this.live.has(m.id),
      granted,
      methods: m.methods,
      events: m.events,
    };
  }

  async call(from: AppFrom, c: AppCall): Promise<AppOutcome<unknown>> {
    const reg = this.reach(c.app);
    const method = reg.manifest.methods.find((m) => m.name === c.method);
    if (!method)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `${reg.manifest.name} has no "${c.method}" on the laptop`,
      });
    this.limit(from.key, reg.manifest);
    this.fits(c.input, reg.manifest.name);
    const id = randomBytes(9).toString("base64url");
    const value = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new TRPCError({
            code: "TIMEOUT",
            message: `${reg.manifest.name} didn't answer in ${Math.round(this.timeoutMs / 1000)} s`,
          }),
        );
      }, this.timeoutMs);
      this.pending.set(id, { app: c.app, resolve, reject, timer });
      reg.push({ kind: "call", id, from, method: c.method, input: c.input ?? null });
    });
    return { value, summary: `${reg.manifest.name}: ${c.method}`, log: method.log };
  }

  async emit(from: AppFrom, e: AppEvent): Promise<AppOutcome<null>> {
    const reg = this.live.get(e.app);
    const manifest = reg?.manifest ?? this.known.get(e.app)?.manifest;
    if (!manifest)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `there's no app "${e.app}" on the laptop`,
      });
    const event = manifest.events.find((m) => m.name === e.name);
    if (!event)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `${manifest.name} takes no "${e.name}" on the laptop`,
      });
    this.limit(from.key, manifest);
    this.fits(e.data, manifest.name);
    const summary = `${manifest.name}: ${e.name}`;
    if (reg) {
      reg.push({ kind: "event", from, name: e.name, data: e.data ?? null, at: this.now() });
      return { value: null, summary, log: event.log };
    }
    if (!e.keep)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `${manifest.name} isn't running on the laptop`,
      });
    const list = this.kept.get(e.app) ?? [];
    list.push({
      from,
      name: e.name,
      data: e.data ?? null,
      at: this.now(),
      until: this.now() + e.keep * 1000,
    });
    while (list.length > APP_KEEP_MAX) list.shift();
    this.kept.set(e.app, list);
    return { value: null, summary: `${summary} (kept until it runs)`, log: event.log };
  }

  /** The app, registered now; else why not, in words. */
  private reach(id: string): Registration {
    const reg = this.live.get(id);
    if (reg) return reg;
    const known = this.known.get(id);
    throw new TRPCError({
      code: "NOT_FOUND",
      message: known
        ? `${known.manifest.name} isn't running on the laptop`
        : `there's no app "${id}" on the laptop`,
    });
  }

  private limit(device: string, m: AppManifest): void {
    const key = `${device}/${m.id}`;
    const now = this.now();
    const times = (this.recent.get(key) ?? []).filter((t) => now - t < 60_000);
    if (times.length >= m.rate)
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `too many requests for ${m.name}: at most ${m.rate} a minute`,
      });
    times.push(now);
    this.recent.set(key, times);
  }

  private fits(body: unknown, name: string): void {
    if (bodySize(body) > APP_BODY_MAX)
      throw new TRPCError({
        code: "PAYLOAD_TOO_LARGE",
        message: `that's over 1 MB for ${name}: send big things through share`,
      });
  }

  private takeKept(id: string): Kept[] {
    const list = this.kept.get(id) ?? [];
    this.kept.delete(id);
    const now = this.now();
    return list.filter((k) => k.until > now);
  }

  private async save(): Promise<void> {
    if (!this.file) return;
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.known.values()], null, 1), { mode: 0o600 });
      await rename(tmp, this.file);
    } catch (e) {
      this.log(`apps.json: ${e}`);
    }
  }

  /** The service is stopping: every app's stream ends, every call in flight fails. */
  shutdown(): void {
    for (const [id, reg] of this.live) {
      reg.end();
      this.failPending(id, "the laptop's service stopped");
    }
  }
}

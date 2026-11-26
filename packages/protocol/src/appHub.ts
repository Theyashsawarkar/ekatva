/**
 * One side's app hub (the laptop's or the phone's): the apps on this device,
 * and how the other device reaches them. The same rules on both sides:
 *
 * - An app is attached while it's connected; attaching again under the same
 *   id replaces the old one (a restarted app whose old connection lingers).
 * - A call waits for the app's reply up to 15 s; an app that goes fails its
 *   calls in flight at once, in words ("nāda stopped on the laptop").
 * - An event for an app that isn't there is dropped, or kept for `keep`
 *   seconds (at most a day, 200 per app) and handed over when it attaches.
 * - Every device has a rate limit per app (the manifest's `rate` a minute),
 *   and bodies are at most 1 MB.
 * - Apps seen once are remembered (`known`): the caller saves them, so a
 *   device can be granted an app that isn't running.
 *
 * Who may reach an app is decided before anything here runs (the router's
 * grant checks); this only routes. Portable JS: it runs in Node and on the
 * phone.
 */
import { TRPCError } from "@trpc/server";
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
} from "./apps.js";

/** An app seen once, remembered across restarts. */
export interface KnownApp {
  manifest: AppManifest;
  seen: number;
}

export interface AppHubOptions {
  side: "laptop" | "phone";
  now?: () => number;
  timeoutMs?: number;
  log?: (m: string) => void;
  /** At most this many apps attached at once. */
  maxApps?: number;
  /** The remembered apps changed: save them. */
  save?: (known: KnownApp[]) => void;
}

interface Attached {
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

export class AppHub {
  private live = new Map<string, Attached>();
  private known = new Map<string, KnownApp>();
  private pending = new Map<string, Pending>();
  private kept = new Map<string, Kept[]>();
  private recent = new Map<string, number[]>();
  private listeners = new Set<() => void>();
  private ids = 0;
  private readonly side: "laptop" | "phone";
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly log: (m: string) => void;
  private readonly maxApps: number;
  private readonly save: (known: KnownApp[]) => void;

  constructor(o: AppHubOptions) {
    this.side = o.side;
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? APP_CALL_TIMEOUT_MS;
    this.log = o.log ?? (() => undefined);
    this.maxApps = o.maxApps ?? 32;
    this.save = o.save ?? (() => undefined);
  }

  /** The apps remembered from before (loaded by the caller). */
  restore(known: KnownApp[]): void {
    for (const k of known) if (k?.manifest?.id) this.known.set(k.manifest.id, k);
  }

  /** Something changed (an app came or went). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }

  private on(): string {
    return `on the ${this.side}`;
  }

  /** Whether an app is attached now. */
  online(id: string): boolean {
    return this.live.has(id);
  }

  /**
   * Attach an app: everything for it goes to `push` until `detach` (or a
   * newer attach of the same id, which calls `end`). Kept events arrive first.
   */
  attach(manifest: AppManifest, push: (m: AppIncoming) => void, end: () => void): () => void {
    if (!this.live.has(manifest.id) && this.live.size >= this.maxApps)
      throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `at most ${this.maxApps} apps` });
    const reg: Attached = { manifest, push, end };
    const old = this.live.get(manifest.id);
    this.live.set(manifest.id, reg);
    old?.end();
    this.known.set(manifest.id, { manifest, seen: this.now() });
    this.save([...this.known.values()]);
    this.log(`${manifest.name} (${manifest.id} ${manifest.version}) attached`);
    for (const k of this.takeKept(manifest.id))
      push({ kind: "event", from: k.from, name: k.name, data: k.data, at: k.at });
    this.changed();
    return () => {
      if (this.live.get(manifest.id) !== reg) return;
      this.live.delete(manifest.id);
      this.failPending(manifest.id, `${manifest.name} stopped ${this.on()}`);
      this.log(`${manifest.name} detached`);
      this.changed();
    };
  }

  /** An app's answer; a late one (its call already timed out) is ignored. */
  reply(r: AppReply): void {
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

  private nameOf(id: string): string {
    return this.live.get(id)?.manifest.name ?? this.known.get(id)?.manifest.name ?? id;
  }

  /** Every app, online or remembered, by name. */
  apps(): { manifest: AppManifest; online: boolean; seen: number | null }[] {
    const ids = new Set([...this.known.keys(), ...this.live.keys()]);
    return [...ids]
      .map((id) => ({
        manifest: this.live.get(id)?.manifest ?? (this.known.get(id) as KnownApp).manifest,
        online: this.live.has(id),
        seen: this.known.get(id)?.seen ?? null,
      }))
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  }

  /** The apps, as the other device sees them. */
  list(granted: (id: string) => boolean): AppInfo[] {
    return this.apps().map(({ manifest: m, online }) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      side: this.side,
      online,
      granted: granted(m.id),
      methods: m.methods,
      events: m.events,
    }));
  }

  /** Forget an app (its approval was taken back): it goes from the list. */
  forget(id: string): void {
    const reg = this.live.get(id);
    this.live.delete(id);
    reg?.end();
    this.failPending(id, `${this.nameOf(id)} was removed ${this.on()}`);
    this.known.delete(id);
    this.kept.delete(id);
    this.save([...this.known.values()]);
    this.changed();
  }

  async call(from: AppFrom, c: AppCall): Promise<AppOutcome<unknown>> {
    const reg = this.reach(c.app);
    const method = reg.manifest.methods.find((m) => m.name === c.method);
    if (!method)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `${reg.manifest.name} has no "${c.method}" ${this.on()}`,
      });
    this.limit(from.key, reg.manifest);
    this.fits(c.input, reg.manifest.name);
    const id = `${this.now().toString(36)}-${(++this.ids).toString(36)}`;
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
      try {
        reg.push({
          kind: "call",
          id,
          from: c.caller ? { ...from, app: c.caller } : from,
          method: c.method,
          input: c.input ?? null,
          files: c.files ?? [],
        });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new TRPCError({
            code: "NOT_FOUND",
            message: `${reg.manifest.name} can't be reached ${this.on()} (${(e as Error).message})`,
          }),
        );
      }
    });
    return { value, summary: callSummary(reg.manifest, c), log: method.log };
  }

  async emit(from: AppFrom, e: AppEvent): Promise<AppOutcome<null>> {
    const reg = this.live.get(e.app);
    const manifest = reg?.manifest ?? this.known.get(e.app)?.manifest;
    if (!manifest)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `there's no app "${e.app}" ${this.on()}`,
      });
    const event = manifest.events.find((m) => m.name === e.name);
    if (!event)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `${manifest.name} takes no "${e.name}" ${this.on()}`,
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
        message: `${manifest.name} isn't running ${this.on()}`,
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

  /** The app, attached now; else why not, in words. */
  private reach(id: string): Attached {
    const reg = this.live.get(id);
    if (reg) return reg;
    const known = this.known.get(id);
    throw new TRPCError({
      code: "NOT_FOUND",
      message: known
        ? `${known.manifest.name} isn't running ${this.on()}`
        : `there's no app "${id}" ${this.on()}`,
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

  /** Stopping: every app is let go, every call in flight fails. */
  shutdown(why: string): void {
    for (const [id, reg] of [...this.live]) {
      this.live.delete(id);
      reg.end();
      this.failPending(id, why);
    }
  }
}

/** "nāda: play", or for a route "claude → vāgdevī: addBook (Monsoon Letters.epub)". */
export function callSummary(m: AppManifest, c: AppCall): string {
  const who = c.caller && c.caller !== m.id ? `${c.caller.replace(/^agent:/, "")} → ` : "";
  const files = c.files?.length ? ` (${c.files.map((f) => f.name).join(", ")})` : "";
  return `${who}${m.name}: ${c.method}${files}`;
}

/**
 * A phone app's link to ekatva, and through it to its own half on the
 * laptop. No Expo here (index.ts gives it the native side), so it's tested
 * with a fake one.
 */

export interface Method {
  name: string;
  /** Why the app wants it, shown when you allow the app and grant it to a phone. */
  why: string;
  risk?: "low" | "medium" | "high";
  /** Write it in the action log (false for reads polled often, like "status"). */
  log?: boolean;
}

export interface Manifest {
  /** "nada": the same id as the app's laptop half. */
  id: string;
  name: string;
  version: string;
  /** What the laptop may call on this app. */
  methods?: Method[];
  /** Events this app takes from the laptop. */
  events?: Method[];
  rate?: number;
}

/**
 * not-installed  ekatva isn't on this phone
 * connecting     binding to it
 * waiting        ekatva is there but not open (locked): open it once
 * unlinked       not linked yet: call link() from your settings ("Link with ekatva")
 * pending        you haven't answered yet: ekatva shows the question
 * allowed        connected: calls go through (when the laptop is linked)
 * denied         you said no (remove it in ekatva's Settings, Apps, then link again)
 * refused        not the app you allowed (signed differently), or a bad manifest
 * disconnected   ekatva went away; it comes back by itself
 */
export type Status =
  | "not-installed"
  | "connecting"
  | "waiting"
  | "unlinked"
  | "pending"
  | "allowed"
  | "denied"
  | "refused"
  | "disconnected";

export interface From {
  key: string;
  name: string;
  /** The calling app or agent on that device ("agent:claude"), if it wasn't this app's own half. */
  app?: string;
}

/** A file that came with a call: this app's own copy. */
export interface LinkFile {
  name: string;
  size: number;
  mime: string;
  uri: string;
}

export interface CallOptions {
  /** "laptop:APP" or "phone:APP" (default: this app's laptop half). Another app asks you once. */
  to?: string;
  /** Files to send along: paths, file:// or content:// URIs. */
  files?: string[];
}

type Handler = (input: unknown, from: From, files: LinkFile[]) => unknown | Promise<unknown>;

/** The native side (Android); null where there is none. */
export interface Native {
  installed(): boolean;
  connect(manifest: string): boolean;
  send(what: "call" | "emit" | "status" | "reply", json: string): boolean;
  callWithFiles(json: string, files: string[]): boolean;
  disconnect(): void;
  addListener(
    event: "onWelcome" | "onResult" | "onIncoming" | "onDisconnect",
    cb: (e: { json?: string; why?: string }) => void,
  ): { remove(): void };
}

export interface EkatvaLink {
  status(): Status;
  /** Why, in words, when it isn't "allowed" (or null). */
  why(): string | null;
  /** Every status change; returns a function that stops listening. */
  onStatus(cb: (s: Status, why: string | null) => void): () => void;
  /** Ask to link with ekatva (your "Link with ekatva" button): ekatva asks you, once. */
  link(): void;
  /** Call this app's laptop half (or another app: `to`). Rejects with the reason in words. */
  call(method: string, input?: unknown, opts?: CallOptions): Promise<unknown>;
  /** An event for the laptop half; `keep` seconds holds it until that app runs there. */
  emit(name: string, data?: unknown, keep?: number): Promise<void>;
  /** Which laptop is linked, and this app's half there (null when not linked or not there). */
  laptop(): Promise<{ laptop: string | null; app: { online: boolean; granted: boolean } | null }>;
  /** Answer the laptop's calls to `method`. */
  on(method: string, handler: Handler): EkatvaLink;
  onEvent(name: string, handler: (data: unknown, from: From, at: number) => void): EkatvaLink;
  close(): void;
}

const FILES_TIMEOUT_MS = 10 * 60_000;

const parse = (json: string | undefined): Record<string, unknown> => {
  try {
    const v = JSON.parse(json ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

export function createLink(
  native: Native | null,
  manifest: Manifest,
  timeoutMs = 20_000,
): EkatvaLink {
  let status: Status = "connecting";
  let why: string | null = null;
  let ids = 0;
  const statusCbs = new Set<(s: Status, why: string | null) => void>();
  const pending = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const handlers = new Map<string, Handler>();
  const events = new Map<string, (data: unknown, from: From, at: number) => void>();
  const subs: { remove(): void }[] = [];

  const set = (s: Status, w: string | null = null) => {
    status = s;
    why = w;
    for (const cb of statusCbs) cb(s, w);
    if (s !== "allowed") failAll(w ?? reasonOf(s));
  };
  const failAll = (reason: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      pending.delete(id);
    }
  };

  if (!native?.installed()) {
    status = "not-installed";
    why = "ekatva isn't on this phone";
  } else {
    subs.push(
      native.addListener("onWelcome", (e) => {
        const w = parse(e.json);
        const s = String(w.status ?? "refused");
        const known = ["waiting", "unlinked", "pending", "allowed", "denied", "refused"];
        set(
          (s === "replaced" ? "disconnected" : known.includes(s) ? s : "refused") as Status,
          typeof w.why === "string" ? w.why : null,
        );
      }),
      native.addListener("onResult", (e) => {
        const r = parse(e.json);
        const p = pending.get(String(r.id));
        if (!p) return;
        pending.delete(String(r.id));
        clearTimeout(p.timer);
        if (r.ok) p.resolve(r.result ?? null);
        else p.reject(new Error(String(r.error ?? "failed")));
      }),
      native.addListener("onIncoming", (e) => void incoming(parse(e.json))),
      native.addListener("onDisconnect", (e) => set("disconnected", e.why ?? "ekatva stopped")),
    );
    if (!native.connect(JSON.stringify(manifest))) set("not-installed", "can't reach ekatva");
  }

  async function incoming(m: Record<string, unknown>) {
    const from = (m.from ?? { key: "", name: "the laptop" }) as From;
    if (m.kind === "event") {
      events.get(String(m.name))?.(m.data ?? null, from, Number(m.at) || Date.now());
      return;
    }
    if (m.kind !== "call") return;
    const h = handlers.get(String(m.method));
    let reply: Record<string, unknown>;
    try {
      if (!h) throw new Error(`${manifest.name} doesn't answer "${m.method}" yet`);
      reply = {
        id: m.id,
        ok: true,
        result: (await h(m.input ?? null, from, (m.files ?? []) as LinkFile[])) ?? null,
      };
    } catch (e) {
      reply = { id: m.id, ok: false, error: ((e as Error).message || "failed").slice(0, 500) };
    }
    native?.send("reply", JSON.stringify(reply));
  }

  const request = (
    what: "call" | "emit" | "status",
    body: Record<string, unknown>,
    files: string[] = [],
  ) =>
    new Promise<unknown>((resolve, reject) => {
      if (!native || status === "not-installed") return reject(new Error(why ?? reasonOf(status)));
      if (status !== "allowed") return reject(new Error(why ?? reasonOf(status)));
      const id = `${Date.now().toString(36)}-${(++ids).toString(36)}`;
      // Files take as long as the link does; a new route waits for you.
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error("ekatva didn't answer"));
        },
        files.length ? FILES_TIMEOUT_MS : body.to ? Math.max(timeoutMs, 90_000) : timeoutMs,
      );
      pending.set(id, { resolve, reject, timer });
      const json = JSON.stringify({ id, ...body });
      let sent = false;
      let error = "not connected to ekatva";
      try {
        sent = files.length ? native.callWithFiles(json, files) : native.send(what, json);
      } catch (e) {
        error = (e as Error).message;
      }
      if (!sent) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(error));
      }
    });

  const link: EkatvaLink = {
    status: () => status,
    why: () => why,
    onStatus(cb) {
      statusCbs.add(cb);
      return () => statusCbs.delete(cb);
    },
    link() {
      if (!native?.installed()) return set("not-installed", reasonOf("not-installed"));
      if (!native.connect(JSON.stringify({ ...manifest, link: true })))
        set("not-installed", "can't reach ekatva");
    },
    call: (method, input, opts = {}) =>
      request(
        "call",
        { method, input: input ?? null, ...(opts.to ? { to: opts.to } : {}) },
        opts.files,
      ),
    emit: async (name, data, keep = 0) => {
      await request("emit", { name, input: data ?? null, keep });
    },
    laptop: async () => (await request("status", {})) as Awaited<ReturnType<EkatvaLink["laptop"]>>,
    on(method, handler) {
      if (!(manifest.methods ?? []).some((m) => m.name === method))
        throw new Error(`"${method}" isn't in ${manifest.name}'s manifest`);
      handlers.set(method, handler);
      return link;
    },
    onEvent(name, handler) {
      if (!(manifest.events ?? []).some((m) => m.name === name))
        throw new Error(`"${name}" isn't in ${manifest.name}'s manifest events`);
      events.set(name, handler);
      return link;
    },
    close() {
      for (const s of subs.splice(0)) s.remove();
      failAll("closed");
      native?.disconnect();
    },
  };
  return link;
}

export function reasonOf(s: Status): string {
  switch (s) {
    case "not-installed":
      return "ekatva isn't on this phone";
    case "connecting":
      return "still connecting to ekatva";
    case "waiting":
      return "ekatva isn't open on the phone: open it once";
    case "unlinked":
      return "link this app with ekatva first";
    case "pending":
      return "allow this app in ekatva first";
    case "denied":
      return "this app wasn't allowed in ekatva";
    case "refused":
      return "ekatva refused this app";
    case "disconnected":
      return "ekatva stopped; it comes back by itself";
    default:
      return "connected";
  }
}

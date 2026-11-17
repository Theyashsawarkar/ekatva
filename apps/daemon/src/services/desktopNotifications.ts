/**
 * The desktop's notifications (org.freedesktop.Notifications, whatever
 * server shows them: mako, dunst, swaync…), through busctl: watching what
 * other apps post and close, and posting our own with buttons.
 *
 * Ours carry the hint `x-ekatva`, so watching never mistakes them for the
 * laptop's own (and never sends a phone's notification back to it).
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface Posted {
  id: number;
  app: string;
  title: string;
  body: string;
  /** The app_icon argument: an icon's name or a file ("" when none). */
  icon: string;
  /** 0 low, 1 normal, 2 urgent. */
  urgency: number;
  /** The image-path hint (a picture), the desktop-entry hint. */
  image: string;
  desktopEntry: string;
}

function urgencyOf(v: unknown): number {
  const u = Number(v);
  return Number.isInteger(u) && u >= 0 && u <= 2 ? u : 1;
}

/** A hint's value: busctl's JSON writes a variant as {type, data}. */
function hintOf(hints: Record<string, unknown>, k: string): unknown {
  const v = hints[k];
  return v && typeof v === "object" && "data" in (v as object) ? (v as { data: unknown }).data : v;
}

/** Why a notification closed (the spec's codes). */
export const CLOSED = { expired: 1, dismissed: 2, closed: 3 } as const;

export interface NotifyOpts {
  app: string;
  title: string;
  body: string;
  /** [key, label] pairs; "default" is a click on the notification itself. */
  actions?: [string, string][];
  replaces?: number;
  /** 0 low, 1 normal, 2 critical. */
  urgency?: 0 | 1 | 2;
  icon?: string;
  /** Extra string hints (x-ekatva-kind, -device, -contact, -number, -app), so a
   * notification server can tell a call from a chat (akashvani draws each its own way). */
  hints?: Record<string, string>;
}

type Call = (args: string[]) => Promise<string>;
type Spawner = (cmd: string, args: string[]) => ChildProcess;

const DEST = ["org.freedesktop.Notifications", "/org/freedesktop/Notifications"];
const IFACE = "org.freedesktop.Notifications";

export class DesktopNotifications {
  private monitor: ChildProcess | null = null;
  private calls = new Map<string, Omit<Posted, "id">>();
  private stopped = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private posted = new Set<(n: Posted) => void>();
  private closed = new Set<(id: number, reason: number) => void>();
  private actions = new Set<(id: number, key: string) => void>();

  constructor(
    private readonly log: (m: string) => void = () => undefined,
    private readonly call: Call = (args) =>
      new Promise((resolve, reject) =>
        execFile("busctl", ["--user", "call", "--", ...args], { timeout: 5000 }, (e, out) =>
          e ? reject(e) : resolve(String(out)),
        ),
      ),
    private readonly spawner: Spawner = (cmd, args) =>
      spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] }),
  ) {}

  onPosted(cb: (n: Posted) => void): () => void {
    this.posted.add(cb);
    return () => this.posted.delete(cb);
  }
  onClosed(cb: (id: number, reason: number) => void): () => void {
    this.closed.add(cb);
    return () => this.closed.delete(cb);
  }
  onAction(cb: (id: number, key: string) => void): () => void {
    this.actions.add(cb);
    return () => this.actions.delete(cb);
  }

  start(): void {
    this.stopped = false;
    if (this.monitor) return;
    let child: ChildProcess;
    try {
      child = this.spawner("busctl", ["--user", "monitor", "--json=short", DEST[0] as string]);
    } catch (e) {
      this.log(`can't watch desktop notifications: ${(e as Error).message}`);
      return;
    }
    this.monitor = child;
    child.on("error", (e) => this.log(`can't watch desktop notifications: ${e.message}`));
    if (child.stdout)
      createInterface({ input: child.stdout }).on("line", (line) => this.handle(line));
    child.on("exit", () => {
      if (this.monitor === child) this.monitor = null;
      if (!this.stopped) {
        this.restartTimer = setTimeout(() => this.start(), 5000);
        this.restartTimer.unref?.();
      }
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.monitor?.kill();
    this.monitor = null;
  }

  /** One line of `busctl monitor --json=short`. */
  handle(line: string): void {
    let m: {
      type?: string;
      sender?: string;
      destination?: string;
      cookie?: number;
      reply_cookie?: number;
      member?: string;
      interface?: string;
      payload?: { data?: unknown[] };
    };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    const data = m.payload?.data ?? [];
    if (m.type === "method_call" && m.interface === IFACE && m.member === "Notify") {
      const [app, , icon, title, body, , hints] = data as [
        string,
        number,
        string,
        string,
        string,
        string[],
        Record<string, unknown>,
      ];
      if (hints && typeof hints === "object" && "x-ekatva" in hints) return;
      if (m.sender && m.cookie !== undefined)
        this.calls.set(`${m.sender}/${m.cookie}`, {
          app: String(app ?? ""),
          title: String(title ?? ""),
          body: String(body ?? ""),
          icon: String(icon ?? ""),
          urgency: urgencyOf(hintOf(hints ?? {}, "urgency")),
          image: String(
            hintOf(hints ?? {}, "image-path") ?? hintOf(hints ?? {}, "image_path") ?? "",
          ),
          desktopEntry: String(hintOf(hints ?? {}, "desktop-entry") ?? ""),
        });
      // Keep the table small whatever happens.
      if (this.calls.size > 200) this.calls.delete(this.calls.keys().next().value as string);
      return;
    }
    if (m.type === "method_return" && m.destination && m.reply_cookie !== undefined) {
      const key = `${m.destination}/${m.reply_cookie}`;
      const c = this.calls.get(key);
      if (!c) return;
      this.calls.delete(key);
      const id = Number(data[0]);
      if (Number.isFinite(id)) for (const cb of this.posted) cb({ id, ...c });
      return;
    }
    if (m.type === "signal" && m.interface === IFACE) {
      if (m.member === "NotificationClosed")
        for (const cb of this.closed) cb(Number(data[0]), Number(data[1]));
      if (m.member === "ActionInvoked")
        for (const cb of this.actions) cb(Number(data[0]), String(data[1]));
    }
  }

  /** Posts one of ours; its id. */
  async notify(o: NotifyOpts): Promise<number> {
    const actions = (o.actions ?? []).flat();
    const out = await this.call([
      ...DEST,
      IFACE,
      "Notify",
      "susssasa{sv}i",
      o.app,
      String(o.replaces ?? 0),
      o.icon ?? "",
      o.title,
      o.body,
      String(actions.length),
      ...actions,
      String(2 + Object.keys(o.hints ?? {}).length),
      "urgency",
      "y",
      String(o.urgency ?? 1),
      "x-ekatva",
      "b",
      "true",
      ...Object.entries(o.hints ?? {}).flatMap(([k, v]) => [k, "s", v]),
      "-1",
    ]);
    const id = Number(/u\s+(\d+)/.exec(out)?.[1]);
    if (!Number.isFinite(id)) throw new Error(`no id from the notification server: ${out}`);
    return id;
  }

  async close(id: number): Promise<void> {
    await this.call([...DEST, IFACE, "CloseNotification", "u", String(id)]).catch(() => undefined);
  }
}

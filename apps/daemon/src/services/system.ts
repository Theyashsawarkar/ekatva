/** The laptop's state, power, clipboard, and showing the phone's events. */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { cpus, homedir, loadavg, uptime } from "node:os";
import { join } from "node:path";
import type { Done, PhoneEvent, Status } from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";
import { saveImage } from "./phoneImages.js";

export function run(cmd: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (err, out, errOut) => {
        if (err)
          reject(
            new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `${cmd}: ${String(errOut || err.message).trim()}`,
            }),
          );
        else resolve(String(out));
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** Is a charger connected? Any mains or USB supply that says it's online. */
export function onMains(root = "/sys/class/power_supply"): boolean {
  try {
    for (const n of readdirSync(root)) {
      try {
        const type = readFileSync(`${root}/${n}/type`, "utf8").trim();
        if (type === "Battery") continue;
        if (readFileSync(`${root}/${n}/online`, "utf8").trim() === "1") return true;
      } catch {
        // not a supply with an online flag
      }
    }
  } catch {
    // no power_supply class
  }
  return false;
}

/**
 * The battery, and whether it's plugged in. A charge limit (Vayu holds it at
 * 80%) makes the battery say "Not charging" while the charger is in: that's
 * plugged in, not on battery.
 */
export function battery(root = "/sys/class/power_supply"): Status["battery"] {
  for (const name of ["BAT0", "BAT1", "BAT"]) {
    try {
      const d = `${root}/${name}`;
      const percent = Number(readFileSync(`${d}/capacity`, "utf8"));
      const status = readFileSync(`${d}/status`, "utf8").trim();
      const plugged =
        onMains(root) || status === "Charging" || status === "Full" || status === "Not charging";
      return { percent, charging: status === "Charging", plugged };
    } catch {
      // next
    }
  }
  return null;
}

function temperature(): number | null {
  for (let i = 0; i < 10; i++) {
    try {
      const type = readFileSync(`/sys/class/thermal/thermal_zone${i}/type`, "utf8").trim();
      if (!/x86_pkg_temp|cpu|k10temp|acpitz/i.test(type)) continue;
      return Math.round(
        Number(readFileSync(`/sys/class/thermal/thermal_zone${i}/temp`, "utf8")) / 1000,
      );
    } catch {
      // next
    }
  }
  return null;
}

/**
 * Is the screen locked? swaylock (Vayu's locker) doesn't tell logind, so a
 * running swaylock counts; other desktops set logind's LockedHint.
 */
export async function locked(): Promise<boolean | null> {
  const uid = process.getuid?.();
  if (uid !== undefined) {
    const own = await run("pgrep", ["-u", String(uid), "-x", "swaylock"]).then(
      () => true,
      () => false,
    );
    if (own) return true;
  }
  try {
    const session = process.env.XDG_SESSION_ID;
    const out = await run("loginctl", [
      "show-session",
      session ?? "auto",
      "-p",
      "LockedHint",
      "--value",
    ]);
    return out.trim() === "yes";
  } catch {
    return null;
  }
}

/** Vayu's own locker (swaylock with its config and the theme's colours). */
const VAYU_LOCK = join(homedir(), ".local/bin/vayu-lock");

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Locks the screen, and checks it did: says so instead of claiming it.
 * On Vayu it starts vayu-lock through sway (in sway's own process group,
 * so restarting ekatva can't take the lock down with it): nothing there
 * answers `loginctl lock-session`. Elsewhere, lock-session.
 */
export async function lockScreen(): Promise<void> {
  if (await locked()) return;
  if (existsSync(VAYU_LOCK) && process.env.SWAYSOCK) await run("swaymsg", ["exec", VAYU_LOCK]);
  else await run("loginctl", ["lock-session"]);
  for (let i = 0; i < 20; i++) {
    await pause(150);
    if (await locked()) return;
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "The laptop didn't lock: no screen locker answered",
  });
}

export class SystemService {
  /**
   * Runs the sleep; set by the daemon so jyoti lets this one sleep happen
   * (and stays on for when the laptop wakes). Says whether it was on.
   */
  whileAsleep: (sleep: () => Promise<void>) => Promise<boolean> = async (sleep) => {
    await sleep();
    return false;
  };

  constructor(
    private readonly name: string,
    private readonly extra: () => Promise<{
      jyoti: Status["jyoti"];
      waiting: number;
      firewall?: Status["firewall"];
    }>,
  ) {}

  async status(): Promise<Status> {
    const { jyoti, waiting, firewall = null } = await this.extra();
    return {
      name: this.name,
      battery: battery(),
      cpu: Math.min(100, Math.round(((loadavg()[0] ?? 0) / Math.max(1, cpus().length)) * 100)),
      temperature: temperature(),
      uptime: Math.round(uptime()),
      jyoti,
      waiting,
      locked: await locked(),
      firewall,
    };
  }

  async lock(): Promise<Done<null>> {
    await lockScreen();
    return { value: null, summary: "Locked the laptop" };
  }

  /**
   * Locks (so it wakes up locked), then sleeps a moment later, once the
   * answer is on its way to the phone. Jyoti doesn't stop it: it's let go
   * for this sleep and is on again when the laptop wakes.
   */
  async suspend(): Promise<Done<null>> {
    const can = await run("busctl", [
      "call",
      "org.freedesktop.login1",
      "/org/freedesktop/login1",
      "org.freedesktop.login1.Manager",
      "CanSuspend",
    ]).catch(() => 's "yes"');
    if (/"(no|na)"/.test(can))
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This laptop can't sleep" });
    await lockScreen();
    const on = (await this.extra()).jyoti !== "off";
    setTimeout(
      () =>
        void this.whileAsleep(() => run("systemctl", ["suspend"]).then(() => undefined)).catch(
          () => undefined,
        ),
      800,
    );
    return {
      value: null,
      summary: on
        ? "Put the laptop to sleep (jyoti stays lit for when it wakes)"
        : "Put the laptop to sleep",
    };
  }

  async clipboardGet(): Promise<string> {
    return run("wl-paste", ["--no-newline"]).catch(() => "");
  }

  async clipboardSet(text: string): Promise<Done<null>> {
    const before = await this.clipboardGet();
    await run("wl-copy", [], text);
    return {
      value: null,
      summary: `Set the clipboard (${text.length} characters)`,
      undo: { kind: "clipboard.set", data: { text: before } },
    };
  }

  /** The phone's notifications, calls and messages, as desktop notifications. */
  async showPhoneEvent(phone: string, e: PhoneEvent): Promise<void> {
    const tag = (kind: string, extra: Record<string, string | null | undefined> = {}) => [
      "-h",
      "boolean:x-ekatva:true",
      "-h",
      `string:x-ekatva-kind:${kind}`,
      "-h",
      `string:x-ekatva-device:${phone}`,
      ...Object.entries(extra).flatMap(([k, v]) => (v ? ["-h", `string:x-ekatva-${k}:${v}`] : [])),
    ];
    const notify = (args: string[]) =>
      run("notify-send", ["-a", `${phone}`, ...args]).catch(() => undefined);
    switch (e.kind) {
      case "notification":
        if (!e.removed)
          await notify([
            ...tag("phone", { app: e.app }),
            ...phoneImages(e),
            "-h",
            `string:x-canonical-private-synchronous:ekatva-${e.id}`,
            `${e.app}: ${e.title}`,
            e.text,
          ]);
        break;
      case "call":
        if (e.state === "ringing")
          await notify([
            ...tag("call", { contact: e.contact, number: e.number }),
            "-u",
            "critical",
            "-i",
            "call-start",
            `Incoming call: ${e.contact ?? e.number}`,
            "on your phone",
          ]);
        if (e.state === "missed")
          await notify([
            ...tag("missed", { contact: e.contact, number: e.number }),
            "-i",
            "call-missed",
            `Missed call: ${e.contact ?? e.number}`,
          ]);
        break;
      case "sms":
        await notify([
          ...tag("sms", { contact: e.contact, number: e.from }),
          "-i",
          "mail-message-new",
          `${e.contact ?? e.from}`,
          e.text,
        ]);
        break;
      case "battery":
        if (!e.charging && e.percent <= 15)
          await notify(["-i", "battery-low", `Your phone's battery is at ${e.percent}%`]);
        break;
    }
  }
}

/** notify-send's flags for a phone notification's icon and picture, when it brings them. */
function phoneImages(e: {
  package?: string;
  app: string;
  icon?: string;
  picture?: string;
}): string[] {
  const icon = saveImage("app", e.package ?? e.app, e.icon);
  const picture = saveImage("pic", "", e.picture);
  // notify-send's -i with a file would arrive as the picture: the icon has its own hint
  return [
    ...(icon ? ["-h", `string:x-ekatva-icon:${icon}`] : []),
    ...(picture ? ["-h", `string:image-path:${picture}`] : []),
  ];
}

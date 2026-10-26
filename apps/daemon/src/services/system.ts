/** The laptop's state, power, clipboard, and showing the phone's events. */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, loadavg, uptime } from "node:os";
import type { Done, PhoneEvent, Status } from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";

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

function battery(): Status["battery"] {
  for (const name of ["BAT0", "BAT1", "BAT"]) {
    try {
      const d = `/sys/class/power_supply/${name}`;
      const percent = Number(readFileSync(`${d}/capacity`, "utf8"));
      const status = readFileSync(`${d}/status`, "utf8").trim();
      return { percent, charging: status === "Charging" || status === "Full" };
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

async function locked(): Promise<boolean | null> {
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

export class SystemService {
  constructor(
    private readonly name: string,
    private readonly extra: () => Promise<{ caffeine: Status["caffeine"]; waiting: number }>,
  ) {}

  async status(): Promise<Status> {
    const { caffeine, waiting } = await this.extra();
    return {
      name: this.name,
      battery: battery(),
      cpu: Math.min(100, Math.round(((loadavg()[0] ?? 0) / Math.max(1, cpus().length)) * 100)),
      temperature: temperature(),
      uptime: Math.round(uptime()),
      caffeine,
      waiting,
      locked: await locked(),
    };
  }

  async lock(): Promise<Done<null>> {
    await run("loginctl", ["lock-session"]);
    return { value: null, summary: "Locked the laptop" };
  }

  async suspend(): Promise<Done<null>> {
    // Lock first, so it wakes up locked.
    await run("loginctl", ["lock-session"]).catch(() => undefined);
    setTimeout(() => void run("systemctl", ["suspend"]).catch(() => undefined), 800);
    return { value: null, summary: "Put the laptop to sleep" };
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
    const notify = (args: string[]) =>
      run("notify-send", ["-a", `${phone}`, ...args]).catch(() => undefined);
    switch (e.kind) {
      case "notification":
        if (!e.removed)
          await notify([
            "-h",
            `string:x-canonical-private-synchronous:ekatva-${e.id}`,
            `${e.app}: ${e.title}`,
            e.text,
          ]);
        break;
      case "call":
        if (e.state === "ringing")
          await notify([
            "-u",
            "critical",
            "-i",
            "call-start",
            `Incoming call: ${e.contact ?? e.number}`,
            "on your phone",
          ]);
        if (e.state === "missed")
          await notify(["-i", "call-missed", `Missed call: ${e.contact ?? e.number}`]);
        break;
      case "sms":
        await notify(["-i", "mail-message-new", `${e.contact ?? e.from}`, e.text]);
        break;
      case "battery":
        if (!e.charging && e.percent <= 15)
          await notify(["-i", "battery-low", `Your phone's battery is at ${e.percent}%`]);
        break;
    }
  }
}

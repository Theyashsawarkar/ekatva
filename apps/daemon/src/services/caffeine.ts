/**
 * Caffeine, in three levels:
 *
 *   off    the desktop dims, locks and sleeps as usual
 *   on     no dimming, no lock, no sleep from idleness
 *   high   on, and the laptop keeps running with the lid closed; closing
 *          the lid still locks it (ekatva watches the lid and locks)
 *
 * Mechanism: a logind inhibitor held by a child process (`systemd-inhibit
 * … sleep infinity`), for idle and sleep, plus the lid switch at "high".
 * Holding the lid switch needs no root for the active session. On Vayu the
 * screen's idle timeouts come from the swayidle user service, which no
 * inhibitor reaches; so, as Vayu's own caffeine toggle does, "on" stops it
 * and leaves the toggle's state file, which keeps the waybar capsule and
 * quick settings in step. Either way the state is remembered across
 * restarts, and an optional timer turns it off.
 *
 * Safety: "high" drops to "on" when the battery is low and discharging,
 * so a closed laptop in a bag can still sleep before it dies.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Caffeine, CaffeineLevel, Done } from "@ekatva/protocol";
import { home } from "../paths.js";

export interface Host {
  /** Runs a command; resolves with its exit code and output. */
  run(cmd: string, args: string[]): Promise<{ code: number; out: string }>;
  /** Starts a long-lived holder process. */
  hold(cmd: string, args: string[]): { stop(): void; onExit(cb: () => void): void };
  /** Is the lid closed? null when there's no lid. */
  lidClosed(): boolean | null;
  /** Battery percent and whether it's discharging, or null. */
  battery(): { percent: number; discharging: boolean } | null;
  now(): number;
}

export const realHost: Host = {
  run: (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 10_000 }, (err, stdout) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : 127
          : 0;
        resolve({ code, out: String(stdout ?? "") });
      });
    }),
  hold(cmd, args) {
    const child: ChildProcess = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => undefined);
    return {
      stop: () => child.kill("SIGTERM"),
      onExit: (cb) => child.on("exit", cb),
    };
  },
  lidClosed() {
    for (const dir of ["LID", "LID0", "LID1"]) {
      try {
        return /closed/.test(readFileSync(`/proc/acpi/button/lid/${dir}/state`, "utf8"));
      } catch {
        // try the next name
      }
    }
    return null;
  },
  battery() {
    try {
      for (const name of ["BAT0", "BAT1", "BAT"]) {
        const d = `/sys/class/power_supply/${name}`;
        if (!existsSync(d)) continue;
        return {
          percent: Number(readFileSync(`${d}/capacity`, "utf8")),
          discharging: readFileSync(`${d}/status`, "utf8").trim() === "Discharging",
        };
      }
    } catch {
      // no battery
    }
    return null;
  },
  now: () => Date.now(),
};

const LOW_BATTERY = 10;

export class CaffeineService {
  private level: CaffeineLevel = "off";
  private since: number | null = null;
  private until: number | null = null;
  private holder: { stop(): void } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lidTimer: ReturnType<typeof setInterval> | null = null;
  private lidWasClosed = false;
  private stoppedSwayidle = false;
  private listeners = new Set<(c: Caffeine) => void>();
  /** Called when caffeine changes by itself (timer, low battery), for the journal. */
  onAuto: (summary: string, from: CaffeineLevel) => void = () => undefined;

  constructor(
    private readonly host: Host = realHost,
    private readonly stateFile: string,
    /** Vayu's caffeine toggle's state file; present = caffeine on. */
    private readonly vayuFile = join(home(), ".local/state/caffeine/enabled"),
  ) {}

  /** Re-applies what was set before a restart, if still due. */
  async restore(): Promise<void> {
    try {
      const s = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (s.level !== "off" && (!s.until || s.until > this.host.now())) {
        await this.apply(
          s.level,
          s.until ? Math.ceil((s.until - this.host.now()) / 60_000) : null,
          s.since,
        );
      }
    } catch {
      // nothing saved
    }
  }

  async get(): Promise<Caffeine> {
    let level = this.level;
    // Turned on elsewhere (quick settings, the toggle script)?
    if (level === "off" && existsSync(this.vayuFile)) level = "on";
    return { level, since: this.since, until: this.until, lidHold: this.host.lidClosed() !== null };
  }

  async set(level: CaffeineLevel, minutes: number | null): Promise<Done<Caffeine>> {
    const before = await this.get();
    await this.apply(level, minutes, null);
    const after = await this.get();
    const what = {
      off: "Caffeine off",
      on: "Caffeine on",
      high: "High caffeine on: stays on with the lid closed",
    }[level];
    return {
      value: after,
      summary: `${what}${minutes ? ` for ${minutes} min` : ""}`,
      undo: { kind: "caffeine.set", data: { level: before.level, until: before.until } },
    };
  }

  /** The undo of a `set`: back to the level (and timer) before it. */
  async undo(data: { level: CaffeineLevel; until: number | null }): Promise<Done<Caffeine>> {
    const minutes = data.until
      ? Math.max(1, Math.ceil((data.until - this.host.now()) / 60_000))
      : null;
    return this.set(data.level, data.until && data.until <= this.host.now() ? null : minutes);
  }

  async *changes(signal: AbortSignal | undefined): AsyncGenerator<Caffeine> {
    const queue: Caffeine[] = [await this.get()];
    let wake: (() => void) | null = null;
    const cb = (c: Caffeine) => {
      queue.push(c);
      wake?.();
    };
    this.listeners.add(cb);
    try {
      while (!signal?.aborted) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((res) => {
          wake = res;
          signal?.addEventListener("abort", () => res(), { once: true });
        });
      }
    } finally {
      this.listeners.delete(cb);
    }
  }

  private async apply(
    level: CaffeineLevel,
    minutes: number | null,
    since: number | null,
  ): Promise<void> {
    this.holder?.stop();
    this.holder = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.lidTimer) clearInterval(this.lidTimer);
    this.lidTimer = null;

    if (level === "off") {
      await this.idleBack();
      this.level = "off";
      this.since = null;
      this.until = null;
    } else {
      const what = level === "high" ? "idle:sleep:handle-lid-switch" : "idle:sleep";
      this.holder = this.host.hold("systemd-inhibit", [
        `--what=${what}`,
        "--who=ekatva",
        `--why=${level === "high" ? "High caffeine: running with the lid closed" : "Caffeine"}`,
        "--mode=block",
        "sleep",
        "infinity",
      ]);
      await this.idleAway();
      this.level = level;
      this.since = since ?? this.host.now();
      this.until = minutes ? this.host.now() + minutes * 60_000 : null;
      if (this.until) {
        this.timer = setTimeout(() => {
          const from = this.level;
          void this.apply("off", null, null).then(() =>
            this.onAuto("Caffeine off: its time was up", from),
          );
        }, this.until - this.host.now());
      }
      if (level === "high") this.watchLid();
    }
    await this.save();
    const now = await this.get();
    for (const cb of this.listeners) cb(now);
    await this.host.run(join(home(), ".local/bin/waybar-signal"), ["12"]).catch(() => undefined);
  }

  /** At "high": lock when the lid closes; drop to "on" when the battery runs low. */
  private watchLid(): void {
    this.lidWasClosed = this.host.lidClosed() === true;
    this.lidTimer = setInterval(() => {
      const closed = this.host.lidClosed() === true;
      if (closed && !this.lidWasClosed) void this.host.run("loginctl", ["lock-session"]);
      this.lidWasClosed = closed;
      const b = this.host.battery();
      if (b?.discharging && b.percent <= LOW_BATTERY) {
        void this.apply(
          "on",
          this.until ? Math.ceil((this.until - this.host.now()) / 60_000) : null,
          this.since,
        ).then(() =>
          this.onAuto(`High caffeine dropped to caffeine: battery at ${b.percent}%`, "high"),
        );
      }
    }, 2000);
  }

  /** Vayu: stop swayidle (its timeouts dim, lock and sleep) and mark caffeine on. */
  private async idleAway(): Promise<void> {
    const active = await this.host.run("systemctl", [
      "--user",
      "is-active",
      "--quiet",
      "swayidle.service",
    ]);
    if (active.code === 0) {
      await this.host.run("systemctl", ["--user", "stop", "swayidle.service"]);
      this.stoppedSwayidle = true;
    }
    if (active.code === 0 || existsSync(dirname(this.vayuFile))) {
      await mkdir(dirname(this.vayuFile), { recursive: true });
      await writeFile(this.vayuFile, "");
    }
  }

  private async idleBack(): Promise<void> {
    const ours = this.stoppedSwayidle || existsSync(this.vayuFile);
    if (!ours) return;
    await rm(this.vayuFile, { force: true });
    const known = await this.host.run("systemctl", ["--user", "cat", "swayidle.service"]);
    if (known.code === 0) await this.host.run("systemctl", ["--user", "start", "swayidle.service"]);
    this.stoppedSwayidle = false;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    await writeFile(
      this.stateFile,
      JSON.stringify({ level: this.level, since: this.since, until: this.until }),
      { mode: 0o600 },
    );
  }

  /** On daemon exit: release the inhibitor (logind would anyway when the holder dies). */
  shutdown(): void {
    this.holder?.stop();
    if (this.timer) clearTimeout(this.timer);
    if (this.lidTimer) clearInterval(this.lidTimer);
  }
}

/**
 * Jyoti (ज्योति, the flame): the laptop stays awake, at three levels.
 *
 *   off        Śānta (शान्त, at rest): the desktop dims, locks and sleeps
 *              as usual
 *   on         Akhaṇḍa (अखण्ड, the unbroken flame): no dimming, no lock, no
 *              sleep from idleness
 *   high       Nandādīpa (नन्दादीप, the lamp kept burning day and night):
 *              Akhaṇḍa, and the laptop keeps running, unlocked, with the lid
 *              closed, so it can be reached from anywhere through ekatva
 *
 * ("on" and "high" are the wire's names, from before the levels had theirs.)
 *
 * Mechanism: a logind inhibitor (`systemd-inhibit … sleep infinity`), for
 * idle and sleep, plus the lid switch at "high", held by a systemd user unit
 * of its own (ekatva-jyoti-on / ekatva-jyoti-high), not by a child of the
 * daemon: stopping, restarting or crashing ekatva must not let it go
 * (2026-11-28: a restart at night, lid closed, let logind suspend the
 * laptop at once). A restarted daemon adopts the unit it finds running; a
 * change of level starts the new unit before stopping the old one, so the
 * lid switch is never free in between. Only turning jyoti off stops it.
 * Holding the lid switch needs no root for the active session. On Vayu the
 * screen's idle timeouts come from the swayidle user service, which no
 * inhibitor reaches; so, as Vayu's own jyoti toggle does, "on" stops it
 * and leaves the toggle's state file, which keeps the waybar capsule and
 * quick settings in step. Either way the state is remembered across
 * restarts, and an optional timer turns it off.
 *
 * A level stays until the user changes it (2026-11-28: Jyoti is manual).
 * Nothing switches it by itself: no drop from Nandādīpa on a low battery
 * (that used to happen at 10%); only a timer the user asked for ends it.
 *
 * Nandādīpa never locks the screen (2026-11-28: it used to lock when the
 * lid closed, and the user wants the laptop as they left it).
 *
 * Asked to sleep while it's lit, the laptop sleeps anyway (whileAsleep):
 * the block is let go for that one sleep and taken back, so it's lit again
 * when the laptop wakes.
 */
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Done, Jyoti, JyotiLevel } from "@ekatva/protocol";
import { home } from "../paths.js";

/** The units that hold the block, one per level. */
export const HOLD_UNITS = ["ekatva-jyoti-on.service", "ekatva-jyoti-high.service"];

export interface Host {
  /** Runs a command; resolves with its exit code and output. */
  run(cmd: string, args: string[]): Promise<{ code: number; out: string }>;
  /**
   * Starts a long-lived holder process, as the systemd user unit `unit`
   * when given (outliving the daemon; adopted when it's already running).
   */
  hold(cmd: string, args: string[], unit?: string): Holder;
  /** Is the lid closed? null when there's no lid. */
  lidClosed(): boolean | null;
  /** Not used by jyoti since 2026-11-28 (no lock on the lid, no battery drop). */
  lock?(): Promise<void>;
  battery?(): { percent: number; discharging: boolean } | null;
  watchPower?(onChange: () => void, onDown: () => void): { stop(): void };
  now(): number;
}

export interface Holder {
  /** Ends it; resolves once it has gone (and logind has let the block go). */
  stop(): Promise<void>;
  onExit(cb: () => void): void;
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
  hold(cmd, args, unit) {
    if (unit) {
      const sc = (...a: string[]) => {
        try {
          execFileSync("systemctl", ["--user", ...a], { stdio: "ignore", timeout: 10_000 });
          return true;
        } catch {
          return false;
        }
      };
      const name = unit.replace(/\.service$/, "");
      // A unit left by a failed one, so the name is free; a running one is adopted.
      if (!sc("is-active", "--quiet", unit)) sc("reset-failed", unit);
      if (
        sc("is-active", "--quiet", unit) ||
        (() => {
          try {
            execFileSync(
              "systemd-run",
              [
                "--user",
                `--unit=${name}`,
                "--collect",
                "--quiet",
                "-p",
                `Description=${name}`,
                cmd,
                ...args,
              ],
              { stdio: "ignore", timeout: 10_000 },
            );
            return true;
          } catch {
            return false;
          }
        })()
      ) {
        return {
          stop: () =>
            new Promise<void>((resolve) => {
              execFile("systemctl", ["--user", "stop", unit], { timeout: 10_000 }, () => resolve());
            }),
          onExit: () => undefined,
        };
      }
      // No user systemd to run it: a child of ours, as before.
    }
    const child: ChildProcess = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", () => undefined);
    let gone = false;
    child.on("exit", () => {
      gone = true;
    });
    return {
      stop: () =>
        new Promise<void>((resolve) => {
          if (gone || child.exitCode !== null) return resolve();
          child.once("exit", () => resolve());
          child.kill("SIGTERM");
          setTimeout(resolve, 2000).unref();
        }),
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
  now: () => Date.now(),
};

export class JyotiService {
  private level: JyotiLevel = "off";
  private since: number | null = null;
  private until: number | null = null;
  private holder: Holder | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stoppedSwayidle = false;
  private listeners = new Set<(c: Jyoti) => void>();
  /** Called when jyoti changes by itself (only a timer the user set), for the journal. */
  onAuto: (summary: string, from: JyotiLevel) => void = () => undefined;

  constructor(
    private readonly host: Host = realHost,
    private readonly stateFile: string,
    /** Vayu's jyoti toggle's state file; present = jyoti lit. */
    private readonly vayuFile = join(home(), ".local/state/jyoti/enabled"),
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

  async get(): Promise<Jyoti> {
    let level = this.level;
    // Turned on elsewhere (quick settings, Super+Shift+a, the toggle script)?
    if (level === "off" && existsSync(this.vayuFile)) level = "on";
    return { level, since: this.since, until: this.until, lidHold: this.host.lidClosed() !== null };
  }

  async set(level: JyotiLevel, minutes: number | null): Promise<Done<Jyoti>> {
    const before = await this.get();
    await this.apply(level, minutes, null);
    const after = await this.get();
    const what = {
      off: "Jyoti Śānta: sleeps and locks as usual",
      on: "Jyoti Akhaṇḍa: the laptop stays awake",
      high: "Jyoti Nandādīpa: keeps running with the lid closed",
    }[level];
    return {
      value: after,
      summary: `${what}${minutes ? ` for ${minutes} min` : ""}`,
      undo: { kind: "jyoti.set", data: { level: before.level, until: before.until } },
    };
  }

  /** The undo of a `set`: back to the level (and timer) before it. */
  async undo(data: { level: JyotiLevel; until: number | null }): Promise<Done<Jyoti>> {
    const minutes = data.until
      ? Math.max(1, Math.ceil((data.until - this.host.now()) / 60_000))
      : null;
    return this.set(data.level, data.until && data.until <= this.host.now() ? null : minutes);
  }

  async *changes(signal: AbortSignal | undefined): AsyncGenerator<Jyoti> {
    const queue: Jyoti[] = [await this.get()];
    let wake: (() => void) | null = null;
    const cb = (c: Jyoti) => {
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

  /**
   * Sleeps now, with jyoti left lit: its block is let go for this one sleep
   * (logind refuses to sleep while it's held) and taken back once the sleep
   * has begun (logind only checks blocks when asked), so it's on again when
   * the laptop wakes. Says whether it was on.
   */
  async whileAsleep(sleep: () => Promise<void>): Promise<boolean> {
    const held = this.holder;
    if (!held || this.level === "off") {
      await sleep();
      return false;
    }
    this.holder = null;
    await held.stop();
    const back = () => {
      if (this.level !== "off" && !this.holder) this.holder = this.holdFor(this.level);
    };
    try {
      await sleep();
    } catch (e) {
      back();
      throw e;
    }
    // Node's timers stop while the laptop sleeps: this lands just after it wakes,
    // or 5 s in if the sleep never came.
    setTimeout(back, 5000).unref?.();
    return true;
  }

  private holdFor(level: JyotiLevel): Holder {
    const unit = level === "high" ? "ekatva-jyoti-high.service" : "ekatva-jyoti-on.service";
    const what = level === "high" ? "idle:sleep:handle-lid-switch" : "idle:sleep";
    return this.host.hold(
      "systemd-inhibit",
      [
        `--what=${what}`,
        "--who=ekatva",
        `--why=${level === "high" ? "Jyoti Nandādīpa: running with the lid closed" : "Jyoti Akhaṇḍa"}`,
        "--mode=block",
        "sleep",
        "infinity",
      ],
      unit,
    );
  }

  private async apply(
    level: JyotiLevel,
    minutes: number | null,
    since: number | null,
  ): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const old = this.holder;
    this.holder = null;

    if (level === "off") {
      await old?.stop();
      // Also one left running by an earlier daemon that this one never held.
      await this.host.run("systemctl", ["--user", "stop", ...HOLD_UNITS]).catch(() => undefined);
      await this.idleBack();
      this.level = "off";
      this.since = null;
      this.until = null;
    } else {
      // The new block first, then the other level's goes: never a moment
      // without. The same level again (a restart's restore) adopts its unit.
      this.holder = this.holdFor(level);
      if (old && this.level !== level) await old.stop();
      const other = HOLD_UNITS[level === "high" ? 0 : 1] as string;
      await this.host.run("systemctl", ["--user", "stop", other]).catch(() => undefined);
      await this.idleAway(level);
      this.level = level;
      this.since = since ?? this.host.now();
      this.until = minutes ? this.host.now() + minutes * 60_000 : null;
      if (this.until) {
        this.timer = setTimeout(() => {
          const from = this.level;
          void this.apply("off", null, null).then(() =>
            this.onAuto("Jyoti back to Śānta: its time was up", from),
          );
        }, this.until - this.host.now());
      }
    }
    await this.save();
    const now = await this.get();
    for (const cb of this.listeners) cb(now);
    await this.host.run(join(home(), ".local/bin/waybar-signal"), ["12"]).catch(() => undefined);
  }

  /**
   * Vayu: stop swayidle (its timeouts dim, lock and sleep) and mark jyoti lit. The
   * toggle's state file holds the level ("on" or "high"), so the waybar capsule can
   * show Nandādīpa (its samai, in ember; jyoti-status.sh); Vayu's toggle leaves it empty,
   * which reads as on.
   */
  private async idleAway(level: JyotiLevel): Promise<void> {
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
      await writeFile(this.vayuFile, `${level}\n`);
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

  /**
   * On daemon exit: the block stays (its own unit), so the laptop stays as
   * the user set it while ekatva is away; the next daemon adopts it.
   */
  shutdown(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

/**
 * The phone as the laptop's trackpad and keyboard (Wayland): ydotool moves,
 * clicks and scrolls (through its daemon, ydotoold), wtype types text and
 * keys with the right layout.
 *
 * Moves arrive many times a second: while one is being sent, the next ones
 * add up and go together, so the pointer never lags behind the finger.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Done, MouseButton } from "@ekatva/protocol";

export type Runner = (cmd: string, args: string[]) => Promise<void>;

const BUTTON: Record<MouseButton, string> = { left: "0xC0", right: "0xC1", middle: "0xC2" };
const MODIFIERS: Record<string, string> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  super: "logo",
  win: "logo",
  meta: "logo",
  logo: "logo",
  altgr: "altgr",
};

function defaultRunner(): Runner {
  const runtime = process.env.XDG_RUNTIME_DIR;
  const socket = runtime ? join(runtime, ".ydotool_socket") : null;
  const env = {
    ...process.env,
    ...(socket && existsSync(socket) && !process.env.YDOTOOL_SOCKET
      ? { YDOTOOL_SOCKET: socket }
      : {}),
  };
  return (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { env, timeout: 10_000 }, (err, _out, stderr) => {
        if (!err) resolve();
        else if ((err as NodeJS.ErrnoException).code === "ENOENT")
          reject(new Error(`${cmd} isn't installed (pacman -S ${cmd})`));
        else reject(new Error(String(stderr).trim().split("\n")[0] || err.message));
      });
    });
}

/** "ctrl+shift+t" → wtype arguments that press it. */
export function comboArgs(combo: string): string[] {
  const parts = combo.split("+").filter(Boolean);
  const key = parts.pop();
  if (!key) throw new Error("no key");
  const mods = parts.map((m) => {
    const w = MODIFIERS[m.toLowerCase()];
    if (!w) throw new Error(`unknown modifier "${m}"`);
    return w;
  });
  // A modifier alone ("super") is a key press of that modifier.
  if (!mods.length && MODIFIERS[key.toLowerCase()]) {
    const m = MODIFIERS[key.toLowerCase()] as string;
    return ["-M", m, "-m", m];
  }
  return [
    ...mods.flatMap((m) => ["-M", m]),
    "-k",
    key,
    ...[...mods].reverse().flatMap((m) => ["-m", m]),
  ];
}

/**
 * Whether the laptop's own touchpad scrolls "naturally" (content follows the
 * finger), from sway; the phone's trackpad then scrolls the same way.
 */
export function swayNaturalScroll(): Promise<boolean | null> {
  return new Promise((resolve) => {
    execFile("swaymsg", ["-t", "get_inputs", "-r"], { timeout: 3000 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const pads = (
          JSON.parse(String(out)) as { type: string; libinput?: { natural_scroll?: string } }[]
        ).filter((d) => d.type === "touchpad" && d.libinput?.natural_scroll);
        resolve(pads.length ? pads.some((d) => d.libinput?.natural_scroll === "enabled") : null);
      } catch {
        resolve(null);
      }
    });
  });
}

export class InputService {
  private pending = { dx: 0, dy: 0 };
  private moving: Promise<void> | null = null;
  private natural: { value: boolean; at: number } | null = null;

  constructor(
    private readonly run: Runner = defaultRunner(),
    /** The laptop touchpad's scroll direction; null when unknown (then natural, as on phones). */
    private readonly naturalScroll: () => Promise<boolean | null> = swayNaturalScroll,
  ) {}

  /** Asked again at most once a minute. */
  private async isNatural(): Promise<boolean> {
    if (this.natural && Date.now() - this.natural.at < 60_000) return this.natural.value;
    const value = (await this.naturalScroll().catch(() => null)) ?? true;
    this.natural = { value, at: Date.now() };
    return value;
  }

  move(dx: number, dy: number): Promise<void> {
    this.pending.dx += dx;
    this.pending.dy += dy;
    this.moving ??= this.flush().finally(() => {
      this.moving = null;
    });
    return this.moving;
  }

  private async flush(): Promise<void> {
    while (Math.round(this.pending.dx) || Math.round(this.pending.dy)) {
      const x = Math.round(this.pending.dx);
      const y = Math.round(this.pending.dy);
      this.pending.dx -= x;
      this.pending.dy -= y;
      await this.run("ydotool", ["mousemove", "-x", String(x), "-y", String(y)]);
    }
  }

  async click(button: MouseButton, double: boolean): Promise<void> {
    await this.run("ydotool", [
      "click",
      ...(double ? ["-r", "2", "-D", "60"] : []),
      BUTTON[button],
    ]);
  }

  /**
   * Fingers moved (dx, dy) wheel notches; positive dy is down the phone's screen.
   * Natural (like the laptop's touchpad, usually): the content follows the fingers.
   */
  async scroll(dx: number, dy: number): Promise<void> {
    const flip = (await this.isNatural()) ? 1 : -1;
    // The wheel: positive is up / right. Fingers down → content down → scroll up (natural).
    const x = Math.round(-dx * flip);
    const y = Math.round(dy * flip);
    if (!x && !y) return;
    await this.run("ydotool", ["mousemove", "-w", "-x", String(x), "-y", String(y)]);
  }

  async type(text: string): Promise<Done<null>> {
    await this.run("wtype", ["--", text]);
    return { value: null, summary: `Typed ${text.length} character(s)` };
  }

  async key(combo: string): Promise<Done<null>> {
    await this.run("wtype", comboArgs(combo));
    return { value: null, summary: `Pressed ${combo}` };
  }
}

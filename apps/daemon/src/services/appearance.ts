/**
 * Light and dark on the laptop.
 *
 * On Vayu the mode is varna's (`varna mode` prints dark or light), and
 * `~/.local/bin/theme-toggle.sh` flips everything with it: the bar, GTK's
 * theme and color-scheme, the portal's signal apps follow. Elsewhere the
 * GTK color-scheme (`prefer-dark`) is the mode, set with gsettings.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Appearance, AppearanceMode, Done } from "@ekatva/protocol";
import { TRPCError } from "@trpc/server";
import { home } from "../paths.js";

export interface AppearanceHost {
  /** Runs a command; code 127 when it isn't there. */
  run(cmd: string, args: string[]): Promise<{ code: number; out: string }>;
  /** Does this file exist? */
  exists(path: string): boolean;
}

export const realAppearanceHost: AppearanceHost = {
  run: (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 15_000 }, (err, stdout) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : 127
          : 0;
        resolve({ code, out: String(stdout ?? "") });
      });
    }),
  exists: (path) => existsSync(path),
};

const SCHEMA = "org.gnome.desktop.interface";

export class AppearanceService {
  constructor(
    private readonly host: AppearanceHost = realAppearanceHost,
    private readonly toggle = join(home(), ".local/bin/theme-toggle.sh"),
  ) {}

  async get(): Promise<Appearance> {
    const varna = await this.host.run("varna", ["mode"]);
    const v = varna.out.trim();
    if (varna.code === 0 && (v === "dark" || v === "light"))
      return {
        mode: v,
        settable: this.host.exists(this.toggle),
        why: this.host.exists(this.toggle) ? null : "theme-toggle.sh is missing",
      };
    const g = await this.host.run("gsettings", ["get", SCHEMA, "color-scheme"]);
    if (g.code === 0)
      return { mode: /prefer-dark/.test(g.out) ? "dark" : "light", settable: true, why: null };
    return {
      mode: "dark",
      settable: false,
      why: "Neither varna nor gsettings is here to say or set light and dark",
    };
  }

  async set(mode: AppearanceMode): Promise<Done<Appearance>> {
    const before = await this.get();
    if (!before.settable)
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: before.why ?? "Can't switch here",
      });
    if (before.mode !== mode) {
      const vayu = (await this.host.run("varna", ["mode"])).code === 0;
      const r = vayu
        ? await this.host.run(this.toggle, [])
        : await this.host.run("gsettings", [
            "set",
            SCHEMA,
            "color-scheme",
            mode === "dark" ? "prefer-dark" : "default",
          ]);
      if (r.code !== 0)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Couldn't switch the laptop to ${mode} mode`,
        });
    }
    const now = await this.get();
    return {
      value: now,
      summary:
        before.mode === mode
          ? `The laptop was already in ${mode} mode`
          : `Switched the laptop to ${now.mode} mode`,
      ...(before.mode !== mode
        ? { undo: { kind: "appearance.set", data: { mode: before.mode } } }
        : {}),
    };
  }
}

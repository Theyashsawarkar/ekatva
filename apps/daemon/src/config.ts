/**
 * ~/.config/ekatva/config.toml: every key is optional.
 *
 *   name = "ace"
 *   port = 47100
 *   host = "0.0.0.0"         advertise = true
 *   [files]   roots = ["~"]          private = ["~/.ssh", …]
 *   [undo]    days = 30              max_gb = 5
 *   [agents]  roots = ["~/personal", "~/codes"]
 *   [tunnel]  kind = "cloudflared"   # or "ngrok", "tailscale", "none"
 *             server = "https://ntfy.sh"   idle_minutes = 10
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { dirs } from "./paths.js";

const Config = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .default(() => hostname()),
  port: z.number().int().min(1024).max(65535).default(47100),
  /** Where to listen: all networks, so the phone can reach it on Wi-Fi. */
  host: z.string().default("0.0.0.0"),
  /** Announce it on the local network (mDNS), so the phone finds it. */
  advertise: z.boolean().default(true),
  files: z
    .object({
      roots: z.array(z.string()).default(["~"]),
      private: z
        .array(z.string())
        .default([
          "~/.ssh",
          "~/.gnupg",
          "~/.local/share/keyrings",
          "~/.password-store",
          "~/.pki",
          "~/.mozilla",
          "~/.config/google-chrome",
          "~/.config/chromium",
          "~/.aws",
          "~/.kube",
          "~/.docker/config.json",
          "~/.netrc",
          "~/.git-credentials",
        ]),
    })
    .default({ roots: ["~"], private: [] }),
  undo: z
    .object({ days: z.number().min(1).default(30), max_gb: z.number().min(0.1).default(5) })
    .default({ days: 30, max_gb: 5 }),
  agents: z
    .object({
      roots: z
        .array(z.string())
        .default(["~/personal", "~/codes", "~/work", "~/projects", "~/src"]),
    })
    .default({ roots: [] }),
  tunnel: z
    .object({
      kind: z.enum(["cloudflared", "ngrok", "tailscale", "none"]).default("cloudflared"),
      /** The ntfy server for the rendezvous. */
      server: z.string().url().default("https://ntfy.sh"),
      idle_minutes: z.number().min(1).default(10),
    })
    .default({ kind: "cloudflared", server: "https://ntfy.sh", idle_minutes: 10 }),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(path = join(dirs.config(), "config.toml")): Config {
  let raw: unknown = {};
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(`${path}: ${(e as Error).message}`);
  }
  const c = Config.parse(raw);
  // A config.toml that names [files] without `private` still gets the defaults.
  if (!c.files.private.length) c.files.private = Config.parse({}).files.private;
  if (!c.agents.roots.length) c.agents.roots = Config.parse({}).agents.roots;
  return c;
}

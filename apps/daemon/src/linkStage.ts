/**
 * `ekatva link stage [DIR]`: gathers, as you, what installing ekatva-link
 * needs from your session (apps/link/install/install.sh runs as root after):
 *
 *   bin/ekatva-link, bin/ekatva-greeter   the built binaries (pnpm build)
 *   link.json                             name, port, owner (your uid), tunnel host, mailbox
 *   identity.key                          the laptop's key, from your keyring (so phones
 *                                         keep trusting it: no re-pairing)
 *   devices.json                          the paired phones and their grants
 *   tunnel/credentials.json, tunnel/env   your named tunnel's own credentials (not cert.pem)
 *
 * DIR (default ~/.local/state/ekatva/link-stage) is made 0700; the key is
 * written 0600. install.sh copies it into /var/lib/ekatva, owned by `ekatva`.
 */
import { existsSync, readdirSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toB64u } from "@ekatva/link";
import type { Config } from "./config.js";
import { loadIdentity } from "./identity.js";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/link, beside apps/daemon. */
export const LINK_APP = join(here, "../../link");

interface TunnelState {
  kind?: string;
  hostname?: string;
  name?: string;
}

/** The named tunnel's credentials file: given, or the only one in ~/.cloudflared. */
function credentialsFile(): string | null {
  if (process.env.EKATVA_TUNNEL_CREDENTIALS) return process.env.EKATVA_TUNNEL_CREDENTIALS;
  const dir = join(homedir(), ".cloudflared");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f));
  return files.length === 1 ? join(dir, files[0] as string) : null;
}

export async function stageLink(
  dir: string,
  config: Config,
  stateDir: string,
  log: (m: string) => void,
): Promise<string[]> {
  const notes: string[] = [];
  const bin = join(LINK_APP, "target/release");
  for (const b of ["ekatva-link", "ekatva-greeter"])
    if (!existsSync(join(bin, b))) throw new Error(`${join(bin, b)} isn't built: run pnpm build`);
  await mkdir(join(dir, "bin"), { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  for (const b of ["ekatva-link", "ekatva-greeter"])
    await copyFile(join(bin, b), join(dir, "bin", b));

  let tunnel: TunnelState = {};
  try {
    tunnel = JSON.parse(await readFile(join(stateDir, "tunnel.json"), "utf8")) as TunnelState;
  } catch {
    // config.toml's [tunnel] then
  }
  const hostname =
    tunnel.kind === "named"
      ? (tunnel.hostname ?? null)
      : config.tunnel.kind === "named"
        ? (config.tunnel.hostname ?? null)
        : null;
  await writeFile(
    join(dir, "link.json"),
    JSON.stringify(
      {
        name: config.name,
        port: config.port,
        host: "0.0.0.0",
        owner: process.getuid?.() ?? 1000,
        greeter: null,
        advertise: config.advertise,
        hostname,
        ntfy: (tunnel.kind ?? config.tunnel.kind) === "none" ? null : config.tunnel.server,
      },
      null,
      1,
    ),
    { mode: 0o600 },
  );

  const { key, where } = await loadIdentity(stateDir, log);
  await writeFile(join(dir, "identity.key"), toB64u(key.secretKey), { mode: 0o600 });
  notes.push(`the laptop's identity (from the ${where}): ${toB64u(key.publicKey)}`);
  const devices = join(stateDir, "devices.json");
  if (existsSync(devices)) {
    await copyFile(devices, join(dir, "devices.json"));
    await chmod(join(dir, "devices.json"), 0o600);
  }

  if (hostname) {
    const creds = credentialsFile();
    if (!creds) {
      notes.push(
        "no tunnel credentials found (set EKATVA_TUNNEL_CREDENTIALS to your tunnel's .json): the link works on this network only",
      );
    } else {
      const id = (JSON.parse(await readFile(creds, "utf8")) as { TunnelID?: string }).TunnelID;
      if (!id || !/^[0-9a-f-]{36}$/.test(id)) throw new Error(`${creds} has no TunnelID`);
      await mkdir(join(dir, "tunnel"), { recursive: true, mode: 0o700 });
      await copyFile(creds, join(dir, "tunnel/credentials.json"));
      await chmod(join(dir, "tunnel/credentials.json"), 0o600);
      await writeFile(join(dir, "tunnel/env"), `TUNNEL_ID=${id}\n`, { mode: 0o600 });
      notes.push(`the tunnel ${hostname} (${id})`);
    }
  }
  return notes;
}

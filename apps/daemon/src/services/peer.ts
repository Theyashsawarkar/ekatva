/**
 * Which program is at the other end of a local socket connection: the
 * socket's inode (/proc/self/fd), its peer's inode and process (`ss -xp`,
 * which shows this user's processes), then that process's command line.
 * Shown when an app asks to link ("python3 ~/personal/nada/nada/bridge.py");
 * best effort, null when it can't be found.
 */
import { execFile } from "node:child_process";
import { readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";

export async function programOf(socket: unknown): Promise<string | null> {
  try {
    const fd = (socket as { _handle?: { fd?: number } })?._handle?.fd;
    if (typeof fd !== "number" || fd < 0) return null;
    const inode = /socket:\[(\d+)\]/.exec(await readlink(`/proc/self/fd/${fd}`))?.[1];
    if (!inode) return null;
    const pid = peerPid(await run("ss", ["-xpnH"]), inode);
    return pid ? await commandOf(pid) : null;
  } catch {
    return null;
  }
}

/** In `ss -xpnH` output, the process whose socket's peer is `inode`. */
export function peerPid(ss: string, inode: string): number | null {
  for (const line of ss.split("\n")) {
    const t = line.trim().split(/\s+/);
    // Netid State Recv-Q Send-Q LocalAddr LocalPort PeerAddr PeerPort [Process]
    if (t.length < 9 || t[7] !== inode) continue;
    const pid = /pid=(\d+)/.exec(t.slice(8).join(" "))?.[1];
    if (pid) return Number(pid);
  }
  return null;
}

async function commandOf(pid: number): Promise<string | null> {
  const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
  const args = raw.split("\0").filter(Boolean);
  if (!args.length) return null;
  const home = homedir();
  return args
    .slice(0, 6)
    .map((a) => (a.startsWith(home) ? `~${a.slice(home.length)}` : a))
    .map((a) => (a.length > 80 ? `…${a.slice(-79)}` : a))
    .join(" ");
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (e, out) =>
      e ? reject(e) : resolve(out),
    ),
  );
}

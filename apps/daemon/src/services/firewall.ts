/**
 * Whether this laptop's firewall lets phones on the same network in. It
 * can't be fixed without root, so it's only found and explained: in the
 * journal, `ekatva status` and the window.
 *
 * ufw (its rule files are world-readable) and firewalld (asked through
 * firewall-cmd, which works without root on most setups). Anything else,
 * or an answer we can't get, counts as "not blocked": better quiet than
 * wrong.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

export interface FirewallHost {
  read(path: string): Promise<string | null>;
  run(cmd: string, args: string[]): Promise<{ code: number; out: string } | null>;
}

const host: FirewallHost = {
  read: (p) => readFile(p, "utf8").catch(() => null),
  run: (cmd, args) =>
    new Promise((resolve) => {
      execFile(cmd, args, { timeout: 5000 }, (err, out) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") resolve(null);
        else
          resolve({
            code: err ? Number((err as { code?: unknown }).code ?? 1) || 1 : 0,
            out: String(out),
          });
      });
    }),
};

/** The command that lets local networks in, and only them. */
export function ufwFix(port: number): string {
  return ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fe80::/10"]
    .map((n) => `sudo ufw allow from ${n} to any port ${port} proto tcp comment 'ekatva LAN'`)
    .join(" && ");
}

export interface FirewallProblem {
  /** What's wrong, in a sentence. */
  problem: string;
  /** The command that fixes it (needs root). */
  fix: string;
}

/** What blocks the port, and the fix; null when nothing we can see does. */
export async function firewallProblem(
  port: number,
  h: FirewallHost = host,
): Promise<FirewallProblem | null> {
  const conf = await h.read("/etc/ufw/ufw.conf");
  if (conf && /^\s*ENABLED\s*=\s*yes/m.test(conf)) {
    const defaults = (await h.read("/etc/default/ufw")) ?? "";
    const policy = /^\s*DEFAULT_INPUT_POLICY\s*=\s*"?(\w+)/m.exec(defaults)?.[1] ?? "DROP";
    if (policy !== "ACCEPT") {
      const rules = `${(await h.read("/etc/ufw/user.rules")) ?? ""}\n${(await h.read("/etc/ufw/user6.rules")) ?? ""}`;
      const opens = rules.split("\n").some((l) => {
        if (!/-j\s+ACCEPT/.test(l) || !/ufw6?-user-input/.test(l)) return false;
        if (new RegExp(`--dport\\s+${port}\\b`).test(l)) return true;
        const range = /--dports\s+([\d,:]+)/.exec(l)?.[1];
        return !!range?.split(",").some((r) => {
          const [a, b] = r.split(":").map(Number);
          return port >= (a as number) && port <= (b ?? a ?? 0);
        });
      });
      if (!opens)
        return {
          problem: `ufw blocks port ${port}, so phones on the same network can't reach this laptop`,
          fix: ufwFix(port),
        };
    }
    return null;
  }
  const state = await h.run("firewall-cmd", ["--state"]);
  if (state?.code === 0 && /running/.test(state.out)) {
    const q = await h.run("firewall-cmd", ["--query-port", `${port}/tcp`]);
    if (q && q.code === 1 && /no/.test(q.out))
      return {
        problem: `firewalld blocks port ${port}, so phones on the same network can't reach this laptop`,
        fix: `sudo firewall-cmd --permanent --add-port=${port}/tcp && sudo firewall-cmd --reload`,
      };
  }
  return null;
}

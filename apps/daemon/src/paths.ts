/** Where ekatva keeps things on the laptop (XDG base directories). */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const env = process.env;
export const home = () => env.HOME || homedir();
const xdg = (name: string, fallback: string) => resolve(env[name] || join(home(), fallback));

export const dirs = {
  /** Keys (when there's no keyring), paired devices, the action log. 0700. */
  state: () => join(xdg("XDG_STATE_HOME", ".local/state"), "ekatva"),
  /** config.toml. */
  config: () => join(xdg("XDG_CONFIG_HOME", ".config"), "ekatva"),
  /** The undo store: what changes and deletes replaced. 0700. */
  undo: () => join(xdg("XDG_DATA_HOME", ".local/share"), "ekatva", "undo"),
  /** The local control socket. */
  runtime: () => env.XDG_RUNTIME_DIR || join(xdg("XDG_STATE_HOME", ".local/state"), "ekatva"),
};

export const socketPath = () => join(dirs.runtime(), "ekatva.sock");

/** "~/x" → "/home/you/x"; relative paths are taken from home. */
export function expand(p: string): string {
  if (p === "~") return home();
  if (p.startsWith("~/")) return join(home(), p.slice(2));
  return resolve(home(), p);
}

/** "/home/you/x" → "~/x", for summaries. */
export function tilde(p: string): string {
  const h = home();
  return p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

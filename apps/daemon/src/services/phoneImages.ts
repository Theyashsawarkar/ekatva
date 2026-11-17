/**
 * The phone's notification icons and pictures (base64 PNGs in its events),
 * as files a notification server can show: an app's icon once per package,
 * a picture (a contact's photo) by its content. Old pictures are pruned.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { home } from "../paths.js";

const KEEP = 300;

export const imageDir = () =>
  join(resolve(process.env.XDG_CACHE_HOME || join(home(), ".cache")), "ekatva", "notifications");

/** Writes it (if it isn't there already); its path, or undefined. */
export function saveImage(
  kind: "app" | "pic",
  key: string,
  b64: string | undefined,
): string | undefined {
  if (!b64) return undefined;
  try {
    const dir = imageDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = createHash("sha256")
      .update(kind === "app" ? `${key}|${b64.length}` : b64)
      .digest("hex")
      .slice(0, 24);
    const path = join(dir, `${kind}-${id}.png`);
    if (!existsSync(path)) {
      writeFileSync(path, Buffer.from(b64, "base64"), { mode: 0o600 });
      prune(dir);
    }
    return path;
  } catch {
    return undefined;
  }
}

function prune(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("pic-"))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files.slice(KEEP)) {
    try {
      unlinkSync(join(dir, f));
    } catch {
      // gone already
    }
  }
}

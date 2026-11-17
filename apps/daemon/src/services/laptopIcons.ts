/**
 * The laptop's app icons as small PNGs, for the phone: an icon's name
 * (firefox, mail-unread) or file, else the app's .desktop entry's Icon,
 * else its name. Searched in the icon themes (the user's, hicolor,
 * Adwaita) and pixmaps; SVGs are drawn with rsvg-convert. Each answer is
 * remembered.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { home } from "../paths.js";

const PX = 96;
const MAX_FILE = 300_000;

type Found = { path: string; score: number };
let index: Map<string, Found> | null = null;
const cache = new Map<string, { key: string; png: string } | null>();

function themes(): string[] {
  const out: string[] = [];
  for (const f of [".config/gtk-4.0/settings.ini", ".config/gtk-3.0/settings.ini"]) {
    try {
      const m = /gtk-icon-theme-name\s*=\s*(.+)/.exec(readFileSync(join(home(), f), "utf8"));
      if (m?.[1]) out.push(m[1].trim());
    } catch {
      // no such file
    }
  }
  return [...new Set([...out, "hicolor", "Adwaita"])];
}

/** How good a file is as an icon: big raster first, then SVG, then small raster. */
function score(path: string): number {
  const ext = extname(path);
  const size = Number(/\/(\d+)x\d+(?:@\d)?\//.exec(path)?.[1] ?? 0);
  if (ext === ".svg") return path.includes("symbolic") ? 10 : 60;
  if (size >= 64) return 100 - Math.abs(size - PX) / 10;
  return size || 30;
}

function walk(dir: string, depth: number, into: Map<string, Found>): void {
  if (depth > 5) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    const ext = extname(n);
    if (ext === ".png" || ext === ".svg") {
      const key = basename(n, ext);
      const s = score(p);
      const had = into.get(key);
      if (!had || s > had.score) into.set(key, { path: p, score: s });
    } else if (!ext) {
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1, into);
      } catch {
        // gone
      }
    }
  }
}

/** Every icon name the themes have (built once, on the first notification). */
function iconIndex(): Map<string, Found> {
  if (index) return index;
  const into = new Map<string, Found>();
  const bases = [join(home(), ".local/share/icons"), join(home(), ".icons"), "/usr/share/icons"];
  // Lower priority first: a later (preferred) theme's icon replaces only when it scores higher or equal.
  const order = [...themes()].reverse();
  for (const t of order)
    for (const b of bases) {
      const part = new Map<string, Found>();
      walk(join(b, t), 0, part);
      for (const [k, v] of part) {
        const had = into.get(k);
        if (!had || v.score + 5 >= had.score) into.set(k, v);
      }
    }
  walk("/usr/share/pixmaps", 0, into);
  index = into;
  return into;
}

function desktopIcon(entry: string): string | null {
  const dirs = [join(home(), ".local/share/applications"), "/usr/share/applications"];
  for (const d of dirs) {
    const f = join(d, entry.endsWith(".desktop") ? entry : `${entry}.desktop`);
    try {
      return /^Icon=(.+)$/m.exec(readFileSync(f, "utf8"))?.[1]?.trim() ?? null;
    } catch {
      // not here
    }
  }
  return null;
}

function toPng(path: string): string | null {
  try {
    if (statSync(path).size > MAX_FILE * 4) return null;
    if (path.endsWith(".svg"))
      return execFileSync("rsvg-convert", ["-w", String(PX), "-h", String(PX), path], {
        maxBuffer: 4_000_000,
        timeout: 3000,
      }).toString("base64");
    const buf = readFileSync(path);
    return buf.length <= MAX_FILE ? buf.toString("base64") : null;
  } catch {
    return null;
  }
}

function resolve(name: string): string | null {
  if (!name) return null;
  const n = name.replace(/^file:\/\//, "");
  if (n.startsWith("/")) return existsSync(n) ? n : null;
  return iconIndex().get(n)?.path ?? iconIndex().get(n.toLowerCase())?.path ?? null;
}

/** The app's icon: a key (stable per icon file) and its PNG, or null. */
export function laptopIcon(
  icon: string,
  desktopEntry: string,
  app: string,
): { key: string; png: string } | null {
  const id = `${icon}|${desktopEntry}|${app}`;
  if (cache.has(id)) return cache.get(id) ?? null;
  let out: { key: string; png: string } | null = null;
  const tries = [
    icon,
    desktopEntry && desktopIcon(desktopEntry),
    desktopEntry,
    app,
    app.toLowerCase().replace(/\s+/g, "-"),
  ];
  for (const t of tries) {
    const path = typeof t === "string" ? resolve(t) : null;
    const png = path ? toPng(path) : null;
    if (path && png) {
      out = { key: createHash("sha256").update(path).digest("hex").slice(0, 16), png };
      break;
    }
  }
  cache.set(id, out);
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return out;
}

/** A picture file (image-path) small enough to send, in base64, or undefined. */
export function laptopPicture(path: string): string | undefined {
  const p = path.replace(/^file:\/\//, "");
  if (!p.startsWith("/") || !/\.(png|jpe?g|webp)$/i.test(p)) return undefined;
  try {
    return statSync(p).size <= MAX_FILE ? readFileSync(p).toString("base64") : undefined;
  } catch {
    return undefined;
  }
}

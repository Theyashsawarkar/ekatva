/**
 * The laptop's notifications, kept for the phone's history (the newest
 * 300, saved across restarts in the state directory; never the phone's
 * own, which ekatva posts itself).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaptopNoteEntry, LaptopNoteHistory } from "@ekatva/protocol";
import { dirs } from "../paths.js";
import { laptopIcon } from "./laptopIcons.js";

/** Where an icon came from (icon, desktop entry, app), so it can be found again after a restart. */
type Source = [string, string, string];

const KEEP = 300;

export class LaptopHistory {
  private items: LaptopNoteEntry[] = [];
  private icons = new Map<string, string>();
  private sources: Record<string, Source> = {};
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly file = join(dirs.state(), "laptop-notifications.json")) {
    try {
      const got = JSON.parse(readFileSync(this.file, "utf8")) as {
        items?: LaptopNoteEntry[];
        sources?: Record<string, Source>;
      };
      this.items = Array.isArray(got.items) ? got.items.slice(0, KEEP) : [];
      this.sources = got.sources && typeof got.sources === "object" ? got.sources : {};
    } catch {
      this.items = [];
    }
  }

  add(e: LaptopNoteEntry, icon: { key: string; png: string } | null, source?: Source): void {
    if (icon) {
      this.icons.set(icon.key, icon.png);
      if (source) this.sources[icon.key] = source;
    }
    // the same id again (replaced in place): the newer one wins
    this.items = [e, ...this.items.filter((x) => x.id !== e.id)].slice(0, KEEP);
    this.saveSoon();
  }

  /** Newest first; icons only for what's listed and known since the daemon started. */
  list(): LaptopNoteHistory {
    const icons: Record<string, string> = {};
    for (const x of this.items) {
      if (!x.icon || icons[x.icon]) continue;
      let png = this.icons.get(x.icon);
      const src = this.sources[x.icon];
      if (!png && src) {
        png = laptopIcon(...src)?.png;
        if (png) this.icons.set(x.icon, png);
      }
      if (png) icons[x.icon] = png;
    }
    return { items: this.items, icons };
  }

  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirs.state(), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.tmp`;
        const used = new Set(this.items.map((x) => x.icon));
        const sources = Object.fromEntries(
          Object.entries(this.sources).filter(([k]) => used.has(k)),
        );
        writeFileSync(tmp, JSON.stringify({ items: this.items, sources }), { mode: 0o600 });
        renameSync(tmp, this.file);
      } catch {
        // the history is a convenience: never fail a notification over it
      }
    }, 2000);
    this.saveTimer.unref?.();
  }
}

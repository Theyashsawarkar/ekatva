/**
 * Writes Jyoti's flame as SVG files, from src/ui/jyoti-art.ts (the one
 * source), for the places outside this app: Darpaṇa (the full flames), the
 * bar (the small ones, in colour) and kendra (the one-colour glyph).
 *
 *   node apps/mobile/scripts/jyoti-art.mjs [out-dir]    default: apps/mobile/assets/jyoti
 *
 *   flame-<name>.svg       the full flame, 200 × 200 (any size from ~40 px)
 *   small-<name>.svg       two layers, no sparks: exactly 18 px (the bar)
 *   small-<name>@2.svg     the same at 36 px, for a 2× screen
 *   glyph.svg              one colour (currentColor), for kendra
 *
 * All vectors: drawn at the size shown, never a scaled picture.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flame, glyph, small } from "../src/ui/jyoti-art.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, "..", "assets", "jyoti");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const NAMES = { off: "shanta", on: "akhanda", high: "nandadipa" };
for (const [level, name] of Object.entries(NAMES)) {
  writeFileSync(join(out, `flame-${name}.svg`), `${flame(level)}\n`);
  writeFileSync(join(out, `small-${name}.svg`), `${small(level, 18)}\n`);
  writeFileSync(join(out, `small-${name}@2.svg`), `${small(level, 36)}\n`);
}
writeFileSync(join(out, "glyph.svg"), `${glyph()}\n`);
console.log(`wrote Jyoti's flame to ${out}`);

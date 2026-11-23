/**
 * Jyoti's flame: the one source for every place it's drawn (the phone's
 * tile; and, through scripts/jyoti-art.mjs, the SVG files Darpaṇa, kendra
 * and the bar use).
 *
 * The flame alone, in three layers with flying sparks, all vectors, so it's
 * sharp at any size (~/Documents/mockups/ekatva-jyoti-flame.html):
 *
 *   Śānta      the same flame at dusk: its colour drained to quiet lilacs,
 *              no sparks (~/Documents/mockups/ekatva-jyoti-shanta.html)
 *   Akhaṇḍa    a blue flame: deep blue outside, an ice-blue heart
 *   Nandādīpa  a bright red flame: red outside, orange, a yellow heart
 *
 * Three forms: `flame()`, the full drawing (any size from ~40 px up);
 * `small()`, two layers and no sparks, clear at 18 px (the bar); and
 * `glyph()`, one colour (`currentColor`), for places that colour their
 * icons themselves (kendra).
 *
 * No imports: scripts/jyoti-art.mjs runs this file with plain Node.
 */

export type Level = "off" | "on" | "high";

/** The levels' colours, as everywhere: lilac at rest, blue Akhaṇḍa, ember Nandādīpa. */
export const LEVEL_COLOR: Record<Level, string> = {
  off: "#cbbfd8",
  on: "#86aee0",
  high: "#e58b52",
};

/** What each flame is called, for screen readers (the SVG's title). */
export const LEVEL_NAME: Record<Level, string> = { off: "Śānta", on: "Akhaṇḍa", high: "Nandādīpa" };

/** Each level's fire: the outer layer (a gradient, top to bottom), the middle, the heart. */
export const FIRE: Record<Level, { top: string; bottom: string; middle: string; core: string }> = {
  off: { top: "#3b3149", bottom: "#4d4160", middle: "#6b5d82", core: "#a597bf" },
  on: { top: "#1c44cf", bottom: "#2f6ff2", middle: "#4d95ff", core: "#b4ddff" },
  high: { top: "#ee1c15", bottom: "#ff5414", middle: "#ff7d1f", core: "#ffcd3c" },
};

/* The flame, on a 200 × 200 grid: a tall tongue leaning left between two
   smaller ones; the middle and the heart nest inside it. */
const OUTER =
  "M100 190C70 190 44 172 42 142C40 120 50 106 58 92C62 86 60 80 56 72C64 80 72 92 72 104C72 84 80 68 86 52C92 38 92 24 86 12C108 26 122 46 122 66C122 76 120 84 116 90C128 84 140 76 148 60C152 80 160 96 160 120C160 160 132 190 100 190Z";
const MIDDLE =
  "M100 186C76 186 58 170 58 146C58 128 66 116 74 106C76 114 80 120 86 122C84 106 90 90 102 76C106 90 116 100 122 108C124 100 126 96 132 92C138 104 142 118 142 136C142 166 124 186 100 186Z";
const CORE =
  "M100 182C84 182 74 170 74 154C74 138 86 126 98 112C100 124 108 128 114 134C122 142 126 150 126 158C126 172 114 182 100 182Z";
/** Sparks flying off the top: wisps pointed at both ends. */
const SPARKS = [
  "M126 14C136 26 137 40 124 52C121 40 118 30 126 14Z",
  "M54 48C60 57 61 65 52 74C50 66 47 58 54 48Z",
  "M162 34C167 42 168 50 160 58C158 51 157 43 162 34Z",
];

const title = (level: Level) => `<title>Jyoti: ${LEVEL_NAME[level]}</title>`;
const svg = (body: string, size = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg"${size} viewBox="0 0 200 200">${body}</svg>`;

function layers(level: Level, full: boolean): string {
  const c = FIRE[level];
  const id = `jyoti-${level}${full ? "" : "-small"}`;
  const sparks =
    full && level !== "off" ? SPARKS.map((d) => `<path d="${d}" fill="${c.top}"/>`) : [];
  return [
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.top}"/><stop offset="1" stop-color="${c.bottom}"/></linearGradient></defs>`,
    ...sparks,
    `<path d="${OUTER}" fill="url(#${id})"/>`,
    full ? `<path d="${MIDDLE}" fill="${c.middle}"/>` : "",
    `<path d="${CORE}" fill="${c.core}"/>`,
  ].join("");
}

/** The full flame: three layers, and sparks when it's lit. */
export function flame(level: Level): string {
  return svg(title(level) + layers(level, true));
}

/**
 * The flame for 18 px: the outer layer and the heart, no sparks, so it stays
 * clear that small. `px` sets its size (the bar draws it at exactly 18, or
 * 36 on a 2× screen); without it, it fills whatever box it's in.
 */
export function small(level: Level, px?: number): string {
  return svg(title(level) + layers(level, false), px ? ` width="${px}" height="${px}"` : "");
}

/** One colour (`currentColor`), the heart cut out: for icons their place colours. */
export function glyph(): string {
  return svg(
    `<title>Jyoti</title><path d="${OUTER} ${CORE}" fill="currentColor" fill-rule="evenodd"/>`,
  );
}

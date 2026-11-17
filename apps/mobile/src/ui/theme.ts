/**
 * Lacquer and brass (see ~/Documents/mockups/ekatva-prototype.html): a warm
 * near-black, brass for where you are, and a few colours that each mean one
 * thing everywhere:
 *   brass  where you are, actions     sage   working, done
 *   amber  an agent asks you          rose   root, danger
 *   steel  the connection             cool   jyoti Akhaṇḍa
 *   ember  jyoti Nandādīpa, held keys
 * `k` holds the design's own tokens; `c` keeps the older names (pointing at
 * the same palette) for code that still uses them.
 * Colours used with an alpha suffix (`${k.rose}2e`) must stay #rrggbb.
 */
export const k = {
  bg: "#0f0c13",
  ink: "#16121b",
  ink2: "#1d1824",
  plum: "#262030",
  plum2: "#302838",
  /** The terminal's own black. */
  term: "#120f17",
  line: "rgba(236,224,206,0.09)",
  line2: "rgba(236,224,206,0.16)",
  text: "#efe7dc",
  sub: "#b9ad9f",
  // 4.5:1 on ink and ink2 for small text (was #857a6e, ~4.4:1).
  mute: "#958a7d",
  brass: "#cdb38a",
  brass2: "#e3cfa9",
  sage: "#9cbf9a",
  amber: "#e3a857",
  rose: "#e2706d",
  steel: "#8ea8c6",
  cool: "#86aee0",
  /** Jyoti at rest (Śānta): the unlit lamp's lilac-grey. */
  rest: "#cbbfd8",
  ember: "#e58b52",
  /** Text on a filled colour: each colour's own dark. */
  onSage: "#152013",
  onAmber: "#2a1d0c",
  onRose: "#2a0f0e",
  onCool: "#0f1a29",
  onEmber: "#2b1305",
  /** A volume or brightness level's fill. */
  fill: "#e9dfd1",
};

/** Corner radii. */
export const r = { s: 14, m: 20, l: 28, tile: 26 };

/** Families by role: the font files' names, built in by the expo-font plugin (app.json). */
export const font = {
  display: "Bricolage-700",
  displaySemi: "Bricolage-600",
  body: "Onest-400",
  medium: "Onest-500",
  semi: "Onest-600",
  bold: "Onest-700",
  deva: "Tiro-400",
  mono: "JetBrainsMono-400",
  monoSemi: "JetBrainsMono-600",
};

/** The older names, on the new palette. */
export const c = {
  crust: k.bg,
  base: k.ink,
  surface: k.ink2,
  overlay: k.plum,
  muted: "#4a4150",
  subtle: k.mute,
  dim: k.sub,
  text: k.text,
  sub: "#d6ccbf",
  accent: k.brass2,
  blue: k.brass2,
  indigo: "#a99bc9",
  teal: k.steel,
  green: k.sage,
  yellow: k.amber,
  gold: k.amber,
  orange: k.amber,
  red: k.rose,
  rose: k.rose,
  pink: k.rose,
  purple: "#b49ac9",
  gray: k.mute,
  line: k.line,
  glass: k.ink2,
  glassEdge: k.line,
  glassTop: k.line2,
};

/** Kept for older code: flat pairs on the new palette (the design has no gradient washes). */
export const grad = {
  action: [k.brass2, k.brass] as const,
  on: [k.cool, k.cool] as const,
  strong: [k.ember, k.ember] as const,
  needs: [`${k.amber}22`, `${k.amber}12`, k.ink2] as const,
  glass: [k.ink2, k.ink2] as const,
};

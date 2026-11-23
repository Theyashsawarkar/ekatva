import { describe, expect, it } from "vitest";
import { FIRE, flame, glyph, type Level, small } from "../src/ui/jyoti-art";

const LEVELS: Level[] = ["off", "on", "high"];

describe("Jyoti's flame", () => {
  it("is a vector at every size: no pictures, no pixel grids, no blur", () => {
    for (const l of LEVELS)
      for (const svg of [flame(l), small(l, 18), small(l)]) {
        expect(svg).toMatch(/viewBox="0 0 200 200"><title>Jyoti: /);
        expect(svg).not.toMatch(/<image|crispEdges|<rect|filter|blur/);
      }
    expect(small("on", 18)).toContain('width="18" height="18"');
    expect(small("on", 36)).toContain('width="36" height="36"');
    expect(small("on")).not.toContain("width=");
  });

  it("burns blue for Akhaṇḍa, red for Nandādīpa, and rests at dusk for Śānta", () => {
    expect(flame("on")).toContain(FIRE.on.core);
    expect(flame("high")).toContain(FIRE.high.top);
    expect(flame("off")).toContain(FIRE.off.middle);
    // Sparks fly only when it's lit; the small flame has none, nor a middle layer.
    const paths = (s: string) => (s.match(/<path /g) ?? []).length;
    expect(paths(flame("on"))).toBe(6);
    expect(paths(flame("off"))).toBe(3);
    expect(paths(small("high"))).toBe(2);
  });

  it("gives each level its own gradient, so three flames on one screen don't share one", () => {
    const ids = LEVELS.flatMap((l) => [flame(l), small(l)].map((s) => /id="([^"]+)"/.exec(s)?.[1]));
    expect(new Set(ids).size).toBe(6);
  });

  it("has a one-colour glyph with its heart cut out", () => {
    expect(glyph()).toContain('fill="currentColor" fill-rule="evenodd"');
  });
});

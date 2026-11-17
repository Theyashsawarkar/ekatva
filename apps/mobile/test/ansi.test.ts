import { describe, expect, it } from "vitest";
import { color256, PALETTE, parseAnsi } from "../src/ui/ansi";

describe("a terminal screen's colours", () => {
  it("turns SGR escapes into styled runs, per line", () => {
    const lines = parseAnsi("\x1b[1;32myash\x1b[0m@ace \x1b[38;5;196mred\x1b[39m\n\x1b[2Kplain");
    expect(lines[0]).toEqual([
      { text: "yash", style: { bold: true, fg: PALETTE[2] } },
      { text: "@ace ", style: {} },
      { text: "red", style: { fg: color256(196) } },
    ]);
    expect(lines[1]).toEqual([{ text: "plain", style: {} }]);
  });

  it("knows the 256 colours and true colour", () => {
    expect(color256(16)).toBe("#000000");
    expect(color256(231)).toBe("#ffffff");
    expect(color256(244)).toBe("#808080");
    expect(parseAnsi("\x1b[48;2;1;2;3mx")[0]?.[0]?.style.bg).toBe("#010203");
  });
});

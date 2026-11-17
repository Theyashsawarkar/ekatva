import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageDir, saveImage } from "../src/services/phoneImages.js";

// a 1x1 PNG
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("phone notification images", () => {
  const old = process.env.XDG_CACHE_HOME;
  beforeEach(() => {
    process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "ekatva-img-"));
  });
  afterEach(() => {
    process.env.XDG_CACHE_HOME = old;
  });

  it("writes an app's icon once, under its package", () => {
    const a = saveImage("app", "com.whatsapp", PNG);
    const b = saveImage("app", "com.whatsapp", PNG);
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a?.startsWith(imageDir())).toBe(true);
    expect(
      readFileSync(a as string)
        .subarray(1, 4)
        .toString(),
    ).toBe("PNG");
  });

  it("keeps a picture by its content, and skips what isn't there", () => {
    const p = saveImage("pic", "", PNG);
    expect(p && existsSync(p)).toBe(true);
    expect(saveImage("pic", "", undefined)).toBeUndefined();
    expect(saveImage("app", "x", "")).toBeUndefined();
  });
});

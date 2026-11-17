import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LaptopFiles } from "../src/services/files.js";

describe("the Files landing view", () => {
  it("gives the space left and the newest files, skipping hidden, built and private places", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "ekatva-ov-"));
    const at = async (p: string, ago: number) => {
      await fs.mkdir(join(root, p, ".."), { recursive: true });
      await fs.writeFile(join(root, p), "x");
      const t = new Date(Date.now() - ago * 1000);
      await fs.utimes(join(root, p), t, t);
    };
    await at("notes/old.md", 500);
    await at("codes/app/src/new.ts", 10);
    await at("codes/app/node_modules/dep/index.js", 1);
    await at(".cache/blob", 1);
    await at("secrets/key", 2);
    const f = new LaptopFiles({
      roots: [root],
      private: [join(root, "secrets")],
      undoDir: join(root, ".undo"),
      forbidden: [],
    });
    const o = await f.overview({ allowPrivate: false });
    expect(o.recent.map((e) => e.name)).toEqual(["new.ts", "old.md"]);
    expect(o.disk && o.disk.total > o.disk.free).toBe(true);
    const all = await f.overview({ allowPrivate: true });
    expect(all.recent.map((e) => e.name)).toContain("key");
    await fs.rm(root, { recursive: true, force: true });
  });
});

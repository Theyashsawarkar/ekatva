import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Devices } from "../src/devices.js";

test("saves at the same moment don't race on the temporary file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ekatva-devices-"));
  const file = join(dir, "devices.json");
  const d = new Devices(file);
  await d.load();
  const s = d as unknown as { save(): Promise<void> };
  await Promise.all(Array.from({ length: 20 }, () => s.save()));
  expect(JSON.parse(await readFile(file, "utf8"))).toBeDefined();
});

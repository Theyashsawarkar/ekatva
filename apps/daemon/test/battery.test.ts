import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { battery } from "../src/services/system.js";

async function supply(root: string, name: string, files: Record<string, string>) {
  await mkdir(join(root, name), { recursive: true });
  for (const [f, v] of Object.entries(files)) await writeFile(join(root, name, f), `${v}\n`);
}

test("held at a charge limit with the charger in: plugged in, not on battery", async () => {
  const root = await mkdtemp(join(tmpdir(), "ekatva-ps-"));
  await supply(root, "AC", { type: "Mains", online: "1" });
  await supply(root, "BAT0", { type: "Battery", status: "Not charging", capacity: "80" });
  expect(battery(root)).toEqual({ percent: 80, charging: false, plugged: true });
});

test("charging, and on battery", async () => {
  const root = await mkdtemp(join(tmpdir(), "ekatva-ps-"));
  await supply(root, "AC", { type: "Mains", online: "0" });
  await supply(root, "BAT0", { type: "Battery", status: "Discharging", capacity: "54" });
  expect(battery(root)).toEqual({ percent: 54, charging: false, plugged: false });
  await supply(root, "AC", { type: "Mains", online: "1" });
  await supply(root, "BAT0", { type: "Battery", status: "Charging", capacity: "54" });
  expect(battery(root)).toEqual({ percent: 54, charging: true, plugged: true });
});

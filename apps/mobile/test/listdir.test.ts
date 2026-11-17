import { expect, test } from "vitest";
import { type Fs, PhoneFiles } from "../src/core/files";

test("a phone folder is listed in one call when the platform can, folders first, sorted", async () => {
  let stats = 0;
  const fs = {
    list: async () => [],
    stat: async () => {
      stats++;
      return null;
    },
    listDetailed: async (dir: string) =>
      dir === "/sd"
        ? [
            { name: "b.txt", isDir: false, size: 3, mtime: 2 },
            { name: "Music", isDir: true, size: 0, mtime: 1 },
            { name: "a.jpg", isDir: false, size: 9, mtime: 3 },
          ]
        : [],
  } as unknown as Fs;
  const f = new PhoneFiles(fs, ["/sd"], "/app/undo");
  const out = await f.list("~", { allowPrivate: false });
  expect(out.map((e) => `${e.kind}:${e.name}`)).toEqual(["dir:Music", "file:a.jpg", "file:b.txt"]);
  expect(out[1]).toMatchObject({ path: "~/a.jpg", size: 9, mtime: 3 });
  expect(stats).toBe(0);
});

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LaptopFiles } from "../src/services/files.js";

let root: string;
let home: string;
let files: LaptopFiles;
const open = { allowPrivate: false };
const b64 = (s: string) => Buffer.from(s).toString("base64");
const read = (p: string) => fs.readFile(join(home, p), "utf8");
const has = (p: string) =>
  fs.lstat(join(home, p)).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "ekatva-files-"));
  home = join(root, "home");
  await fs.mkdir(join(home, ".ssh"), { recursive: true });
  await fs.mkdir(join(home, ".local/state/ekatva"), { recursive: true });
  await fs.writeFile(join(home, ".ssh/id_ed25519"), "SECRET");
  await fs.writeFile(join(home, ".local/state/ekatva/devices.json"), "{}");
  await fs.writeFile(join(home, "notes.md"), "v1");
  await fs.mkdir(join(root, "outside"));
  await fs.writeFile(join(root, "outside/x"), "x");
  process.env.HOME = home;
  files = new LaptopFiles({
    roots: ["~"],
    private: ["~/.ssh"],
    undoDir: join(root, "undo"),
    forbidden: [join(home, ".local/state/ekatva")],
  });
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

describe("where the phone may go", () => {
  it("lists home, hiding ekatva's own state", async () => {
    const names = (await files.list("~", open)).map((e) => e.name);
    expect(names).toContain("notes.md");
    expect(names).toContain(".ssh");
    expect((await files.list("~/.local/state", open)).map((e) => e.name)).not.toContain("ekatva");
  });

  it("refuses paths outside the roots, also through .. and symlinks", async () => {
    await expect(
      files.read({ path: join(root, "outside/x"), offset: 0, length: 10 }, open),
    ).rejects.toThrow(/outside/);
    await expect(
      files.read({ path: "~/../outside/x", offset: 0, length: 10 }, open),
    ).rejects.toThrow(/outside/);
    await fs.symlink(join(root, "outside"), join(home, "link"));
    await expect(files.read({ path: "~/link/x", offset: 0, length: 10 }, open)).rejects.toThrow(
      /outside/,
    );
    await expect(
      files.write({ path: "~/link/new", data: b64("x"), mode: "create" }, open),
    ).rejects.toThrow(/outside/);
  });

  it("never reaches ekatva's state, even with the private grant", async () => {
    for (const a of [open, { allowPrivate: true }]) {
      await expect(
        files.read({ path: "~/.local/state/ekatva/devices.json", offset: 0, length: 10 }, a),
      ).rejects.toThrow(/ekatva's own/);
      await expect(files.remove("~/.local", a)).rejects.toThrow(/ekatva's own/);
      await expect(
        files.move({ from: "~/.local", to: "~/elsewhere", overwrite: false }, a),
      ).rejects.toThrow(/ekatva's own/);
    }
  });

  it("keeps private places closed without their grant", async () => {
    await expect(
      files.read({ path: "~/.ssh/id_ed25519", offset: 0, length: 10 }, open),
    ).rejects.toThrow(/private/);
    await expect(
      files.copy({ from: "~", to: "/tmp/all", overwrite: false }, open),
    ).rejects.toThrow();
    const r = await files.read(
      { path: "~/.ssh/id_ed25519", offset: 0, length: 10 },
      { allowPrivate: true },
    );
    expect(Buffer.from(r.data, "base64").toString()).toBe("SECRET");
  });
});

describe("changes, and undoing them", () => {
  it("overwrite → undo restores the old version → undo again (redo)", async () => {
    const d = await files.write({ path: "~/notes.md", data: b64("v2"), mode: "overwrite" }, open);
    expect(await read("notes.md")).toBe("v2");
    const back = await files.undo(d.undo!);
    expect(await read("notes.md")).toBe("v1");
    await files.undo(back.undo!);
    expect(await read("notes.md")).toBe("v2");
  });

  it("create refuses to clobber; undo of a create removes it", async () => {
    await expect(
      files.write({ path: "~/notes.md", data: b64("x"), mode: "create" }, open),
    ).rejects.toThrow(/exists/);
    const d = await files.write({ path: "~/a/b/new.txt", data: b64("hi"), mode: "create" }, open);
    expect(await read("a/b/new.txt")).toBe("hi");
    await files.undo(d.undo!);
    expect(await has("a/b/new.txt")).toBe(false);
  });

  it("delete a whole folder → undo brings all of it back", async () => {
    await fs.mkdir(join(home, "proj/src"), { recursive: true });
    await fs.writeFile(join(home, "proj/src/a.ts"), "a");
    const d = await files.remove("~/proj", open);
    expect(await has("proj")).toBe(false);
    await files.undo(d.undo!);
    expect(await read("proj/src/a.ts")).toBe("a");
    await expect(files.remove("~", open)).rejects.toThrow(/whole shared folder|ekatva.s own/);
  });

  it("move over something keeps it; undo moves back and restores it", async () => {
    await fs.writeFile(join(home, "other.md"), "other");
    await expect(
      files.move({ from: "~/notes.md", to: "~/other.md", overwrite: false }, open),
    ).rejects.toThrow(/exists/);
    const d = await files.move({ from: "~/notes.md", to: "~/other.md", overwrite: true }, open);
    expect(await read("other.md")).toBe("v1");
    await files.undo(d.undo!);
    expect(await read("notes.md")).toBe("v1");
    expect(await read("other.md")).toBe("other");
  });

  it("append → undo cuts it back, unless it changed since", async () => {
    const d = await files.write({ path: "~/notes.md", data: b64("+more"), mode: "append" }, open);
    expect(await read("notes.md")).toBe("v1+more");
    const back = await files.undo(d.undo!);
    expect(await read("notes.md")).toBe("v1");
    await files.undo(back.undo!);
    expect(await read("notes.md")).toBe("v1+more");
    const d2 = await files.write({ path: "~/notes.md", data: b64("!"), mode: "append" }, open);
    await fs.appendFile(join(home, "notes.md"), "edited by hand");
    await expect(files.undo(d2.undo!)).rejects.toThrow(/changed since/);
  });

  it("copy and mkdir undo; reads come in chunks", async () => {
    const c = await files.copy({ from: "~/notes.md", to: "~/copy.md", overwrite: false }, open);
    await files.undo(c.undo!);
    expect(await has("copy.md")).toBe(false);
    const m = await files.mkdir("~/folder", open);
    await files.undo(m.undo!);
    expect(await has("folder")).toBe(false);
    await fs.writeFile(join(home, "big"), "0123456789");
    const r = await files.read({ path: "~/big", offset: 4, length: 3 }, open);
    expect(Buffer.from(r.data, "base64").toString()).toBe("456");
    expect(r).toMatchObject({ size: 10, eof: false });
  });

  it("prunes the undo store by age and size", async () => {
    await files.remove("~/notes.md", open);
    expect(await files.store.prune(30, 1)).toBe(1);
  });
});

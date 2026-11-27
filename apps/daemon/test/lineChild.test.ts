import { describe, expect, it } from "vitest";
import { debounce, LineChild } from "../src/services/lineChild.js";
import { fakeSpawn, until } from "./fakeChild.js";

describe("a long-lived helper read line by line", () => {
  it("hands over whole lines, however they arrive", async () => {
    const spawn = fakeSpawn();
    const lines: string[] = [];
    const c = new LineChild({ cmd: "x", args: [], spawn, onLine: (l) => lines.push(l) });
    c.start();
    const p = spawn.procs[0];
    p?.stdout.write("one\ntw");
    p?.stdout.write("o\nthree");
    await until(() => lines.length === 2);
    expect(lines).toEqual(["one", "two"]);
    c.stop();
    expect(p?.killed).toBe(true);
  });

  it("comes back after it dies, later each time, and gives up when it keeps dying", async () => {
    const spawn = fakeSpawn();
    const downs: string[] = [];
    const c = new LineChild({
      cmd: "x",
      args: [],
      spawn,
      onLine: () => {},
      onDown: (why) => downs.push(why),
      minMs: 5,
      maxMs: 20,
      giveUpAfter: 3,
    });
    c.start();
    spawn.procs[0]?.exit(1);
    await until(() => spawn.procs.length === 2);
    spawn.procs[1]?.exit(1);
    await until(() => spawn.procs.length === 3);
    spawn.procs[2]?.exit(1);
    await until(() => downs.length === 1);
    expect(downs).toEqual(["failing"]);
    expect(c.running).toBe(false);
  });

  it("says when it isn't installed, and doesn't try again", async () => {
    const spawn = fakeSpawn(["wl-paste"]);
    const downs: string[] = [];
    const c = new LineChild({
      cmd: "wl-paste",
      args: [],
      spawn,
      onLine: () => {},
      onDown: (why) => downs.push(why),
      minMs: 5,
    });
    c.start();
    await until(() => downs.length === 1);
    expect(downs).toEqual(["missing"]);
    await new Promise((r) => setTimeout(r, 30));
    expect(spawn.procs).toHaveLength(1);
  });

  it("doesn't come back once stopped", async () => {
    const spawn = fakeSpawn();
    const c = new LineChild({ cmd: "x", args: [], spawn, onLine: () => {}, minMs: 5 });
    c.start();
    c.stop();
    await new Promise((r) => setTimeout(r, 30));
    expect(spawn.procs).toHaveLength(1);
  });

  it("debounces a burst into one call, and keeps a gap between calls", async () => {
    let n = 0;
    const d = debounce(() => n++, 10, 60);
    d();
    d();
    d();
    await until(() => n === 1);
    const at = Date.now();
    d();
    await until(() => n === 2);
    expect(Date.now() - at).toBeGreaterThanOrEqual(40);
    d();
    d.cancel();
    await new Promise((r) => setTimeout(r, 90));
    expect(n).toBe(2);
  });
});

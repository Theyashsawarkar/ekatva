/** A pretend child process for the event watchers: its output is whatever the test writes. */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { LineProc, Spawn } from "../src/services/lineChild.js";

export class FakeProc extends EventEmitter implements LineProc {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  /** What was written to its stdin. */
  input: string[] = [];
  killed = false;

  constructor(
    readonly cmd: string,
    readonly args: string[],
  ) {
    super();
    this.stdout.setEncoding("utf8");
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (d: string) => this.input.push(...d.split("\n").filter(Boolean)));
  }

  /** Writes lines on its stdout. */
  say(...lines: string[]): void {
    this.stdout.write(lines.map((l) => `${l}\n`).join(""));
  }

  /** It ends by itself. */
  exit(code = 0, stderr = ""): void {
    if (stderr) this.stderr.write(stderr);
    setImmediate(() => this.emit("exit", code, null));
  }

  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }
}

/** A spawn that records each child; `missing` commands fail as if not installed. */
export function fakeSpawn(missing: string[] = []): Spawn & { procs: FakeProc[] } {
  const procs: FakeProc[] = [];
  const spawn = ((cmd: string, args: string[]) => {
    const p = new FakeProc(cmd, args);
    procs.push(p);
    if (missing.includes(cmd))
      setImmediate(() =>
        p.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })),
      );
    return p;
  }) as Spawn & { procs: FakeProc[] };
  spawn.procs = procs;
  return spawn;
}

export const until = async (f: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
};

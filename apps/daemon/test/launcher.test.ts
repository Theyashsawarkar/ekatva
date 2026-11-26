/**
 * The installed `ekatva` (bin/ekatva, a sh launcher), in a copy of the
 * repo's layout with stand-ins for the TypeScript CLI, ekatva-rs and
 * pranali that say how they were called.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
let root: string;
let launcher: string;
let ts: string;
let rs: string;
let dist: string;
let withPranali: string;

const stand = async (path: string, name: string) => {
  await fs.mkdir(join(path, ".."), { recursive: true });
  await fs.writeFile(path, `#!/bin/sh\necho "${name} $* \${EKATVA_TS_CLI:-}"\n`, { mode: 0o755 });
};

function run(args: string[], pranali = false, more: Record<string, string> = {}) {
  return execFileSync(launcher, args, {
    env: { PATH: pranali ? `${withPranali}:/usr/bin:/bin` : "/usr/bin:/bin", ...more },
    encoding: "utf8",
  }).trim();
}

const age = (path: string, s: number) => fs.utimes(path, s, s);

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "ekatva-launch-")));
  launcher = join(root, "apps/daemon/bin/ekatva");
  ts = join(root, "apps/daemon/bin/ekatva.js");
  rs = join(root, "apps/daemon-rs/target/release/ekatva-rs");
  dist = join(root, "apps/daemon/dist/cli.js");
  withPranali = join(root, "path");
  await fs.mkdir(join(root, "apps/daemon/bin"), { recursive: true });
  await fs.copyFile(join(here, "../bin/ekatva"), launcher);
  await fs.chmod(launcher, 0o755);
  await stand(ts, "ts");
  await stand(rs, "rs");
  await stand(join(withPranali, "pranali"), "pranali");
  await fs.mkdir(join(root, "apps/daemon/dist"));
  await fs.writeFile(dist, "");
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("bin/ekatva", () => {
  it("runs the waybar watcher in Rust when it's built after the TypeScript", async () => {
    await age(dist, 1_000_000);
    await age(rs, 2_000_000);
    expect(run(["call", "--waybar"])).toBe(`rs call --waybar ${ts}`);
    // Anything else is the TypeScript CLI's.
    expect(run(["call"])).toBe("ts call");
    expect(run(["status"])).toBe("ts status");
  });

  it("falls back to TypeScript when ekatva-rs is older than its dist (a stale build)", async () => {
    await age(dist, 3_000_000);
    await age(rs, 2_000_000);
    expect(run(["call", "--waybar"])).toBe("ts call --waybar");
  });

  it("sends `mcp` to pranali when it's installed, with the TypeScript server as fallback", () => {
    expect(run(["mcp"], true, { EKATVA_AGENT: "claude" })).toBe(
      `pranali ekatva --agent claude --fallback ${ts} mcp --in-process`,
    );
    expect(run(["mcp"], true)).toBe(
      `pranali ekatva --agent agent --fallback ${ts} mcp --in-process`,
    );
    expect(run(["mcp"])).toBe("ts mcp");
  });
});

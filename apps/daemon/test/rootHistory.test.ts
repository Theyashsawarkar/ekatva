import * as fs from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RootBridge } from "../src/services/root.js";

describe("root requests' history", () => {
  it("says how each ended and who answered it, newest first, and remembers after a restart", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "ekatva-rh-"));
    const log = join(dir, "requests.jsonl");
    const answers = join(dir, "root-answers.json");
    const bridge = new RootBridge(
      join(dir, "root.sock"),
      () => undefined,
      () => undefined,
      answers,
      log,
    );
    await bridge.listen();
    // A window asks; the phone denies it.
    const s = netConnect(join(dir, "root.sock"));
    await new Promise((r) => s.once("connect", r));
    s.write(
      `${JSON.stringify({ t: "request", v: 1, id: "req-a", via: "anumati", requester: "Claude Code", reason: "r", commands: [{ cmd: "true", why: "w" }] })}\n`,
    );
    for (let i = 0; i < 100 && !bridge.list().length; i++)
      await new Promise((r) => setTimeout(r, 10));
    await bridge.respond(bridge.list()[0]?.id ?? "", false, null, null);
    // dvarapala logs both: this one, and one answered on the laptop that ran.
    await fs.writeFile(
      log,
      [
        {
          time: 100,
          id: "req-b",
          requester: "Claude Code",
          reason: "update",
          status: "completed",
          commands: [
            { cmd: "pacman -Syu", decision: "approved", state: "ok", exit_code: 0 },
            {
              cmd: "systemctl restart sddm",
              decision: "declined",
              state: "not_run",
              exit_code: null,
            },
          ],
        },
        {
          time: 200,
          id: "req-a",
          requester: "Claude Code",
          reason: "r",
          status: "denied",
          commands: [{ cmd: "true", decision: "declined", state: "not_run" }],
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    const h = await bridge.history();
    expect(h.map((e) => [e.id, e.status, e.where])).toEqual([
      ["req-a", "denied", "phone"],
      ["req-b", "completed", "laptop"],
    ]);
    expect(h[1]?.commands[0]).toEqual({
      cmd: "pacman -Syu",
      decision: "approved",
      state: "ok",
      exitCode: 0,
    });
    expect(h[1]?.at).toBe(100_000);
    s.destroy();
    await bridge.close();
    // A new daemon still knows the phone answered req-a.
    const again = new RootBridge(
      join(dir, "root2.sock"),
      () => undefined,
      () => undefined,
      answers,
      log,
    );
    expect((await again.history())[0]?.where).toBe("phone");
    expect(
      await new RootBridge(
        join(dir, "x.sock"),
        () => undefined,
        () => undefined,
        null,
        join(dir, "none"),
      ).history(),
    ).toEqual([]);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

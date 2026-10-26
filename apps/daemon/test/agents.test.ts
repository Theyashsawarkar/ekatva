import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentsService, tmuxOn } from "../src/services/agents.js";

// A private tmux server, never the user's sessions.
const socket = `ekatva-test-${process.pid}`;
const run = tmuxOn(socket);
let dir: string;
let agents: AgentsService;

// Run by a copy of bash named "claude", so tmux sees the command "claude" as it does the real one.
const FAKE_CLAUDE = `
printf '● Running the tests.\\n\\n'
printf ' Bash command\\n\\n   pnpm test\\n\\n Do you want to proceed?\\n'
printf ' ❯ 1. Yes\\n   2. Yes, and do not ask again\\n   3. No (esc)\\n'
read -r key
printf '\\n● chose %s\\n' "$key"
IFS= read -r line
printf '● got reply: %s\\n' "$line"
sleep 60
`;

const wait = async (f: () => Promise<boolean>) => {
  for (let i = 0; i < 60 && !(await f()); i++) await new Promise((r) => setTimeout(r, 100));
};

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "ekatva-agents-"));
  await fs.mkdir(join(dir, "bin"));
  await fs.copyFile("/usr/bin/bash", join(dir, "bin/claude"));
  await fs.chmod(join(dir, "bin/claude"), 0o755);
  await fs.writeFile(join(dir, "fake.sh"), FAKE_CLAUDE);
  await fs.mkdir(join(dir, "proj"));
  execFileSync("tmux", [
    "-L",
    socket,
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    "Aura",
    "-x",
    "120",
    "-y",
    "30",
    "-c",
    join(dir, "proj"),
    join(dir, "bin/claude"),
    join(dir, "fake.sh"),
  ]);
  agents = new AgentsService(run, []);
  await wait(async () => (await agents.list())[0]?.state === "waiting");
});
afterAll(async () => {
  agents.shutdown();
  try {
    execFileSync("tmux", ["-L", socket, "kill-server"]);
  } catch {}
  await fs.rm(dir, { recursive: true, force: true });
});

describe("agents in tmux", () => {
  it("finds the session and reads its question", async () => {
    const [s] = await agents.list();
    expect(s).toMatchObject({ session: "Aura", agent: "claude", state: "waiting" });
    expect(s?.question?.text).toBe("Do you want to proceed?");
    expect(s?.question?.options).toHaveLength(3);
  });

  it("refuses an answer to a question it no longer shows", async () => {
    const [s] = await agents.list();
    await expect(agents.answer(s!.id, "1", "stale-hash")).rejects.toThrow(/something else/);
    await expect(agents.answer(s!.id, "9", s!.question!.hash)).rejects.toThrow(
      /not one of the options/,
    );
  });

  it("answers by sending the option's key, then replies with paste", async () => {
    const [s] = await agents.list();
    const d = await agents.answer(s!.id, "2", s!.question!.hash);
    expect(d.summary).toMatch(/Answered "Yes, and do not ask again" in Aura/);
    // `read` needs Enter after the key in this fake; real Claude takes the key alone.
    await run(["send-keys", "-t", s!.id, "Enter"]);
    await wait(async () => (await agents.tail(s!.id, 20)).includes("chose 2"));
    expect(await agents.tail(s!.id, 20)).toContain("chose 2");
    await agents.reply(s!.id, "run only the unit tests");
    await wait(async () => (await agents.tail(s!.id, 20)).includes("got reply"));
    expect(await agents.tail(s!.id, 20)).toContain("got reply: run only the unit tests");
  });

  it("starts sessions only in known projects", async () => {
    await expect(agents.start("/etc", null, "claude")).rejects.toThrow(
      /isn't one of your projects/,
    );
    const projects = await agents.projects();
    expect(projects.map((p) => p.name)).toContain("proj");
  });
});

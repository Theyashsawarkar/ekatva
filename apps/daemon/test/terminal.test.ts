import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { tmuxOn } from "../src/services/agents.js";
import { FIRST_SESSION, keyName, sessionName, TerminalService } from "../src/services/terminal.js";

// A private tmux server: the user's own sessions are never touched.
const socket = `ekatva-term-test-${randomBytes(4).toString("hex")}`;
const tmux = tmuxOn(socket);
const term = new TerminalService(tmux);

afterAll(async () => {
  await tmux(["kill-server"]).catch(() => "");
});

const until = async (ok: () => Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await ok()) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
};

describe("a terminal on the laptop's tmux", () => {
  it("starts a session when there is none, runs what you type, and shows the screen", async () => {
    const sessions = await term.sessions();
    expect(sessions.map((s) => s.name)).toEqual([FIRST_SESSION]);
    const tabs = await term.tabs(FIRST_SESSION);
    expect(tabs).toHaveLength(1);
    const id = tabs[0]?.id ?? "";
    expect(id).toMatch(/^@\d+$/);
    await term.send(id, "echo ekatva-$((40+2))", ["Enter"]);
    let screen = await term.screen(id, 50);
    await until(async () => {
      screen = await term.screen(id, 50);
      return /ekatva-42/.test(screen.text);
    });
    expect(screen.text).toMatch(/ekatva-42/);
    const more = await term.newTab(FIRST_SESSION);
    expect(more.value).toHaveLength(2);
    const closed = await term.closeTab(more.value[1]?.id ?? "");
    expect(closed.value).toHaveLength(1);
    // tmux's own prefix, a split and copy mode, by the window's id.
    await term.send(id, null, ["Prefix", "Escape"]);
    await term.action(id, "split");
    expect(await tmux(["display-message", "-p", "-t", id, "#{window_panes}"])).toMatch(/^2/);
    await term.action(id, "scroll");
    expect(await tmux(["display-message", "-p", "-t", id, "#{pane_in_mode}"])).toMatch(/^1/);
  }, 20_000);

  it("lists every session and starts new ones at the phone's size", async () => {
    const made = await term.newSession("work", 48, 22);
    expect(made.value.map((s) => s.name).sort()).toEqual(["main", "work"]);
    const [tab] = await term.tabs("work");
    const screen = await term.screen(tab?.id ?? "", 0);
    expect(screen.cols).toBe(48);
    expect(screen.rows).toBe(22);
    const named = await term.newSession(null, 40, 20);
    expect(named.value).toHaveLength(3);
    // A window of any session can be read, by its id.
    expect((await term.screen(tab?.id ?? "", 0)).cols).toBe(48);
  }, 20_000);

  it("refuses what isn't a tab, a session or a key", async () => {
    await expect(term.screen("%3", 10)).rejects.toThrow(/not a terminal tab/);
    await expect(term.screen("@99999", 10)).rejects.toThrow(/closed/);
    await expect(term.tabs("nope")).rejects.toThrow(/no tmux session/);
    expect(() => sessionName("a:b")).toThrow(/not a session name/);
    expect(() => sessionName("=main")).toThrow(/not a session name/);
    expect(() => sessionName("x\ny")).toThrow(/not a session name/);
    expect(sessionName("OnAds_Super")).toBe("OnAds_Super");
    expect(keyName("C-c")).toBe("C-c");
    expect(keyName("Up")).toBe("Up");
    expect(keyName("Backspace")).toBe("BSpace");
    expect(() => keyName("C-c; kill-server")).toThrow(/not a key/);
    expect(() => keyName("Enter Enter")).toThrow(/not a key/);
  });
});

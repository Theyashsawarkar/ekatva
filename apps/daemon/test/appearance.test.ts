import { describe, expect, it } from "vitest";
import { type AppearanceHost, AppearanceService } from "../src/services/appearance.js";

/** A fake desktop: Vayu (varna + theme-toggle.sh) or plain GTK (gsettings), never the real one. */
function host(kind: "vayu" | "gtk" | "none", start: "light" | "dark") {
  let mode = start;
  const calls: string[] = [];
  const h: AppearanceHost = {
    exists: (p) => kind === "vayu" && p.endsWith("theme-toggle.sh"),
    run: async (cmd, args) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "varna")
        return kind === "vayu" ? { code: 0, out: `${mode}\n` } : { code: 127, out: "" };
      if (cmd.endsWith("theme-toggle.sh")) {
        mode = mode === "dark" ? "light" : "dark";
        return { code: 0, out: "" };
      }
      if (cmd === "gsettings" && kind === "gtk") {
        if (args[0] === "get")
          return { code: 0, out: mode === "dark" ? "'prefer-dark'\n" : "'default'\n" };
        mode = args[3] === "prefer-dark" ? "dark" : "light";
        return { code: 0, out: "" };
      }
      return { code: 127, out: "" };
    },
  };
  return { h, calls, now: () => mode };
}

describe("appearance", () => {
  it("Vayu: reads varna, and flips with theme-toggle.sh only when the mode differs", async () => {
    const f = host("vayu", "dark");
    const a = new AppearanceService(f.h, "/home/x/.local/bin/theme-toggle.sh");
    expect(await a.get()).toEqual({ mode: "dark", settable: true, why: null });
    const same = await a.set("dark");
    expect(same.undo).toBeUndefined();
    expect(f.calls.some((c) => c.includes("theme-toggle"))).toBe(false);
    const d = await a.set("light");
    expect(d.value.mode).toBe("light");
    expect(d.summary).toBe("Switched the laptop to light mode");
    expect(d.undo).toEqual({ kind: "appearance.set", data: { mode: "dark" } });
    expect(f.calls.filter((c) => c.includes("theme-toggle"))).toHaveLength(1);
  });

  it("elsewhere: GTK's color-scheme", async () => {
    const f = host("gtk", "light");
    const a = new AppearanceService(f.h, "/nowhere/theme-toggle.sh");
    expect((await a.get()).mode).toBe("light");
    await a.set("dark");
    expect(f.now()).toBe("dark");
    expect(f.calls).toContain("gsettings set org.gnome.desktop.interface color-scheme prefer-dark");
  });

  it("says why when it can't", async () => {
    const a = new AppearanceService(host("none", "dark").h, "/nowhere");
    const g = await a.get();
    expect(g.settable).toBe(false);
    expect(g.why).toMatch(/varna|gsettings/);
    await expect(a.set("light")).rejects.toThrow();
  });
});

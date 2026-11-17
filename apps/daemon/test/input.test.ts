import { describe, expect, it } from "vitest";
import { comboArgs, InputService } from "../src/services/input.js";

const recorder = () => {
  const calls: string[][] = [];
  return { calls, run: async (cmd: string, args: string[]) => void calls.push([cmd, ...args]) };
};

describe("the phone as trackpad", () => {
  it("scrolls like the laptop's touchpad: natural follows the fingers", async () => {
    const r = recorder();
    const natural = new InputService(r.run, async () => true);
    // Fingers move down the phone: content follows, so the wheel goes up (+).
    await natural.scroll(0, 2);
    const traditional = new InputService(r.run, async () => false);
    await traditional.scroll(0, 2);
    expect(r.calls).toEqual([
      ["ydotool", "mousemove", "-w", "-x", "0", "-y", "2"],
      ["ydotool", "mousemove", "-w", "-x", "0", "-y", "-2"],
    ]);
  });

  it("is natural when the laptop doesn't say", async () => {
    const r = recorder();
    await new InputService(r.run, async () => null).scroll(0, 1);
    expect(r.calls[0]?.at(-1)).toBe("1");
  });

  it("clicks each button, and presses chords with wtype", async () => {
    const r = recorder();
    const s = new InputService(r.run, async () => true);
    await s.click("left", false);
    await s.click("right", false);
    await s.click("middle", true);
    expect(r.calls).toEqual([
      ["ydotool", "click", "0xC0"],
      ["ydotool", "click", "0xC1"],
      ["ydotool", "click", "-r", "2", "-D", "60", "0xC2"],
    ]);
    expect(comboArgs("super")).toEqual(["-M", "logo", "-m", "logo"]);
    expect(() => comboArgs("hyper+x")).toThrow(/unknown modifier/);
  });
});

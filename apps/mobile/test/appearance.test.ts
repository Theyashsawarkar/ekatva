import { expect, test } from "vitest";
import { type DeviceApi, phoneServices } from "../src/core/services";

function device(canSet: boolean) {
  let mode: "light" | "dark" = "dark";
  const d = {
    appearance: {
      get: async () => ({ mode, settable: canSet, why: canSet ? null : "needs a grant" }),
      set: async (m: "light" | "dark") => {
        if (!canSet)
          throw new Error("Switching the phone's dark mode needs a one-time permission over USB");
        mode = m;
        return mode;
      },
    },
  } as unknown as DeviceApi;
  return { d, now: () => mode };
}

test("switching the phone's mode is logged, and undo puts it back", async () => {
  const { d, now } = device(true);
  const s = phoneServices(d, {} as never, {} as never);
  const done = await s.appearance.set("light");
  expect(now()).toBe("light");
  expect(done.summary).toBe("Switched the phone to light mode");
  expect(done.undo).toEqual({ kind: "appearance.set", data: { mode: "dark" } });
  if (done.undo) await s.undo(done.undo);
  expect(now()).toBe("dark");
});

test("without the USB grant it says why, and changes nothing", async () => {
  const { d, now } = device(false);
  const s = phoneServices(d, {} as never, {} as never);
  expect((await s.appearance.get()).settable).toBe(false);
  await expect(s.appearance.set("light")).rejects.toThrow(/one-time permission over USB/);
  expect(now()).toBe("dark");
});

import { describe, expect, it } from "vitest";
import { CallState } from "../src/services/calls.js";
import { appCall, NotificationBridge } from "../src/services/notifyBridge.js";

const wa = (
  actions: string[],
  removed = false,
  title = "Suhani Rawat",
  text = "Incoming voice call",
) =>
  ({
    kind: "notification",
    id: "w1",
    app: "WhatsApp",
    title,
    text,
    actions,
    reply: null,
    removed,
    package: "com.whatsapp",
    call: true,
  }) as const;

describe("an app's call (WhatsApp)", () => {
  it("is ringing while it offers Answer, going on once it doesn't, over when it's gone", () => {
    expect(appCall(wa(["Decline", "Answer"]))).toEqual({ state: "ringing", answer: 1, reject: 0 });
    expect(appCall(wa(["Hang up"]))).toEqual({ state: "active", answer: -99, reject: 0 });
    expect(appCall(wa([], true)).state).toBe("ended");
  });

  it("a call-style one (a video call) says it's ringing, with its own Answer and Decline", () => {
    const video = {
      ...wa([], false, "Suhani Rawat", "Incoming video call"),
      callState: "ringing" as const,
      callButtons: ["answer", "decline"] as ("answer" | "decline")[],
    };
    expect(appCall(video)).toEqual({ state: "ringing", answer: -1, reject: -2 });
    const going = { ...video, callState: "active" as const, callButtons: ["hangup"] as "hangup"[] };
    expect(appCall(going)).toEqual({ state: "active", answer: -99, reject: -3 });
  });

  it("is the call in progress, with the app's Hang up to end it", () => {
    const calls = new CallState(() => 1000);
    calls.onApp("phone", "CMF", "WhatsApp", "w1", "ringing", "Suhani", 0);
    expect(calls.get()).toMatchObject({ state: "ringing", contact: "Suhani", app: "WhatsApp" });
    calls.onApp("phone", "CMF", "WhatsApp", "w1", "active", "Suhani", 0);
    expect(calls.hangupButton()).toEqual({ device: "phone", id: "w1", index: 0 });
    calls.onApp("phone", "CMF", "WhatsApp", "w1", "ended", "", -1);
    expect(calls.get()).toBeNull();
  });

  it("rings on the laptop with the app's own Answer and Decline, and goes once answered", async () => {
    const shown: { title: string; actions?: [string, string][] }[] = [];
    const closed: number[] = [];
    const desktop = {
      notify: async (n: { title: string; actions?: [string, string][] }) => {
        shown.push(n);
        return shown.length;
      },
      close: async (id: number) => {
        closed.push(id);
      },
    };
    const b = new NotificationBridge(desktop as never, () => [], (async () => null) as never);
    await b.fromPhoneEvent("phone", "CMF", wa(["Decline", "Answer"]));
    expect(shown[0]?.title).toBe("Incoming WhatsApp call: Suhani Rawat");
    expect(shown[0]?.actions).toEqual([
      ["answer", "Answer"],
      ["reject", "Decline"],
    ]);
    await b.fromPhoneEvent(
      "phone",
      "CMF",
      wa(["Hang up"], false, "Suhani Rawat", "Ongoing voice call"),
    );
    expect(closed).toEqual([1]);
    expect(shown).toHaveLength(1);
  });
});

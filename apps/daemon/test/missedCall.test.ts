import { describe, expect, it } from "vitest";
import { NotificationBridge } from "../src/services/notifyBridge.js";

/** A desktop that only records what was shown and closed. */
function fakeDesktop() {
  const shown: { title: string; id: number }[] = [];
  const closed: number[] = [];
  let next = 1;
  const desktop = {
    notify: async (n: { title: string }) => {
      const id = next++;
      shown.push({ title: n.title, id });
      return id;
    },
    close: async (id: number) => {
      closed.push(id);
    },
  };
  return { desktop, shown, closed };
}

const call = (state: "ringing" | "active" | "ended", contact: string | null = "Aai") =>
  ({ kind: "call", state, number: state === "ringing" ? "+918080836917" : "", contact }) as const;

describe("a call that rings while you're at the laptop", () => {
  it("rang and ended unanswered: the ringing notice goes, a missed call stays", async () => {
    const { desktop, shown, closed } = fakeDesktop();
    const b = new NotificationBridge(desktop as never, () => [], (async () => null) as never);
    await b.fromPhoneEvent("phone", "CMF", call("ringing"));
    await b.fromPhoneEvent("phone", "CMF", call("ended", null));
    expect(shown.map((s) => s.title)).toEqual(["Incoming call: Aai", "Missed call: Aai"]);
    expect(closed).toEqual([1]);
  });

  it("answered: no missed call", async () => {
    const { desktop, shown } = fakeDesktop();
    const b = new NotificationBridge(desktop as never, () => [], (async () => null) as never);
    await b.fromPhoneEvent("phone", "CMF", call("ringing"));
    await b.fromPhoneEvent("phone", "CMF", call("active", null));
    await b.fromPhoneEvent("phone", "CMF", call("ended", null));
    expect(shown.map((s) => s.title)).toEqual(["Incoming call: Aai"]);
  });

  it("a call made from the phone ends: nothing shown", async () => {
    const { desktop, shown } = fakeDesktop();
    const b = new NotificationBridge(desktop as never, () => [], (async () => null) as never);
    await b.fromPhoneEvent("phone", "CMF", call("active", null));
    await b.fromPhoneEvent("phone", "CMF", call("ended", null));
    expect(shown).toEqual([]);
  });

  it("the phone's dialer's own call notifications aren't shown again", async () => {
    const { desktop, shown, closed } = fakeDesktop();
    const b = new NotificationBridge(desktop as never, () => [], (async () => null) as never);
    const dialer = (title: string, removed = false) =>
      ({
        kind: "notification",
        id: "d1",
        app: "Phone",
        title,
        text: "",
        actions: [],
        reply: null,
        removed,
        package: "com.google.android.dialer",
      }) as const;
    await b.fromPhoneEvent("phone", "CMF", call("ringing"));
    await b.fromPhoneEvent("phone", "CMF", call("ended", null));
    await b.fromPhoneEvent("phone", "CMF", dialer("Missed call"));
    expect(shown.map((s) => s.title)).toEqual(["Incoming call: Aai", "Missed call: Aai"]);
    // Cleared on the phone (seen there): the missed call here goes too.
    await b.fromPhoneEvent("phone", "CMF", dialer("Missed call", true));
    expect(closed).toEqual([1, 2]);
  });
});

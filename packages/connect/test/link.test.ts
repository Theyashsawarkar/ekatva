import { describe, expect, it } from "vitest";
import { createLink, type Native } from "../src/link";

const NADA = {
  id: "nada",
  name: "nāda",
  version: "1",
  methods: [{ name: "queue", why: "What the phone is playing" }],
  events: [{ name: "handoff", why: "Continue here" }],
};

/** ekatva's side, faked: what the app sends, and ekatva's answers. */
function fake(installed = true) {
  const cbs = new Map<string, (e: { json?: string; why?: string }) => void>();
  const sent: { what: string; body: Record<string, unknown> }[] = [];
  let hello: string | null = null;
  const native: Native = {
    installed: () => installed,
    connect: (m) => {
      hello = m;
      return true;
    },
    send: (what, json) => {
      sent.push({ what, body: JSON.parse(json) });
      return true;
    },
    callWithFiles: (json, files) => {
      if (files.includes("/nope")) throw new Error("can't open /nope");
      sent.push({ what: "call", body: { ...JSON.parse(json), files } });
      return true;
    },
    disconnect: () => undefined,
    addListener: (event, cb) => {
      cbs.set(event, cb);
      return { remove: () => cbs.delete(event) };
    },
  };
  const fire = (event: string, body: unknown) => cbs.get(event)?.({ json: JSON.stringify(body) });
  return { native, fire, sent, hello: () => hello };
}

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("a phone app's link to ekatva", () => {
  it("without ekatva: says so, and calls reject in words", async () => {
    const link = createLink(fake(false).native, NADA);
    expect(link.status()).toBe("not-installed");
    await expect(link.call("play")).rejects.toThrow("ekatva isn't on this phone");
    await expect(createLink(null, NADA).call("play")).rejects.toThrow("ekatva isn't on this phone");
  });

  it("says hello with its manifest, and follows where ekatva says it stands", async () => {
    const f = fake();
    const link = createLink(f.native, NADA);
    expect(JSON.parse(f.hello() ?? "")).toMatchObject({ id: "nada" });
    const seen: string[] = [];
    link.onStatus((s) => seen.push(s));
    f.fire("onWelcome", { status: "pending", why: "allow it in ekatva on this phone" });
    expect(link.why()).toBe("allow it in ekatva on this phone");
    await expect(link.call("play")).rejects.toThrow("allow it in ekatva on this phone");
    f.fire("onWelcome", { status: "allowed" });
    expect(seen).toEqual(["pending", "allowed"]);
  });

  it("calls the laptop half, matching each answer to its call", async () => {
    const f = fake();
    const link = createLink(f.native, NADA);
    f.fire("onWelcome", { status: "allowed" });
    const a = link.call("play", { song: 1 });
    const b = link.call("pause");
    const [ca, cb] = f.sent.map((s) => s.body);
    expect(f.sent.map((s) => s.what)).toEqual(["call", "call"]);
    f.fire("onResult", { id: cb?.id, ok: false, error: "nāda isn't running on the laptop" });
    f.fire("onResult", { id: ca?.id, ok: true, result: { playing: true } });
    expect(await a).toEqual({ playing: true });
    await expect(b).rejects.toThrow("nāda isn't running on the laptop");
  });

  it("answers the laptop's calls, and takes its events", async () => {
    const f = fake();
    const got: unknown[] = [];
    const link = createLink(f.native, NADA)
      .on("queue", (_i, from) => ({ songs: ["Monsoon Letters"], for: from.name }))
      .onEvent("handoff", (data) => got.push(data));
    f.fire("onWelcome", { status: "allowed" });
    f.fire("onIncoming", {
      kind: "call",
      id: "c1",
      method: "queue",
      from: { key: "k", name: "Ace" },
    });
    f.fire("onIncoming", {
      kind: "call",
      id: "c2",
      method: "nope",
      from: { key: "k", name: "Ace" },
    });
    f.fire("onIncoming", { kind: "event", name: "handoff", data: { at: 42 }, at: 1 });
    await tick();
    const replies = f.sent
      .map((s) => s.body)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    expect(replies).toEqual([
      { id: "c1", ok: true, result: { songs: ["Monsoon Letters"], for: "Ace" } },
      { id: "c2", ok: false, error: `nāda doesn't answer "nope" yet` },
    ]);
    expect(got).toEqual([{ at: 42 }]);
    expect(() => link.on("fly", () => null)).toThrow(`"fly" isn't in nāda's manifest`);
  });

  it("fails calls in flight when ekatva goes away", async () => {
    const f = fake();
    const link = createLink(f.native, NADA);
    f.fire("onWelcome", { status: "allowed" });
    const a = link.call("play");
    f.fire("onDisconnect", { why: "ekatva stopped" });
    await expect(a).rejects.toThrow("ekatva stopped");
    expect(link.status()).toBe("disconnected");
  });

  it("asks to link only when told to, and sends files and an address with a call", async () => {
    const f = fake();
    const link = createLink(f.native, NADA);
    expect(JSON.parse(f.hello() ?? "")).not.toHaveProperty("link");
    f.fire("onWelcome", { status: "unlinked" });
    expect(link.status()).toBe("unlinked");
    await expect(link.call("play")).rejects.toThrow("link this app with ekatva first");
    link.link();
    expect(JSON.parse(f.hello() ?? "")).toMatchObject({ id: "nada", link: true });
    f.fire("onWelcome", { status: "allowed" });
    const call = link.call("open", { a: 1 }, { to: "laptop:darshan", files: ["/a.epub"] });
    expect(f.sent[0]?.body).toMatchObject({ to: "laptop:darshan", files: ["/a.epub"] });
    f.fire("onResult", { id: f.sent[0]?.body.id, ok: true, result: "opened" });
    expect(await call).toBe("opened");
    await expect(link.call("open", null, { files: ["/nope"] })).rejects.toThrow("can't open /nope");
  });

  it("hands a call's files to its handler", async () => {
    const f = fake();
    createLink(f.native, NADA).on("queue", (_i, from, files) => [from.app, files[0]?.uri]);
    f.fire("onWelcome", { status: "allowed" });
    const files = [{ name: "a.epub", size: 3, mime: "x", uri: "file:///a.epub" }];
    const from = { key: "k", name: "Ace", app: "agent:claude" };
    f.fire("onIncoming", { kind: "call", id: "1", method: "queue", from, files });
    await tick();
    expect(f.sent[0]).toEqual({
      what: "reply",
      body: { id: "1", ok: true, result: ["agent:claude", "file:///a.epub"] },
    });
  });
});

import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon, DesktopNotifications, loadConfig } from "@ekatva/daemon";
import { generateKeyPair, webSocketTransport } from "@ekatva/link";
import type { LaptopNotification, LocalRouter } from "@ekatva/protocol";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MemoryKV } from "../src/core/kv";
import { MemoryLines } from "../src/core/logStore";
import type { DeviceApi } from "../src/core/services";
import { type Platform, Session } from "../src/core/session";
import { MemFs } from "./memfs";

async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

/** What the phone's hardware was asked to do. */
const phoneSide = {
  ringing: null as string | null,
  calls: [] as string[],
  sms: [] as { to: string; text: string }[],
  dismissed: [] as string[],
  acted: [] as { id: string; index: number; reply: string | null }[],
  shown: [] as LaptopNotification[],
  closed: [] as string[],
  opened: [] as string[],
};
/** What the laptop's desktop was asked to do. */
const laptopSide = {
  input: [] as string[][],
  opened: [] as string[],
  clipboard: [] as string[],
  notes: [] as string[][],
  closed: [] as number[],
};

describe("KDE Connect's features, laptop and phone together", () => {
  let root: string;
  let daemon: Daemon;
  let phone: Session;
  let ws: ReturnType<typeof createWSClient>;
  let local: ReturnType<typeof createTRPCClient<LocalRouter>>;
  let memfs: MemFs;
  let nextId = 100;
  // A notification server that only records (never the real desktop's).
  const desktop = new DesktopNotifications(
    () => undefined,
    async (args) => {
      if (args.includes("CloseNotification")) laptopSide.closed.push(Number(args.at(-1)));
      if (args.includes("Notify")) {
        laptopSide.notes.push(args);
        return `u ${nextId++}`;
      }
      return "";
    },
    () => ({ on: () => undefined, kill: () => true, stdout: null }) as never,
  );

  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), "ekatva-kde-"));
    process.env.HOME = join(root, "home");
    await fs.mkdir(process.env.HOME);
    const config = loadConfig(join(root, "none.toml"));
    config.name = "ace";
    daemon = new Daemon({
      config,
      key: generateKeyPair(),
      stateDir: join(root, "home/.local/state/ekatva"),
      configDir: join(root, "home/.config/ekatva"),
      undoDir: join(root, "home/.local/share/ekatva/undo"),
      socketPath: join(root, "ekatva.sock"),
      port: 0,
      host: "127.0.0.1",
      beacon: false,
      checkFirewall: false,
      rendezvous: false,
      desktopNotifications: desktop,
      inputRunner: async (cmd, args) => {
        laptopSide.input.push([cmd, ...args]);
      },
      shareDir: join(root, "Downloads"),
      shareHost: {
        openUrl: async (u) => {
          laptopSide.opened.push(u);
        },
        setClipboard: async (t) => {
          laptopSide.clipboard.push(t);
        },
        notify: () => undefined,
      },
      prompt: async () => "on my way",
      lan: (port) => [`127.0.0.1:${port}`],
      jyotiHost: {
        run: async () => ({ code: 0, out: "" }),
        hold: () => ({ stop: async () => undefined, onExit() {} }),
        lock: async () => undefined,
        lidClosed: () => null,
        battery: () => null,
        now: Date.now,
      },
      log: () => undefined,
    });
    await daemon.start();
    memfs = new MemFs();
    const kv = new MemoryKV();
    const lines = new Map<string, MemoryLines>();
    const device: DeviceApi = {
      name: "Pixel 8",
      battery: async () => null,
      signal: async () => null,
      locked: async () => null,
      ring: async (from) => {
        phoneSide.ringing = from;
      },
      stopRinging: async () => {
        phoneSide.ringing = null;
      },
      ringing: () => phoneSide.ringing !== null,
      keepAwake: async () => {},
      awake: () => false,
      clipboardGet: async () => "",
      clipboardSet: async () => {},
      lock: null,
      calls: {
        log: async () => [],
        dial: async () => {},
        answer: async () => {
          phoneSide.calls.push("answer");
        },
        hangUp: async () => {
          phoneSide.calls.push("hangUp");
        },
      },
      sms: {
        threads: async () => [],
        read: async () => [],
        send: async (to, text) => {
          phoneSide.sms.push({ to, text });
        },
      },
      notifications: {
        dismiss: async (id) => {
          phoneSide.dismissed.push(id);
          return true;
        },
        act: async (id, index, reply) => {
          phoneSide.acted.push({ id, index, reply });
          return true;
        },
        show: async (n) => {
          phoneSide.shown.push(n);
        },
        close: async (id) => {
          phoneSide.closed.push(id);
        },
      },
    };
    const p: Platform = {
      kv,
      lines: (n) => {
        const l = lines.get(n) ?? new MemoryLines();
        lines.set(n, l);
        return l;
      },
      fs: memfs,
      roots: async () => ["/sd"],
      undoDir: "/app/undo",
      device,
      open: (url, ms) =>
        new Promise((resolve, reject) => {
          const s = new WebSocket(url);
          const t = setTimeout(() => {
            s.terminate();
            reject(new Error("timed out"));
          }, ms);
          s.once("open", () => {
            clearTimeout(t);
            resolve(webSocketTransport(s as never));
          });
          s.once("error", (e) => {
            clearTimeout(t);
            reject(e);
          });
        }),
      info: {},
      shareHost: {
        dir: async () => "/storage/emulated/0/Download/ekatva",
        openUrl: async (u) => {
          phoneSide.opened.push(u);
        },
        setClipboard: async () => {},
        notify: () => {},
      },
    };
    phone = await Session.create(p);
    ws = createWSClient({
      url: `ws+unix://${join(root, "ekatva.sock")}:/`,
      WebSocket: WebSocket as never,
    });
    local = createTRPCClient<LocalRouter>({ links: [wsLink({ client: ws })] });
    const offer = await local.admin.pair.start.mutate({ away: false });
    const sub = local.admin.pair.pending.subscribe(undefined, {
      onData: (l) => {
        if (l[0]) {
          sub.unsubscribe();
          void local.admin.pair.confirm.mutate({
            id: l[0].id,
            accept: true,
            grants: ["status", "input", "share", "notifications", "phone.notifications"],
          });
        }
      },
    });
    await phone.link.pair(offer.uri, () => undefined);
  });

  afterAll(async () => {
    phone.link.stop();
    ws.close();
    await daemon.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rings the phone until it's stopped", async () => {
    await local.admin.phone.mutate.mutate({ path: "ring" });
    expect(phoneSide.ringing).toBe("ace");
    expect(
      ((await local.admin.phone.query.query({ path: "status" })) as { ringing: boolean }).ringing,
    ).toBe(true);
    await local.admin.phone.mutate.mutate({ path: "stopRinging" });
    expect(phoneSide.ringing).toBeNull();
  });

  it("the phone is the laptop's trackpad and keyboard", async () => {
    const api = phone.link.client;
    if (!api) throw new Error("offline");
    await Promise.all([
      api.input.move.mutate({ dx: 3, dy: 4 }),
      api.input.move.mutate({ dx: 2, dy: 1 }),
    ]);
    const moved = laptopSide.input.filter((c) => c[1] === "mousemove");
    const sum = moved.reduce((s, c) => ({ x: s.x + Number(c[3]), y: s.y + Number(c[5]) }), {
      x: 0,
      y: 0,
    });
    expect(sum).toEqual({ x: 5, y: 5 });
    await api.input.click.mutate({ button: "right" });
    await api.input.type.mutate({ text: "héllo" });
    await api.input.key.mutate({ combo: "ctrl+shift+t" });
    expect(laptopSide.input.slice(-3)).toEqual([
      ["ydotool", "click", "0xC1"],
      ["wtype", "--", "héllo"],
      ["wtype", "-M", "ctrl", "-M", "shift", "-k", "t", "-m", "shift", "-m", "ctrl"],
    ]);
    await expect(api.input.key.mutate({ combo: "ctrl+c; rm -rf ~" })).rejects.toThrow();
    // Typed text is in the log only as its length.
    const log = await local.admin.log.list.query({ host: "self" });
    expect(JSON.stringify(log)).not.toContain("héllo");
  });

  it("sends files and links both ways", async () => {
    const api = phone.link.client;
    if (!api) throw new Error("offline");
    // Phone → laptop: a link opens, a file lands in Downloads under a safe name.
    await api.share.text.mutate({ text: "https://example.com/a" });
    expect(laptopSide.opened).toEqual(["https://example.com/a"]);
    await api.share.text.mutate({ text: "just words" });
    expect(laptopSide.clipboard).toEqual(["just words"]);
    const data = Buffer.from("hello from the phone");
    const { id } = await api.share.begin.mutate({ name: "../../.bashrc", size: data.length });
    await api.share.put.mutate({ id, data: data.subarray(0, 5).toString("base64") });
    await api.share.put.mutate({ id, data: data.subarray(5).toString("base64") });
    const saved = await api.share.finish.mutate({ id });
    expect(saved.path).toBe(join(root, "Downloads", "bashrc"));
    expect(await fs.readFile(saved.path, "utf8")).toBe("hello from the phone");
    // A second one with the same name doesn't overwrite it.
    const again = await api.share.begin.mutate({ name: "bashrc", size: 1 });
    await api.share.put.mutate({ id: again.id, data: Buffer.from("x").toString("base64") });
    expect((await api.share.finish.mutate({ id: again.id })).path).toMatch(/bashrc \(1\)$/);
    // Laptop → phone.
    const t = (await local.admin.phone.mutate.mutate({
      path: "share.begin",
      input: { name: "notes.txt", size: 2 },
    })) as { id: string };
    await local.admin.phone.mutate.mutate({
      path: "share.put",
      input: { id: t.id, data: Buffer.from("hi").toString("base64") },
    });
    await local.admin.phone.mutate.mutate({ path: "share.finish", input: { id: t.id } });
    expect(await memfs.read("/storage/emulated/0/Download/ekatva/notes.txt", 0, 100)).toBe(
      Buffer.from("hi").toString("base64"),
    );
    await local.admin.phone.mutate.mutate({ path: "share.text", input: { text: "https://x.org" } });
    expect(phoneSide.opened).toEqual(["https://x.org"]);
  });

  it("phone notifications on the laptop: buttons, replies, dismissing", async () => {
    const api = phone.link.client;
    if (!api) throw new Error("offline");
    await api.inbox.report.mutate({
      kind: "notification",
      id: "0|com.whatsapp|1",
      app: "WhatsApp",
      title: "Asha",
      text: "where are you?",
      actions: ["Reply", "Mark as read"],
      reply: 0,
      removed: false,
    });
    const note = laptopSide.notes.at(-1) ?? [];
    expect(note).toContain("WhatsApp: Asha");
    expect(note).toContain("Mark as read");
    const id = nextId - 1;
    // Reply, typed on the laptop.
    desktop.handle(
      JSON.stringify({
        type: "signal",
        interface: "org.freedesktop.Notifications",
        member: "ActionInvoked",
        payload: { data: [id, "a0"] },
      }),
    );
    await until(() => phoneSide.acted.length > 0);
    expect(phoneSide.acted[0]).toEqual({ id: "0|com.whatsapp|1", index: 0, reply: "on my way" });
    // Dismissed here: gone on the phone.
    desktop.handle(
      JSON.stringify({
        type: "signal",
        interface: "org.freedesktop.Notifications",
        member: "NotificationClosed",
        payload: { data: [id, 2] },
      }),
    );
    await until(() => phoneSide.dismissed.length > 0);
    expect(phoneSide.dismissed).toEqual(["0|com.whatsapp|1"]);
    // A call: Answer from the laptop.
    await api.inbox.report.mutate({
      kind: "call",
      state: "ringing",
      number: "+911",
      contact: "Ma",
    });
    desktop.handle(
      JSON.stringify({
        type: "signal",
        interface: "org.freedesktop.Notifications",
        member: "ActionInvoked",
        payload: { data: [nextId - 1, "answer"] },
      }),
    );
    await until(() => phoneSide.calls.length > 0);
    expect(phoneSide.calls).toEqual(["answer"]);
    // An SMS: Reply from the laptop.
    await api.inbox.report.mutate({ kind: "sms", from: "+912", contact: null, text: "ok?", at: 1 });
    desktop.handle(
      JSON.stringify({
        type: "signal",
        interface: "org.freedesktop.Notifications",
        member: "ActionInvoked",
        payload: { data: [nextId - 1, "reply"] },
      }),
    );
    await until(() => phoneSide.sms.length > 0);
    expect(phoneSide.sms).toEqual([{ to: "+912", text: "on my way" }]);
  });

  it("laptop notifications on the phone, dismissed on either", async () => {
    const api = phone.link.client;
    if (!api) throw new Error("offline");
    desktop.handle(
      JSON.stringify({
        type: "method_call",
        interface: "org.freedesktop.Notifications",
        member: "Notify",
        sender: ":1.9",
        cookie: 7,
        payload: { data: ["Slack", 0, "", "#general", "deploy done", [], {}, -1] },
      }),
    );
    desktop.handle(
      JSON.stringify({
        type: "method_return",
        destination: ":1.9",
        reply_cookie: 7,
        payload: { data: [555] },
      }),
    );
    await until(() => phoneSide.shown.length > 0);
    expect(phoneSide.shown[0]).toEqual({
      id: "555",
      app: "Slack",
      title: "#general",
      text: "deploy done",
    });
    // One of ours is never sent back to the phone.
    desktop.handle(
      JSON.stringify({
        type: "method_call",
        interface: "org.freedesktop.Notifications",
        member: "Notify",
        sender: ":1.9",
        cookie: 8,
        payload: {
          data: ["Pixel 8", 0, "", "x", "y", [], { "x-ekatva": { type: "b", data: true } }, -1],
        },
      }),
    );
    desktop.handle(
      JSON.stringify({
        type: "method_return",
        destination: ":1.9",
        reply_cookie: 8,
        payload: { data: [556] },
      }),
    );
    // Swiped away on the phone: closed on the laptop.
    await api.notifications.dismiss.mutate({ id: "555" });
    expect(laptopSide.closed).toContain(555);
    expect(phoneSide.shown).toHaveLength(1);
    // Only ones the laptop sent can be closed from the phone.
    await api.notifications.dismiss.mutate({ id: "1" });
    expect(laptopSide.closed).not.toContain(1);
  });
});

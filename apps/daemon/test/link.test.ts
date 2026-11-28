/**
 * ekatva-link (apps/link, Rust) against the real TypeScript phone side
 * (@ekatva/link's connect) and the session's LinkClient: both stay byte for
 * byte compatible. The link runs on temporary paths with a made-up identity
 * and made-up phones. Skipped when the binary isn't built (`pnpm build`, or
 * `cargo build --release` in apps/link).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Channel,
  connect,
  generateKeyPair,
  type KeyPair,
  PORT_LAPTOP,
  toB64u,
  utf8,
  webSocketTransport,
} from "@ekatva/link";
import { channelWebSocket, type LaptopRouter } from "@ekatva/protocol";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import { Daemon } from "../src/daemon.js";
import { LinkClient, type LinkPending, type SplicedChannel } from "../src/link.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const BIN = ["release", "debug"]
  .map((p) => join(here, `../../link/target/${p}/ekatva-link`))
  .find((p) => existsSync(p));
const GREETER = BIN ? join(BIN, "../ekatva-greeter") : undefined;

const laptop = generateKeyPair();
const phone = generateKeyPair();
let dir: string;
let port: number;
let proc: ChildProcess;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

async function dial(
  me: KeyPair,
  hello: Record<string, unknown> = {},
  onSas?: (e: string[]) => void,
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/link`);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  return connect(webSocketTransport(ws as never), {
    me,
    expect: laptop.publicKey,
    hello: { v: 1, name: "Test phone", ...hello },
    keepaliveMs: 0,
    ...(onSas ? { onSas } : {}),
  });
}

let asked = 0;

/** One request on the link's own port (3). */
function ask(ch: Channel, m: string, p: unknown = null): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const id = ++asked;
    const off = ch.onPort(3, (d) => {
      const r = JSON.parse(utf8.decode(d));
      if (r.id !== id) return;
      off();
      resolve(r);
    });
    ch.sendText(3, JSON.stringify({ id, m, p }));
  });
}

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

beforeAll(async () => {
  if (!BIN) return;
  dir = await fs.mkdtemp(join(tmpdir(), "ekl-"));
  port = await freePort();
  const state = join(dir, "state");
  await fs.mkdir(state, { recursive: true });
  await fs.writeFile(join(state, "identity.key"), toB64u(laptop.secretKey));
  await fs.writeFile(
    join(state, "link.json"),
    JSON.stringify({
      name: "ace",
      port,
      host: "127.0.0.1",
      owner: process.getuid?.(),
      greeter: process.getuid?.(),
      advertise: false,
    }),
  );
  await fs.writeFile(
    join(state, "devices.json"),
    JSON.stringify([
      {
        key: toB64u(phone.publicKey),
        name: "Test phone",
        grants: ["status", "unlock", "power"],
        pairedAt: 1,
        lastSeen: 1,
        info: {},
      },
    ]),
  );
  proc = spawn(BIN, [], {
    env: { ...process.env, EKATVA_LINK_STATE: state, EKATVA_LINK_RUN: join(dir, "run") },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    proc.stderr?.on("data", (d) => String(d).includes("listening on port") && resolve());
    proc.once("exit", (c) => reject(new Error(`ekatva-link exited (${c})`)));
  });
});

afterAll(async () => {
  proc?.kill();
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

describe.skipIf(!BIN)("ekatva-link", () => {
  it("lets a paired phone in without a session, and answers its own port", async () => {
    const { channel, welcome } = await dial(phone);
    expect(welcome).toMatchObject({
      name: "ace",
      session: false,
      grants: ["status", "unlock", "power"],
    });
    expect(toB64u(channel.remoteStatic)).toBe(toB64u(laptop.publicKey));
    const status = await ask(channel, "status");
    expect(status).toMatchObject({
      ok: true,
      v: { name: "ace", session: false, loginScreen: false },
    });
    // Logging in needs the login screen, which isn't up.
    const login = await ask(channel, "login", { password: "made-up" });
    expect(login).toMatchObject({ ok: false, code: "PRECONDITION_FAILED" });
    channel.close();
  });

  it("refuses a phone that isn't paired", async () => {
    await expect(dial(generateKeyPair())).rejects.toThrow(/isn't paired/);
  });

  it("hands a phone's ports to the attached session, both ways, large messages too", async () => {
    // A phone already in (no session) is told to come back once the session attaches.
    const before = await dial(phone);
    const reasons: string[] = [];
    before.channel.onClose((r) => reasons.push(r));

    const opened: SplicedChannel[] = [];
    const link = await LinkClient.connect(
      {
        open: (c) => opened.push(c),
        devices: () => undefined,
        pending: () => undefined,
        lost: () => undefined,
      },
      join(dir, "run", "session.sock"),
    );
    expect(link.hello).toMatchObject({ key: toB64u(laptop.publicKey), name: "ace", port });
    expect(link.devices.map((d) => d.name)).toEqual(["Test phone"]);
    await until(() => reasons.length > 0);
    expect(reasons[0]).toMatch(/session started/);

    const { channel, welcome } = await dial(phone);
    expect(welcome).toMatchObject({ session: true });
    await until(() => opened.length === 1);
    const s = opened[0] as SplicedChannel;
    expect(s.key).toBe(toB64u(phone.publicKey));
    expect(s.peer.name).toBe("Test phone");

    // Phone → session on port 1; session → phone on port 2; 300 KB is split into frames.
    const big = new Uint8Array(300_000).map((_, i) => i % 251);
    const atSession: Uint8Array[] = [];
    s.onPort(1, (d) => atSession.push(d));
    const atPhone: Uint8Array[] = [];
    channel.onPort(2, (d) => atPhone.push(d));
    channel.send(1, big);
    channel.sendText(1, "hello laptop");
    await until(() => atSession.length === 2);
    expect(Buffer.from(atSession[0] as Uint8Array).equals(Buffer.from(big))).toBe(true);
    expect(utf8.decode(atSession[1] as Uint8Array)).toBe("hello laptop");
    s.send(2, big);
    s.sendText(2, "hello phone");
    await until(() => atPhone.length === 2);
    expect(Buffer.from(atPhone[0] as Uint8Array).equals(Buffer.from(big))).toBe(true);
    expect(utf8.decode(atPhone[1] as Uint8Array)).toBe("hello phone");

    // Control messages pass through (pings are the link's own).
    const ctl: Record<string, unknown>[] = [];
    s.onControl((m) => ctl.push(m));
    channel.control({ t: "keepalive", ms: 5000 });
    await until(() => ctl.length === 1);
    expect(ctl[0]).toEqual({ t: "keepalive", ms: 5000 });

    // The phone leaves: the session hears it.
    const ended: string[] = [];
    s.onClose((r) => ended.push(r));
    channel.close();
    await until(() => ended.length === 1);
    link.close();
  });

  it("pairs a new phone: a token from the session, the emoji, a yes on the desktop", async () => {
    let pending: LinkPending[] = [];
    const link = await LinkClient.connect(
      {
        open: () => undefined,
        devices: () => undefined,
        pending: (l) => {
          pending = l;
        },
        lost: () => undefined,
      },
      join(dir, "run", "session.sock"),
    );
    const { token } = await link.call<{ token: string }>("pair.token");
    const fresh = generateKeyPair();
    let shown: string[] = [];
    const dialing = dial(fresh, { token, info: { model: "Made-up 1" } }, (e) => {
      shown = e;
    });
    await until(() => pending.length === 1);
    const p = pending[0] as LinkPending;
    expect(p.key).toBe(toB64u(fresh.publicKey));
    expect(p.info).toMatchObject({ model: "Made-up 1", address: "127.0.0.1" });
    await until(() => shown.length === 4);
    expect(p.sas).toEqual(shown);
    await link.call("devices.put", {
      record: {
        key: p.key,
        name: p.name,
        grants: ["status"],
        pairedAt: 2,
        lastSeen: 2,
        info: p.info,
      },
    });
    await link.call("pair.decide", {
      id: p.id,
      ok: true,
      welcome: { grants: ["status"], name: "ace" },
    });
    const { channel, welcome } = await dialing;
    expect(welcome).toMatchObject({ grants: ["status"], session: true });
    channel.close();
    // The token was used up.
    await expect(dial(generateKeyPair(), { token })).rejects.toThrow(/used or has expired/);
    await link.call("devices.remove", { key: p.key });
    link.close();
  });

  it("a Daemon attached to the link serves the phone's tRPC, and the phone hears when it goes", async () => {
    const home = join(dir, "home");
    await fs.mkdir(home, { recursive: true });
    const config = loadConfig(join(dir, "none.toml"));
    config.name = "ace";
    const d = new Daemon({
      config,
      key: laptop,
      link: join(dir, "run", "session.sock"),
      stateDir: join(home, "state"),
      configDir: join(home, "config"),
      undoDir: join(home, "undo"),
      socketPath: join(dir, "d.sock"),
      checkFirewall: false,
      desktopNotifications: false,
      keepaliveMs: 0,
      jyotiHost: {
        run: async () => ({ code: 0, out: "" }),
        hold: () => ({ stop: async () => undefined, onExit: () => undefined }),
        lidClosed: () => null,
        now: () => Date.now(),
      },
      mediaHost: {
        run: async () => ({ code: 127, out: "" }),
        art: async () => null,
        now: Date.now,
      },
      approve: async () => false,
      log: () => undefined,
    });
    await d.start();
    // Its paired phones are the link's.
    expect(d.devices.all().map((x) => x.name)).toEqual(["Test phone"]);
    expect(d.route().url).toBeNull();

    const { channel, welcome } = await dial(phone);
    expect(welcome).toMatchObject({ session: true });
    const ws = createWSClient({
      url: "ekatva:",
      WebSocket: channelWebSocket(channel, PORT_LAPTOP),
    });
    const client = createTRPCClient<LaptopRouter>({ links: [wsLink({ client: ws })] });
    const status = await client.status.query();
    expect(status.name).toBe("ace");

    const reasons: string[] = [];
    channel.onClose((r) => reasons.push(r));
    await d.stop();
    await until(() => reasons.length > 0);
    // Sent away to come back in login-screen mode.
    const again = await dial(phone);
    expect(again.welcome).toMatchObject({ session: false });
    again.channel.close();
    void ws.close();
  });

  it("logs in through the greeter, and says when the password was wrong", async () => {
    // A stand-in greeter: answers the login request as greetd would for a wrong password.
    const g = createConnection(join(dir, "run", "greeter.sock"));
    await new Promise((r) => g.once("connect", r));
    const asked: Record<string, unknown>[] = [];
    let buf = Buffer.alloc(0);
    g.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const total = buf.readUInt32BE(0);
        const hlen = buf.readUInt32BE(4);
        const h = JSON.parse(buf.subarray(8, 8 + hlen).toString());
        buf = buf.subarray(4 + total);
        asked.push(h);
        const reply = Buffer.from(JSON.stringify({ t: "reply", id: h.id, ok: false, wrong: true }));
        const out = Buffer.alloc(8);
        out.writeUInt32BE(4 + reply.length, 0);
        out.writeUInt32BE(reply.length, 4);
        g.write(Buffer.concat([out, reply]));
      }
    });
    const { channel } = await dial(phone);
    await until(() => true, 10);
    const status = await ask(channel, "status");
    expect(status).toMatchObject({ v: { loginScreen: true, session: false } });
    const r = await ask(channel, "login", { password: "made-up password" });
    expect(r).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(asked[0]).toMatchObject({
      t: "login",
      password: "made-up password",
      phone: "Test phone",
    });
    channel.close();
    g.destroy();
  });

  it("ekatva-greeter logs in through greetd: a wrong password brings tuigreet back, a right one starts the session", async () => {
    if (!GREETER || !existsSync(GREETER)) return;
    // A stand-in greetd: one secret question, the password "right one".
    const said: Record<string, unknown>[] = [];
    const greetd = createServer((c: Socket) => {
      let buf = Buffer.alloc(0);
      const reply = (m: unknown) => {
        const body = Buffer.from(JSON.stringify(m));
        const len = Buffer.alloc(4);
        len.writeUInt32LE(body.length);
        c.write(Buffer.concat([len, body]));
      };
      c.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
          const n = buf.readUInt32LE(0);
          const m = JSON.parse(buf.subarray(4, 4 + n).toString());
          buf = buf.subarray(4 + n);
          said.push(m);
          if (m.type === "create_session")
            reply({
              type: "auth_message",
              auth_message_type: "secret",
              auth_message: "Password: ",
            });
          else if (m.type === "post_auth_message_response")
            reply(
              m.response === "right one"
                ? { type: "success" }
                : { type: "error", error_type: "auth_error", description: "nope" },
            );
          else reply({ type: "success" });
        }
      });
    });
    const greetdSock = join(dir, "greetd.sock");
    await new Promise<void>((r) => greetd.listen(greetdSock, r));
    const g = spawn(GREETER, ["--", "sleep", "300"], {
      env: {
        ...process.env,
        GREETD_SOCK: greetdSock,
        EKATVA_GREETER_SOCKET: join(dir, "run", "greeter.sock"),
        EKATVA_GREETER_SESSION_FROM: join(dir, "none.toml"),
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    const exited = new Promise<number | null>((r) => g.once("exit", (c) => r(c)));
    const { channel } = await dial(phone);
    const end = Date.now() + 5000;
    while (
      Date.now() < end &&
      !((await ask(channel, "status")).v as { loginScreen: boolean }).loginScreen
    )
      await new Promise((r) => setTimeout(r, 100));

    const wrong = await ask(channel, "login", { password: "wrong one" });
    expect(wrong).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(g.exitCode).toBeNull();
    const right = await ask(channel, "login", { password: "right one" });
    expect(right).toMatchObject({ ok: true });
    expect(await exited).toBe(0);
    const types = said.map((m) => m.type);
    expect(types).toContain("cancel_session");
    expect(said.at(-1)).toMatchObject({ type: "start_session", cmd: ["/bin/sh", "-c", "sway"] });
    channel.close();
    greetd.close();
  });
});

import { createSocket } from "node:dgram";
import type { AddressInfo } from "node:net";
import { beaconKey, generateKeyPair, openBeacon, toB64u } from "@ekatva/link";
import { describe, expect, it } from "vitest";
import { BeaconSender, broadcastTargets } from "../src/services/beacon.js";
import { type FirewallHost, firewallProblem } from "../src/services/firewall.js";

describe("beacon sender", () => {
  it("broadcasts on real networks only", () => {
    const iface = (address: string, netmask: string, internal = false) => ({
      address,
      netmask,
      family: "IPv4" as const,
      mac: "00:00:00:00:00:00",
      internal,
      cidr: null,
    });
    expect(
      broadcastTargets({
        lo: [iface("127.0.0.1", "255.0.0.0", true)],
        wlan0: [iface("10.21.205.78", "255.255.255.0")],
        eth0: [iface("192.168.1.20", "255.255.0.0"), iface("169.254.3.4", "255.255.0.0")],
        docker0: [iface("172.17.0.1", "255.255.0.0")],
        "br-edd9b6856ac7": [iface("192.168.49.1", "255.255.255.0")],
        tailscale0: [iface("100.64.0.2", "255.255.255.255")],
      }),
    ).toEqual(["10.21.205.255", "192.168.255.255"]);
  });

  it("sends each paired phone a beacon only it can open", async () => {
    const laptop = generateKeyPair();
    const phone = generateKeyPair();
    const other = generateKeyPair();
    const rx = createSocket("udp4");
    await new Promise<void>((r) => rx.bind(0, "127.0.0.1", () => r()));
    const got: Buffer[] = [];
    rx.on("message", (m) => got.push(m));
    let direct = false;
    let connected = false;
    const sender = new BeaconSender(
      laptop,
      () => [
        { key: toB64u(phone.publicKey), direct, connected },
        { key: toB64u(other.publicKey), direct: direct && connected, connected },
      ],
      () => 47100,
      {
        everyMs: 60_000,
        quietEvery: 3,
        connectedEvery: 2,
        targets: () => ["127.0.0.1"],
        beaconPort: (rx.address() as AddressInfo).port,
      },
    );
    await sender.start();
    await waitFor(() => got.length >= 2);
    const k = beaconKey(phone, laptop.publicKey);
    const opened = got.map((m) => openBeacon(k, new Uint8Array(m)));
    expect(opened.filter(Boolean)).toHaveLength(1);
    expect(opened.find(Boolean)?.port).toBe(47100);
    // Everyone connected, one through the tunnel: one round in `connectedEvery`.
    connected = true;
    got.length = 0;
    for (let i = 0; i < 4; i++) sender.send();
    await new Promise((r) => setTimeout(r, 100));
    expect(got.length).toBe(4);
    // A phone drops: every round again.
    connected = false;
    got.length = 0;
    sender.send();
    sender.send();
    await new Promise((r) => setTimeout(r, 100));
    expect(got.length).toBe(4);
    // Everyone connected directly: only one round in `quietEvery`.
    direct = true;
    connected = true;
    got.length = 0;
    sender.send();
    sender.send();
    sender.send();
    await new Promise((r) => setTimeout(r, 100));
    expect(got.length).toBe(2);
    sender.stop();
    rx.close();
  });
});

async function waitFor(ok: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("firewall check", () => {
  const fake = (files: Record<string, string>, run?: FirewallHost["run"]): FirewallHost => ({
    read: async (p) => files[p] ?? null,
    run: run ?? (async () => null),
  });
  const ufwOn = {
    "/etc/ufw/ufw.conf": "ENABLED=yes\n",
    "/etc/default/ufw": 'DEFAULT_INPUT_POLICY="DROP"\n',
  };

  it("finds ufw dropping the port, with a fix for local networks only", async () => {
    const p = await firewallProblem(47100, fake({ ...ufwOn, "/etc/ufw/user.rules": "*filter\n" }));
    expect(p?.problem).toMatch(/ufw blocks port 47100/);
    expect(p?.fix).toContain("ufw allow from 192.168.0.0/16 to any port 47100 proto tcp");
    expect(p?.fix).not.toMatch(/allow 47100/);
  });

  it("is quiet when a rule (or a range) lets it in, or ufw is off", async () => {
    const rule = "-A ufw-user-input -p tcp --dport 47100 -s 10.0.0.0/8 -j ACCEPT\n";
    expect(
      await firewallProblem(47100, fake({ ...ufwOn, "/etc/ufw/user.rules": rule })),
    ).toBeNull();
    const range = "-A ufw-user-input -p tcp -m multiport --dports 47000:47200 -j ACCEPT\n";
    expect(
      await firewallProblem(47100, fake({ ...ufwOn, "/etc/ufw/user.rules": range })),
    ).toBeNull();
    expect(await firewallProblem(47100, fake({ "/etc/ufw/ufw.conf": "ENABLED=no\n" }))).toBeNull();
    expect(await firewallProblem(47100, fake({}))).toBeNull();
  });

  it("asks firewalld when it runs", async () => {
    const p = await firewallProblem(
      47100,
      fake({}, async (_cmd, args) =>
        args[0] === "--state" ? { code: 0, out: "running\n" } : { code: 1, out: "no\n" },
      ),
    );
    expect(p?.fix).toContain("--add-port=47100/tcp");
  });
});

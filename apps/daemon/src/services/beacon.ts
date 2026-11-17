/**
 * Telling paired phones on the same network where the laptop is: an
 * encrypted UDP beacon per phone, broadcast on each real local network
 * (see @ekatva/link's beacon). Works with no internet at all, as on the
 * phone's own hotspot. Every few seconds while a paired phone isn't
 * connected directly; rarely otherwise.
 */
import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { BEACON_PORT, beaconKey, fromB64u, type KeyPair, sealBeacon } from "@ekatva/link";

/** Interfaces that never lead to a phone: containers, VMs, VPN tunnels. */
export const VIRTUAL =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|podman|cni|flannel|tun|tap|wg|tailscale|zt)/;

/** The broadcast address of each real local IPv4 network this laptop is on. */
export function broadcastTargets(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const out = new Set<string>();
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      const ip = a.address.split(".").map(Number);
      const mask = a.netmask.split(".").map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      out.add(ip.map((b, i) => (b | (~(mask[i] as number) & 255)) & 255).join("."));
    }
  }
  return [...out];
}

export class BeaconSender {
  private socket: Socket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private keys = new Map<string, Uint8Array>();
  private ticks = 0;

  constructor(
    private readonly me: KeyPair,
    /** Paired phones, and whether each is already connected directly. */
    private readonly devices: () => { key: string; direct: boolean }[],
    private readonly port: () => number,
    private readonly opts: {
      everyMs?: number;
      /** While every phone is connected directly, send once per this many ticks. */
      quietEvery?: number;
      targets?: () => string[];
      beaconPort?: number;
      log?: (m: string) => void;
    } = {},
  ) {}

  async start(): Promise<void> {
    if (this.socket) return;
    const s = createSocket({ type: "udp4", reuseAddr: true });
    s.on("error", (e) => this.opts.log?.(`beacon: ${e.message}`));
    await new Promise<void>((res) => s.bind(0, () => res()));
    s.setBroadcast(true);
    this.socket = s;
    this.send();
    this.timer = setInterval(() => this.send(), this.opts.everyMs ?? 3000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
  }

  /** One round of beacons (skipped when every phone is already here directly). */
  send(): void {
    const s = this.socket;
    if (!s) return;
    const devices = this.devices();
    const quiet = devices.every((d) => d.direct);
    if (quiet && this.ticks++ % (this.opts.quietEvery ?? 20) !== 0) return;
    if (!quiet) this.ticks = 0;
    const targets = (this.opts.targets ?? broadcastTargets)();
    for (const d of devices) {
      let key = this.keys.get(d.key);
      if (!key) {
        key = beaconKey(this.me, fromB64u(d.key));
        this.keys.set(d.key, key);
      }
      const datagram = sealBeacon(key, { at: Date.now(), port: this.port() });
      for (const t of targets)
        s.send(datagram, this.opts.beaconPort ?? BEACON_PORT, t, () => undefined);
    }
  }

  /** A device was unpaired: forget its key. */
  forget(key: string): void {
    this.keys.delete(key);
  }
}

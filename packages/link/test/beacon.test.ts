import { describe, expect, it } from "vitest";
import { BEACON_SIZE, beaconKey, openBeacon, sealBeacon } from "../src/beacon.js";
import { generateKeyPair } from "../src/noise.js";

const laptop = generateKeyPair();
const phone = generateKeyPair();

describe("beacon", () => {
  it("only the pair can open it; it says when and which port", () => {
    const k = beaconKey(laptop, phone.publicKey);
    expect(beaconKey(phone, laptop.publicKey)).toEqual(k);
    const at = Date.now();
    const b = sealBeacon(k, { at, port: 47100 });
    expect(b.length).toBe(BEACON_SIZE);
    expect(openBeacon(k, b)).toEqual({ at, port: 47100 });
    const stranger = beaconKey(generateKeyPair(), laptop.publicKey);
    expect(openBeacon(stranger, b)).toBeNull();
  });

  it("looks different every time, so nobody can follow it", () => {
    const k = beaconKey(laptop, phone.publicKey);
    const at = Date.now();
    expect(sealBeacon(k, { at, port: 47100 })).not.toEqual(sealBeacon(k, { at, port: 47100 }));
  });

  it("refuses stale, damaged and odd-sized beacons", () => {
    const k = beaconKey(laptop, phone.publicKey);
    expect(openBeacon(k, sealBeacon(k, { at: Date.now() - 3 * 60_000, port: 47100 }))).toBeNull();
    const b = sealBeacon(k, { at: Date.now(), port: 47100 });
    const bad = b.slice();
    bad[20] = (bad[20] as number) ^ 1;
    expect(openBeacon(k, bad)).toBeNull();
    expect(openBeacon(k, b.subarray(1))).toBeNull();
    expect(openBeacon(k, new Uint8Array(0))).toBeNull();
    expect(openBeacon(k, sealBeacon(k, { at: Date.now(), port: 80 }))).toBeNull();
  });
});

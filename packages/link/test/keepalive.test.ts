import { expect, it } from "vitest";
import { accept, connect, type Transport } from "../src/channel.js";
import { generateKeyPair } from "../src/noise.js";
import { pipe } from "./memory.js";

const laptopKey = generateKeyPair();
const phoneKey = generateKeyPair();

/** A transport that can be cut: nothing gets through either way, and no close arrives (out of range). */
function cuttable(t: Transport): Transport & { cut(): void } {
  let cut = false;
  return {
    send: (d) => {
      if (!cut) t.send(d);
    },
    close: (c, r) => t.close(c, r),
    onMessage: (cb) => t.onMessage((d) => !cut && cb(d)),
    onClose: (cb) => t.onClose(cb),
    cut: () => {
      cut = true;
    },
  };
}

async function link(keepaliveMs: number) {
  const [pt, lt] = pipe();
  const phoneEnd = cuttable(pt);
  const laptop = accept(lt, {
    keepaliveMs,
    me: laptopKey,
    hello: { v: 1, name: "ace" },
    authorize: () => ({ ok: true, welcome: {} }),
  });
  const phone = await connect(phoneEnd, {
    keepaliveMs: 0,
    me: phoneKey,
    expect: laptopKey.publicKey,
    hello: { v: 1, name: "Pixel" },
  });
  return { laptop: await laptop, phone: phone.channel, phoneEnd };
}

it("drops a phone that went silent (out of range) after three missed pings", async () => {
  const { laptop, phoneEnd } = await link(30);
  const why = new Promise<string>((r) => laptop.onClose(r));
  // Still there: pings answered, nothing dropped.
  await new Promise((r) => setTimeout(r, 120));
  expect(laptop.isOpen).toBe(true);
  // Gone, with no close: the laptop notices by itself.
  phoneEnd.cut();
  const t0 = Date.now();
  expect(await why).toBe("timed out");
  expect(Date.now() - t0).toBeLessThan(200);
  // And the same phone connects again cleanly.
  const again = await link(30);
  expect(again.laptop.isOpen).toBe(true);
  again.laptop.close();
});

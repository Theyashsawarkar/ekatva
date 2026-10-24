import type { Transport } from "../src/channel.js";

/** Two transports wired to each other, delivering asynchronously like a socket. */
export function pipe(): [Transport, Transport] {
  type End = {
    msg: ((d: Uint8Array) => void)[];
    close: ((c: number, r: string) => void)[];
    closed: boolean;
    sent: Uint8Array[];
  };
  const mk = (): End => ({ msg: [], close: [], closed: false, sent: [] });
  const a = mk();
  const b = mk();
  const end = (me: End, other: End): Transport => ({
    send(d) {
      if (me.closed) throw new Error("closed");
      me.sent.push(d);
      const copy = d.slice();
      setTimeout(() => {
        if (!other.closed) for (const cb of other.msg) cb(copy);
      }, 0);
    },
    close(code = 1000, reason = "") {
      if (me.closed) return;
      me.closed = true;
      setTimeout(() => {
        for (const cb of me.close) cb(code, reason);
        if (!other.closed) {
          other.closed = true;
          for (const cb of other.close) cb(code, reason);
        }
      }, 0);
    },
    onMessage: (cb) => me.msg.push(cb),
    onClose: (cb) => me.close.push(cb),
  });
  return [end(a, b), end(b, a)];
}

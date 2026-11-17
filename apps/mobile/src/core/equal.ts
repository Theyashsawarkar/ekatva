/**
 * Deep equality for plain data (what tRPC answers with: objects, arrays,
 * strings, numbers, booleans, null). Polls use it to keep the previous
 * answer when a new one says the same, so nothing re-renders.
 */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    // NaN equals NaN here: a reading that hasn't changed.
    return typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.hasOwn(b as object, key)) return false;
    if (!same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
      return false;
  }
  return true;
}

/** Where a player is now, moving on from when it was read. */
function at(
  p: { position: number | null; at: number; status: string },
  now: number,
): number | null {
  if (p.position === null) return null;
  return p.status === "Playing" ? p.position + (now - p.at) : p.position;
}

/**
 * Media answers are the same unless something you'd see changed: every read
 * stamps `at` and a moving `position`, which alone isn't a change (the rim
 * runs on by itself). A position more than a second off where it should be
 * now is a change (a seek, a stall).
 */
export function sameMedia(a: unknown, b: unknown, now = Date.now()): boolean {
  if (a === b) return true;
  type P = { position: number | null; at: number; status: string } & Record<string, unknown>;
  const A = a as { players?: P[] } | null;
  const B = b as { players?: P[] } | null;
  if (!A || !B || !Array.isArray(A.players) || !Array.isArray(B.players)) return same(a, b);
  if (A.players.length !== B.players.length) return false;
  const strip = (m: Record<string, unknown>) => {
    const { players: _, ...rest } = m;
    return rest;
  };
  if (!same(strip(A as Record<string, unknown>), strip(B as Record<string, unknown>))) return false;
  for (let i = 0; i < A.players.length; i++) {
    const p = A.players[i] as P;
    const q = B.players[i] as P;
    const { position: _p, at: _a, ...pr } = p;
    const { position: _q, at: _b, ...qr } = q;
    if (!same(pr, qr)) return false;
    const x = at(p, now);
    const y = at(q, now);
    if ((x === null) !== (y === null)) return false;
    if (x !== null && y !== null && Math.abs(x - y) > 1000) return false;
  }
  return true;
}

/**
 * The laptop's long-term key pair. The secret lives in the desktop keyring
 * (Secret Service, via secret-tool) when there is one; otherwise in a file
 * readable only by you, with a warning.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fromB64u, generateKeyPair, type KeyPair, keyPairFromSecret, toB64u } from "@ekatva/link";

const ATTRS = ["service", "ekatva", "kind", "identity"];

function secretTool(args: string[], input?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile("secret-tool", args, { timeout: 10_000 }, (err, out) =>
      resolve(err ? null : String(out).trim()),
    );
    child.stdin?.end(input ?? "");
  });
}

export async function loadIdentity(
  stateDir: string,
  log: (m: string) => void,
): Promise<{ key: KeyPair; where: "keyring" | "file" }> {
  const stored = await secretTool(["lookup", ...ATTRS]);
  if (stored) return { key: keyPairFromSecret(fromB64u(stored)), where: "keyring" };
  const file = join(stateDir, "identity.key");
  try {
    const text = (await readFile(file, "utf8")).trim();
    return { key: keyPairFromSecret(fromB64u(text)), where: "file" };
  } catch {
    // none yet
  }
  const key = generateKeyPair();
  const secret = toB64u(key.secretKey);
  if (
    (await secretTool(["store", "--label=ekatva: this laptop's identity", ...ATTRS], secret)) !==
    null
  ) {
    if ((await secretTool(["lookup", ...ATTRS])) === secret) return { key, where: "keyring" };
  }
  log("no desktop keyring: keeping the identity key in a file only you can read");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(file, secret, { mode: 0o600, flag: "wx" });
  return { key, where: "file" };
}

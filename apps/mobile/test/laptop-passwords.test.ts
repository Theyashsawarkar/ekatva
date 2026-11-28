import { describe, expect, it } from "vitest";
import { MemoryKV } from "../src/core/kv";
import { kvBox, LaptopPasswords, Vault } from "../src/core/vault";

describe("laptop passwords for Unlock", () => {
  it("are kept in the vault's box beside the keys, per laptop, and forgotten on request", async () => {
    const kv = new MemoryKV();
    const box = kvBox(kv);
    const secrets = await Vault.create(box);
    expect(await LaptopPasswords.get(box, "laptopA")).toBeNull();

    await LaptopPasswords.set(box, "laptopA", "pw-a");
    await LaptopPasswords.set(box, "laptopB", "pw-b");
    expect(await LaptopPasswords.get(box, "laptopA")).toBe("pw-a");
    expect(await LaptopPasswords.get(box, "laptopB")).toBe("pw-b");

    // The keys are untouched: the vault still opens to the same identity.
    const again = await Vault.open(box, kv);
    expect(again.identity.publicKey).toEqual(secrets.identity.publicKey);

    await LaptopPasswords.set(box, "laptopA", null);
    expect(await LaptopPasswords.get(box, "laptopA")).toBeNull();
    expect(await LaptopPasswords.get(box, "laptopB")).toBe("pw-b");
  });
});

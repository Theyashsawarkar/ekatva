import { expect, test } from "vitest";
import { hostOf } from "../src/core/tunnel-address";

test("an address for the laptop's tunnel, however it's typed or pasted", () => {
  expect(hostOf(" Ekatva-Tunnel.Example.dev ")).toBe("ekatva-tunnel.example.dev");
  expect(hostOf("wss://ekatva-tunnel.example.dev/link")).toBe("ekatva-tunnel.example.dev");
  expect(hostOf("https://ekatva-tunnel.example.dev/")).toBe("ekatva-tunnel.example.dev");
  expect(hostOf("not an address")).toBeNull();
  expect(hostOf("localhost")).toBeNull();
});

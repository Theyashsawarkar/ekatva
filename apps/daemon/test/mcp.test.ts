import { describe, expect, it } from "vitest";
import { agentLabel } from "../src/daemon.js";

describe("agentLabel", () => {
  it("names the agent acting for the user", () => {
    expect(agentLabel("yash", "claude")).toBe("yash via claude");
  });
  it("is just the user without an agent", () => {
    expect(agentLabel("yash", undefined)).toBe("yash");
    expect(agentLabel("yash", "")).toBe("yash");
    expect(agentLabel("yash", 42)).toBe("yash");
  });
  it("keeps the label short and plain", () => {
    expect(agentLabel("yash", "evil\n<b>x</b>")).toBe("yash via evilbxb");
    expect(agentLabel("yash", "a".repeat(100))).toBe(`yash via ${"a".repeat(40)}`);
  });
});

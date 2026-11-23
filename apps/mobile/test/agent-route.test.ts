import { expect, test } from "vitest";
import { agentRoute, paneOf } from "../src/ui/agents/route";

test("a pane id travels in the route without its %", () => {
  for (const id of ["%6", "%15", "%1", "%120"]) {
    const route = agentRoute(id);
    expect(route.params.id).not.toContain("%");
    // What Expo Router does to params on the way.
    expect(paneOf(decodeURIComponent(encodeURIComponent(route.params.id)))).toBe(id);
  }
  expect(paneOf(["p3"])).toBe("%3");
  expect(paneOf(undefined)).toBe("");
});

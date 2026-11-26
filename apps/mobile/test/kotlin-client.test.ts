import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

test("the Kotlin client other apps copy is the one @ekatva/connect and the Flutter plugin use", () => {
  const at = (p: string) => readFileSync(join(__dirname, "../../..", p), "utf8");
  expect(at("clients/android/EkatvaClient.kt")).toBe(
    at(
      "packages/connect/android/src/main/java/io/github/theyashsawarkar/ekatva/connect/EkatvaClient.kt",
    ),
  );
  expect(
    at(
      "clients/flutter/ekatva_connect/android/src/main/kotlin/io/github/theyashsawarkar/ekatva/connect/EkatvaClient.kt",
    ),
  ).toBe(at("clients/android/EkatvaClient.kt"));
});

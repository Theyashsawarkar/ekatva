import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/**
 * The QR scanner (Google's code scanner, ML Kit) loads its classes by name:
 * a release build's R8 strips them unless they're kept, and scanning then
 * fails at once ("Call to function 'EkatvaPhone.scanQr' has been rejected").
 * That happened twice; this keeps it from happening a third time.
 */
test("release builds keep the QR scanner's classes", () => {
  const app = JSON.parse(readFileSync(join(__dirname, "../app.json"), "utf8"));
  const build = app.expo.plugins.find(
    (p: unknown) => Array.isArray(p) && p[0] === "expo-build-properties",
  );
  const rules: string = build[1].android.extraProguardRules;
  for (const kept of [
    "io.github.theyashsawarkar.ekatva.**",
    "com.google.mlkit.**",
    "com.google.android.gms.internal.mlkit_**",
    "com.google.android.libraries.barhopper.**",
    "com.google.photos.vision.barhopper.**",
  ])
    expect(rules).toContain(`-keep class ${kept} { *; }`);
});

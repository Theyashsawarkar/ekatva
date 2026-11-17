/**
 * Ships only English resources: libraries bring strings for ~90 locales
 * (resources.arsc), and ekatva's screens are English only. AGP 8.8+
 * (`androidResources.localeFilters`; `resConfigs` is gone in AGP 9).
 */
const { withAppBuildGradle } = require("expo/config-plugins");

module.exports = function withEnglishOnly(config) {
  return withAppBuildGradle(config, (c) => {
    const g = c.modResults.contents;
    if (!g.includes("localeFilters")) {
      c.modResults.contents = g.replace(
        /\nandroid\s*\{/,
        (m) =>
          `${m}\n    // English only (plugins/with-english-only.js).\n    androidResources {\n        localeFilters += ["en"]\n    }`,
      );
    }
    return c;
  });
};

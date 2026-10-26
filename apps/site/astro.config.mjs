// @ts-check
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://theyashsawarkar.github.io",
  base: "/ekatva",
  integrations: [
    starlight({
      title: "ekatva",
      description:
        "Your phone and your laptop as one device: pair by QR, control each other near or far, end-to-end encrypted.",
      logo: { src: "./src/assets/logo.svg", alt: "" },
      favicon: "/favicon.svg",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/Theyashsawarkar/ekatva" },
      ],
      editLink: { baseUrl: "https://github.com/Theyashsawarkar/ekatva/edit/main/apps/site/" },
      customCss: ["./src/styles/theme.css"],
      lastUpdated: true,
      sidebar: [
        { label: "Start", items: ["start/what-is-ekatva", "start/install", "start/pairing"] },
        {
          label: "Features",
          items: [
            "features/agents",
            "features/files",
            "features/caffeine",
            "features/media",
            "features/phone",
            "features/root",
            "features/action-log",
          ],
        },
        { label: "Security", items: ["security/model", "security/crypto", "security/threats"] },
        {
          label: "Guides",
          items: ["guides/capabilities", "guides/development", "guides/kde-connect"],
        },
        {
          label: "Reference",
          items: ["reference/cli", "reference/config", "reference/protocol", "reference/changelog"],
        },
      ],
    }),
  ],
});

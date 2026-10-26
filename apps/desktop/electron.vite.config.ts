import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: ["@ekatva/protocol", "@ekatva/link"] } } },
  // A sandboxed preload must be CommonJS.
  preload: {
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: { plugins: [react()] },
});

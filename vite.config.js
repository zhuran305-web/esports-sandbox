import { defineConfig } from "vite";
import { miniappManifest } from "@heybox/hb-sdk/vite";

export default defineConfig({
  base: "./",
  plugins: [miniappManifest()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});

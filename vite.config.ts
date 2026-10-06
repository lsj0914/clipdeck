import { defineConfig } from "vite";
export default defineConfig({
  base: "./",
  build: { outDir: "dist/renderer", assetsInlineLimit: 0 },
});

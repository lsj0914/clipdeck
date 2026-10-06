import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
await mkdir("dist/main", { recursive: true });
await build({
  entryPoints: ["src/main/main.ts"],
  outfile: "dist/main/main.cjs",
  platform: "node",
  format: "cjs",
  bundle: true,
  external: ["electron"],
  target: "node24",
  sourcemap: true,
});
await copyFile("src/main/preload.cjs", "dist/main/preload.cjs");

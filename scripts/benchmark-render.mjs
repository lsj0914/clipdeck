import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const temporary = await mkdtemp(
  path.join(tmpdir(), "clipdeck-benchmark-runner-"),
);
try {
  const entry = path.join(temporary, "benchmark.mjs");
  await build({
    entryPoints: ["scripts/render-benchmark.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
  });
  await import(pathToFileURL(entry).href);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

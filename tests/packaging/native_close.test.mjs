import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const require = createRequire(import.meta.url);
test("native quit, close and renderer acknowledgement preserve drafts on cancellation/failure", { timeout: 40000 }, async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "clipdeck-native-close-"));
  try {
    const result = await new Promise((resolve, reject) => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(require("electron"), ["scripts/native-close-runtime.cjs", `--user-data-dir=${profile}`], { env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", error = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { error += chunk; });
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, output, error }));
    });
    assert.equal(result.code, 0, result.error);
    const evidence = JSON.parse(result.output.split("\n").find((line) => line.includes('"event":"native-close-integration"')));
    for (const [key, value] of Object.entries(evidence)) if (key !== "event") assert.equal(value, true, key);
  } finally { await rm(profile, { recursive: true, force: true }); }
});

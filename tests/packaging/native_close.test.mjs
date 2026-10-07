import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
      child.once("close", (code, signal) => resolve({ code, signal, output, error }));
    });
    assert.equal(result.code, 0, result.error);
    assert.equal(result.signal, null);
    const evidence = JSON.parse(await readFile(path.join(profile, "native-close-evidence.json"), "utf8"));
    assert.deepEqual(evidence, {
      event: "native-close-integration",
      nativeQuitCancelled: true,
      nativeSaveCancelled: true,
      runningTaskPreserved: true,
      recoveryFailureKeepsWindow: true,
      focusedTitleRecovered: true,
      closeRetried: true,
    });
    const recovery = JSON.parse(await readFile(path.join(profile, "recovery.json"), "utf8"));
    assert.equal(recovery.project.name, "Focused native close draft");
  } finally { await rm(profile, { recursive: true, force: true }); }
});

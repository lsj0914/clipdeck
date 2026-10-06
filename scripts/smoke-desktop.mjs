import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const data = await mkdtemp(path.join(os.tmpdir(), "clipdeck-smoke-"));
try {
  await new Promise((resolve, reject) => {
    const child = spawn(
      require("electron"),
      ["scripts/smoke-runtime.cjs", `--user-data-dir=${data}`],
      {
        stdio: "inherit",
        env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
      },
    );
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Desktop smoke timed out"));
    }, 30000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolve()
        : reject(new Error(`Desktop smoke exited ${code}`));
    });
  });
} finally {
  await rm(data, { recursive: true, force: true });
}

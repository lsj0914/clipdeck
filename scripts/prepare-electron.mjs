import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const require = createRequire(import.meta.url);
const electronDir = path.dirname(require.resolve("electron/package.json"));
const install = spawnSync(
  process.execPath,
  [path.join(electronDir, "install.js")],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      electron_config_cache: path.resolve(".electron-download-cache"),
    },
  },
);
if (install.status !== 0) process.exit(install.status ?? 1);
if (process.platform === "darwin") {
  // Official developer archives omit this empty directory; Chromium needs it
  // when obtaining the Helper sandbox extension. No binary is modified.
  await mkdir(
    path.join(
      electronDir,
      "dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/Resources",
    ),
    { recursive: true },
  );
}
console.log(JSON.stringify({ prepared: true, sandboxEnabled: true }));

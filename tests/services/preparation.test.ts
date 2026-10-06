import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
const run = promisify(execFile);
it("refuses an unverified portable runtime receipt before altering the project runtime", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "clipdeck-wheel-"));
  try {
    await writeFile(path.join(dir, "payload.json"), "tampered runtime receipt");
    await expect(
      run(process.execPath, [
        "scripts/prepare-worker.mjs",
        "--runtime-dir",
        dir,
        "--runtime-manifest",
        path.join(dir, "payload.json"),
      ]),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(/manifest integrity/i),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

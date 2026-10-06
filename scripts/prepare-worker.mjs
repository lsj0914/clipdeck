import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  copyFile,
  cp,
  lstat,
  readlink,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const RUNTIME_MANIFEST_SHA256 =
  "298b8f006e05917c887a055d3d021899135669b2a0771b95d257e2492208df07";
function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
async function verifyPayload(directory, manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length < 1)
    throw new Error("Invalid runtime manifest");
  const expectedPaths = new Set(manifest.files.map((file) => file.path));
  const actualPaths = [];
  async function enumerate(relative = "") {
    for (const item of await readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const selected = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) await enumerate(selected);
      else actualPaths.push(selected);
    }
  }
  await enumerate();
  if (
    actualPaths.length !== expectedPaths.size ||
    actualPaths.some((file) => !expectedPaths.has(file))
  )
    throw new Error("Runtime payload inventory mismatch");
  for (const file of manifest.files) {
    if (
      typeof file.path !== "string" ||
      path.isAbsolute(file.path) ||
      file.path.split(/[\\/]/).includes("..")
    )
      throw new Error("Invalid runtime manifest path");
    const selected = path.join(directory, file.path);
    const stats = await lstat(selected);
    if (file.symlink !== undefined) {
      if (
        !stats.isSymbolicLink() ||
        (await readlink(selected)) !== file.symlink ||
        path.isAbsolute(file.symlink) ||
        path
          .relative(
            directory,
            path.resolve(path.dirname(selected), file.symlink),
          )
          .startsWith("..")
      )
        throw new Error("Runtime symlink integrity mismatch");
    } else if (
      !stats.isFile() ||
      stats.size !== file.bytes ||
      createHash("sha256")
        .update(await readFile(selected))
        .digest("hex") !== file.sha256
    ) {
      throw new Error("Runtime payload integrity mismatch");
    }
  }
}
async function preflight(directory) {
  const python = path.join(directory, "bin/python3.12");
  const { stdout } = await run(python, [
    "-c",
    "import sys;print(sys.version.split()[0])",
  ]);
  if (stdout.trim() !== "3.12.15")
    throw new Error("Worker preparation requires verified Python 3.12.15");
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/sandbox-exec",
      [
        "-p",
        "(version 1)(allow default)(deny network-outbound)",
        python,
        path.join(root, "worker/transcribe.py"),
      ],
      {
        env: {
          ...process.env,
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
          ORT_DISABLE_TELEMETRY: "1",
          PYTHONDONTWRITEBYTECODE: "1",
        },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(stderr || stdout || error.message))
          : resolve(stdout),
    );
    child.stdin.end(JSON.stringify({ mode: "check" }) + "\n");
  });
}
try {
  const source = option("--runtime-dir"),
    receipt = option("--runtime-manifest");
  if (!source || !receipt)
    throw new Error("Provide --runtime-dir and the pinned --runtime-manifest");
  const manifestBytes = await readFile(path.resolve(receipt));
  if (
    createHash("sha256").update(manifestBytes).digest("hex") !==
    RUNTIME_MANIFEST_SHA256
  )
    throw new Error("Runtime manifest integrity mismatch");
  const manifest = JSON.parse(manifestBytes);
  await verifyPayload(path.resolve(source), manifest);
  const target = path.join(root, ".runtime/worker");
  const staging = `${target}.prepared-${randomUUID()}`,
    backup = `${target}.previous-${randomUUID()}`;
  await mkdir(path.dirname(target), { recursive: true });
  let previous = false;
  let published = false;
  try {
    await cp(path.resolve(source), staging, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    await verifyPayload(staging, manifest);
    const check = await preflight(staging);
    try {
      await rename(target, backup);
      previous = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (previous) await rename(backup, target);
      throw error;
    }
    published = true;
    process.stdout.write(check);
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (published) await rm(backup, { recursive: true, force: true });
  }
  const native = option("--native-dir");
  if (native) {
    await mkdir(path.join(root, ".runtime/bin"), { recursive: true });
    for (const name of ["ffmpeg", "ffprobe"])
      await copyFile(
        path.join(path.resolve(native), name),
        path.join(root, ".runtime/bin", name),
      );
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

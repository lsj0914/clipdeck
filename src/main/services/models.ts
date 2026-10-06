import { realpath, stat, mkdir, open, rm, readFile } from "node:fs/promises";
import { existsSync, lstatSync, renameSync, rmSync } from "node:fs";
import { publicErrorMessage } from "../errors";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ModelStatus, ModelChoice } from "../../shared/contracts";
import { fingerprintFile } from "./media";
import { atomicJson } from "./storage";
export interface ResourceManifest {
  id: string;
  revision: string;
  files: Array<{ name: string; bytes: number; sha256: string; url: string }>;
}
const revision = "536b0662742c02347bc0e980a01041f333bce120";
export const MODEL_MANIFEST: ResourceManifest = {
  id: "Systran/faster-whisper-small",
  revision,
  files: [
    [
      "model.bin",
      483546902,
      "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
    ],
    [
      "tokenizer.json",
      2203239,
      "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab",
    ],
    [
      "config.json",
      2370,
      "b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828",
    ],
    [
      "vocabulary.txt",
      459861,
      "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913",
    ],
  ].map(([name, bytes, sha256]) => ({
    name: name as string,
    bytes: bytes as number,
    sha256: sha256 as string,
    url: `https://huggingface.co/Systran/faster-whisper-small/resolve/${revision}/${name}`,
  })),
};
const turboRevision = "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf";
export const TURBO_MANIFEST: ResourceManifest = {
  id: "dropbox-dash/faster-whisper-large-v3-turbo",
  revision: turboRevision,
  files: [
    [
      "config.json",
      2263,
      "b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e",
    ],
    [
      "preprocessor_config.json",
      340,
      "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711",
    ],
    [
      "tokenizer.json",
      2710337,
      "297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd",
    ],
    [
      "vocabulary.json",
      1068114,
      "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1",
    ],
    [
      "model.bin",
      1617884929,
      "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da",
    ],
  ].map(([name, bytes, sha256]) => ({
    name: name as string,
    bytes: bytes as number,
    sha256: sha256 as string,
    url: `https://huggingface.co/dropbox-dash/faster-whisper-large-v3-turbo/resolve/${turboRevision}/${name}`,
  })),
};
export const MODEL_MANIFESTS: Record<ModelChoice, ResourceManifest> = {
  small: MODEL_MANIFEST,
  turbo: TURBO_MANIFEST,
};
export const MODEL_CHOICES = (
  Object.keys(MODEL_MANIFESTS) as ModelChoice[]
).map((choice) => ({
  choice,
  label:
    choice === "small" ? "Small multilingual" : "Large v3 turbo multilingual",
  bytes: MODEL_MANIFESTS[choice].files.reduce(
    (total, file) => total + file.bytes,
    0,
  ),
}));
export function manifestDigest(manifest: ResourceManifest): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        manifest.files.map(({ name, bytes, sha256 }) => ({
          name,
          bytes,
          sha256,
        })),
      ),
    )
    .digest("hex");
}
export const MODEL_DIGEST = manifestDigest(MODEL_MANIFEST);
export async function verifyModelDirectory(
  directory: string,
  requested?: ModelChoice,
): Promise<{
  id: string;
  digest: string;
  directory: string;
  choice: ModelChoice;
}> {
  if (requested !== undefined && requested !== "small" && requested !== "turbo")
    throw new Error("Unsupported local model choice");
  const root = await realpath(directory);
  const choices = requested
    ? [requested]
    : (["small", "turbo"] as ModelChoice[]);
  let failure: unknown;
  for (const choice of choices) {
    const manifest = MODEL_MANIFESTS[choice];
    if (!manifest) throw new Error("Unsupported local model choice");
    try {
      for (const resource of manifest.files) {
        const selected = path.join(root, resource.name);
        let size: number;
        try {
          size = (await stat(selected)).size;
        } catch {
          throw new Error(
            `Missing local model resource: ${resource.name}; online fallback forbidden`,
          );
        }
        if (
          size !== resource.bytes ||
          (await fingerprintFile(selected)) !== `sha256:${resource.sha256}`
        )
          throw new Error(`Local model hash/size mismatch: ${resource.name}`);
      }
      return {
        id: manifest.id,
        digest: manifestDigest(manifest),
        directory: root,
        choice,
      };
    } catch (error) {
      failure ??= error;
    }
  }
  throw failure ?? new Error("No supported complete local model found");
}
type Commit = (publish: () => void) => void;
async function verifiedDirectory(
  manifest: ResourceManifest,
  target: string,
): Promise<void> {
  for (const file of manifest.files) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(file.name))
      throw new Error("Invalid resource manifest");
    const selected = path.join(target, file.name);
    if (
      (await stat(selected)).size !== file.bytes ||
      (await fingerprintFile(selected)) !== `sha256:${file.sha256}`
    )
      throw new Error("Local model integrity mismatch");
  }
}
async function stageManifest(
  manifest: ResourceManifest,
  target: string,
  signal: AbortSignal,
  progress: (p: number) => void,
): Promise<string> {
  const staging = `${target}.partial-${randomUUID()}`;
  const total = manifest.files.reduce((n, f) => n + f.bytes, 0);
  let transferred = 0;
  await mkdir(staging, { recursive: true });
  try {
    for (const file of manifest.files) {
      if (
        !/^[a-zA-Z0-9_.-]+$/.test(file.name) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1
      )
        throw new Error("Invalid resource manifest");
      signal.throwIfAborted();
      const response = await fetch(file.url, { signal });
      if (!response.ok || !response.body)
        throw new Error(`Model download failed (${response.status})`);
      const handle = await open(path.join(staging, file.name), "wx", 0o600);
      const digest = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          bytes += chunk.length;
          if (bytes > file.bytes)
            throw new Error(`Downloaded resource size exceeded: ${file.name}`);
          digest.update(chunk);
          await handle.write(chunk);
          transferred += chunk.length;
          progress(transferred / total);
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (bytes !== file.bytes || digest.digest("hex") !== file.sha256)
        throw new Error(`Downloaded resource integrity mismatch: ${file.name}`);
    }
    signal.throwIfAborted();
    return staging;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
/** Synchronous publication rolls back both destinations if either rename fails. */
function publishResources(
  staging: string | null,
  target: string,
  settingsTemporary?: string,
  statePath?: string,
): void {
  const backup = `${target}.previous-${randomUUID()}`;
  const stateBackup = statePath
    ? `${statePath}.previous-${randomUUID()}`
    : null;
  let oldTarget = false,
    newTarget = false,
    oldState = false,
    newState = false;
  try {
    if (staging) {
      if (existsSync(target)) {
        renameSync(target, backup);
        oldTarget = true;
      }
      renameSync(staging, target);
      newTarget = true;
    }
    if (settingsTemporary && statePath) {
      if (existsSync(statePath) && lstatSync(statePath).isFile()) {
        renameSync(statePath, stateBackup!);
        oldState = true;
      }
      renameSync(settingsTemporary, statePath);
      newState = true;
    }
  } catch (error) {
    if (newState) rmSync(statePath!, { force: true });
    if (oldState) renameSync(stateBackup!, statePath!);
    if (newTarget) rmSync(target, { recursive: true, force: true });
    if (oldTarget) renameSync(backup, target);
    throw error;
  }
  // Cleanup is best effort after publication, and cannot invalidate a committed result.
  if (oldTarget)
    try {
      rmSync(backup, { recursive: true, force: true });
    } catch {}
  if (oldState)
    try {
      rmSync(stateBackup!, { force: true });
    } catch {}
}
/** Main-only acquisition utility; the registry always uses the immutable official manifest. */
export async function downloadManifest(
  manifest: ResourceManifest,
  target: string,
  signal: AbortSignal,
  progress: (p: number) => void,
): Promise<void> {
  const staging = await stageManifest(manifest, target, signal, progress);
  try {
    signal.throwIfAborted();
    publishResources(staging, target);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
/** Prepare all bytes before one cancellable synchronous directory/settings publication. */
export async function acquireManifest(
  manifest: ResourceManifest,
  target: string,
  statePath: string,
  signal: AbortSignal,
  progress: (p: number) => void,
  commit: Commit,
): Promise<void> {
  signal.throwIfAborted();
  await mkdir(path.dirname(target), { recursive: true });
  let cached = false;
  try {
    await verifiedDirectory(manifest, target);
    cached = true;
  } catch {}
  signal.throwIfAborted();
  const staging = cached
    ? null
    : await stageManifest(manifest, target, signal, progress);
  const settingsTemporary = `${statePath}.prepared-${randomUUID()}`;
  let committed = false;
  try {
    await atomicJson(settingsTemporary, {
      directory: target,
      manifestRevision: manifest.revision,
    });
    signal.throwIfAborted();
    commit(() => {
      publishResources(staging, target, settingsTemporary, statePath);
      committed = true;
    });
  } finally {
    try {
      if (staging) await rm(staging, { recursive: true, force: true });
      await rm(settingsTemporary, { force: true });
    } catch (error) {
      if (!committed) throw error;
    }
  }
}
export class ModelRegistry {
  directory: string | null = null;
  status: ModelStatus = {
    status: "notReady",
    id: null,
    message: "Choose a verified local model or explicitly download it",
    progress: null,
    available: MODEL_CHOICES,
  };
  constructor(
    readonly statePath: string,
    readonly downloadPath: string,
    readonly notify: () => void,
  ) {}
  private activeChoice: ModelChoice = "small";
  async initialize(): Promise<void> {
    try {
      const config = JSON.parse(await readFile(this.statePath, "utf8"));
      if (typeof config.directory === "string")
        await this.choose(config.directory);
    } catch (error) {
      this.status = {
        status: "notReady",
        id: null,
        message: "Local model needs preparation",
        progress: null,
        available: MODEL_CHOICES,
      };
    }
  }
  async choose(directory: string): Promise<void> {
    const checked = await verifyModelDirectory(directory);
    await atomicJson(this.statePath, {
      directory: checked.directory,
      manifestRevision: MODEL_MANIFESTS[checked.choice].revision,
    });
    this.directory = checked.directory;
    this.activeChoice = checked.choice;
    this.status = {
      status: "ready",
      id: checked.id,
      choice: checked.choice,
      available: MODEL_CHOICES,
      message: "Verified local model ready",
      progress: 1,
    };
    this.notify();
  }
  async verify(): Promise<{
    id: string;
    digest: string;
    directory: string;
    choice: ModelChoice;
  }> {
    if (!this.directory || this.status.status !== "ready")
      throw new Error("Choose or download a complete local model first");
    return verifyModelDirectory(this.directory, this.activeChoice);
  }
  async download(
    signal: AbortSignal,
    commit: Commit = (publish) => {
      signal.throwIfAborted();
      publish();
    },
    choice: ModelChoice = "small",
  ): Promise<void> {
    if (choice !== "small" && choice !== "turbo")
      throw new Error("Unsupported local model choice");
    const manifest = MODEL_MANIFESTS[choice];
    if (!manifest) throw new Error("Unsupported local model choice");
    const target =
      choice === "small"
        ? this.downloadPath
        : path.join(
            path.dirname(this.downloadPath),
            "faster-whisper-large-v3-turbo-0a363e9",
          );
    const previousDirectory = this.directory;
    const previousChoice = this.activeChoice;
    const previousStatus = this.status;
    signal.throwIfAborted();
    this.status = {
      status: "downloading",
      id: manifest.id,
      choice,
      available: MODEL_CHOICES,
      message: "Downloading explicitly requested local model",
      progress: 0,
    };
    this.notify();
    try {
      await acquireManifest(
        manifest,
        target,
        this.statePath,
        signal,
        (progress) => {
          this.status = { ...this.status, progress };
          this.notify();
        },
        (publish) =>
          commit(() => {
            publish();
            this.directory = target;
            this.activeChoice = choice;
            this.status = {
              status: "ready",
              id: manifest.id,
              choice,
              available: MODEL_CHOICES,
              message: "Verified local model ready",
              progress: 1,
            };
          }),
      );
      this.notify();
    } catch (error) {
      this.directory = previousDirectory;
      this.activeChoice = previousChoice;
      this.status =
        previousStatus.status === "ready"
          ? previousStatus
          : {
              status: signal.aborted ? "notReady" : "failed",
              id: null,
              message: signal.aborted
                ? "Model download cancelled"
                : publicErrorMessage(error),
              progress: null,
              available: MODEL_CHOICES,
            };
      this.notify();
      throw error;
    }
  }
}

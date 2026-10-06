import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, stat, rename, symlink, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OwnedStagingRegistry, CLEANUP_WARNING } from "../../src/main/services/transient";
import { RenderService } from "../../src/main/services/render";
import { MediaService, SourceRegistry } from "../../src/main/services/media";
import { JobManager } from "../../src/main/services/jobs";
import { createProject } from "../../src/domain/project";
import * as storage from "../../src/main/services/storage";
let dir: string, parent: string, journal: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "clipdeck-owned-cleanup-")));
  parent = path.join(dir, "exports"); journal = path.join(dir, "profile/render-staging.json");
  await mkdir(parent);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });
it("a symlink replacing an export ancestor preserves the relocated stage and its journal entry", async () => {
  const ancestor = path.join(dir, "external"), moved = path.join(dir, "moved-external");
  parent = path.join(ancestor, "exports"); await mkdir(parent, { recursive: true });
  const staging = await new OwnedStagingRegistry(journal).create(parent);
  await writeFile(path.join(staging, "audio.wav"), "neutral relocated private PCM");
  await rename(ancestor, moved); await symlink(moved, ancestor);
  const restarted = new OwnedStagingRegistry(journal); await restarted.initialize();
  expect(await readFile(path.join(staging, "audio.wav"), "utf8")).toBe("neutral relocated private PCM");
  expect(JSON.parse(await readFile(journal, "utf8")).entries).toHaveLength(1);
  expect([...restarted.warnings]).toEqual([CLEANUP_WARNING]);
});
it("a symlinked private journal root cannot authorize external cleanup", async () => {
  const staging = await new OwnedStagingRegistry(journal).create(parent);
  await writeFile(path.join(staging, "audio.wav"), "neutral private PCM");
  const root = path.dirname(journal), moved = path.join(dir, "moved-profile");
  await rename(root, moved); await symlink(moved, root);
  const restarted = new OwnedStagingRegistry(journal); await restarted.initialize();
  expect(await readFile(path.join(staging, "audio.wav"), "utf8")).toBe("neutral private PCM");
  expect([...restarted.warnings]).toEqual([CLEANUP_WARNING]);
  await expect(restarted.create(parent)).rejects.toThrow(/storage needs attention/i);
});
it("a symlink replacing a journal ancestor preserves its stage and durable records", async () => {
  const ancestor = path.join(dir, "private-storage"), moved = path.join(dir, "moved-private-storage");
  journal = path.join(ancestor, "profile/render-staging.json");
  const staging = await new OwnedStagingRegistry(journal).create(parent);
  await writeFile(path.join(staging, "audio.wav"), "neutral private PCM");
  await rename(ancestor, moved); await symlink(moved, ancestor);
  const restarted = new OwnedStagingRegistry(journal); await restarted.initialize();
  expect(await readFile(path.join(staging, "audio.wav"), "utf8")).toBe("neutral private PCM");
  expect(JSON.parse(await readFile(journal, "utf8")).entries).toHaveLength(1);
  expect([...restarted.warnings]).toEqual([CLEANUP_WARNING]);
});
it("failed ownership persistence preserves a same-path replacement directory", async () => {
  let replacement!: string, moved!: string;
  vi.spyOn(storage, "atomicJson").mockImplementationOnce(async (_file, value: any) => {
    replacement = value.entries[0].directory;
    moved = path.join(parent, "user-moved-stage");
    await rename(replacement, moved); await mkdir(replacement);
    await writeFile(path.join(replacement, "user.txt"), "replacement sentinel");
    throw Object.assign(new Error("Controlled storage full"), { code: "ENOSPC" });
  });
  const registry = new OwnedStagingRegistry(journal);
  await expect(registry.create(parent)).rejects.toThrow(/storage full/);
  expect(await readFile(path.join(replacement, "user.txt"), "utf8")).toBe("replacement sentinel");
  expect((await stat(moved)).isDirectory()).toBe(true);
  expect([...registry.warnings]).toEqual([CLEANUP_WARNING]);
});
it("render startup retires journaled private PCM while preserving completed exports and unowned folders", async () => {
  const staging = await new OwnedStagingRegistry(journal).create(parent);
  await writeFile(path.join(staging, "audio.wav"), "neutral private derived audio");
  await writeFile(path.join(parent, "finished.mp4"), "completed export sentinel");
  await mkdir(path.join(parent, ".clipdeck-render-UnOwNd"));
  const rendering = new RenderService({ ffmpeg: "/unavailable/ffmpeg", ffprobe: "/unavailable/ffprobe",
    media: new MediaService("/unavailable/ffprobe", new SourceRegistry()), jobs: new JobManager(() => {}),
    cacheRoot: path.join(dir, "profile/media-cache"), getProject: () => createProject() });
  await rendering.initialize();
  await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(parent, "finished.mp4"), "utf8")).toBe("completed export sentinel");
  expect((await stat(path.join(parent, ".clipdeck-render-UnOwNd"))).isDirectory()).toBe(true);
  expect(JSON.parse(await readFile(journal, "utf8")).entries).toEqual([]);
});
it("a replacement directory with a copied marker is preserved by inode verification", async () => {
  const staging = await new OwnedStagingRegistry(journal).create(parent), moved = path.join(parent, "moved-private-stage");
  await rename(staging, moved); await mkdir(staging);
  await copyFile(path.join(moved, ".clipdeck-owned.json"), path.join(staging, ".clipdeck-owned.json"));
  await writeFile(path.join(staging, "user.txt"), "user replacement sentinel");
  const restarted = new OwnedStagingRegistry(journal); await restarted.initialize();
  expect(await readFile(path.join(staging, "user.txt"), "utf8")).toBe("user replacement sentinel");
  expect((await stat(moved)).isDirectory()).toBe(true);
  expect([...restarted.warnings]).toEqual([CLEANUP_WARNING]);
});
it("symlinked staging and moved export parents are never recursively swept", async () => {
  const staging = await new OwnedStagingRegistry(journal).create(parent), outside = path.join(dir, "user-files");
  await mkdir(outside); await writeFile(path.join(outside, "original.mp4"), "original sentinel");
  await rm(staging, { recursive: true }); await symlink(outside, staging);
  const restarted = new OwnedStagingRegistry(journal); await restarted.initialize();
  expect(await readFile(path.join(outside, "original.mp4"), "utf8")).toBe("original sentinel");
  expect([...restarted.warnings]).toEqual([CLEANUP_WARNING]);
  await rename(parent, path.join(dir, "moved-exports"));
  const moved = new OwnedStagingRegistry(journal); await moved.initialize();
  expect([...moved.warnings]).toEqual([CLEANUP_WARNING]);
});
it("malformed ownership records cannot authorize deletion or unjournaled new media", async () => {
  await mkdir(path.dirname(journal));
  await writeFile(journal, JSON.stringify({ version: 1, entries: [{ directory: parent, parent: path.dirname(parent), identity: "forged", parentIdentity: "forged", token: "forged" }] }));
  const registry = new OwnedStagingRegistry(journal); await registry.initialize();
  expect((await stat(parent)).isDirectory()).toBe(true);
  expect([...registry.warnings]).toEqual([CLEANUP_WARNING]);
  await expect(registry.create(parent)).rejects.toThrow(/storage needs attention/i);
});
it("concurrent export ownership survives restart and normal cleanup retires its journal", async () => {
  const registry = new OwnedStagingRegistry(journal);
  const [one, two] = await Promise.all([registry.create(parent), registry.create(parent)]);
  expect(JSON.parse(await readFile(journal, "utf8")).entries).toHaveLength(2);
  await registry.remove(one);
  expect(JSON.parse(await readFile(journal, "utf8")).entries.map((entry: any) => entry.directory)).toEqual([two]);
  await new OwnedStagingRegistry(journal).initialize();
  await expect(stat(two)).rejects.toMatchObject({ code: "ENOENT" });
});

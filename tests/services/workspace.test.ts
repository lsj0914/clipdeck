import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, copyFile, readFile, mkdir, symlink, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { WorkspaceService } from "../../src/main/services/workspace";
import { validateProject, serializeProject } from "../../src/domain/project";
import { asset as admissionAsset } from "../domain/fixtures";
let dir: string;
const run = promisify(execFile);
const runtime = {
  ffmpeg: path.resolve(".runtime/bin/ffmpeg"),
  ffprobe: path.resolve(".runtime/bin/ffprobe"),
  python: path.resolve(".runtime/worker/bin/python3.12"),
  worker: path.resolve("worker/transcribe.py"),
};
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clipdeck-workspace-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
it("startup removes abandoned owned audio/model partials while preserving originals, projects and ready models", async () => {
  const dataRoot = path.join(dir, "data"), job = path.join(dataRoot, "jobs/transcription-Ab12Cd"),
    modelRoot = path.join(dataRoot, "models"), token = "12345678-1234-1234-1234-123456789abc",
    partial = path.join(modelRoot, `faster-whisper-small-536b066.partial-${token}`),
    ready = path.join(modelRoot, "faster-whisper-small-536b066"),
    outside = path.join(dir, "originals"), notes = path.join(dataRoot, "jobs/manual-notes");
  for (const folder of [job, partial, ready, outside, notes]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(job, "audio.wav"), "neutral abandoned PCM");
  await writeFile(path.join(partial, "model.bin"), "incomplete download");
  await writeFile(path.join(ready, "model.bin"), "ready cache sentinel");
  await writeFile(path.join(outside, "original.mp4"), "original sentinel");
  await writeFile(path.join(notes, "notes.txt"), "user notes sentinel");
  await symlink(outside, path.join(dataRoot, "jobs/transcription-LiNk12"));
  const prepared = path.join(dataRoot, `model-settings.json.prepared-${token}`);
  await writeFile(prepared, "uncommitted settings");
  await writeFile(path.join(dataRoot, "saved.clipdeck"), "saved project sentinel");
  const workspace = new WorkspaceService({
    runtime: { ffmpeg: "/unavailable/ffmpeg", ffprobe: "/unavailable/ffprobe", python: "/unavailable/python", worker: "/unavailable/worker" },
    dataRoot, notify: () => {},
    dialogs: { media: async () => [], open: async () => null, save: async () => null, relink: async () => null, model: async () => null },
  });
  await workspace.initialize();
  for (const owned of [job, partial, prepared]) await expect(stat(owned)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(ready, "model.bin"), "utf8")).toBe("ready cache sentinel");
  expect(await readFile(path.join(outside, "original.mp4"), "utf8")).toBe("original sentinel");
  expect(await readFile(path.join(notes, "notes.txt"), "utf8")).toBe("user notes sentinel");
  expect(await readFile(path.join(dataRoot, "saved.clipdeck"), "utf8")).toBe("saved project sentinel");
});
it("close cancels an admitted transcription preflight before it can register a late job", async () => {
  const workspace = new WorkspaceService({ runtime, dataRoot: path.join(dir, "data"), notify: () => {},
    dialogs: { media: async () => [], open: async () => null, save: async () => null, relink: async () => null, model: async () => null } });
  await workspace.initialize();
  workspace.project.assets = [{ ...admissionAsset }];
  vi.spyOn(workspace.media, "verifyAssetIdentity").mockResolvedValue(undefined);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)), waiting = new Promise<void>((r) => (entered = r));
  vi.spyOn(workspace.models, "verify").mockImplementation(async () => {
    entered(); await gate;
    return { id: "fixture", digest: "fixture", directory: dir, choice: "small" };
  });
  const starting = workspace.transcribe(admissionAsset.id, "en");
  await waiting;
  const outcome = starting.then((accepted) => ({ accepted, error: undefined }), (error) => ({ accepted: undefined, error }));
  const closing = workspace.close();
  release();
  try {
    await closing;
    expect((await outcome).error?.message).toMatch(/cancel/i);
    expect(workspace.jobs.list()).toEqual([]);
    await expect(workspace.transcribe(admissionAsset.id, "en")).rejects.toThrow(/closing/i);
  } finally { await workspace.jobs.cancelAll(); }
});
it("a failed durable close reopens transcription admission for retry", async () => {
  const workspace = new WorkspaceService({ runtime, dataRoot: path.join(dir, "data"), notify: () => {},
    dialogs: { media: async () => [], open: async () => null, save: async () => null, relink: async () => null, model: async () => null } });
  await workspace.initialize();
  workspace.project.assets = [{ ...admissionAsset }];
  vi.spyOn(workspace.media, "verifyAssetIdentity").mockResolvedValue(undefined);
  vi.spyOn(workspace.models, "verify").mockResolvedValue({ id: "fixture", digest: "fixture", directory: dir, choice: "small" });
  vi.spyOn(workspace.store, "autosave").mockRejectedValueOnce(new Error("unavailable storage"));
  await expect(workspace.close()).rejects.toThrow(/recovery/i);
  const id = await workspace.transcribe(admissionAsset.id, "en");
  expect(workspace.jobs.list().some((job) => job.id === id)).toBe(true);
  await workspace.jobs.cancel(id);
});
it("close settles an already-admitted source preview before its late job can run", async () => {
  const source = path.join(dir, "late-preview.mp4");
  await run(runtime.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x48:r=30:d=1", "-c:v", "libx264", source]);
  const workspace = new WorkspaceService({ runtime, dataRoot: path.join(dir, "data"), notify: () => {},
    dialogs: { media: async () => [source], open: async () => null, save: async () => null, relink: async () => null, model: async () => null } });
  await workspace.initialize();
  const asset = (await workspace.importMedia()).project.assets[0]!;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)), waiting = new Promise<void>((r) => (entered = r));
  const original = (workspace.rendering as any).target.bind(workspace.rendering);
  vi.spyOn(workspace.rendering as any, "target").mockImplementation(async (...args) => {
    const target = await original(...args); entered(); await gate; return target;
  });
  const starting = workspace.prepareSourcePreview(asset.id);
  const outcome = starting.then((id) => ({ id, error: undefined }), (error) => ({ id: undefined, error }));
  await waiting;
  const closing = workspace.close();
  release();
  try {
    await closing;
    expect((await outcome).error?.message).toMatch(/cancel/i);
    expect(workspace.jobs.list().every((job) => job.status === "cancelled")).toBe(true);
  } finally { await workspace.jobs.cancelAll(); }
});
it("queued transcription cancellation releases its source for an immediate retry", async () => {
  const workspace = new WorkspaceService({ runtime, dataRoot: path.join(dir, "data"), notify: () => {},
    dialogs: { media: async () => [], open: async () => null, save: async () => null, relink: async () => null, model: async () => null } });
  await workspace.initialize();
  workspace.project.assets = [{ ...admissionAsset }];
  vi.spyOn(workspace.media, "verifyAssetIdentity").mockResolvedValue(undefined);
  vi.spyOn(workspace.models, "verify").mockResolvedValue({ id: "fixture", digest: "fixture", directory: dir, choice: "small" });
  for (let i = 0; i < 2; i++) workspace.jobs.start("preview", {}, async (ctx) => {
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    const first = await workspace.transcribe(admissionAsset.id, "en");
    expect(workspace.jobs.list().find((job) => job.id === first)?.status).toBe("queued");
    await workspace.cancelJob(first);
    const retry = await workspace.transcribe(admissionAsset.id, "en");
    expect(retry).not.toBe(first);
    expect(workspace.jobs.list().find((job) => job.id === retry)?.status).toBe("queued");
  } finally { await workspace.jobs.cancelAll(); }
});
it("rejects cumulative oversized correction before publishing or overwriting valid saved and recovery bytes", async () => {
  const source = path.join(dir, "correction.mp4"),
    target = path.join(dir, "corrected.clipdeck"),
    dataRoot = path.join(dir, "data");
  await run(runtime.ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x48:r=30:d=1",
    "-c:v",
    "libx264",
    source,
  ]);
  let publications = 0;
  const workspace = new WorkspaceService({
    runtime,
    dataRoot,
    notify: () => {
      publications++;
    },
    dialogs: {
      media: async () => [source],
      open: async () => target,
      save: async () => target,
      relink: async () => null,
      model: async () => null,
    },
  });
  await workspace.initialize();
  const asset = (await workspace.importMedia()).project.assets[0]!;
  const words = Array.from({ length: 101 }, (_, index) => ({
    id: `word-${index}`,
    text: "x",
    startMs: index,
    endMs: index + 1,
  }));
  // Synthetic timed domain data isolates persistence bounds; this test invokes no ASR.
  workspace.project = validateProject({
    ...serializeProject(workspace.project),
    transcripts: [
      {
        assetId: asset.id,
        fingerprint: asset.fingerprint,
        revision: 1,
        language: "en",
        words,
        segments: [
          {
            id: "segment",
            text: "x".repeat(101),
            startMs: 0,
            endMs: 101,
            wordIds: words.map((word) => word.id),
          },
        ],
        model: { id: "fixture", digest: "fixture" },
        engine: { name: "fixture", version: "1" },
        parameters: { vad: true },
      },
    ],
  });
  await workspace.applyEdit({
    type: "correctTranscript",
    assetId: asset.id,
    fingerprint: asset.fingerprint,
    transcriptRevision: 1,
    changes: words
      .slice(0, 99)
      .map((word) => ({ wordId: word.id, text: "a".repeat(1000) })),
  });
  await workspace.saveProject();
  const saved = await readFile(target),
    recovery = await readFile(path.join(dataRoot, "recovery.json")),
    prior = workspace.project,
    history = prior.history,
    count = publications;
  await expect(
    workspace
      .applyEdit({
        type: "correctTranscript",
        assetId: asset.id,
        fingerprint: asset.fingerprint,
        transcriptRevision: 2,
        changes: [{ wordId: "word-99", text: "b".repeat(1000) }],
      })
      .then(() => undefined),
  ).rejects.toThrow(/too long|limit/i);
  expect(workspace.project).toBe(prior);
  expect(workspace.project.history).toBe(history);
  expect(publications).toBe(count);
  expect(await readFile(target)).toEqual(saved);
  expect(await readFile(path.join(dataRoot, "recovery.json"))).toEqual(
    recovery,
  );
  const reopened = await workspace.openProject();
  expect(reopened.project.transcripts[0]!.segments[0]!.text.length).toBe(99002);
  expect(reopened.project.transcripts[0]!.revision).toBe(2);
  expect(reopened.project.transcripts[0]!.words[99]!.text).toBe("x");
});
it("real import, edit, native save target, and reopen retain source identity with no exposed host paths", async () => {
  const source = path.join(dir, "中文 original.mp4");
  await run(runtime.ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x48:r=30:d=1",
    "-c:v",
    "libx264",
    source,
  ]);
  const target = path.join(dir, "p.clipdeck");
  const workspace = new WorkspaceService({
    runtime,
    dataRoot: path.join(dir, "app-data"),
    notify: () => {},
    dialogs: {
      media: async () => [source],
      open: async () => target,
      save: async () => target,
      relink: async () => source,
      model: async () => null,
    },
  });
  await workspace.initialize();
  const imported = await workspace.importMedia();
  const asset = imported.project.assets[0]!;
  expect(asset.name).toBe("中文 original.mp4");
  expect(JSON.stringify(imported)).not.toContain(dir);
  expect(imported.capabilities).toMatchObject({
    media: true,
    persistence: true,
  });
  await workspace.applyEdit({
    type: "addCut",
    cut: {
      id: "manual",
      assetId: asset.id,
      fingerprint: asset.fingerprint,
      transcriptRevision: null,
      startMs: 100,
      endMs: 500,
      wordIds: [],
      text: "Manual",
      note: "",
      needsReview: false,
    },
  });
  await workspace.saveProject();
  expect(workspace.snapshot().save.dirty).toBe(false);
  const reopened = await workspace.openProject();
  expect(reopened.project.cuts[0]?.endMs).toBe(500);
  expect(reopened.project.assets[0]?.status).toBe("ready");
  expect(reopened.save.dirty).toBe(false);
  expect(JSON.stringify(reopened)).not.toContain(dir);
});
it("rejected native relink preserves source authority and a saveable missing-source project", async () => {
  const source = path.join(dir, "actual-one-second.mp4"), projectFile = path.join(dir, "missing.clipdeck"),
    savedFile = path.join(dir, "preserved.clipdeck");
  await run(runtime.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=30:d=1", "-c:v", "libx264", source]);
  const workspace = new WorkspaceService({ runtime, dataRoot: path.join(dir, "data"), notify: () => {},
    dialogs: { media: async () => [], open: async () => projectFile, save: async () => savedFile,
      relink: async () => source, model: async () => null } });
  await workspace.initialize();
  const actual = await workspace.media.probeAsset(source);
  const missing = { ...actual, fileRef: "missing-source.mp4", durationMs: 5000, status: "missing" as const };
  const project = { ...workspace.project, assets: [missing],
    cuts: [{ id: "outside-actual", assetId: actual.id, fingerprint: actual.fingerprint, transcriptRevision: null,
      startMs: 2000, endMs: 3000, wordIds: [], text: "Existing selection", note: "", needsReview: false }],
    cutOrder: ["outside-actual"] };
  await writeFile(projectFile, JSON.stringify(serializeProject(project)));
  await workspace.openProject();
  const before = structuredClone(workspace.project);
  expect(workspace.sources.ids()).toEqual([]);
  await expect(workspace.relinkMedia(actual.id)).rejects.toThrow("Invalid source interval");
  expect(workspace.sources.ids()).toEqual([]);
  expect(workspace.project).toEqual(before);
  expect(workspace.store.currentPath).toBe(await realpath(projectFile));
  await workspace.saveProject(true);
  const saved = JSON.parse(await readFile(savedFile, "utf8"));
  expect(saved.assets[0]).toMatchObject({ fileRef: "missing-source.mp4", durationMs: 5000, status: "missing" });
  const reopened = await workspace.store.open(savedFile);
  expect(reopened.assets[0]?.status).toBe("missing");
  expect(reopened.cuts[0]).toMatchObject({ startMs: 2000, endMs: 3000 });
});
it("reopening the same project supersedes a pending native relink without granting its source", async () => {
  const source = path.join(dir, "actual-one-second.mp4"), projectFile = path.join(dir, "missing.clipdeck");
  await run(runtime.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x48:r=30:d=1", "-c:v", "libx264", source]);
  const workspace = new WorkspaceService({ runtime, dataRoot: path.join(dir, "data"), notify: () => {},
    dialogs: { media: async () => [], open: async () => projectFile, save: async () => null,
      relink: async () => source, model: async () => null } });
  await workspace.initialize();
  const actual = await workspace.media.probeAsset(source);
  await writeFile(projectFile, JSON.stringify(serializeProject({ ...workspace.project,
    assets: [{ ...actual, fileRef: "missing-source.mp4", status: "missing" as const }] })));
  await workspace.openProject();
  const prepare = workspace.media.prepareRelink.bind(workspace.media);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
  vi.spyOn(workspace.media, "prepareRelink").mockImplementation(async (asset, file) => {
    const inspected = await prepare(asset, file); entered(); await gate; return inspected;
  });
  const relinking = workspace.relinkMedia(actual.id);
  await waiting;
  try {
    await workspace.openProject();
    const before = structuredClone(workspace.project);
    release();
    await expect(relinking).rejects.toThrow("Project changed during relink");
    expect(workspace.sources.ids()).toEqual([]);
    expect(workspace.project).toEqual(before);
    expect(workspace.store.currentPath).toBe(await realpath(projectFile));
  } finally { release(); await relinking.catch(() => {}); }
});
it("equal-duration relink invalidates transcripts and marks dependent cuts for review without changing expected metadata", async () => {
  const a = path.join(dir, "a.mp4"),
    b = path.join(dir, "b.mp4");
  for (const [f, c] of [
    [a, "red"],
    [b, "blue"],
  ])
    await run(runtime.ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${c}:s=64x48:r=30:d=1`,
      "-c:v",
      "libx264",
      f!,
    ]);
  const workspace = new WorkspaceService({
    runtime,
    dataRoot: path.join(dir, "app-data"),
    notify: () => {},
    dialogs: {
      media: async () => [a],
      open: async () => null,
      save: async () => null,
      relink: async () => b,
      model: async () => null,
    },
  });
  await workspace.initialize();
  const asset = (await workspace.importMedia()).project.assets[0]!;
  await workspace.applyEdit({
    type: "addCut",
    cut: {
      id: "manual",
      assetId: asset.id,
      fingerprint: asset.fingerprint,
      transcriptRevision: null,
      startMs: 100,
      endMs: 500,
      wordIds: [],
      text: "Manual",
      note: "",
      needsReview: false,
    },
  });
  const changed = await workspace.relinkMedia(asset.id);
  expect(changed.project.assets[0]).toMatchObject({
    status: "changed",
    durationMs: 1000,
    fingerprint: asset.fingerprint,
  });
  expect(changed.project.cuts[0]?.needsReview).toBe(true);
  await workspace.applyEdit({ type: "undo" });
  expect(workspace.snapshot().project.assets[0]?.status).toBe("changed");
});
it("reports corrupt recovery explicitly instead of silently claiming an empty healthy workspace", async () => {
  const dataRoot = path.join(dir, "app-data");
  await (await import("node:fs/promises")).mkdir(dataRoot);
  await writeFile(path.join(dataRoot, "recovery.json"), "broken JSON");
  const workspace = new WorkspaceService({
    runtime,
    dataRoot,
    notify: () => {},
    dialogs: {
      media: async () => [],
      open: async () => null,
      save: async () => null,
      relink: async () => null,
      model: async () => null,
    },
  });
  await workspace.initialize();
  expect(workspace.snapshot().save.error).toMatch(/recover/i);
});
it("refresh applies changed identity to the latest assets without losing a concurrent import or its cuts", async () => {
  const a = path.join(dir, "A.mp4"),
    b = path.join(dir, "B.mp4");
  for (const [file, color] of [
    [a, "red"],
    [b, "blue"],
  ])
    await run(runtime.ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=64x48:r=30:d=1`,
      "-c:v",
      "libx264",
      file!,
    ]);
  const workspace = new WorkspaceService({
    runtime,
    dataRoot: path.join(dir, "app-data"),
    notify: () => {},
    dialogs: {
      media: async () => [],
      open: async () => null,
      save: async () => null,
      relink: async () => null,
      model: async () => null,
    },
  });
  await workspace.initialize();
  const old = (await workspace.importPaths([a])).project.assets[0]!;
  const verify = workspace.media.verifyAssetIdentity.bind(workspace.media);
  let resume!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => (resume = r));
  const waiting = new Promise<void>((r) => (entered = r));
  workspace.media.verifyAssetIdentity = async (asset) => {
    if (asset.id === old.id) {
      entered();
      await gate;
    }
    return verify(asset);
  };
  const refreshing = workspace.refreshSources();
  await waiting;
  const imported = await workspace.importPaths([b]);
  const latest = imported.project.assets.find((asset) => asset.id !== old.id)!;
  await workspace.applyEdit({
    type: "addCut",
    cut: {
      id: "B-cut",
      assetId: latest.id,
      fingerprint: latest.fingerprint,
      transcriptRevision: null,
      startMs: 100,
      endMs: 500,
      wordIds: [],
      text: "B",
      note: "",
      needsReview: false,
    },
  });
  await copyFile(b, a);
  resume();
  await expect(refreshing).resolves.toBeUndefined();
  expect(
    workspace.snapshot().project.assets.map((asset) => asset.name),
  ).toEqual(["A.mp4", "B.mp4"]);
  expect(workspace.snapshot().project.assets[0]?.status).toBe("changed");
  expect(workspace.snapshot().project.cuts[0]).toMatchObject({
    assetId: latest.id,
    needsReview: false,
  });
  expect(workspace.sources.ids()).toContain(latest.id);
});
it("valid-corrupt-valid batch retains both real sources and reports a safe per-file failure", async () => {
  const a = path.join(dir, "good-one.mp4"),
    b = path.join(dir, "broken.mp4"),
    c = path.join(dir, "good-two.mp4");
  for (const target of [a, c])
    await run(runtime.ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x48:r=30:d=1",
      "-c:v",
      "libx264",
      target,
    ]);
  await writeFile(b, "corrupt");
  const workspace = new WorkspaceService({
    runtime,
    dataRoot: path.join(dir, "app-data"),
    notify: () => {},
    dialogs: {
      media: async () => [],
      open: async () => null,
      save: async () => null,
      relink: async () => null,
      model: async () => null,
    },
  });
  await workspace.initialize();
  const result = await workspace.importPaths([a, b, c]);
  expect(result.project.assets.map((asset) => asset.name)).toEqual([
    "good-one.mp4",
    "good-two.mp4",
  ]);
  expect(result.importFailures).toEqual([
    {
      name: "broken.mp4",
      message: expect.stringMatching(/supported|readable/i),
    },
  ]);
  expect(JSON.stringify(result)).not.toContain(dir);
  expect(workspace.sources.ids()).toHaveLength(2);
});

it("partial import publishes both assets and safe failures before a recovery error, then a real save retains both", async () => {
  const a = path.join(dir, "first.mp4"),
    bad = path.join(dir, "broken.mp4"),
    b = path.join(dir, "second.mp4");
  for (const file of [a, b])
    await run(runtime.ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x48:r=30:d=1",
      "-c:v",
      "libx264",
      file,
    ]);
  await writeFile(bad, "broken");
  const dataRoot = path.join(dir, "app-data"),
    target = path.join(dir, "saved.clipdeck");
  const emitted: any[] = [];
  const workspace = new WorkspaceService({
    runtime,
    dataRoot,
    notify: (s) => emitted.push(s),
    dialogs: {
      media: async () => [],
      open: async () => target,
      save: async () => target,
      relink: async () => null,
      model: async () => null,
    },
  });
  await workspace.initialize();
  await (
    await import("node:fs/promises")
  ).mkdir(path.join(dataRoot, "recovery.json"), { recursive: true });
  await expect(workspace.importPaths([a, bad, b])).rejects.toThrow(/recovery/i);
  const snapshot = workspace.snapshot();
  expect(snapshot.project.assets).toHaveLength(2);
  expect(snapshot.importFailures?.[0]?.name).toBe("broken.mp4");
  expect(snapshot.save.error).toMatch(/recovery/i);
  expect(
    emitted.some(
      (s) => s.project.assets.length === 2 && s.importFailures?.length === 1,
    ),
  ).toBe(true);
  expect((await workspace.getSnapshot()).importFailures).toEqual(
    snapshot.importFailures,
  );
  await rm(path.join(dataRoot, "recovery.json"), { recursive: true });
  await workspace.saveProject();
  const saved = await (
    await import("../../src/main/services/storage")
  ).readProjectFile(target);
  expect(saved.assets).toHaveLength(2);
  const recovery = JSON.parse(
    await (
      await import("node:fs/promises")
    ).readFile(path.join(dataRoot, "recovery.json"), "utf8"),
  );
  expect(recovery.currentPath).toBe(
    await (await import("node:fs/promises")).realpath(target),
  );
  expect(recovery.project.assets).toHaveLength(2);
  expect(workspace.snapshot().save).toMatchObject({
    dirty: false,
    error: null,
  });
  expect(workspace.snapshot().importFailures).toEqual(snapshot.importFailures);
  await workspace.importPaths([]);
  expect(workspace.snapshot().importFailures).toEqual([]);
});

it("a pending verification of an old path cannot revoke a newly authorized same-content relink", async () => {
  const a = path.join(dir, "old.mp4"),
    b = path.join(dir, "new.mp4");
  await run(runtime.ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x48:r=30:d=1",
    "-c:v",
    "libx264",
    a,
  ]);
  await copyFile(a, b);
  const workspace = new WorkspaceService({
    runtime,
    dataRoot: path.join(dir, "app-data"),
    notify: () => {},
    dialogs: {
      media: async () => [],
      open: async () => null,
      save: async () => null,
      relink: async () => b,
      model: async () => null,
    },
  });
  await workspace.initialize();
  const asset = (await workspace.importPaths([a])).project.assets[0]!;
  await writeFile(a, "changed");
  const verify = workspace.media.verifyAssetIdentity.bind(workspace.media);
  let failed!: () => void, resumeVerify!: () => void;
  const checked = new Promise<void>((r) => (failed = r)),
    verifyGate = new Promise<void>((r) => (resumeVerify = r));
  workspace.media.verifyAssetIdentity = async (selected) => {
    try {
      await verify(selected);
    } catch (error) {
      failed();
      await verifyGate;
      throw error;
    }
  };
  const prepare = workspace.media.prepareRelink.bind(workspace.media);
  let registered!: () => void;
  const linked = new Promise<void>((r) => (registered = r));
  workspace.media.prepareRelink = async (selected, file) => {
    const value = await prepare(selected, file);
    return { ...value, approve: () => { value.approve(); registered(); } };
  };
  const refresh = workspace.refreshSources();
  await checked;
  const relinking = workspace.relinkMedia(asset.id);
  await linked;
  resumeVerify();
  await refresh;
  expect(workspace.sources.resolve(asset.id)).toBe(
    await (await import("node:fs/promises")).realpath(b),
  );
  await relinking;
  expect(workspace.snapshot().project.assets[0]?.status).toBe("ready");
});
it("prepares guarded source and assembly previews and only exports through the native destination authority", async () => {
  const source = path.join(dir, "clip.mp4"),
    output = path.join(dir, "out.mp4");
  await run(runtime.ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x48:r=24:d=1",
    "-c:v",
    "libx264",
    source,
  ]);
  let dialogs = 0;
  const w = new WorkspaceService({
    runtime,
    dataRoot: path.join(dir, "data"),
    notify: () => {},
    dialogs: {
      media: async () => [source],
      open: async () => null,
      save: async () => null,
      relink: async () => null,
      model: async () => null,
      export: async () => {
        dialogs++;
        return output;
      },
    },
  });
  await w.initialize();
  await w.importMedia();
  const asset = w.project.assets[0]!;
  const sourceId = await w.prepareSourcePreview(asset.id);
  await w.jobs.wait(sourceId);
  expect(w.snapshot().project.assets[0]?.mediaUrl).toMatch(/^clipdeck-media:/);
  await w.applyEdit({
    type: "addCut",
    cut: {
      id: "manual",
      assetId: asset.id,
      fingerprint: asset.fingerprint,
      transcriptRevision: null,
      startMs: 130,
      endMs: 531,
      wordIds: [],
      text: "",
      note: "",
      needsReview: false,
    },
  });
  const preview = await w.preparePreview();
  await w.jobs.wait(preview);
  expect(w.jobs.list().find((j) => j.id === preview)?.status).toBe("completed");
  const exported = await w.exportVideo();
  await w.jobs.wait(exported);
  expect(dialogs).toBe(1);
  expect(w.jobs.list().find((j) => j.id === exported)?.status).toBe(
    "completed",
  );
  const { stat } = await import("node:fs/promises");
  expect((await stat(output)).size).toBeGreaterThan(1000);
  expect(JSON.stringify(w.snapshot())).not.toContain(dir);
  await w.close();
}, 30000);

const acceptanceRoot = process.env.CLIPDECK_ACCEPTANCE_ROOT;
it.runIf(!!acceptanceRoot)(
  "safe re-ASR keeps prior text while running, commits a new origin, stales cuts, and text correction survives save/reopen",
  async () => {
    const source = path.join(dir, "speech.mp4");
    await run(runtime.ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x48:r=30",
      "-i",
      path.join(acceptanceRoot!, "acceptance-fixtures/paddlespeech-zh.wav"),
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-shortest",
      source,
    ]);
    const target = path.join(dir, "corrected.clipdeck");
    const localModel = path.join(
      process.env.HOME!,
      ".cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120",
    );
    const workspace = new WorkspaceService({
      runtime,
      dataRoot: path.join(dir, "quality-data"),
      notify: () => {},
      dialogs: {
        media: async () => [source],
        open: async () => target,
        save: async () => target,
        relink: async () => null,
        model: async () => localModel,
      },
    });
    await workspace.initialize();
    const asset = (await workspace.importMedia()).project.assets[0]!;
    await workspace.chooseModel();
    const first = await workspace.transcribe(asset.id, "zh");
    await workspace.jobs.wait(first);
    expect(workspace.jobs.list().find((job) => job.id === first)?.status).toBe(
      "completed",
    );
    const old = workspace.project.transcripts[0]!;
    const word = old.words[0]!;
    await workspace.applyEdit({
      type: "addCut",
      cut: {
        id: "derived-cut",
        assetId: asset.id,
        fingerprint: asset.fingerprint,
        transcriptRevision: old.revision,
        startMs: word.startMs,
        endMs: word.endMs,
        wordIds: [word.id],
        text: word.text,
        note: "",
        needsReview: false,
      },
    });
    const retry = await workspace.transcribe(asset.id, "zh", {
      vocabulary: "跑步，健康",
    });
    expect(workspace.project.transcripts[0]).toBe(old);
    await expect(workspace.transcribe(asset.id, "zh")).rejects.toThrow(
      /already/,
    );
    await workspace.jobs.wait(retry);
    expect(workspace.jobs.list().find((job) => job.id === retry)?.status).toBe(
      "completed",
    );
    const replaced = workspace.project.transcripts[0]!;
    expect(replaced.revision).toBe(old.revision + 1);
    expect(replaced.originId).not.toBe(old.originId);
    expect(workspace.project.cuts[0]?.needsReview).toBe(true);
    const anchored = replaced.words[0]!;
    await workspace.applyEdit({
      type: "correctTranscript",
      assetId: asset.id,
      fingerprint: asset.fingerprint,
      transcriptRevision: replaced.revision,
      changes: [{ wordId: anchored.id, text: "我" }],
    });
    const corrected = workspace.project.transcripts[0]!;
    expect(corrected.words[0]).toMatchObject({
      id: anchored.id,
      startMs: anchored.startMs,
      endMs: anchored.endMs,
      text: "我",
    });
    await workspace.saveProject();
    const reopened = await workspace.openProject();
    expect(reopened.project.transcripts[0]).toEqual(corrected);
    expect(reopened.project.cuts[0]?.needsReview).toBe(true);
    expect(reopened.save.dirty).toBe(false);
    await workspace.close();
  },
  60000,
);

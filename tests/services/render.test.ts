import { beforeAll, afterAll, it, expect, vi } from "vitest";
import {
  mkdtemp,
  rm,
  readFile,
  readdir,
  writeFile,
  link,
  symlink,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MediaService, SourceRegistry } from "../../src/main/services/media";
import { JobManager } from "../../src/main/services/jobs";
import { RenderService } from "../../src/main/services/render";
import { runProcess } from "../../src/main/services/process";
import { createProject } from "../../src/domain/project";
import { buildAssemblyPlan } from "../../src/domain/assembly";
import type { Asset, Project } from "../../src/shared/contracts";
const ffmpeg = path.resolve(".runtime/bin/ffmpeg"),
  ffprobe = path.resolve(".runtime/bin/ffprobe");
let dir: string, red: string, blue: string, delayed: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clipdeck-render-"));
  red = path.join(dir, "red 中文.mp4");
  blue = path.join(dir, "blue.mp4");
  delayed = path.join(dir, "delayed.mkv");
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=96x64:r=24:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    red,
  ]);
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x96:r=25:d=2",
    "-vf",
    "setsar=4/3",
    "-c:v",
    "libx264",
    blue,
  ]);
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=96x64:r=30:d=2",
    "-itsoffset",
    "0.5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=48000:duration=1.5",
    "-c:v",
    "libx264",
    "-c:a",
    "pcm_s16le",
    delayed,
  ]);
}, 30000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function setup(files = [red, blue], notify: () => void = () => {}) {
  const media = new MediaService(ffprobe, new SourceRegistry());
  const assets = await Promise.all(files.map((f) => media.probeAsset(f)));
  const project = createProject();
  project.assets = assets;
  project.output = {
    preset: "landscape",
    width: 1920,
    height: 1080,
    fps: 30,
    sampleRate: 48000,
  };
  project.cuts = assets.map((a, i) => ({
    id: `cut-${i}`,
    assetId: a.id,
    fingerprint: a.fingerprint,
    transcriptRevision: null,
    startMs: 130,
    endMs: 531,
    wordIds: [],
    text: "",
    note: "",
    needsReview: false,
  }));
  project.cutOrder = project.cuts.map((c) => c.id);
  const jobs = new JobManager(notify);
  const render = new RenderService({
    ffmpeg,
    ffprobe,
    media,
    jobs,
    cacheRoot: path.join(dir, crypto.randomUUID()),
    getProject: () => project,
  });
  return { media, assets, project, jobs, render };
}
async function finish(s: Awaited<ReturnType<typeof setup>>, id: string) {
  await s.jobs.wait(id);
  return s.jobs.list().find((j) => j.id === id)!;
}
it("renders exact non-frame-aligned two-source selections to 26 frames and 41600 decoded samples", async () => {
  const s = await setup();
  const plan = buildAssemblyPlan(s.project);
  const id = await s.render.preview(plan);
  const job = await finish(s, id);
  expect(job.status, job.error ?? "").toBe("completed");
  const receipt = s.render.receipt(id)!;
  expect(receipt).toMatchObject({
    frames: 26,
    samples: 41600,
    width: 960,
    height: 540,
  });
  expect(job).toMatchObject({ projectId: s.project.id, projectRevision: 0 });
  expect(job.outputUrl).toMatch(/^clipdeck-media:\/\/media\/[a-f0-9-]+$/);
}, 30000);
it("rejects an interval containing no selected frame and leaves no published file", async () => {
  const s = await setup([red]);
  s.project.cuts[0]!.startMs = 1;
  s.project.cuts[0]!.endMs = 2;
  const id = await s.render.preview(buildAssemblyPlan(s.project));
  const job = await finish(s, id);
  expect(job.status).toBe("failed");
  expect(job.error).toMatch(/frame|range/i);
  expect(job.outputUrl).toBeNull();
}, 30000);
it("preserves delayed audio on the common source time axis", async () => {
  const s = await setup([delayed]);
  s.project.cuts[0]!.startMs = 100;
  s.project.cuts[0]!.endMs = 1100;
  const id = await s.render.preview(buildAssemblyPlan(s.project));
  expect((await finish(s, id)).status).toBe("completed");
  const wav = path.join(dir, "delay.wav");
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-i",
    s.render.outputPath(id)!,
    "-vn",
    "-c:a",
    "pcm_s16le",
    wav,
  ]);
  const bytes = await readFile(wav);
  const pos = bytes.indexOf(Buffer.from("data")) + 8;
  const energy = (start: number, end: number) => {
    let v = 0;
    for (let n = start * 48000 * 2; n < end * 48000 * 2; n++)
      v += Math.abs(bytes.readInt16LE(pos + n * 2));
    return v / ((end - start) * 48000 * 2);
  };
  expect(energy(0, 0.35)).toBeLessThan(10);
  expect(energy(0.5, 0.8)).toBeGreaterThan(500);
}, 30000);
it("rejects source hardlink/symlink targets and unconfirmed existing outputs", async () => {
  const s = await setup([red]);
  const plan = buildAssemblyPlan(s.project);
  const hard = path.join(dir, "hard.mp4"),
    sym = path.join(dir, "sym.mp4"),
    existing = path.join(dir, "existing.mp4");
  await link(red, hard);
  await symlink(red, sym);
  await writeFile(existing, "keep");
  for (const target of [red, hard, sym])
    await expect(
      s.render.export(plan, { path: target, overwriteConfirmed: true }),
    ).rejects.toThrow(/source|alias|symbolic/i);
  await expect(
    s.render.export(plan, { path: existing, overwriteConfirmed: false }),
  ).rejects.toThrow(/overwrite|confirm/i);
  expect(await readFile(existing, "utf8")).toBe("keep");
}, 30000);
it("detects source replacement after encoding, cleans only its staging files, and retries", async () => {
  const own = path.join(dir, "changing.mp4");
  await copyFile(red, own);
  let s: Awaited<ReturnType<typeof setup>>,
    changed = false;
  s = await setup([own], () => {
    if (
      !changed &&
      s?.jobs.list().some((j) => j.stage === "validating decode")
    ) {
      changed = true;
      requireWrite();
    }
  });
  function requireWrite() {
    /* synchronous external replacement at the actual validation boundary */ const fs =
      process.getBuiltinModule("fs");
    fs.copyFileSync(blue, own);
  }
  const target = path.join(dir, "change-output.mp4");
  const id = await s.render.export(buildAssemblyPlan(s.project), {
    path: target,
    overwriteConfirmed: false,
  });
  expect((await finish(s, id)).status).toBe("failed");
  expect(changed).toBe(true);
  expect(await readdir(dir)).not.toContain("change-output.mp4");
  await copyFile(red, own);
  const retry = await s.render.export(buildAssemblyPlan(s.project), {
    path: target,
    overwriteConfirmed: false,
  });
  expect((await finish(s, retry)).status).toBe("completed");
}, 30000);
it.each([
  "rendering cut 1 of 1",
  "validating decode",
  "validating presentation",
  "validating samples",
  "checking sources",
  "committing",
])(
  "cancels at %s before publication and preserves existing target",
  async (stage) => {
    let s: Awaited<ReturnType<typeof setup>>,
      cancelled = false;
    s = await setup([red], () => {
      const job = s?.jobs.list().find((j) => j.stage === stage);
      if (job && !cancelled) {
        cancelled = true;
        void s.jobs.cancel(job.id);
      }
    });
    const target = path.join(dir, `cancel-${stage.replaceAll(" ", "-")}.mp4`);
    await writeFile(target, "keep");
    const id = await s.render.export(buildAssemblyPlan(s.project), {
      path: target,
      overwriteConfirmed: true,
    });
    expect((await finish(s, id)).status).toBe("cancelled");
    expect(cancelled).toBe(true);
    expect(await readFile(target, "utf8")).toBe("keep");
  },
  30000,
);
it("a published result stays completed after cancellation; render uses immutable startup plan", async () => {
  const s = await setup([red]);
  const plan = buildAssemblyPlan(s.project);
  const id = await s.render.preview(plan);
  plan.segments[0]!.endMs = 1800;
  plan.output.width = 12;
  expect((await finish(s, id)).status).toBe("completed");
  await s.jobs.cancel(id);
  expect(s.render.receipt(id)?.frames).toBe(13);
  expect(s.jobs.list().find((j) => j.id === id)?.status).toBe("completed");
}, 30000);
it("normalizes source previews with original source time, independent job kind, identity invalidation and cancellable retry", async () => {
  const s = await setup([delayed]);
  const asset = s.assets[0]!;
  const id = await s.render.prepareSourcePreview(asset.id);
  const job = await finish(s, id);
  expect(job.status, job.error ?? "").toBe("completed");
  expect(job.kind).toBe("sourcePreview");
  expect(job.projectRevision).toBeUndefined();
  expect(s.render.sourceUrl(asset)).toBe(job.outputUrl);
  expect(s.render.receipt(id)).toMatchObject({ frames: 60, samples: 96000 });
  expect(await s.render.prepareSourcePreview(asset.id)).toBe(id);
  s.media.sources.register(asset.id, delayed);
  expect(s.render.sourceUrl(asset)).toBeNull();
  expect(
    (await s.render.protocol.handle(new Request(job.outputUrl!), true)).status,
  ).toBe(410);
});
it("normalizes a positive container origin without erasing delayed audio", async () => {
  const file = path.join(dir, "positive-origin.mp4");
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=green:s=96x64:r=30:d=2",
    "-itsoffset",
    "0.5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=48000:duration=1.5",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-output_ts_offset",
    "3",
    file,
  ]);
  const s = await setup([file]);
  expect(s.assets[0]?.durationMs).toBe(2000);
  s.project.cuts[0]!.startMs = 100;
  s.project.cuts[0]!.endMs = 1100;
  const id = await s.render.preview(buildAssemblyPlan(s.project));
  expect((await finish(s, id)).status).toBe("completed");
  const wav = path.join(dir, "origin.wav");
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-i",
    s.render.outputPath(id)!,
    "-vn",
    "-c:a",
    "pcm_s16le",
    wav,
  ]);
  const bytes = await readFile(wav),
    pos = bytes.indexOf(Buffer.from("data")) + 8;
  let silence = 0,
    tone = 0;
  for (let i = 0; i < 12000; i++)
    silence += Math.abs(bytes.readInt16LE(pos + i * 4));
  for (let i = 24000; i < 36000; i++)
    tone += Math.abs(bytes.readInt16LE(pos + i * 4));
  expect(silence / 12000).toBeLessThan(10);
  expect(tone / 12000).toBeGreaterThan(500);
}, 30000);
it("source preparation cancels before verification and retries without a stale URL", async () => {
  let s: Awaited<ReturnType<typeof setup>>,
    cancelled = false;
  s = await setup([red], () => {
    const j = s?.jobs
      .list()
      .find(
        (j) =>
          j.kind === "sourcePreview" && j.stage === "validating presentation",
      );
    if (j && !cancelled) {
      cancelled = true;
      void s.jobs.cancel(j.id);
    }
  });
  const first = await s.render.prepareSourcePreview(s.assets[0]!.id);
  expect((await finish(s, first)).status).toBe("cancelled");
  expect(s.render.sourceUrl(s.assets[0]!)).toBeNull();
  const retry = await s.render.prepareSourcePreview(s.assets[0]!.id);
  expect(retry).not.toBe(first);
  expect((await finish(s, retry)).status).toBe("completed");
}, 30000);
it("pads the last selected frame and never borrows the next source frame across the end bound", async () => {
  const file = path.join(dir, "red-then-blue.mp4");
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=96x64:r=24:d=0.5",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=96x64:r=24:d=0.5",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map",
    "[v]",
    "-c:v",
    "libx264",
    file,
  ]);
  const s = await setup([file]);
  s.project.cuts[0]!.startMs = 130;
  s.project.cuts[0]!.endMs = 499;
  const id = await s.render.preview(buildAssemblyPlan(s.project));
  expect((await finish(s, id)).status).toBe("completed");
  expect(s.render.receipt(id)?.frames).toBe(12);
  const image = path.join(dir, "last-selected.png");
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-i",
    s.render.outputPath(id)!,
    "-vf",
    "trim=start_frame=11,crop=8:8:iw/2:ih/2,scale=1:1,format=rgb24",
    "-frames:v",
    "1",
    "-an",
    "-c:v",
    "png",
    image,
  ]);
  const { inflateSync } = await import("node:zlib");
  const png = await readFile(image);
  let at = 8;
  const parts: Buffer[] = [];
  while (at < png.length) {
    const n = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT")
      parts.push(png.subarray(at + 8, at + 8 + n));
    at += n + 12;
  }
  const rgb = inflateSync(Buffer.concat(parts));
  expect(rgb[1]).toBeGreaterThan(230);
  expect(rgb[3]).toBeLessThan(20);
}, 30000);
it("coalesces simultaneous preparation requests and rebuilds a deleted proxy", async () => {
  const s = await setup([red]);
  const asset = s.assets[0]!;
  const [a, b] = await Promise.all([
    s.render.prepareSourcePreview(asset.id),
    s.render.prepareSourcePreview(asset.id),
  ]);
  expect(a).toBe(b);
  expect((await finish(s, a)).status).toBe("completed");
  await rm(s.render.outputPath(a)!);
  expect(s.render.sourceUrl(asset)).toBeNull();
  const retry = await s.render.prepareSourcePreview(asset.id);
  expect(retry).not.toBe(a);
  expect((await finish(s, retry)).status).toBe("completed");
}, 30000);
it("invalidates a cached proxy after same-content source metadata changes and rebuilds without permanent stale authority", async () => {
  const own = path.join(dir, "touched-source.mp4");
  await copyFile(red, own);
  const s = await setup([own]);
  const asset = s.assets[0]!;
  const first = await s.render.prepareSourcePreview(asset.id);
  expect((await finish(s, first)).status).toBe("completed");
  const { utimes } = await import("node:fs/promises");
  await utimes(own, new Date(), new Date(Date.now() + 1000));
  expect(s.render.sourceUrl(asset)).toBeNull();
  expect(s.render.sourceJobCurrent(first)).toBe(false);
  const retry = await s.render.prepareSourcePreview(asset.id);
  expect(retry).not.toBe(first);
  expect((await finish(s, retry)).status).toBe("completed");
}, 30000);
it("evicts the oldest inactive proxy on a ninth source, protects the currently served video, and makes eviction prepareable", async () => {
  const s = await setup(Array(9).fill(red));
  const ids: string[] = [];
  for (const asset of s.assets.slice(0, 8)) {
    const id = await s.render.prepareSourcePreview(asset.id);
    expect((await finish(s, id)).status).toBe("completed");
    ids.push(id);
  }
  const active = s.render.sourceUrl(s.assets[0]!)!;
  const firstRead = await s.render.protocol.handle(new Request(active), true);
  expect(firstRead.status).toBe(200);
  await firstRead.arrayBuffer();
  const ninth = await s.render.prepareSourcePreview(s.assets[8]!.id);
  expect((await finish(s, ninth)).status).toBe("completed");
  expect(s.render.sourceUrl(s.assets[0]!)).toBe(active);
  expect(s.render.sourceUrl(s.assets[1]!)).toBeNull();
  expect(s.render.outputPath(ids[1]!)).toBeUndefined();
  const activeAgain = await s.render.protocol.handle(new Request(active), true);
  expect(activeAgain.status).toBe(200);
  await activeAgain.arrayBuffer();
  const retry = await s.render.prepareSourcePreview(s.assets[1]!.id);
  expect(retry).not.toBe(ids[1]);
  expect((await finish(s, retry)).status).toBe("completed");
}, 30000);
it("retiring a deleted proxy at the eight-entry limit preserves its completed replacement lookup", async () => {
  const s = await setup(Array(8).fill(red));
  const ids: string[] = [];
  for (const asset of s.assets) {
    const id = await s.render.prepareSourcePreview(asset.id);
    expect((await finish(s, id)).status).toBe("completed");
    ids.push(id);
  }
  const asset = s.assets[0]!;
  await rm(s.render.outputPath(ids[0]!)!);
  expect(s.render.sourceUrl(asset)).toBeNull();
  const retry = await s.render.prepareSourcePreview(asset.id);
  const completed = await finish(s, retry);
  expect(completed.status, completed.error ?? "").toBe("completed");
  expect(completed.outputUrl).not.toBeNull();
  expect(s.render.sourceUrl(asset)).toBe(completed.outputUrl);
  const response = await s.render.protocol.handle(
    new Request(s.render.sourceUrl(asset)!),
    true,
  );
  expect(response.status).toBe(200);
  expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  expect(await s.render.prepareSourcePreview(asset.id)).toBe(retry);
}, 30000);
it.each(["source", "assembly"] as const)(
  "%s playback serves repeated GET/HEAD/ranges without rereading original bytes",
  async (kind) => {
    const s = await setup([red, blue]);
    // Observe the real whole-file verifier: no hashing or native processing is mocked.
    const hashes = vi.spyOn(s.media, "verifyAssetIdentity");
    const id =
      kind === "source"
        ? await s.render.prepareSourcePreview(s.assets[0]!.id)
        : await s.render.preview(buildAssemblyPlan(s.project));
    const job = await finish(s, id);
    expect(job.status, job.error ?? "").toBe("completed");
    const processingHashes = hashes.mock.calls.length;
    expect(processingHashes).toBe(kind === "source" ? 2 : 4);
    await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const response = await s.render.protocol.handle(
          new Request(job.outputUrl!, {
            method: i % 3 === 0 ? "HEAD" : "GET",
            headers: { Range: `bytes=${i * 16}-${i * 16 + 15}` },
          }),
          true,
        );
        expect(response.status).toBe(206);
        expect(response.headers.get("content-length")).toBe("16");
        expect((await response.arrayBuffer()).byteLength).toBe(
          i % 3 === 0 ? 0 : 16,
        );
      }),
    );
    expect(hashes.mock.calls.length).toBe(processingHashes);
  },
  30000,
);
it.each([
  "source change",
  "registry change",
  "proxy change",
  "project revision",
] as const)(
  "playback denies %s through lightweight authority checks",
  async (change) => {
    const own = path.join(dir, `${change.replaceAll(" ", "-")}-guard.mp4`);
    await copyFile(red, own);
    const s = await setup([own]);
    const hashes = vi.spyOn(s.media, "verifyAssetIdentity");
    const sourceId = await s.render.prepareSourcePreview(s.assets[0]!.id);
    const sourceJob = await finish(s, sourceId);
    const assemblyId = await s.render.preview(buildAssemblyPlan(s.project));
    const assemblyJob = await finish(s, assemblyId);
    expect(sourceJob.status).toBe("completed");
    expect(assemblyJob.status).toBe("completed");
    const processingHashes = hashes.mock.calls.length;
    if (change === "source change") await copyFile(blue, own);
    if (change === "registry change")
      s.media.sources.register(s.assets[0]!.id, own);
    if (change === "proxy change") {
      await writeFile(s.render.outputPath(sourceId)!, "changed proxy");
      await writeFile(s.render.outputPath(assemblyId)!, "changed proxy");
    }
    if (change === "project revision") s.project.revision++;
    for (const job of [sourceJob, assemblyJob]) {
      const response = await s.render.protocol.handle(
        new Request(job.outputUrl!, { headers: { Range: "bytes=0-15" } }),
        true,
      );
      const expected =
        change === "project revision" && job.kind === "sourcePreview"
          ? 206
          : 410;
      expect(response.status).toBe(expected);
      await response.arrayBuffer();
    }
    expect(hashes.mock.calls.length).toBe(processingHashes);
  },
  30000,
);

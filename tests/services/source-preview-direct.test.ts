import { beforeAll, afterAll, it, expect, vi } from "vitest";
import {
  mkdtemp,
  rm,
  copyFile,
  readFile,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MediaService, SourceRegistry } from "../../src/main/services/media";
import { JobManager } from "../../src/main/services/jobs";
import { RenderService } from "../../src/main/services/render";
import { runProcess } from "../../src/main/services/process";
import { createProject } from "../../src/domain/project";
import { ProjectStore } from "../../src/main/services/storage";
const ffmpeg = path.resolve(".runtime/bin/ffmpeg"),
  ffprobe = path.resolve(".runtime/bin/ffprobe");
let dir: string,
  video: string,
  delayed: string,
  positive: string,
  rotated: string,
  sar: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clipdeck-direct-"));
  video = path.join(dir, "verified source.mp4");
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=96x64:r=30:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    video,
  ]);
  delayed = path.join(dir, "delayed.mp4");
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=96x64:r=30:d=3",
    "-itsoffset",
    "0.5",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=2.5",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    delayed,
  ]);
  positive = path.join(dir, "positive.mp4");
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-i",
    video,
    "-c",
    "copy",
    "-output_ts_offset",
    "3",
    positive,
  ]);
  rotated = path.join(dir, "rotated.mp4");
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-display_rotation",
    "90",
    "-i",
    video,
    "-c",
    "copy",
    rotated,
  ]);
  sar = path.join(dir, "sar.mp4");
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-i",
    video,
    "-vf",
    "setsar=4/3",
    "-c:v",
    "libx264",
    "-c:a",
    "copy",
    sar,
  ]);
}, 30000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function setup(files = [video]) {
  const media = new MediaService(ffprobe, new SourceRegistry()),
    project = createProject();
  project.assets = await Promise.all(files.map((f) => media.probeAsset(f)));
  const jobs = new JobManager(() => {}),
    render = new RenderService({
      ffmpeg,
      ffprobe,
      media,
      jobs,
      cacheRoot: path.join(dir, crypto.randomUUID()),
      getProject: () => project,
    });
  return { media, project, jobs, render };
}
async function finish(s: Awaited<ReturnType<typeof setup>>, id: string) {
  await s.jobs.wait(id);
  const job = s.jobs.list().find((j) => j.id === id)!;
  expect(job.status, job.error ?? "").toBe("completed");
  return job;
}
it("publishes an approved MP4 original immediately with guarded range bytes and no source encode", async () => {
  const s = await setup(),
    asset = s.project.assets[0]!;
  const encode = vi.spyOn(s.render.engine, "ff"),
    hash = vi.spyOn(s.media, "verifyAssetIdentity");
  const url = s.render.sourceUrl(asset);
  expect(url).toBeTypeOf("string");
  expect(url).toMatch(/^clipdeck-media:\/\/media\//);
  expect(s.jobs.list()).toHaveLength(0);
  expect(encode).not.toHaveBeenCalled();
  expect(hash).not.toHaveBeenCalled();
  const response = await s.render.protocol.handle(
    new Request(url!, { headers: { Range: "bytes=0-31" } }),
    true,
  );
  expect(response.status).toBe(206);
  expect(response.headers.get("content-type")).toBe("video/mp4");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(
    (await readFile(video)).subarray(0, 32),
  );
  expect(
    (await s.render.protocol.handle(new Request(url!), false)).status,
  ).toBe(403);
  expect(s.render.sourceUrl(asset)).toBe(url);
});
it("uses verified native metadata rather than extension or renderer-supplied asset metadata", async () => {
  const renamed = path.join(dir, "genuine-video.untrusted-extension");
  await copyFile(video, renamed);
  const s = await setup([renamed]);
  const asset = s.project.assets[0]!;
  expect(s.render.sourceUrl(asset)).not.toBeNull();
  s.media.sources.register(asset.id, renamed);
  expect(s.render.sourceUrl(asset)).toBeNull();
  const linked = await s.media.relink(asset, renamed);
  s.project.assets = [linked];
  expect(s.render.sourceUrl(linked)).not.toBeNull();
  expect(
    s.render.sourceUrl({ ...linked, fingerprint: "sha256:" + "0".repeat(64) }),
  ).toBeNull();
  expect(s.render.sourceUrl({ ...linked, durationMs: 1234 })).toBeNull();
  expect(s.render.sourceUrl({ ...linked, rotation: 90 })).toBeNull();
});
it("an explicit normalized fallback retires the direct candidate before its job and coalesces proxy requests", async () => {
  const s = await setup(),
    asset = s.project.assets[0]!;
  const direct = s.render.sourceUrl(asset)!;
  expect(direct).not.toBeNull();
  const request = s.render.prepareSourcePreview(asset.id);
  expect(s.render.sourceUrl(asset)).toBeNull();
  expect(
    (await s.render.protocol.handle(new Request(direct), true)).status,
  ).toBe(403);
  const [first, second] = await Promise.all([
    request,
    s.render.prepareSourcePreview(asset.id),
  ]);
  expect(first).toBe(second);
  const done = await finish(s, first);
  expect(s.render.sourceUrl(asset)).toBe(done.outputUrl);
  expect(done.outputUrl).not.toBe(direct);
  expect(s.render.outputPath(first)).not.toBe(video);
  expect((await readFile(video)).byteLength).toBeGreaterThan(1000);
});
it("failed direct fallback stays retired and permits explicit normalized retry", async () => {
  const s = await setup(),
    asset = s.project.assets[0]!;
  const direct = s.render.sourceUrl(asset)!;
  expect(direct).not.toBeNull();
  const encode = vi
    .spyOn(s.render.engine, "ff")
    .mockRejectedValueOnce(new Error("Controlled encoder failure"));
  const id = await s.render.prepareSourcePreview(asset.id);
  await s.jobs.wait(id);
  expect(s.jobs.list().find((j) => j.id === id)?.status).toBe("failed");
  expect(s.render.sourceUrl(asset)).toBeNull();
  expect(
    (await s.render.protocol.handle(new Request(direct), true)).status,
  ).toBe(403);
  encode.mockRestore();
  const retry = await s.render.prepareSourcePreview(asset.id);
  const done = await finish(s, retry);
  expect(s.render.sourceUrl(asset)).toBe(done.outputUrl);
});
it("rejects delayed audio, positive origins, non-square pixels and rotated candidates without removing proxy fallback", async () => {
  const s = await setup([delayed, positive, sar, rotated]);
  for (const asset of s.project.assets)
    expect(s.render.sourceUrl(asset)).toBeNull();
  const id = await s.render.prepareSourcePreview(s.project.assets[0]!.id);
  const done = await finish(s, id);
  expect(s.render.sourceUrl(s.project.assets[0]!)).toBe(done.outputUrl);
});
it("cancelled normalization does not revive an already rejected direct identity", async () => {
  const s = await setup(),
    asset = s.project.assets[0]!,
    direct = s.render.sourceUrl(asset)!;
  expect(direct).not.toBeNull();
  const id = await s.render.prepareSourcePreview(asset.id);
  await s.jobs.cancel(id);
  expect(s.jobs.list().find((job) => job.id === id)?.status).toBe("cancelled");
  expect(s.render.sourceUrl(asset)).toBeNull();
  expect(
    (await s.render.protocol.handle(new Request(direct), true)).status,
  ).toBe(403);
  const retry = await s.render.prepareSourcePreview(asset.id);
  expect((await finish(s, retry)).outputUrl).not.toBeNull();
});
it("revokes original authority on file changes, relink and project switch", async () => {
  const own = path.join(dir, "mutable.mp4");
  await copyFile(video, own);
  const s = await setup([own]),
    asset = s.project.assets[0]!;
  const original = s.render.sourceUrl(asset)!;
  expect(original).not.toBeNull();
  const same = path.join(dir, "same.mp4");
  await copyFile(video, same);
  const linked = await s.media.relink(asset, same);
  s.project.assets = [linked];
  const relinked = s.render.sourceUrl(linked)!;
  expect(relinked).not.toBe(original);
  expect(
    (await s.render.protocol.handle(new Request(original), true)).status,
  ).not.toBe(200);
  await writeFile(same, "changed source");
  expect(s.render.sourceUrl(linked)).toBeNull();
  expect(
    (await s.render.protocol.handle(new Request(relinked), true)).status,
  ).not.toBe(200);
  const restored = await s.media.relink(asset, video);
  s.project.assets = [restored];
  const current = s.render.sourceUrl(restored)!;
  expect(current).not.toBeNull();
  s.project.id = crypto.randomUUID();
  expect(
    (await s.render.protocol.handle(new Request(current), true)).status,
  ).not.toBe(200);
  expect(s.render.sourceUrl(restored)).not.toBe(current);
});
it("reopened projects obtain direct approval only through verified native relink", async () => {
  const s = await setup();
  const store = new ProjectStore(
      path.join(dir, "recovery.json"),
      s.media.sources,
      s.media,
    ),
    target = path.join(dir, "saved.clipdeck");
  const url = s.render.sourceUrl(s.project.assets[0]!)!;
  expect(url).not.toBeNull();
  await store.save(s.project, target);
  const reopened = await store.open(target);
  Object.assign(s.project, reopened);
  const restored = s.render.sourceUrl(s.project.assets[0]!);
  expect(restored).not.toBeNull();
  expect(restored).not.toBe(url);
  expect(
    (await s.render.protocol.handle(new Request(url), true)).status,
  ).not.toBe(200);
});
it("original capabilities never occupy or get deleted by the eight-entry proxy cache", async () => {
  const s = await setup(Array(10).fill(video)),
    originalBytes = await readFile(video);
  const direct = s.render.sourceUrl(s.project.assets[0]!)!;
  expect(direct).not.toBeNull();
  for (const asset of s.project.assets.slice(1)) {
    const id = await s.render.prepareSourcePreview(asset.id);
    await finish(s, id);
  }
  expect(await readFile(video)).toEqual(originalBytes);
  expect(s.render.sourceUrl(s.project.assets[0]!)).toBe(direct);
  const response = await s.render.protocol.handle(
    new Request(direct, { headers: { Range: "bytes=0-15" } }),
    true,
  );
  expect(response.status).toBe(206);
  await response.arrayBuffer();
  expect(
    (await readdir(s.render.options.cacheRoot)).filter((f) =>
      f.endsWith(".mp4"),
    ),
  ).toHaveLength(8);
}, 30000);
const codecRoot = process.env.CLIPDECK_DIRECT_FIXTURES;
it.runIf(!!codecRoot)(
  "native probe approves a real SDR HEVC Main10 hvc1 original and forces proxy for ProRes/PCM and PQ",
  async () => {
    const s = await setup([
      path.join(codecRoot!, "hevc-main10-sdr.mp4"),
      path.join(codecRoot!, "prores-pcm.mov"),
      path.join(codecRoot!, "hevc-main10-pq.mp4"),
    ]);
    const hevc = s.project.assets[0]!;
    expect(s.media.approvedOriginal(hevc)?.codec).toBe("hevc");
    const url = s.render.sourceUrl(hevc);
    expect(url).not.toBeNull();
    expect(s.jobs.list()).toHaveLength(0);
    const response = await s.render.protocol.handle(
      new Request(url!, { headers: { Range: "bytes=0-31" } }),
      true,
    );
    expect(response.status).toBe(206);
    await response.arrayBuffer();
    expect(s.render.sourceUrl(s.project.assets[1]!)).toBeNull();
    expect(s.render.sourceUrl(s.project.assets[2]!)).toBeNull();
    const id = await s.render.prepareSourcePreview(hevc.id);
    const done = await finish(s, id);
    expect(done.outputUrl).not.toBe(url);
    expect(s.render.sourceUrl(hevc)).toBe(done.outputUrl);
    const proresId = await s.render.prepareSourcePreview(
      s.project.assets[1]!.id,
    );
    expect((await finish(s, proresId)).outputUrl).not.toBeNull();
  },
  30000,
);

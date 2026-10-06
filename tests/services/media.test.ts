import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MediaService, SourceRegistry } from "../../src/main/services/media";
const run = promisify(execFile);
const ffmpeg = path.resolve(".runtime/bin/ffmpeg");
const ffprobe = path.resolve(".runtime/bin/ffprobe");
let dir: string, a: string, b: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clipdeck-media-"));
  a = path.join(dir, "中文 interview with spaces.mp4");
  b = path.join(dir, "replacement.mp4");
  for (const [target, color] of [
    [a, "red"],
    [b, "blue"],
  ])
    await run(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=64x48:r=30:d=1`,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-shortest",
      target!,
    ]);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
describe("real source probing and identities", () => {
  it("probes Unicode/space filenames and returns actual dimensions, duration and audio", async () => {
    const media = new MediaService(ffprobe, new SourceRegistry());
    const asset = await media.probeAsset(a);
    expect(asset).toMatchObject({
      name: "中文 interview with spaces.mp4",
      width: 64,
      height: 48,
      durationMs: 1000,
      hasAudio: true,
      fps: 30,
      rotation: 0,
      status: "ready",
    });
    expect(asset.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(asset.fileRef).not.toContain(dir);
    await expect(media.verifyAssetIdentity(asset)).resolves.toBeUndefined();
  });
  it("rejects corrupt and unsupported inputs without registration", async () => {
    const bad = path.join(dir, "bad.mp4");
    await writeFile(bad, "not video");
    const registry = new SourceRegistry();
    const media = new MediaService(ffprobe, registry);
    await expect(media.probeAsset(bad)).rejects.toThrow();
    expect(registry.ids()).toEqual([]);
  });
  it("same bytes relink as ready but equal-duration different bytes preserve expected identity and invalidate", async () => {
    const registry = new SourceRegistry();
    const media = new MediaService(ffprobe, registry);
    const asset = await media.probeAsset(a);
    const same = path.join(dir, "same.mp4");
    await copyFile(a, same);
    expect(await media.relink(asset, same)).toMatchObject({
      status: "ready",
      fingerprint: asset.fingerprint,
      durationMs: 1000,
    });
    const changed = await media.relink(asset, b);
    expect(changed).toMatchObject({
      status: "changed",
      fingerprint: asset.fingerprint,
      durationMs: 1000,
    });
    await expect(media.verifyAssetIdentity(changed)).rejects.toThrow(
      /changed/i,
    );
  });
  it("shorter replacement keeps old duration so existing cut ranges remain valid but blocked", async () => {
    const short = path.join(dir, "short.mp4");
    await run(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=64x48:r=30:d=0.4",
      "-c:v",
      "libx264",
      short,
    ]);
    const media = new MediaService(ffprobe, new SourceRegistry());
    const asset = await media.probeAsset(a);
    expect(await media.relink(asset, short)).toMatchObject({
      status: "changed",
      durationMs: 1000,
      fingerprint: asset.fingerprint,
    });
  });
});
it("rejects audio-only imports rather than creating an unrenderable video source", async () => {
  const audio = path.join(dir, "audio-only.wav");
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    audio,
  ]);
  const sources = new SourceRegistry();
  const media = new MediaService(ffprobe, sources);
  await expect(media.probeAsset(audio)).rejects.toThrow(/video/i);
  expect(sources.ids()).toEqual([]);
});

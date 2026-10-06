import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { deflateSync, inflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { RenderService } from "../src/main/services/render";
import { JobManager } from "../src/main/services/jobs";
import { SourceRegistry, MediaService } from "../src/main/services/media";
import { runProcess } from "../src/main/services/process";
import { createProject } from "../src/domain/project";
import { buildAssemblyPlan } from "../src/domain/assembly";
const values = Object.fromEntries(
  process.argv
    .filter((a) => a.startsWith("--"))
    .map((a) => a.slice(2).split("=")),
);
if (!values["output-dir"])
  throw new Error(
    "Provide --output-dir outside the repository for generated fixtures/evidence",
  );
const root = path.resolve(values["output-dir"]);
if (root.startsWith(process.cwd() + path.sep))
  throw new Error("Generated benchmark media must be outside product source");
await mkdir(root, { recursive: true });
const fixtures = path.join(root, "fixtures");
await mkdir(fixtures, { recursive: true });
const ffmpeg = path.resolve(".runtime/bin/ffmpeg"),
  ffprobe = path.resolve(".runtime/bin/ffprobe");
function crc(b: Buffer) {
  let c = 0xffffffff;
  for (const byte of b) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type), data]),
    size = Buffer.alloc(4),
    sum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([size, body, sum]);
}
const glyphs = [
  "111101101101111",
  "010110010010111",
  "111001111100111",
  "111001111001111",
  "101101111001001",
  "111100111001111",
  "111100111101111",
  "111001010010010",
  "111101111101111",
  "111101111001111",
];
function pngMarker(n: number, color: number[]) {
  const w = 96,
    h = 64,
    b = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++)
        b[y * (1 + w * 3) + 1 + x * 3 + c] = color[c]!;
  for (const [d, char] of String(n).padStart(2, "0").split("").entries())
    for (let y = 0; y < 5; y++)
      for (let x = 0; x < 3; x++)
        if (glyphs[Number(char)]![y * 3 + x] === "1")
          for (let yy = 0; yy < 3; yy++)
            for (let xx = 0; xx < 3; xx++) {
              const pos =
                (24 + y * 3 + yy) * (1 + w * 3) +
                1 +
                (36 + d * 12 + x * 3 + xx) * 3;
              b.fill(255, pos, pos + 3);
            }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(b)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function rgb(file: Buffer) {
  let at = 8;
  const data: Buffer[] = [];
  while (at < file.length) {
    const size = file.readUInt32BE(at);
    if (file.toString("ascii", at + 4, at + 8) === "IDAT")
      data.push(file.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  const b = inflateSync(Buffer.concat(data));
  assert.ok(b[0]! <= 4);
  return [...b.subarray(1, 4)];
}
const truth: any[] = [];
for (let i = 0; i < 60; i++) {
  const color = [
      40 + (i % 5) * 40,
      40 + (Math.floor(i / 5) % 4) * 40,
      40 + Math.floor(i / 20) * 70,
    ],
    fps = [24, 25, 30][i % 3]!,
    frequency = 300 + i * 30;
  const image = path.join(fixtures, `marker-${i}.png`),
    file = path.join(fixtures, `marker-${i}.mp4`);
  await writeFile(image, pngMarker(i, color));
  const args = [
    "-v",
    "error",
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(fps),
    "-i",
    image,
  ];
  if (i !== 59)
    args.push(
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=48000:duration=1`,
    );
  const filters = [
    "scale=" + (i % 2 ? "64:96" : "96:64"),
    ...(i % 7 === 0 ? ["setsar=4/3"] : []),
  ];
  args.push(
    "-vf",
    filters.join(","),
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
  );
  if (i !== 59) args.push("-c:a", "aac");
  args.push(file);
  await runProcess(ffmpeg, args);
  let source = file;
  if (i % 11 === 0) {
    source = path.join(fixtures, `rotated-${i}.mp4`);
    await runProcess(ffmpeg, [
      "-v",
      "error",
      "-y",
      "-display_rotation",
      "90",
      "-i",
      file,
      "-c",
      "copy",
      source,
    ]);
  }
  truth.push({
    index: i,
    color,
    frequency: i === 59 ? null : frequency,
    fps,
    rotation: i % 11 === 0 ? 90 : 0,
    sar: i % 7 === 0 ? 4 / 3 : 1,
    file: source,
    sha256: createHash("sha256")
      .update(await readFile(source))
      .digest("hex"),
    selected: [130, 531],
    frames: 13,
    samples: 20800,
  });
}
await writeFile(
  path.join(root, "truth.json"),
  JSON.stringify(
    {
      provenance:
        "Original generated numbered color markers and synthesized tones; no third-party media",
      truth,
    },
    null,
    2,
  ),
);
const media = new MediaService(ffprobe, new SourceRegistry()),
  project = createProject();
for (const marker of truth)
  project.assets.push(await media.probeAsset(marker.file));
// Recognizable reverse order, not a repetition of one intermediate.
for (let i = 59; i >= 0; i--) {
  const a = project.assets[i]!;
  project.cuts.push({
    id: `cut-${i}`,
    assetId: a.id,
    fingerprint: a.fingerprint,
    transcriptRevision: null,
    startMs: 130,
    endMs: 531,
    wordIds: [],
    text: `Marker ${i}`,
    note: "",
    needsReview: false,
  });
}
project.cutOrder = project.cuts.map((c) => c.id);
const runs = [];
const count = Number(values.runs ?? 3);
assert.ok(count >= 1 && count <= 5);
for (let run = 0; run < count; run++) {
  const jobs = new JobManager(() => {}),
    service = new RenderService({
      ffmpeg,
      ffprobe,
      media,
      jobs,
      getProject: () => project,
      cacheRoot: path.join(root, `cache-${run}`),
    });
  let sampledPeakTreeRssKiB = 0,
    sampling = false;
  const timer = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void runProcess("/bin/ps", ["-axo", "pid=,ppid=,rss=,comm="])
      .then(({ stdout }) => {
        const rows = stdout
          .trim()
          .split("\n")
          .map((line) => {
            const [pid, ppid, rss, ...command] = line.trim().split(/\s+/);
            return {
              pid: Number(pid),
              ppid: Number(ppid),
              rss: Number(rss),
              command: command.join(" "),
            };
          });
        const descendants = new Set([process.pid]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const row of rows)
            if (
              descendants.has(row.ppid) &&
              !descendants.has(row.pid) &&
              !row.command.endsWith("/ps")
            ) {
              descendants.add(row.pid);
              changed = true;
            }
        }
        sampledPeakTreeRssKiB = Math.max(
          sampledPeakTreeRssKiB,
          rows
            .filter((row) => descendants.has(row.pid))
            .reduce((sum, row) => sum + row.rss, 0),
        );
      })
      .finally(() => {
        sampling = false;
      });
  }, 100);
  const started = performance.now();
  const id = await service.export(buildAssemblyPlan(project), {
    path: path.join(root, `assembly-${run}.mp4`),
    overwriteConfirmed: false,
  });
  await jobs.wait(id);
  const elapsedMs = performance.now() - started;
  clearInterval(timer);
  const job = jobs.list().find((j) => j.id === id)!;
  assert.equal(job.status, "completed", job.error ?? "");
  const receipt = service.receipt(id)!;
  assert.equal(receipt.frames, 780);
  assert.equal(receipt.samples, 1248000);
  const framesDir = path.join(root, `frames-${run}`);
  await mkdir(framesDir, { recursive: true });
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-i",
    service.outputPath(id)!,
    "-vf",
    "crop=8:8:iw/2:ih/4,scale=1:1,format=rgb24",
    "-an",
    "-c:v",
    "png",
    path.join(framesDir, "%04d.png"),
  ]);
  const frames = (await readdir(framesDir)).sort();
  assert.equal(frames.length, 780);
  const boundaries = [];
  for (let cut = 0; cut < 60; cut++) {
    const marker = truth[59 - cut]!;
    for (const within of [0, 6, 12]) {
      const frame = cut * 13 + within,
        actual = rgb(await readFile(path.join(framesDir, frames[frame]!)));
      assert.ok(
        actual.every((v, c) => Math.abs(v - marker.color[c]) < 15),
        `Frame ${frame}: marker ${marker.index} expected ${marker.color}, got ${actual}`,
      );
      boundaries.push({ frame, marker: marker.index, rgb: actual });
    }
  }
  const wav = path.join(root, `audio-${run}.wav`);
  await runProcess(ffmpeg, [
    "-v",
    "error",
    "-i",
    service.outputPath(id)!,
    "-vn",
    "-c:a",
    "pcm_s16le",
    wav,
  ]);
  const audio = await readFile(wav),
    start = audio.indexOf(Buffer.from("data")) + 8;
  const frequencies = [];
  for (let cut = 0; cut < 60; cut++) {
    const expected = truth[59 - cut]!.frequency;
    let crossings = 0,
      energy = 0,
      previous = 0;
    const length = 7200;
    for (let n = 0; n < length; n++) {
      const sample = audio.readInt16LE(start + (cut * 20800 + 4800 + n) * 4);
      energy += Math.abs(sample);
      if (previous < 0 && sample >= 0) crossings++;
      previous = sample;
    }
    const hz = crossings / (length / 48000);
    if (expected === null) assert.ok(energy / length < 10);
    else
      assert.ok(
        Math.abs(hz - expected) < 10,
        `Cut ${cut} expected tone ${expected}, got ${hz}`,
      );
    frequencies.push({
      cut,
      marker: 59 - cut,
      expected,
      hz,
      meanAmplitude: energy / length,
    });
  }
  runs.push({
    run,
    condition:
      run === 0
        ? "first render; fixture generation warmed filesystem"
        : "repeat render; new service/cache",
    elapsedMs,
    nodeMaxRssKiB: process.resourceUsage().maxRSS,
    sampledPeakTreeRssKiB,
    memoryMeasurement:
      "100ms ps sampling of Node render process and native descendants; sampled peak, not kernel high-water mark",
    receipt,
    boundaries,
    frequencies,
  });
  console.log(
    JSON.stringify({
      run,
      elapsedMs,
      receipt,
      verifiedMarkers: 60,
      verifiedFrames: 180,
      verifiedTones: 60,
    }),
  );
}
await writeFile(
  path.join(root, "receipt.json"),
  JSON.stringify(
    {
      machine: {
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        cpus: os.cpus()[0]?.model,
        totalMemory: os.totalmem(),
      },
      runtime: (await runProcess(ffmpeg, ["-version"])).stdout.split("\n")[0],
      scope:
        "Actual original-source export; numbered synthetic markers; mixed 24/25/30 fps, mixed geometry/rotation/SAR, silent source; no browser or installer claim",
      runs,
    },
    null,
    2,
  ),
);

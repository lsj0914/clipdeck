import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { decodeTranscriptionAudio, PcmWaveDecoder } from "../../src/main/services/audio";
import { JobManager } from "../../src/main/services/jobs";
import { transcriptionPcmBytes } from "../../src/shared/capacity";
let dir: string;
const run = promisify(execFile), ffmpeg = path.resolve(".runtime/bin/ffmpeg");
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "clipdeck-bounded-pcm-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function fixture(seconds: number, delay = false): Promise<string> {
  const source = path.join(dir, "neutral.mp4");
  await run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=s=64x48:r=30:d=" + seconds,
    ...(delay ? ["-itsoffset", "0.4"] : []),
    "-f", "lavfi", "-i", "sine=frequency=440:duration=" + (seconds - (delay ? 0.4 : 0)),
    "-c:v", "libx264", "-c:a", "aac", "-t", String(seconds), source]);
  return source;
}
it("the bounded WAV transport survives every split point in an actual native header", async () => {
  const source = await fixture(1);
  const { stdout } = await run(ffmpeg, ["-v", "error", "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"], { encoding: "buffer" });
  const dataStart = stdout.indexOf(Buffer.from("data")) + 8;
  expect(dataStart).toBeGreaterThan(40);
  const expectedPcm = stdout.subarray(dataStart);
  for (let split = 1; split < dataStart; split++) {
    const samples: Buffer[] = [], decoder = new PcmWaveDecoder((packet) => samples.push(packet));
    decoder.push(stdout.subarray(0, split)); decoder.push(stdout.subarray(split));
    expect(decoder.complete).toBe(true);
    // Compare every decoded byte without the generic object walk over a Buffer.
    expect(Buffer.concat(samples).equals(expectedPcm), `WAV header split ${split}`).toBe(true);
  }
  const forged = Buffer.from(stdout.subarray(0, 20));
  forged.writeUInt32LE(0xffffff00, 16);
  expect(() => new PcmWaveDecoder(() => {}).push(forged)).toThrow(/header exceeds/);
});
it("raw PCM exceeds a dishonest duration by failing instead of reporting a truncated success", async () => {
  const source = await fixture(5), output = path.join(dir, "audio.pcm"), jobs = new JobManager(() => {});
  const id = jobs.start("transcription", {}, (ctx) => decodeTranscriptionAudio(ffmpeg, source, output, 1000, ctx));
  await jobs.wait(id);
  expect(jobs.list()[0]).toMatchObject({ status: "failed", error: "Decoded audio exceeds this source's supported length. Split or re-import the source." });
  expect((await stat(output)).size).toBeLessThanOrEqual(transcriptionPcmBytes(1000));
});
it("delayed audio preserves original video time with leading silence and intact later sound", async () => {
  const source = await fixture(3, true), output = path.join(dir, "audio.pcm"), jobs = new JobManager(() => {});
  const id = jobs.start("transcription", {}, (ctx) => decodeTranscriptionAudio(ffmpeg, source, output, 3000, ctx));
  await jobs.wait(id);
  expect(jobs.list()[0]?.status).toBe("completed");
  const pcm = await readFile(output);
  const rms = (begin: number, end: number) => {
    let energy = 0;
    for (let sample = begin; sample < end; sample++) energy += pcm.readInt16LE(sample * 2) ** 2;
    return Math.sqrt(energy / (end - begin));
  };
  expect(rms(0, 16000 * 0.3)).toBeLessThan(5);
  expect(rms(16000 * 0.8, 16000 * 1.2)).toBeGreaterThan(1000);
  expect(pcm.length / 32000).toBeGreaterThanOrEqual(2.99);
  expect(pcm.length).toBeLessThanOrEqual(transcriptionPcmBytes(3000));
});

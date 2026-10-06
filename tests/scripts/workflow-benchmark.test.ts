import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  loadBenchmarkInputs,
  parsePcmWav,
  processTreeSample,
  publicReceipt,
  requireBenchmarkNodeVersion,
} from "../../scripts/workflow-benchmark-utils.mjs";

describe("workflow benchmark evidence", () => {
  it("rejects unsupported Node before a cohort can be mislabeled as the supported runtime", () => {
    expect(() => requireBenchmarkNodeVersion("23.11.0")).toThrow("Benchmark requires Node 24");
    expect(() => requireBenchmarkNodeVersion("25.0.0")).toThrow("Benchmark requires Node 24");
    expect(() => requireBenchmarkNodeVersion("24.19.0")).not.toThrow();
  });
  it("loads only hash-matching original sources and converts passage bounds to integer milliseconds", async () => {
    // A skipped hash comparison would silently benchmark changed media.
    const dir = await mkdtemp(path.join(os.tmpdir(), "clipdeck-benchmark-input-"));
    try {
      const bytes = Buffer.from("original fixture");
      await writeFile(path.join(dir, "story.mp4"), bytes);
      await writeFile(path.join(dir, "manifest.json"), JSON.stringify({
        sources: [{ id: "story", path: "/old/machine/story.mp4", sha256: createHash("sha256").update(bytes).digest("hex") }],
        selectable_passages: [{ id: "p1", source_id: "story", start_seconds: 0.1300625, end_seconds: 0.5310625, expected_text: "whole passage" }],
      }));
      const inputs = await loadBenchmarkInputs(dir);
      expect(inputs.passages[0]).toMatchObject({ startMs: 130, endMs: 531 });
      expect(inputs.sources[0]!.file).toBe(path.join(dir, "story.mp4"));
      await writeFile(path.join(dir, "story.mp4"), "changed fixture");
      await expect(loadBenchmarkInputs(dir)).rejects.toThrow("Source hash mismatch: story");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("rejects collapsed passage bounds before native rendering", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "clipdeck-benchmark-range-"));
    try {
      await writeFile(path.join(dir, "x.mp4"), "x");
      await writeFile(path.join(dir, "manifest.json"), JSON.stringify({
        sources: [{ id: "x", path: "x.mp4", sha256: createHash("sha256").update("x").digest("hex") }],
        selectable_passages: [{ id: "p1", source_id: "x", start_seconds: 1, end_seconds: 1.0001 }],
      }));
      await expect(loadBenchmarkInputs(dir)).rejects.toThrow("Invalid integer passage range");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("counts actual PCM samples after non-audio RIFF chunks", () => {
    // Assuming a fixed WAV header can report wrong sample totals.
    const format = Buffer.alloc(24);
    format.write("fmt "); format.writeUInt32LE(16, 4);
    format.writeUInt16LE(1, 8); format.writeUInt16LE(2, 10); format.writeUInt32LE(48000, 12);
    format.writeUInt32LE(192000, 16); format.writeUInt16LE(4, 20); format.writeUInt16LE(16, 22);
    const junk = Buffer.from([74,85,78,75,1,0,0,0,42,0]);
    const data = Buffer.alloc(24); data.write("data"); data.writeUInt32LE(16, 4);
    const header = Buffer.alloc(12); header.write("RIFF"); header.write("WAVE", 8);
    const wav = Buffer.concat([header, junk, format, data]); header.writeUInt32LE(wav.length - 8, 4);
    expect(parsePcmWav(wav)).toMatchObject({ samples: 4, channels: 2, sampleRate: 48000, bytesPerSample: 2 });
    expect(() => parsePcmWav(Buffer.from("not wave"))).toThrow("Invalid WAV");
  });
  it("sums only the simultaneous measured process tree and omits the sampler", () => {
    const rows = "10 1 100 node\n11 10 200 ffmpeg\n12 11 300 worker\n13 10 900 /bin/ps\n99 1 9999 unrelated";
    expect(processTreeSample(rows, 10)).toEqual({ treeRssKiB: 600, nativeRssKiB: 500, processes: [
      { pid: 10, ppid: 1, rssKiB: 100, command: "node" },
      { pid: 11, ppid: 10, rssKiB: 200, command: "ffmpeg" },
      { pid: 12, ppid: 11, rssKiB: 300, command: "worker" },
    ] });
  });
  it("redacts local paths while preserving reproducible command roles and metric tails", () => {
    const raw = { argv: ["/Users/private/name/runtime/python", "--flag", "/tmp/input.mp4"], elapsedMs: [7, 999], note: "failed at /Users/private/name/source.mp4", sha256: "abc" };
    expect(publicReceipt(raw, { "/Users/private/name/runtime": "$RUNTIME", "/tmp": "$OUTPUT" })).toEqual({
      argv: ["$RUNTIME/python", "--flag", "$OUTPUT/input.mp4"], elapsedMs: [7, 999], note: "failed at [local path]", sha256: "abc",
    });
  });
});

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
  summarizeRendererEvidence,
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

describe("renderer benchmark summary", () => {
  const names = ["select-word", "cross-unmounted-selection", "add-selection", "undo-add", "edit-cut", "reorder-cut", "undo-reorder", "find-transcript", "find-next-scroll"];
  const conditions = ["first-operation-after-open", "filesystem-warm-1", "filesystem-warm-2", "filesystem-warm-3"];
  const fixture = () => {
    const actions = [1, 2, 3].flatMap(run => conditions.flatMap(condition => names.map((name, index) => ({
      run, name, condition, predicateId: `r17.task7.${name}.v2`, ms: 10 + index + run,
      event: { isTrusted: true }, error: null,
    }))));
    const report = { sourceHead: "a".repeat(40), actionsSha256: "b".repeat(64), timedSamples: 108, freshProcesses: 3,
      operations: names, conditions, allTrusted: true, allNoError: true,
      boundaries: ["No OS page-cache eviction"] };
    return { report, actions };
  };
  it("derives new timings and retains a slow tail instead of repeating historic passing numbers", () => {
    const { report, actions } = fixture();
    actions.find(a => a.run === 2 && a.condition === "filesystem-warm-1" && a.name === "add-selection")!.ms = 999;
    const result = summarizeRendererEvidence(report, actions, report.actionsSha256);
    expect(result.sourceCommit).toBe(report.sourceHead);
    expect(result.operationP95Ms["select-word"]).toBe(13);
    expect(result.operationP95Ms["add-selection"]).toBe(999);
    expect(result.maximumMs).toBe(999);
    expect(result.withinInteractionThreshold).toBe(false);
    expect(result.measuredSamples).toHaveLength(108);
  });
  it("rejects a missing sample and a duplicated run/condition/operation slot", () => {
    const { report, actions } = fixture();
    expect(() => summarizeRendererEvidence(report, actions.slice(1), report.actionsSha256)).toThrow("108");
    actions[1] = { ...actions[0]! };
    expect(() => summarizeRendererEvidence(report, actions, report.actionsSha256)).toThrow("Duplicate");
  });
  it.each(["untrusted", "error", "nonfinite", "predicate"])("rejects %s observations instead of dropping them", problem => {
    const { report, actions } = fixture();
    if (problem === "untrusted") actions[0]!.event.isTrusted = false;
    if (problem === "error") Object.assign(actions[0]!, { error: "timed out" });
    if (problem === "nonfinite") actions[0]!.ms = Number.NaN;
    if (problem === "predicate") actions[0]!.predicateId = "r17.task7.select-word.v1";
    expect(() => summarizeRendererEvidence(report, actions, report.actionsSha256)).toThrow("Invalid renderer observation");
  });
  it("binds the report to the exact raw actions and excludes only explicitly unmeasured setup rows", () => {
    const { report, actions } = fixture();
    expect(() => summarizeRendererEvidence(report, actions, "c".repeat(64))).toThrow("hash");
    const setup = { ...actions[0]!, name: "project-open", condition: "setup-unmeasured", ms: 12000 };
    const result = summarizeRendererEvidence(report, [setup, ...actions], report.actionsSha256);
    expect(result.unmeasuredSetupRows).toBe(1);
    expect(result.maximumMs).toBe(21);
    expect(result.withinInteractionThreshold).toBe(true);
  });
});

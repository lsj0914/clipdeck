import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { publicReceipt, requireBenchmarkNodeVersion, summarizeRendererEvidence } from "./workflow-benchmark-utils.mjs";

const args = Object.fromEntries(process.argv.slice(2).map(value => {
  const i = value.indexOf("=");
  return [value.slice(2, i), value.slice(i + 1)];
}));
if (!args["receipt-dir"] || !args["renderer-report"] || !args["renderer-actions"] || !args["output-file"]) throw new Error("Provide --receipt-dir, --renderer-report (JSON), --renderer-actions (JSONL) and --output-file");
const directory = path.resolve(args["receipt-dir"]);
const readJson = async file => JSON.parse(await readFile(file, "utf8"));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const cohorts = await Promise.all([0, 1, 2].map(n => readJson(path.join(directory, `cohort-${n}/receipt.json`))));
for (const [n, cohort] of cohorts.entries()) {
  requireBenchmarkNodeVersion(cohort.node);
  assert.equal(cohort.node, cohorts[0].node);
  assert.equal(cohort.cohort, n);
  assert.equal(cohort.status, "verified native subset");
  assert.equal(cohort.sourceCommit, cohorts[0].sourceCommit);
  assert.ok(cohort.operations.every(operation => operation.status === "completed"));
  assert.deepEqual(cohort.runtimeHashes, cohorts[0].runtimeHashes);
  assert.deepEqual(cohort.sourceHashes, cohorts[0].sourceHashes);
  assert.deepEqual(cohort.preservedOriginalHashes, cohorts[0].preservedOriginalHashes);
}
const operations = cohorts.flatMap(cohort => cohort.operations);
for (const operation of operations) {
  assert.ok(operation.memorySamples.every(sample => sample.error === undefined), "Memory sampling error retained; do not publish a successful memory summary");
  if (operation.name === "transcription") {
    const transcript = await readJson(path.join(directory, `cohort-${operation.cohort}/${operation.sourceId}-${operation.condition}-transcript.json`));
    assert.equal(digest(JSON.stringify(transcript)), operation.transcriptSha256);
    operation.punctuation = transcript.parameters?.punctuation ?? null;
  }
}
for (const condition of ["first", "fs-warm"]) {
  for (const sourceId of ["story-part-1", "synthetic-zh"]) assert.equal(operations.filter(o => o.name === "transcription" && o.condition === condition && o.sourceId === sourceId).length, 3);
  for (const sourceId of ["story-part-1", "story-part-2", "story-part-3"]) assert.equal(operations.filter(o => o.name === "source-proxy" && o.condition === condition && o.sourceId === sourceId).length, 3);
  for (const name of ["assembly-preview", "assembly-export"]) assert.equal(operations.filter(o => o.name === name && o.condition === condition && o.preset === "landscape").length, 3);
}
for (const operation of operations.filter(o => o.name === "assembly-preview" || o.name === "assembly-export")) {
  assert.equal(operation.receipt.frames, 2909);
  assert.equal(operation.receipt.samples, 4654400);
  assert.equal(operation.receipt.audioPresentationSamples, 4654400);
}
const rendererBytes = await readFile(args["renderer-report"]);
const rendererActionsBytes = await readFile(args["renderer-actions"]);
const rendererActions = rendererActionsBytes.toString("utf8").trim().split("\n").map(line => JSON.parse(line));
const renderer = summarizeRendererEvidence(JSON.parse(rendererBytes), rendererActions, digest(rendererActionsBytes));
const diagnostics = await Promise.all(["story-part-1", "synthetic-zh"].map(async sourceId => {
  const diagnostic = await readJson(path.join(directory, `cohort-0/${sourceId}-diagnostic.json`));
  const ready = diagnostic.events.find(event => event.event.type === "ready").event;
  return { sourceId, method: diagnostic.method, authoritativeThroughput: false, audio: diagnostic.audio, versions: ready.versions, pythonVersion: ready.pythonVersion, telemetryDisabled: ready.telemetryDisabled, vadDigest: ready.vadDigest, phases: diagnostic.derived };
}));
const storyProject = await readJson(path.join(directory, "cohort-0/story.clipdeck"));
const storySourceMedia = storyProject.assets.map(asset => ({
  sourceId: cohorts[0].inputs.find(source => `sha256:${source.sha256}` === asset.fingerprint)?.id,
  width: asset.width, height: asset.height, fps: asset.fps, rotation: asset.rotation,
  sampleAspectRatio: asset.sampleAspectRatio, durationMs: asset.durationMs, hasAudio: asset.hasAudio,
}));
assert.equal(storySourceMedia.length, 3);
assert.ok(storySourceMedia.every(source => source.sourceId));
const nativeStages = operation => {
  if (operation.name !== "transcription") return {};
  const at = stage => operation.stages.find(event => event.job.kind === "transcription" && event.job.stage === stage)?.atMs;
  const decoding = at("decoding audio"), loading = at("loading local model"), transcribing = at("transcribing"), complete = at("complete");
  assert.ok([decoding, loading, transcribing, complete].every(Number.isFinite));
  return { serviceStageMs: {
    decodingAndPostDecodeSourceVerification: loading - decoding,
    workerStartupModelCheckPreflightPcmAndModelInit: transcribing - loading,
    transcribingPunctuationValidationAndCommit: complete - transcribing,
  } };
};
const publicOperation = operation => ({
  cohort: operation.cohort, name: operation.name, condition: operation.condition,
  ...(operation.sourceId ? { sourceId: operation.sourceId } : {}),
  ...(operation.language ? { language: operation.language } : {}),
  ...(operation.name === "transcription" ? { punctuation: operation.punctuation } : {}),
  ...(operation.preset ? { preset: operation.preset, validationOnly: operation.validationOnly } : {}),
  elapsedMs: operation.elapsedMs,
  ...(operation.endToEndRtf ? { audioDurationSeconds: operation.audioDurationSeconds, audioSamples: operation.audioSamples, endToEndRtf: operation.endToEndRtf, wordCount: operation.wordCount, transcriptSha256: operation.transcriptSha256 } : {}),
  ...nativeStages(operation),
  sampledPeakTreeRssKiB: operation.sampledPeakTreeRssKiB, sampledPeakNativeRssKiB: operation.sampledPeakNativeRssKiB,
  memorySampleCount: operation.memorySamples.length,
  ...(operation.receipt ? { receipt: operation.receipt } : {}),
  ...(operation.output ? { outputSha256: operation.output.sha256, outputBytes: operation.output.bytes } : {}),
  status: operation.status,
});
const summary = {
  schemaVersion: 2,
  scope: "Verified native benchmark subset on an exact development candidate; not full R17/Task5/product/package/public delivery acceptance",
  sourceCommits: cohorts.map(c => c.sourceCommit), sourceHashes: cohorts[0].sourceHashes,
  frozenEntrySha256: digest(await readFile(path.join(directory, "workflow-entry.mjs"))),
  rawReceiptSha256: await Promise.all([0, 1, 2].map(async n => digest(await readFile(path.join(directory, `cohort-${n}/receipt.json`))))),
  runtimeHashes: cohorts[0].runtimeHashes, ffmpeg: cohorts[0].ffmpeg, workerRuntimePins: cohorts[0].workerRuntimePins, model: cohorts[0].model,
  hardware: cohorts[0].machine, initialLoadAverages: cohorts.map(c => c.machine.loadAverage), node: cohorts[0].node,
  inputs: cohorts[0].inputs, manifestSha256: cohorts[0].manifestSha256, preservedOriginalHashes: cohorts[0].preservedOriginalHashes,
  conditions: cohorts[0].conditions,
  reproduction: [
    "node scripts/benchmark-workflow.mjs --mode=measure --inputs-dir=$INPUTS --output-dir=$OUTPUT --model-dir=$MODEL",
    "node scripts/summarize-workflow-benchmark.mjs --receipt-dir=$RUN --renderer-report=$RENDERER_REPORT --renderer-actions=$RENDERER_ACTIONS --output-file=docs/verification/workflow-performance.json",
  ],
  story: { sourceFiles: 3, sourceMedia: storySourceMedia, recordedReaderIdentities: 1, selectedCompletePassages: 12, selectedSpeechSeconds: 96.7150625, integerSelectedMs: 96715, outputFrames: 2909, outputSamples: 4654400, outputDurationSeconds: 2909 / 30, audioSampleRate: 48000, framesPerSecond: 30, manualCorpusBounds: true, rendererWordSelectionClaim: false },
  nativeOperations: operations.map(publicOperation), diagnostics,
  renderer: { ...renderer, reportSha256: digest(rendererBytes) },
  separateMarkerEvidence: "Sixty-marker checks are separate from this workflow summary; consult the benchmark documentation for the matched artifact.",
  nativeWorkflowScopeLimits: cohorts[0].scopeLimits,
};
if (args["condition-events"]) {
  const bytes = await readFile(args["condition-events"]);
  const events = JSON.parse(bytes.toString("utf8"));
  assert.ok(Array.isArray(events));
  summary.observedConditionEvents = events;
  summary.conditionEventsSha256 = digest(bytes);
}
if (args["superseded-dir"]) {
  const earlier = path.resolve(args["superseded-dir"]);
  const superseded = await Promise.all([0, 1, 2].map(n => readJson(path.join(earlier, `cohort-${n}/receipt.json`))));
  for (const old of superseded) {
    assert.equal(old.node, "23.11.0");
    assert.equal(old.status, "verified native subset");
    for (const [file, hash] of Object.entries(cohorts[0].sourceHashes)) {
      if (file.startsWith("src/") || file.startsWith("worker/")) assert.equal(old.sourceHashes[file], hash, `Native pipeline changed from superseded run: ${file}`);
    }
    assert.deepEqual(old.runtimeHashes, cohorts[0].runtimeHashes);
    assert.deepEqual(old.preservedOriginalHashes, cohorts[0].preservedOriginalHashes);
  }
  summary.supersededRuntimeCohort = {
    reason: "Self-review found shell node was 23.11.0 rather than the plan's Node24; retained all original results, added a fail-closed Node24 guard, and repeated the identical finite cohort under explicit bundled Node24.19.0. No inputs, thresholds, model, worker, media runtime or native source changed.",
    node: "23.11.0", sourceCommits: superseded.map(c => c.sourceCommit),
    frozenEntrySha256: digest(await readFile(path.join(earlier, "workflow-entry.mjs"))),
    rawReceiptSha256: await Promise.all([0, 1, 2].map(async n => digest(await readFile(path.join(earlier, `cohort-${n}/receipt.json`))))),
    nativeOperations: superseded.flatMap(c => c.operations).map(publicOperation),
    excludedFromAuthoritativeNode24Comparison: true,
  };
}
await writeFile(args["output-file"], JSON.stringify(publicReceipt(summary), null, 2) + "\n");
console.log(JSON.stringify({ status: "summary verified", cohorts: cohorts.length, operations: operations.length, output: args["output-file"] }));

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, appendFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MediaService, SourceRegistry, fingerprintFile } from "../src/main/services/media";
import { RenderService } from "../src/main/services/render";
import type { RenderReceipt } from "../src/main/services/render-engine";
import { JobManager } from "../src/main/services/jobs";
import { ModelRegistry, MODEL_MANIFEST, MODEL_DIGEST } from "../src/main/services/models";
import { TranscriptionService, checkWorker } from "../src/main/services/transcription";
import { offlineWorkerCommand, runProcess } from "../src/main/services/process";
import { createProject, outputSettings, serializeProject } from "../src/domain/project";
import { buildAssemblyPlan } from "../src/domain/assembly";
import type { OutputPreset, Project, Job } from "../src/shared/contracts";
import { loadBenchmarkInputs, parsePcmWav, processTreeSample, publicReceipt, requireBenchmarkNodeVersion } from "./workflow-benchmark-utils.mjs";

requireBenchmarkNodeVersion(process.versions.node);

const argv = Object.fromEntries(process.argv.slice(2).map(value => { const i = value.indexOf("="); return [value.slice(2, i), value.slice(i + 1)]; }));
const repo = path.resolve(argv.repo!), output = path.resolve(argv["output-dir"]!), inputsDirectory = path.resolve(argv["inputs-dir"]!);
const cohort = Number(argv.cohort), mode = argv.mode;
const root = path.join(output, `cohort-${cohort}`);
await mkdir(root, { recursive: true });
const runtime = { ffmpeg: path.join(repo, ".runtime/bin/ffmpeg"), ffprobe: path.join(repo, ".runtime/bin/ffprobe"), python: path.join(repo, ".runtime/worker/bin/python3.12"), worker: path.join(repo, "worker/transcribe.py") };
const exec = promisify(execFile);
const hash = async (file: string) => (await fingerprintFile(file)).slice(7);
const inputs = await loadBenchmarkInputs(inputsDirectory);
const roots: Record<string, string> = { [repo]: "$REPO", [inputsDirectory]: "$INPUTS", [output]: "$OUTPUT" };
if (argv["model-dir"]) roots[path.resolve(argv["model-dir"]!)] = "$MODEL";
const operations: any[] = [], stages: Array<{ atMs: number; job: Job }> = [];
let jobs: JobManager;
const lastJobs = new Map<string, string>();
const epoch = performance.now();
jobs = new JobManager(() => {
  for (const job of jobs.list()) {
    const value = JSON.stringify(job);
    if (lastJobs.get(job.id) !== value) { stages.push({ atMs: performance.now() - epoch, job }); lastJobs.set(job.id, value); }
  }
});
const media = new MediaService(runtime.ffprobe, new SourceRegistry());
let project: Project = createProject();
const sourceAssets = new Map<string, Project["assets"][number]>();

async function observe<T>(name: string, details: Record<string, unknown>, work: () => Promise<T>): Promise<T> {
  const started = performance.now(), stageStart = stages.length;
  const memory: any[] = [];
  let outstanding: Promise<void> | undefined;
  const sample = () => {
    if (outstanding) return;
    outstanding = runProcess("/bin/ps", ["-axo", "pid=,ppid=,rss=,comm="])
      .then(({ stdout }) => { memory.push({ atMs: performance.now() - started, ...processTreeSample(stdout, process.pid) }); })
      .catch(error => { memory.push({ atMs: performance.now() - started, error: String(error) }); })
      .finally(() => { outstanding = undefined; });
  };
  sample();
  const timer = setInterval(sample, 100);
  let failure: string | undefined, result: T;
  try { result = await work(); return result; }
  catch (error) { failure = String(error); throw error; }
  finally {
    const elapsedMs = performance.now() - started;
    clearInterval(timer);
    if (outstanding) await outstanding;
    const record = { cohort, name, ...details, elapsedMs, status: failure ? "failed" : "completed", ...(failure ? { failure } : {}),
      stages: stages.slice(stageStart), memorySamples: memory,
      sampledPeakTreeRssKiB: Math.max(0, ...memory.map(s => s.treeRssKiB ?? 0)),
      sampledPeakNativeRssKiB: Math.max(0, ...memory.map(s => s.nativeRssKiB ?? 0)),
      memoryMethod: "100ms ps simultaneous Node+descendant RSS samples excluding ps; sampled peaks, not kernel high-water; short cache hits may contain only initial sample" };
    operations.push(record);
    await appendFile(path.join(root, "operations.jsonl"), JSON.stringify(record) + "\n");
    console.log(JSON.stringify({ cohort, name, condition: details.condition, elapsedMs, status: record.status }));
  }
}
async function completed(id: string): Promise<void> {
  await jobs.wait(id);
  const job = jobs.list().find(job => job.id === id)!;
  assert.equal(job.status, "completed", job.error ?? "Native job did not complete");
}
async function prepareStory(): Promise<void> {
  for (const source of inputs.sources.filter(source => source.id.startsWith("story-part-"))) {
    const asset = await media.probeAsset(source.file);
    assert.equal(asset.fingerprint, `sha256:${source.sha256}`);
    asset.fileRef = path.relative(root, source.file);
    sourceAssets.set(source.id, asset);
    project.assets.push(asset);
  }
  assert.equal(sourceAssets.size, 3);
  assert.equal(inputs.passages.length, 12);
  for (const passage of inputs.passages) {
    const asset = sourceAssets.get(passage.source_id)!;
    project.cuts.push({ id: passage.id, assetId: asset.id, fingerprint: asset.fingerprint, transcriptRevision: null, startMs: passage.startMs, endMs: passage.endMs, wordIds: [], text: passage.expected_text ?? passage.id, note: "Complete corpus passage, manually specified benchmark range", needsReview: false });
  }
  project.cutOrder = project.cuts.map(c => c.id);
  const plan = buildAssemblyPlan(project);
  assert.equal(plan.totalFrames, 2909);
  assert.equal(plan.totalSamples, 4654400);
  await writeFile(path.join(root, "story-plan.json"), JSON.stringify({ provenance: "Recorded OpenSLR31 reader 2412; generated visual markers; three logical files of one reader, twelve complete corpus passages", manifestSha256: inputs.manifestSha256, passageSourceSeconds: inputs.manifest.selection_duration_seconds, integerSelectedMs: project.cuts.reduce((sum, cut) => sum + cut.endMs - cut.startMs, 0), plan, cuts: project.cuts }, null, 2) + "\n");
  await writeFile(path.join(root, "story.clipdeck"), JSON.stringify(serializeProject(project), null, 2) + "\n");
}
const sourceFiles = ["src/main/services/transcription.ts", "src/main/services/render.ts", "src/main/services/render-engine.ts", "src/main/services/process.ts", "src/main/services/models.ts", "src/main/services/media.ts", "src/main/services/jobs.ts", "src/domain/assembly.ts", "worker/transcribe.py", "worker/requirements.txt", "scripts/workflow-benchmark.ts", "scripts/benchmark-workflow.mjs", "scripts/benchmark-worker-timing.py", "scripts/workflow-benchmark-utils.mjs"];
const provenance = {
  date: new Date().toISOString(), mode, cohort,
  sourceCommit: (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim(),
  sourceStatus: (await exec("git", ["status", "--short"], { cwd: repo })).stdout,
  sourceHashes: Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, await hash(path.join(repo, file))]))),
  runtimeHashes: Object.fromEntries(await Promise.all(Object.entries(runtime).map(async ([role, file]) => [role, await hash(file)]))),
  machine: { platform: os.platform(), arch: os.arch(), release: os.release(), cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryBytes: os.totalmem(), loadAverage: os.loadavg(), hardware: (await exec("/usr/sbin/sysctl", ["-n", "hw.model"])).stdout.trim() },
  initialProcessInventory: (await runProcess("/bin/ps", ["-axo", "pid=,ppid=,rss=,comm="])).stdout,
  node: process.versions.node,
  ffmpeg: (await runProcess(runtime.ffmpeg, ["-version"])).stdout.split("\n")[0],
  workerRuntimePins: await readFile(path.join(repo, "worker/requirements.txt"), "utf8"),
  model: { id: MODEL_MANIFEST.id, revision: MODEL_MANIFEST.revision, digest: MODEL_DIGEST, files: MODEL_MANIFEST.files },
  inputs: inputs.sources.map(s => ({ id: s.id, sha256: s.sha256, audioKind: s.audio_kind, visualKind: s.visual_kind, durationSeconds: s.duration_seconds })), manifestSha256: inputs.manifestSha256,
  command: { executable: process.execPath, argv: process.argv.slice(1) },
  conditions: { first: "first measured operation of its kind in a fresh Node cohort; source probing/model registration/hash checks can warm filesystem; no OS cache purge or reboot", fsWarm: "one subsequent recompute in the same Node cohort with a new RenderService/cache or a new per-job ASR worker; not persistent-model warm", cacheHit: "same live native RenderService reuses a committed verified preview; no re-encoding", repeats: "exactly three fresh cohorts; one first and one FS-warm recompute each, no discarded tails", scope: "Native development services and worker; no picker, renderer/human listening, package installation or whole-app memory claim" },
};
await writeFile(path.join(root, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
await prepareStory();
let failure: string | undefined;
try {
  if (mode === "prepare") {
    console.log(JSON.stringify({ cohort, status: "prepared", originalSourcesVerified: inputs.sources.length, passages: inputs.passages.length, totalFrames: 2909, totalSamples: 4654400, durationSeconds: 2909 / 30 }));
  } else if (mode === "smoke") {
    // Real native source → assembly → decode/atomic commit; short enough for a script smoke.
    project.cuts = [{ ...project.cuts[0]!, id: "smoke-cut", startMs: 130, endMs: 531 }];
    project.cutOrder = ["smoke-cut"];
    const service = new RenderService({ ...runtime, media, jobs, getProject: () => project, cacheRoot: path.join(root, "smoke-cache") });
    await service.initialize();
    const plan = buildAssemblyPlan(project);
    assert.equal(plan.totalFrames, 13);
    const id = await observe("smoke-export", { condition: "one short native correctness smoke" }, async () => { const id = await service.export(plan, { path: path.join(root, "smoke.mp4"), overwriteConfirmed: false }); await completed(id); return id; });
    assert.equal(service.receipt(id)!.frames, 13);
    assert.equal(service.receipt(id)!.samples, 20800);
    await writeFile(path.join(root, "smoke-receipt.json"), JSON.stringify(service.receipt(id), null, 2) + "\n");
  } else if (mode === "measure") {
    const models = new ModelRegistry(path.join(root, "model-state.json"), path.join(root, "forbidden-download"), () => {});
    await observe("model-registration", { condition: "setup outside ASR throughput; official four-resource local verification warms filesystem" }, () => models.choose(argv["model-dir"]!));
    await observe("worker-preflight", { condition: "separate model-free fresh Python process; real OS outbound-network denial" }, () => checkWorker(runtime.python, runtime.worker));
    for (const [sourceId, language, anchor] of [["story-part-1", "en", /reader/i], ["synthetic-zh", "zh", /视频|視頻/]] as const) {
      let asset = sourceAssets.get(sourceId);
      if (!asset) { asset = await media.probeAsset(inputs.sources.find(s => s.id === sourceId)!.file); project.assets.push(asset); }
      const pcm = path.join(root, `${sourceId}-duration.wav`);
      await runProcess(runtime.ffmpeg, ["-v", "error", "-nostdin", "-i", media.sources.resolve(asset.id), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", pcm]);
      const audio = parsePcmWav(await readFile(pcm));
      const service = new TranscriptionService({ ...runtime, tempRoot: path.join(root, "asr-temporary"), media, models, jobs, getProject: () => project, onDraft: () => {}, onTranscript: t => { project.transcripts = [...project.transcripts.filter(old => old.assetId !== t.assetId), t]; } });
      for (const condition of ["first", "fs-warm"] as const) {
        await observe("transcription", { sourceId, language, condition, audioDurationSeconds: audio.durationSeconds, audioSamples: audio.samples, authoritativeUninstrumented: true }, async () => { const id = await service.start(asset!.id, language); await completed(id); });
        const transcript = project.transcripts.find(t => t.assetId === asset!.id)!;
        assert.ok(anchor.test(transcript.segments.map(s => s.text).join(" ")));
        assert.ok(transcript.words.length > 10);
        assert.ok(transcript.words.every(w => w.startMs >= 0 && w.endMs > w.startMs && w.endMs <= asset!.durationMs));
        const record = operations.at(-1)!;
        record.endToEndRtf = record.elapsedMs / 1000 / audio.durationSeconds;
        record.wordCount = transcript.words.length;
        record.transcriptSha256 = createHash("sha256").update(JSON.stringify(transcript)).digest("hex");
        await writeFile(path.join(root, `${sourceId}-${condition}-transcript.json`), JSON.stringify(transcript, null, 2) + "\n");
      }
      if (cohort === 0) {
        // Observe only; never replace any model/worker function or use this run for throughput claims.
        const command = offlineWorkerCommand(runtime.python, path.join(repo, "scripts/benchmark-worker-timing.py"));
        const timingFile = path.join(root, `${sourceId}-diagnostic.json`);
        const request = { mode: "transcribe", modelDirectory: argv["model-dir"], audioPath: pcm, durationMs: asset.durationMs, language };
        const result = await observe("transcription-phase-diagnostic", { sourceId, language, condition: "one profile-observed run; overhead included; excluded from throughput cohort" }, () => runProcess(command.executable, command.argv, { env: { ...command.env, CLIPDECK_BENCHMARK_WORKER: runtime.worker, CLIPDECK_BENCHMARK_TIMING: timingFile }, input: JSON.stringify(request) + "\n", maxBytes: 64 * 1024 * 1024 }));
        await writeFile(path.join(root, `${sourceId}-diagnostic.stdout.jsonl`), result.stdout);
        await writeFile(path.join(root, `${sourceId}-diagnostic.stderr.log`), result.stderr);
        assert.equal(result.stderr, "");
        const diagnostic = JSON.parse(await readFile(timingFile, "utf8"));
        for (const phase of ["check_model", "preflight", "model_constructor"]) assert.ok(diagnostic.spans[phase]?.endMs > diagnostic.spans[phase]?.startMs, `Unobserved diagnostic phase: ${phase}`);
        const ready = diagnostic.events.find((e: any) => e.event.type === "ready"), complete = diagnostic.events.find((e: any) => e.event.type === "complete");
        assert.ok(ready && complete);
        diagnostic.derived = { modelCheckMs: diagnostic.spans.check_model.endMs - diagnostic.spans.check_model.startMs, preflightMs: diagnostic.spans.preflight.endMs - diagnostic.spans.preflight.startMs, pcmLoadAndInputValidationMs: diagnostic.spans.model_constructor.startMs - diagnostic.spans.preflight.endMs, modelInitMs: diagnostic.spans.model_constructor.endMs - diagnostic.spans.model_constructor.startMs, inferenceAndEventDeliveryMs: complete.atMs - ready.atMs, inferenceAndEventDeliveryRtf: (complete.atMs - ready.atMs) / 1000 / audio.durationSeconds };
        await writeFile(timingFile, JSON.stringify(diagnostic, null, 2) + "\n");
      }
    }
    for (const condition of ["first", "fs-warm"] as const) {
      const service = new RenderService({ ...runtime, media, jobs, getProject: () => project, cacheRoot: path.join(root, `cache-${condition}`) });
      await service.initialize();
      for (const [sourceId, asset] of sourceAssets) {
        const id = await observe("source-proxy", { sourceId, condition, sourceDurationSeconds: asset.durationMs / 1000 }, async () => { const id = await service.prepareSourcePreview(asset.id); await completed(id); return id; });
        operations.at(-1)!.receipt = service.receipt(id);
        await observe("source-proxy-cache-hit", { sourceId, condition }, async () => { const cached = await service.prepareSourcePreview(asset.id); assert.equal(cached, id); await completed(cached); });
      }
      const presets: OutputPreset[] = condition === "first" && cohort === 0 ? ["landscape", "portrait", "square"] : ["landscape"];
      for (const preset of presets) {
        project.output = outputSettings(preset);
        const plan = buildAssemblyPlan(project);
        assert.equal(plan.totalFrames, 2909); assert.equal(plan.totalSamples, 4654400);
        const validationOnly = preset !== "landscape";
        for (const kind of ["preview", "export"] as const) {
          const id: string = await observe<string>(`assembly-${kind}`, { preset, condition, validationOnly, planRevision: plan.revision, planFrames: plan.totalFrames, planSamples: plan.totalSamples }, async (): Promise<string> => { const startedId = kind === "preview" ? await service.preview(plan) : await service.export(plan, { path: path.join(root, `story-${preset}-${condition}.mp4`), overwriteConfirmed: false }); await completed(startedId); return startedId; });
          const receipt: RenderReceipt = service.receipt(id)!;
          assert.equal(receipt.frames, 2909); assert.equal(receipt.samples, 4654400);
          assert.equal(receipt.audioPresentationSamples, 4654400);
          assert.ok(Math.abs(receipt.durationSeconds - 2909 / 30) <= 1 / 30);
          operations.at(-1)!.receipt = receipt;
          operations.at(-1)!.output = { file: service.outputPath(id), sha256: await hash(service.outputPath(id)!), bytes: (await stat(service.outputPath(id)!)).size };
          if (kind === "preview") await observe("assembly-preview-cache-hit", { preset, condition, validationOnly }, async () => { const cached = await service.preview(plan); assert.equal(cached, id); await completed(cached); });
        }
      }
    }
  } else throw new Error("Unknown workflow benchmark mode");
} catch (error) { failure = String(error); throw error; }
finally {
  await jobs.cancelAll();
  const finalHashes = Object.fromEntries(await Promise.all(inputs.sources.map(async source => [source.id, await hash(source.file)])));
  for (const source of inputs.sources) assert.equal(finalHashes[source.id], source.sha256, `Original altered: ${source.id}`);
  const receipt = { ...provenance, status: failure ? "failed" : "verified native subset", ...(failure ? { failure } : {}), operations, preservedOriginalHashes: finalHashes, scopeLimits: ["Native automation does not prove desktop picker/human viewing/listening/relink/install", "Manual corpus passage bounds are independent of ASR word selection correctness", "Portrait/square are one correctness preview+export each, not three-repeat performance cohorts", "ASR model reloads in each worker job; FS-warm is not persistent-model warm", "No 60-marker rerun; existing render-acceptance.json remains separate evidence"] };
  await writeFile(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  await writeFile(path.join(root, "public-receipt.json"), JSON.stringify(publicReceipt(receipt, roots), null, 2) + "\n");
}

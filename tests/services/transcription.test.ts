import { it, expect, describe, beforeEach, afterEach, vi } from "vitest";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { MediaService, SourceRegistry } from "../../src/main/services/media";
import {
  ModelRegistry,
  MODEL_MANIFEST,
  MODEL_DIGEST,
} from "../../src/main/services/models";
import { JobManager } from "../../src/main/services/jobs";
import { TranscriptionService } from "../../src/main/services/transcription";
import { PUNCTUATION_MODEL } from "../../src/main/services/punctuation";
import { createProject } from "../../src/domain/project";
import type { Project, TranscriptionDraft } from "../../src/shared/contracts";
import { asset as durationAsset } from "../domain/fixtures";
it("an unsupported source length is rejected before hashing, model verification or decoding", async () => {
  const media = new MediaService("/unavailable/ffprobe", new SourceRegistry());
  const models = new ModelRegistry("/unavailable/settings", "/unavailable/models", () => {});
  const sourceCheck = vi.spyOn(media, "verifyAssetIdentity").mockResolvedValue(undefined);
  const modelCheck = vi.spyOn(models, "verify").mockResolvedValue({ id: "fixture", digest: "fixture", directory: "/unavailable/model", choice: "small" });
  const jobs = new JobManager(() => {});
  const service = new TranscriptionService({
    ffmpeg: "/unavailable/ffmpeg", python: "/unavailable/python", worker: "/unavailable/worker", tempRoot: "/unavailable/jobs",
    media, models, jobs, getProject: () => ({ ...createProject(), assets: [{ ...durationAsset, durationMs: 21600001 }] }),
    onDraft: () => {}, onTranscript: () => {},
  });
  try {
    await expect(service.start(durationAsset.id, "en")).rejects.toThrow(/six hours/);
    expect(sourceCheck).not.toHaveBeenCalled();
    expect(modelCheck).not.toHaveBeenCalled();
    expect(jobs.list()).toEqual([]);
  } finally { await jobs.cancelAll(); vi.restoreAllMocks(); }
});
const root = process.env.CLIPDECK_ACCEPTANCE_ROOT;
const model = path.join(
  process.env.HOME!,
  ".cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120",
);
let dir: string;
const run = promisify(execFile);
async function videoFixture(fixture: string, input?: string): Promise<string> {
  const target = path.join(dir, fixture + ".mp4");
  await run(path.resolve(".runtime/bin/ffmpeg"), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x48:r=30",
    "-i",
    input ?? path.join(root!, "tool-readiness/transcription", fixture),
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    target,
  ]);
  return target;
}
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clipdeck-transcribe-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
describe.runIf(!!root)(
  "actual native FFmpeg → offline pinned model worker",
  () => {
    it.each([
      ["en", "en-synthetic.wav", /computer/],
      ["zh", "zh-synthetic.wav", /视频|視頻/],
    ] as const)(
      "completes %s with real full positive word timestamps",
      async (language, fixture, anchor) => {
        const sources = new SourceRegistry();
        const media = new MediaService(
          path.resolve(".runtime/bin/ffprobe"),
          sources,
        );
        const asset = await media.probeAsset(await videoFixture(fixture));
        let project: Project = { ...createProject(), assets: [asset] };
        let draft: TranscriptionDraft | undefined;
        const models = new ModelRegistry(
          path.join(dir, "model.json"),
          path.join(dir, "model"),
          () => {},
        );
        await models.choose(model);
        const jobs = new JobManager(() => {});
        const service = new TranscriptionService({
          ffmpeg: path.resolve(".runtime/bin/ffmpeg"),
          python: path.resolve(".runtime/worker/bin/python3.12"),
          worker: path.resolve("worker/transcribe.py"),
          tempRoot: dir,
          media,
          models,
          jobs,
          getProject: () => project,
          onDraft: (_id, d) => (draft = d),
          onTranscript: (t) => {
            project = { ...project, transcripts: [t] };
          },
        });
        const id = await service.start(asset.id, language);
        await jobs.wait(id);
        expect(jobs.list()[0]?.status).toBe("completed");
        expect(
          project.transcripts[0]?.segments.map((s) => s.text).join(""),
        ).toMatch(anchor);
        expect(project.transcripts[0]?.words.length).toBeGreaterThan(10);
        expect(
          project.transcripts[0]?.words.every(
            (w) =>
              w.endMs > w.startMs &&
              w.startMs >= 0 &&
              w.endMs <= asset.durationMs,
          ),
        ).toBe(true);
        if (language === "en")
          expect(
            project.transcripts[0]?.segments.length,
          ).toBeGreaterThanOrEqual(3);
        expect(draft).toBeUndefined();
      },
      30000,
    );
    it("cancelled worker never commits transcript or leaves draft", async () => {
      const sources = new SourceRegistry();
      const media = new MediaService(
        path.resolve(".runtime/bin/ffprobe"),
        sources,
      );
      const asset = await media.probeAsset(
        await videoFixture("en-synthetic.wav"),
      );
      let project: Project = { ...createProject(), assets: [asset] };
      let draft: TranscriptionDraft | undefined;
      const models = new ModelRegistry(
        path.join(dir, "model.json"),
        path.join(dir, "model"),
        () => {},
      );
      await models.choose(model);
      const jobs = new JobManager(() => {});
      const service = new TranscriptionService({
        ffmpeg: path.resolve(".runtime/bin/ffmpeg"),
        python: path.resolve(".runtime/worker/bin/python3.12"),
        worker: path.resolve("worker/transcribe.py"),
        tempRoot: dir,
        media,
        models,
        jobs,
        getProject: () => project,
        onDraft: (_id, d) => (draft = d),
        onTranscript: (t) => {
          project = { ...project, transcripts: [t] };
        },
      });
      const id = await service.start(asset.id, "en");
      await jobs.cancel(id);
      expect(jobs.list()[0]?.status).toBe("cancelled");
      expect(project.transcripts).toEqual([]);
      expect(draft).toBeUndefined();
    }, 30000);
  },
);
describe.runIf(!!root)("vocabulary preflight", () => {
  it("rejects excessive hints before audio decoding and completes a shortened retry", async () => {
    const sources = new SourceRegistry();
    const media = new MediaService(path.resolve(".runtime/bin/ffprobe"), sources);
    const asset = await media.probeAsset(await videoFixture("en-synthetic.wav"));
    let project: Project = { ...createProject(), assets: [asset] };
    const models = new ModelRegistry(path.join(dir, "settings"), path.join(dir, "model"), () => {});
    await models.choose(model);
    const stages: string[] = [];
    const jobs = new JobManager(() => stages.push(...jobs.list().map((job) => job.stage)));
    const service = new TranscriptionService({
      ffmpeg: path.resolve(".runtime/bin/ffmpeg"),
      python: path.resolve(".runtime/worker/bin/python3.12"),
      worker: path.resolve("worker/transcribe.py"),
      tempRoot: dir, media, models, jobs,
      getProject: () => project,
      onDraft: () => {},
      onTranscript: (transcript) => { project = { ...project, transcripts: [transcript] }; },
    });
    const rejected = await service.start(asset.id, "auto", { vocabulary: "复杂".repeat(200) });
    await jobs.wait(rejected);
    expect(jobs.list().find((job) => job.id === rejected)).toMatchObject({
      status: "failed", error: "Vocabulary is too long for this model. Keep only the most important names and terms.",
    });
    expect(stages).not.toContain("decoding audio");
    expect(project.transcripts).toEqual([]);
    const retry = await service.start(asset.id, "en", { vocabulary: "computer, video" });
    await jobs.wait(retry);
    expect(jobs.list().find((job) => job.id === retry)?.status).toBe("completed");
    expect(project.transcripts[0]?.parameters.vocabulary).toBe("computer, video");
    expect(project.transcripts[0]?.words.length).toBeGreaterThan(10);
  }, 30000);
});
describe.runIf(!!root)("queued ASR cancellation", () => {
  it("cancelled queued source can be retried without a leaked active reservation", async () => {
    const sources = new SourceRegistry();
    const media = new MediaService(
      path.resolve(".runtime/bin/ffprobe"),
      sources,
    );
    const asset = await media.probeAsset(
      await videoFixture("en-synthetic.wav"),
    );
    const project: Project = { ...createProject(), assets: [asset] };
    const models = new ModelRegistry(
      path.join(dir, "model.json"),
      path.join(dir, "model"),
      () => {},
    );
    await models.choose(model);
    const jobs = new JobManager(() => {});
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = jobs.start("export", {}, async () => gate);
    const b = jobs.start("preview", {}, async () => gate);
    await new Promise((r) => setImmediate(r));
    const service = new TranscriptionService({
      ffmpeg: path.resolve(".runtime/bin/ffmpeg"),
      python: path.resolve(".runtime/worker/bin/python3.12"),
      worker: path.resolve("worker/transcribe.py"),
      tempRoot: dir,
      media,
      models,
      jobs,
      getProject: () => project,
      onDraft: () => {},
      onTranscript: () => {},
    });
    const first = await service.start(asset.id, "en");
    await jobs.cancel(first);
    let second: string | undefined;
    try {
      second = await service.start(asset.id, "en");
      expect(jobs.list().find((j) => j.id === second)?.status).toBe("queued");
    } finally {
      if (second) await jobs.cancel(second);
      release();
      await Promise.all([jobs.wait(a), jobs.wait(b)]);
    }
  }, 30000);
});

it.each([
  [false, "completed"],
  [true, "failed"],
  [undefined, "failed"],
] as const)("native protocol adapter requires truthful previous-text provenance %s and retains timed anchors", async (reported, expectedStatus) => {
  const source = path.join(dir, "protocol.mp4");
  await run(path.resolve(".runtime/bin/ffmpeg"), [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x48:r=30:d=2",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    source,
  ]);
  const events = [
    { type: "ready", wordTimingReview: true },
    {
      type: "segment",
      index: 0,
      language: "en",
      text: "Hello. Then",
      startMs: 100,
      endMs: 450,
      words: [
        { text: "Hello.", startMs: 100, endMs: 300 },
        { text: " Then", startMs: 350, endMs: 450 },
      ],
      processedMs: 450,
      untimedWordCount: 0,
      leadingUntimedText: "",
    },
    {
      type: "segment",
      index: 1,
      language: "en",
      text: " world. Next",
      startMs: 450,
      endMs: 1800,
      words: [
        { text: " world.", startMs: 450, endMs: 650 },
        { text: " Next", startMs: 1500, endMs: 1800 },
      ],
      processedMs: 1800,
      untimedWordCount: 0,
      leadingUntimedText: "",
    },
    {
      type: "segment",
      index: 2,
      language: "en",
      text: ".",
      startMs: 1800,
      endMs: 1900,
      words: [],
      processedMs: 1900,
      untimedWordCount: 1,
      leadingUntimedText: ".",
    },
    {
      type: "complete",
      language: "en",
      segmentCount: 3,
      untimedWordCount: 1,
      modelChoice: "small",
      modelId: MODEL_MANIFEST.id,
      modelDigest: MODEL_DIGEST,
      simplifiedChinese: false,
      conditionOnPreviousText: reported,
      wordTimingReview: true,
    },
  ];
  // Deterministic worker transport fixture; the separate acceptance tests exercise actual inference.
  const script = path.join(dir, "protocol.py");
  await writeFile(
    script,
    `import sys,json\nrequest=json.loads(sys.stdin.readline())\nif request.get("mode")=="punctuate":\n assert request.get("language")=="en"\n print(json.dumps({"type":"punctuation","start":0,"fragments":request["fragments"]}),flush=True)\n print(json.dumps({"type":"complete","fragmentCount":len(request["fragments"]),"language":"en","model":json.loads(${JSON.stringify(JSON.stringify(PUNCTUATION_MODEL))})}),flush=True)\n sys.exit(0)\nassert request.get("vocabulary")=="editing"\nif request.get("mode")=="validate-options":\n print(json.dumps({"type":"options-validated"}),flush=True)\n sys.exit(0)\nprint(${JSON.stringify(events.map((event) => JSON.stringify(event)).join("\n"))},flush=True)\n`,
  );
  const sources = new SourceRegistry(),
    media = new MediaService(path.resolve(".runtime/bin/ffprobe"), sources),
    asset = await media.probeAsset(source);
  let project: Project = { ...createProject(), assets: [asset] };
  const drafts: TranscriptionDraft[] = [];
  const models = new ModelRegistry(
    path.join(dir, "settings"),
    path.join(dir, "model"),
    () => {},
  );
  await models.choose(model);
  const jobs = new JobManager(() => {});
  const service = new TranscriptionService({
    ffmpeg: path.resolve(".runtime/bin/ffmpeg"),
    python: path.resolve(".runtime/worker/bin/python3.12"),
    worker: script,
    tempRoot: dir,
    media,
    models,
    jobs,
    getProject: () => project,
    onDraft: (_id, draft) => {
      if (draft) drafts.push(draft);
    },
    onTranscript: (t) => {
      project = { ...project, transcripts: [t] };
    },
  });
  const id = await service.start(asset.id, "en", { vocabulary: "editing" });
  await jobs.wait(id);
  expect(jobs.list()[0]?.status).toBe(expectedStatus);
  if (expectedStatus === "failed") {
    expect(project.transcripts).toEqual([]);
    return;
  }
  const transcript = project.transcripts[0]!;
  expect(transcript.parameters).toMatchObject({
    vocabulary: "editing",
    simplifiedChinese: false,
    conditionOnPreviousText: false,
    wordTimingReview: true,
    punctuation: PUNCTUATION_MODEL,
  });
  expect(transcript.originId).toBe(id);
  expect(transcript.segments.map((segment) => segment.text)).toEqual([
    "Hello.",
    "Then world.",
    "Next.",
  ]);
  expect(transcript.segments.map((segment) => segment.id)).toEqual(
    drafts.at(-1)!.segments.map((segment) => segment.id),
  );
  expect(transcript.words.at(-1)).toMatchObject({
    text: " Next.",
    startMs: 1500,
    endMs: 1800,
    timingNeedsReview: true,
  });
  expect(drafts[0]?.segments[0]?.id).toBe(transcript.segments[0]?.id);
  expect(drafts[0]?.words.at(-1)?.text).toBe(" Then");
}, 30000);

const turboModel = process.env.CLIPDECK_TURBO_MODEL;
describe.runIf(!!root && !!turboModel)(
  "recorded speech on both verified multilingual models",
  () => {
    it.each([
      [
        "small",
        "en",
        "generated/recorded-en-a.wav",
        /reader|country|sheep/i,
        "",
      ],
      ["small", "zh", "paddlespeech-zh.wav", /跑步|健康/, "跑步，健康"],
      [
        "turbo",
        "en",
        "generated/recorded-en-a.wav",
        /reader|country|sheep/i,
        "",
      ],
      ["turbo", "zh", "paddlespeech-zh.wav", /跑步|健康/, "跑步，健康"],
    ] as const)(
      "%s recorded %s completes with verified provenance and positive unchanged-source timings",
      async (choice, language, fixture, anchor, vocabulary) => {
        const input = path.join(root!, "acceptance-fixtures", fixture),
          source = await videoFixture(`${choice}-${language}`, input);
        const sources = new SourceRegistry(),
          media = new MediaService(
            path.resolve(".runtime/bin/ffprobe"),
            sources,
          ),
          asset = await media.probeAsset(source);
        let project: Project = { ...createProject(), assets: [asset] };
        const models = new ModelRegistry(
          path.join(dir, "model-settings"),
          path.join(dir, "small"),
          () => {},
        );
        await models.choose(choice === "small" ? model : turboModel!);
        const jobs = new JobManager(() => {});
        const service = new TranscriptionService({
          ffmpeg: path.resolve(".runtime/bin/ffmpeg"),
          python: path.resolve(".runtime/worker/bin/python3.12"),
          worker: path.resolve("worker/transcribe.py"),
          tempRoot: dir,
          media,
          models,
          jobs,
          getProject: () => project,
          onDraft: () => {},
          onTranscript: (transcript) => {
            project = { ...project, transcripts: [transcript] };
          },
        });
        const id = await service.start(asset.id, language, { vocabulary });
        await jobs.wait(id);
        expect(jobs.list()[0]?.status).toBe("completed");
        const transcript = project.transcripts[0]!;
        expect(transcript.model.id).toBe(
          choice === "small"
            ? MODEL_MANIFEST.id
            : "dropbox-dash/faster-whisper-large-v3-turbo",
        );
        expect(transcript.originId).toBe(id);
        expect(transcript.parameters).toMatchObject({
          vad: true,
          simplifiedChinese: language === "zh",
          conditionOnPreviousText: false,
          ...(vocabulary ? { vocabulary } : {}),
        });
        expect(
          transcript.segments.map((segment) => segment.text).join(""),
        ).toMatch(anchor);
        expect(transcript.words.length).toBeGreaterThan(10);
        expect(
          transcript.words.every(
            (word) =>
              word.startMs >= 0 &&
              word.endMs > word.startMs &&
              word.endMs <= asset.durationMs,
          ),
        ).toBe(true);
      },
      90000,
    );
  },
);
for (const outcome of ["cancelled", "failed"] as const) {
  it(`retranscription ${outcome} retains the prior complete transcript until a successful replacement`, async () => {
    const source = path.join(dir, "retained.mp4");
    await run(path.resolve(".runtime/bin/ffmpeg"), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x48:r=30:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-shortest",
      source,
    ]);
    const sources = new SourceRegistry(),
      media = new MediaService(path.resolve(".runtime/bin/ffprobe"), sources),
      asset = await media.probeAsset(source);
    const previous = {
      assetId: asset.id,
      fingerprint: asset.fingerprint,
      revision: 8,
      language: "en" as const,
      originId: "old-ASR",
      words: [
        { id: "old-word", text: "old complete text", startMs: 100, endMs: 500 },
      ],
      segments: [
        {
          id: "old-segment",
          text: "old complete text",
          startMs: 100,
          endMs: 500,
          wordIds: ["old-word"],
        },
      ],
      model: { id: MODEL_MANIFEST.id, digest: MODEL_DIGEST },
      engine: { name: "faster-whisper", version: "1.2.1" },
      parameters: { vad: true },
    };
    let project: Project = {
      ...createProject(),
      assets: [asset],
      transcripts: [previous],
    };
    const script = path.join(dir, "failure.py");
    await writeFile(
      script,
      'import sys\nsys.stdin.readline()\nprint(\' {"type":"error","message":"Explicit worker failure"}\',flush=True)\nsys.exit(1)\n',
    );
    const models = new ModelRegistry(
      path.join(dir, "settings"),
      path.join(dir, "small"),
      () => {},
    );
    await models.choose(model);
    const jobs = new JobManager(() => {});
    let draft: TranscriptionDraft | undefined;
    const service = new TranscriptionService({
      ffmpeg: path.resolve(".runtime/bin/ffmpeg"),
      python: path.resolve(".runtime/worker/bin/python3.12"),
      worker: script,
      tempRoot: dir,
      media,
      models,
      jobs,
      getProject: () => project,
      onDraft: (_id, value) => (draft = value),
      onTranscript: (transcript) => {
        project = { ...project, transcripts: [transcript] };
      },
    });
    const id = await service.start(asset.id, "en");
    expect(project.transcripts[0]).toBe(previous);
    if (outcome === "cancelled") await jobs.cancel(id);
    await jobs.wait(id);
    expect(jobs.list()[0]?.status).toBe(outcome);
    expect(project.transcripts[0]).toBe(previous);
    expect(draft).toBeUndefined();
  }, 30000);
}

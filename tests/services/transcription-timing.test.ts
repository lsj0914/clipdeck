import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TranscriptionService } from "../../src/main/services/transcription";
import { MediaService, SourceRegistry } from "../../src/main/services/media";
import { ModelRegistry, MODEL_DIGEST, MODEL_MANIFEST } from "../../src/main/services/models";
import { JobManager } from "../../src/main/services/jobs";
import { createProject } from "../../src/domain/project";
import type { Project, TranscriptionDraft } from "../../src/shared/contracts";
import { asset } from "../domain/fixtures";
import type { ProcessOptions } from "../../src/main/services/process";

// Only external decoding/inference transport is substituted; actual adapter,
// JobManager, parsing, validation, draft updates and commit remain exercised.
const transport = vi.hoisted(() => ({ packets: [] as unknown[] }));
vi.mock("../../src/main/services/process", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/main/services/process")>()),
  runProcess: vi.fn(async (_file: string, _args: string[], options: ProcessOptions) => {
    if (options?.onStdout) for (const packet of transport.packets) options.onStdout(JSON.stringify(packet) + "\n");
    return { stdout: "", stderr: "" };
  }),
}));
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "clipdeck-timing-unit-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

const packet = (index: number, text: string, words: unknown[], leadingUntimedText = "") => ({
  type: "segment", index, language: "en", text, startMs: 100 + index * 400,
  endMs: 450 + index * 400, processedMs: 450 + index * 400,
  words, untimedWordCount: leadingUntimedText ? 1 : 0, leadingUntimedText,
});
const complete = (segmentCount: number, wordTimingReview: unknown = true) => ({
  type: "complete", language: "en", segmentCount, modelChoice: "small",
  modelId: MODEL_MANIFEST.id, modelDigest: MODEL_DIGEST, simplifiedChinese: false,
  conditionOnPreviousText: false, wordTimingReview,
});
async function execute(packets: unknown[]) {
  transport.packets = packets;
  const sources = new SourceRegistry(); sources.register(asset.id, path.join(dir, "unit-source.mp4"));
  const media = new MediaService("unit-ffprobe", sources);
  vi.spyOn(media, "verifyAssetIdentity").mockResolvedValue();
  const models = new ModelRegistry(path.join(dir, "settings"), path.join(dir, "unused-model"), () => {});
  vi.spyOn(models, "verify").mockResolvedValue({ id: MODEL_MANIFEST.id, digest: MODEL_DIGEST, directory: path.join(dir, "unit-model"), choice: "small" });
  let project: Project = { ...createProject(), assets: [asset] };
  const jobs = new JobManager(() => {}), drafts: TranscriptionDraft[] = [];
  let commits = 0;
  const service = new TranscriptionService({
    ffmpeg: "unit-ffmpeg", python: "unit-python", worker: "unit-worker", tempRoot: dir,
    media, models, jobs, getProject: () => project,
    onDraft: (_id, draft) => { if (draft) drafts.push(draft); },
    onTranscript: transcript => { commits++; project = { ...project, transcripts: [transcript] }; },
  });
  const id = await service.start(asset.id, "en"); await jobs.wait(id);
  return { project, job: jobs.list().find(j => j.id === id)!, drafts, commits, id };
}

it("retains worker flags and marks the receiver of leading and all-untimed packets without changing text/time", async () => {
  const result = await execute([
    { type: "ready", wordTimingReview: true },
    packet(0, "Folded text next", [
      { text: "Folded text", startMs: 100, endMs: 300, timingNeedsReview: true },
      { text: " next", startMs: 350, endMs: 450, timingNeedsReview: false },
    ]),
    packet(1, " lead word.", [{ text: " word.", startMs: 500, endMs: 700 }], " lead"),
    packet(2, "!", [], "!"),
    complete(3),
  ]);
  expect(result.job.status).toBe("completed"); expect(result.commits).toBe(1);
  const transcript = result.project.transcripts[0]!;
  expect(transcript.parameters).toHaveProperty("wordTimingReview", true);
  expect(transcript.words).toEqual([
    { id: `${result.id}-w-0`, text: "Folded text", startMs: 100, endMs: 300, timingNeedsReview: true },
    { id: `${result.id}-w-1`, text: " next lead", startMs: 350, endMs: 450, timingNeedsReview: true },
    { id: `${result.id}-w-2`, text: " word.!", startMs: 500, endMs: 700, timingNeedsReview: true },
  ]);
  expect(result.drafts[0]!.words[1]).toMatchObject({ text: " next", timingNeedsReview: false });
});

it("marks the first anchor receiving initial leading text", async () => {
  const result = await execute([{ type: "ready", wordTimingReview: true }, packet(0, "Lead word.", [{ text: " word.", startMs: 100, endMs: 300 }], "Lead"), complete(1)]);
  expect(result.job.status).toBe("completed");
  expect(result.project.transcripts[0]!.words[0]).toMatchObject({ text: "Lead word.", startMs: 100, endMs: 300, timingNeedsReview: true });
});

it("keeps an initial all-untimed packet display-only without inventing or flagging unrelated anchors", async () => {
  const result = await execute([{ type: "ready", wordTimingReview: true }, packet(0, "Untimed!", [], "Untimed!"), packet(1, "Reliable.", [{ text: "Reliable.", startMs: 600, endMs: 800 }]), complete(2)]);
  expect(result.job.status).toBe("completed");
  expect(result.project.transcripts[0]!.words).toEqual([{ id: `${result.id}-w-0`, text: "Reliable.", startMs: 600, endMs: 800 }]);
  expect(result.project.transcripts[0]!.segments[0]).toMatchObject({ text: "Untimed!", wordIds: [], startMs: 100, endMs: 450 });
});

it.each([
  [undefined, true], [false, true], ["true", true], [true, undefined], [true, false], [true, "true"],
] as const)("refuses unsupported ready/complete timing provenance %s / %s before commit", async (readyReview, completeReview) => {
  const ending = { ...complete(1), wordTimingReview: completeReview };
  const result = await execute([{ type: "ready", wordTimingReview: readyReview }, packet(0, "Word", [{ text: "Word", startMs: 100, endMs: 300 }]), ending]);
  expect(result.job.status).toBe("failed"); expect(result.commits).toBe(0); expect(result.project.transcripts).toEqual([]);
});

it("cannot establish supported provenance with a complete packet alone", async () => {
  const result = await execute([packet(0, "Word", [{ text: "Word", startMs: 100, endMs: 300 }]), complete(1)]);
  expect(result.job.status).toBe("failed"); expect(result.commits).toBe(0);
  expect(result.drafts).toEqual([]);
});

it.each(["true", 1, null])("rejects malformed native word flags %j before commit", async timingNeedsReview => {
  const result = await execute([{ type: "ready", wordTimingReview: true }, packet(0, "Word", [{ text: "Word", startMs: 100, endMs: 300, timingNeedsReview }]), complete(1)]);
  expect(result.job.status).toBe("failed"); expect(result.commits).toBe(0);
});

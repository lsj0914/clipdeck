import { parseTranscriptionOptions } from "../../domain/transcription-options";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type {
  Project,
  Language,
  Transcript,
  TranscriptionDraft,
  TimedWord,
  TranscriptSegment,
  TranscriptionOptions as TranscriptionRequestOptions,
} from "../../shared/contracts";
import { validateProject, serializeProject } from "../../domain/project";
import { record, text, integer, list, oneOf, bool } from "../../domain/validation";
import { MediaService } from "./media";
import { ModelRegistry } from "./models";
import { JobManager } from "./jobs";
import { offlineWorkerCommand, runProcess } from "./process";
import { groupSentences } from "./sentences";
export interface TranscriptionOptions {
  ffmpeg: string;
  python: string;
  worker: string;
  tempRoot: string;
  media: MediaService;
  models: ModelRegistry;
  jobs: JobManager;
  getProject: () => Project;
  onDraft: (assetId: string, draft: TranscriptionDraft | undefined) => void;
  onTranscript: (transcript: Transcript) => void;
}
export async function checkWorker(
  python: string,
  worker: string,
): Promise<void> {
  const command = offlineWorkerCommand(python, worker);
  const result = await runProcess(command.executable, command.argv, {
    env: command.env,
    input:
      JSON.stringify({
        mode: "check",
      }) + "\n",
  });
  const event = JSON.parse(result.stdout.trim());
  if (event.type !== "ready")
    throw new Error(event.message ?? "Worker runtime failed preflight");
}
export class TranscriptionService {
  private active = new Set<string>();
  constructor(readonly options: TranscriptionOptions) {}
  async start(
    assetId: string,
    language: Language,
    request: TranscriptionRequestOptions = {},
  ): Promise<string> {
    const requestOptions = parseTranscriptionOptions(request);
    oneOf(language, ["auto", "en", "zh"]);
    const o = this.options;
    const initial = o.getProject();
    const asset = initial.assets.find((a) => a.id === assetId);
    if (!asset) throw new Error("Unknown source");
    if (!asset.hasAudio)
      throw new Error("This source has no audio; create a manual cut");
    if (this.active.has(assetId))
      throw new Error("Transcription already queued for this source");
    this.active.add(assetId);
    let model;
    try {
      await o.media.verifyAssetIdentity(asset);
      model = await o.models.verify();
    } catch (error) {
      this.active.delete(assetId);
      throw error;
    }
    let jobId = "";
    jobId = o.jobs.start(
      "transcription",
      {
        assetId,
        totalMs: asset.durationMs,
        projectId: initial.id,
        projectRevision: initial.revision,
      },
      async (ctx) => {
        let temporary: string | undefined;
        const words: TimedWord[] = [];
        const segments: TranscriptSegment[] = [];
        let detected: Language = language;
        let complete = false;
        let wordTimingReviewReady = false;
        let workerError: string | undefined;
        let buffer = "";
        let bytes = 0;
        try {
          ctx.throwIfCancelled();
          await o.media.verifyAssetIdentity(asset);
          await mkdir(o.tempRoot, { recursive: true });
          temporary = await mkdtemp(path.join(o.tempRoot, "transcription-"));
          const pcm = path.join(temporary, "audio.wav");
          ctx.update({
            stage: "decoding audio",
            progress: null,
            processedMs: 0,
          });
          await runProcess(
            o.ffmpeg,
            [
              "-v",
              "error",
              "-nostdin",
              "-i",
              o.media.sources.resolve(assetId),
              "-map",
              "0:a:0",
              "-vn",
              "-ac",
              "1",
              "-ar",
              "16000",
              "-c:a",
              "pcm_s16le",
              "-f",
              "wav",
              pcm,
            ],
            { signal: ctx.signal },
          );
          await o.media.verifyAssetIdentity(asset);
          ctx.throwIfCancelled();
          ctx.update({
            stage: "loading local model",
            progress: null,
            processedMs: 0,
          });
          const command = offlineWorkerCommand(o.python, o.worker);
          await runProcess(command.executable, command.argv, {
            signal: ctx.signal,
            env: command.env,
            input:
              JSON.stringify({
                mode: "transcribe",
                modelDirectory: model.directory,
                modelChoice: model.choice,
                vocabulary: requestOptions.vocabulary ?? "",
                audioPath: pcm,
                durationMs: asset.durationMs,
                language,
              }) + "\n",
            onStdout: (chunk) => {
              bytes += Buffer.byteLength(chunk);
              if (bytes > 64 * 1024 * 1024)
                throw new Error("Transcript output limit exceeded");
              buffer += chunk;
              if (Buffer.byteLength(buffer) > 1024 * 1024)
                throw new Error("Worker event byte limit exceeded");
              for (;;) {
                const newline = buffer.indexOf("\n");
                if (newline < 0) break;
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (!line.trim()) continue;
                const event = JSON.parse(line);
                if (event.type === "error") {
                  workerError = text(event.message, 10000);
                  throw new Error(workerError);
                }
                if (event.type === "ready") {
                  if (event.wordTimingReview !== true)
                    throw new Error("Worker word timing review provenance mismatch");
                  wordTimingReviewReady = true;
                  ctx.update({ stage: "transcribing", progress: null });
                  continue;
                }
                if (event.type === "segment") {
                  if (!wordTimingReviewReady)
                    throw new Error("Worker word timing review provenance mismatch");
                  const v = record(event, [
                    "type",
                    "index",
                    "language",
                    "text",
                    "startMs",
                    "endMs",
                    "words",
                    "processedMs",
                    "untimedWordCount",
                    "leadingUntimedText",
                  ]);
                  if (integer(v.index) !== segments.length)
                    throw new Error("Out-of-order worker segments");
                  const segmentWords = list(
                    v.words,
                    (item) => {
                      const w = record(item, [
                        "text",
                        "startMs",
                        "endMs",
                        "timingNeedsReview",
                      ]);
                      return {
                        id: "pending",
                        text: text(w.text, 10000, true),
                        startMs: integer(w.startMs),
                        endMs: integer(w.endMs),
                        ...(w.timingNeedsReview === undefined
                          ? {}
                          : { timingNeedsReview: bool(w.timingNeedsReview) }),
                      };
                    },
                    500000,
                  );
                  for (let index = 0; index < segmentWords.length; index++)
                    segmentWords[index]!.id =
                      `${jobId}-w-${words.length + index}`;
                  const leading =
                    v.leadingUntimedText === undefined
                      ? ""
                      : text(v.leadingUntimedText, 10000, true);
                  if (leading) {
                    if (words.length) {
                      const last = words.at(-1)!;
                      words[words.length - 1] = {
                        ...last,
                        text: last.text + leading,
                        timingNeedsReview: true,
                      };
                    } else if (segmentWords.length) {
                      segmentWords[0]!.text = leading + segmentWords[0]!.text;
                      segmentWords[0]!.timingNeedsReview = true;
                    }
                  }
                  words.push(...segmentWords);
                  const rawText = text(v.text, 100000, true);
                  const segment = {
                    id: `${jobId}-s-${segments.length}`,
                    text:
                      !segmentWords.length && leading && words.length
                        ? rawText.replace(leading, "").trim()
                        : rawText,
                    startMs: integer(v.startMs),
                    endMs: integer(v.endMs),
                    wordIds: segmentWords.map((w) => w.id),
                  };
                  segments.push(segment);
                  detected =
                    v.language === "en" || v.language === "zh"
                      ? v.language
                      : language;
                  const processed = integer(v.processedMs, 0, asset.durationMs);
                  ctx.update({
                    stage: "transcribing",
                    processedMs: processed,
                    progress: processed / asset.durationMs,
                  });
                  const current = o.getProject();
                  if (current.id !== initial.id)
                    throw new Error("Project changed during transcription");
                  o.onDraft(assetId, {
                    assetId,
                    language: detected,
                    words: [...words],
                    segments: groupSentences(words, segments, jobId),
                  });
                  continue;
                }
                if (event.type === "complete") {
                  if (!wordTimingReviewReady || event.wordTimingReview !== true)
                    throw new Error("Worker word timing review provenance mismatch");
                  if (event.segmentCount !== segments.length)
                    throw new Error("Incomplete worker transcript");
                  if (
                    event.modelChoice !== model.choice ||
                    event.modelId !== model.id ||
                    event.modelDigest !== model.digest ||
                    event.simplifiedChinese !== (language === "zh") ||
                    event.conditionOnPreviousText !== false
                  )
                    throw new Error(
                      "Worker model or decoding identity mismatch",
                    );
                  complete = true;
                  continue;
                }
                throw new Error("Unknown worker event");
              }
            },
          }).catch((error) => {
            if (workerError) throw new Error(workerError);
            throw error;
          });
          if (buffer.trim() || !complete)
            throw new Error("Worker exited without complete transcript");
          ctx.throwIfCancelled();
          await o.media.verifyAssetIdentity(asset);
          ctx.throwIfCancelled();
          const current = o.getProject();
          if (
            current.id !== initial.id ||
            !current.assets.some(
              (a) =>
                a.id === assetId &&
                a.fingerprint === asset.fingerprint &&
                a.status === "ready",
            )
          )
            throw new Error("Source/project changed during transcription");
          const transcript: Transcript = {
            assetId,
            fingerprint: asset.fingerprint,
            revision:
              (current.transcripts.find((t) => t.assetId === assetId)
                ?.revision ?? 0) + 1,
            language: detected,
            words,
            segments: groupSentences(words, segments, jobId),
            model: { id: model.id, digest: model.digest },
            engine: { name: "faster-whisper", version: "1.2.1" },
            originId: jobId,
            parameters: {
              vad: true,
              ...(requestOptions.vocabulary
                ? { vocabulary: requestOptions.vocabulary }
                : {}),
              simplifiedChinese: language === "zh",
              conditionOnPreviousText: false,
              wordTimingReview: true,
            },
          };
          validateProject({
            ...serializeProject(current),
            transcripts: [
              ...current.transcripts.filter((t) => t.assetId !== assetId),
              transcript,
            ],
          });
          // Finish cleanup before the synchronous commit; cancellation has no await gap after commit.
          await rm(temporary, { recursive: true, force: true });
          temporary = undefined;
          ctx.throwIfCancelled();
          o.onDraft(assetId, undefined);
          ctx.commit(() => o.onTranscript(transcript));
        } finally {
          this.active.delete(assetId);
          o.onDraft(assetId, undefined);
          if (temporary) await rm(temporary, { recursive: true, force: true });
        }
      },
    );
    void o.jobs.wait(jobId).then(() => {
      this.active.delete(assetId);
      o.onDraft(assetId, undefined);
    });
    return jobId;
  }
}

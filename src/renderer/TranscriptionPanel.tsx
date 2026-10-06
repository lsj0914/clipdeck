import { useLocale } from "./locale";
import React, { useRef, useState, useEffect } from "react";
import type {
  ClipDeckAPI,
  Language,
  ModelChoice,
  SafeAsset,
  WorkspaceSnapshot,
} from "../shared/contracts";
import { message } from "./format";
const working = (status: string) =>
  ["queued", "running", "cancelling"].includes(status);
export function TranscriptionPanel({
  api,
  snapshot,
  asset,
  accept,
  settingsRequest = 0,
}: {
  settingsRequest?: number;
  api: ClipDeckAPI;
  snapshot: WorkspaceSnapshot;
  asset: SafeAsset;
  accept: (snapshot: WorkspaceSnapshot) => void;
}) {
  const { t } = useLocale();
  const transcript = snapshot.project.transcripts.find(
    (t) => t.assetId === asset.id && t.fingerprint === asset.fingerprint,
  );
  const identity = `${snapshot.project.id}:${asset.id}:${asset.fingerprint}`;
  const [opened, setOpened] = useState(false),
    [, refresh] = useState(0);
  useEffect(() => {
    if (settingsRequest) setOpened(true);
  }, [settingsRequest]);
  const settings = useRef(
    new Map<string, { language: Language; vocabulary: string }>(),
  );
  if (!settings.current.has(identity))
    settings.current.set(identity, {
      language: transcript?.language ?? "auto",
      vocabulary: transcript?.parameters.vocabulary ?? "",
    });
  const values = settings.current.get(identity)!;
  const [choice, setChoice] = useState<ModelChoice>(
    snapshot.model.choice ?? "small",
  );
  useEffect(() => {
    if (snapshot.model.choice) setChoice(snapshot.model.choice);
  }, [snapshot.model.choice]);
  const attempts = useRef(
    new Map<string, { pending: boolean; jobId?: string; error?: string }>(),
  );
  const modelAttempt = useRef<{
    pending: boolean;
    jobId?: string;
    error?: string;
  }>({ pending: false });
  const job = snapshot.jobs.findLast(
    (j) => j.kind === "transcription" && j.assetId === asset.id,
  );
  const attempt = attempts.current.get(identity);
  if (attempt?.jobId && snapshot.jobs.some((j) => j.id === attempt.jobId))
    attempt.pending = false;
  if (
    modelAttempt.current.jobId &&
    snapshot.jobs.some((j) => j.id === modelAttempt.current.jobId)
  )
    modelAttempt.current.pending = false;
  const active = !!attempt?.pending || (!!job && working(job.status));
  const modelPending =
    modelAttempt.current.pending || snapshot.model.status === "downloading";
  const modelReady =
    snapshot.model.status === "ready" &&
    (!snapshot.model.choice || snapshot.model.choice === choice);
  function update(change: Partial<typeof values>) {
    settings.current.set(identity, { ...values, ...change });
    refresh((n) => n + 1);
  }
  async function transcribe() {
    if (active || attempts.current.get(identity)?.pending) return;
    const next = { pending: true } as {
      pending: boolean;
      jobId?: string;
      error?: string;
    };
    attempts.current.set(identity, next);
    refresh((n) => n + 1);
    try {
      next.jobId = await api.transcribe(asset.id, values.language, {
        vocabulary: values.vocabulary.trim(),
      });
    } catch (error) {
      next.pending = false;
      next.error = message(error);
    }
    refresh((n) => n + 1);
  }
  async function model(local = false) {
    if (modelPending || modelAttempt.current.pending) return;
    modelAttempt.current = { pending: true };
    refresh((n) => n + 1);
    try {
      if (local) {
        accept(await api.chooseModel());
        modelAttempt.current.pending = false;
      } else modelAttempt.current.jobId = await api.downloadModel(choice);
    } catch (error) {
      modelAttempt.current = { pending: false, error: message(error) };
    }
    refresh((n) => n + 1);
  }
  const error = attempt?.error ?? (job?.status === "failed" ? job.error : null);
  return (
    <section
      className={`transcription-panel${opened || !transcript ? " expanded" : ""}`}
      aria-label={t("Source transcription")}
    >
      <div className="transcription-summary">
        <span>
          {active
            ? `${t("Transcribing")} · ${t(job?.stage ?? "Waiting for local processing")}`
            : error
              ? t("Transcription needs attention")
              : transcript
                ? t("Transcript ready")
                : t("Next: prepare text or select a time range")}
        </span>
        <button
          aria-expanded={opened}
          onClick={() => setOpened(!opened)}
        >
          {t("Transcription settings")}
        </button>
      </div>
      {active && (
        <div className="source-task">
          <progress
            aria-label={t("Transcription progress")}
            max={1}
            {...(job?.progress == null ? {} : { value: job.progress })}
          />
          {job && (
            <button
              disabled={job.cancelRequested}
              onClick={() =>
                void api.cancelJob(job.id).catch((e) => {
                  attempts.current.set(identity, {
                    pending: false,
                    error: message(e),
                  });
                  refresh((n) => n + 1);
                })
              }
            >
              {t("Cancel transcription")}
            </button>
          )}
          <p>
            {transcript
              ? t(
                  "Current text stays available until the new transcription succeeds.",
                )
              : t("Words become selectable when transcription finishes.")}
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="field-error">
          {t(error)}
          <button
            disabled={active || !modelReady}
            onClick={() => void transcribe()}
          >
            {t("Retry transcription")}
          </button>
        </p>
      )}
      {job?.status === "cancelled" && !active && (
        <p>{t("Transcription cancelled. Your previous text is kept.")}</p>
      )}
      {(opened || !transcript) && (
        <div className="transcription-options">
          <div className="recognition-options">
            <label>
              {t("Recognition language")}
              <select
                aria-label={t("Transcription language")}
                value={values.language}
                disabled={active}
                onChange={(e) =>
                  update({ language: e.target.value as Language })
                }
              >
                <option value="auto">{t("Detect language")}</option>
                <option value="en">{t("English")}</option>
                <option value="zh">中文</option>
              </select>
            </label>
            <label>
              {t("Local model")}
              <select
                aria-label={t("Recognition model")}
                value={choice}
                disabled={active || modelPending}
                onChange={(e) => setChoice(e.target.value as ModelChoice)}
              >
                {(
                  snapshot.model.available ?? [
                    { choice: "small", label: "Whisper small", bytes: 0 },
                    {
                      choice: "turbo",
                      label: "Whisper large-v3-turbo",
                      bytes: 0,
                    },
                  ]
                ).map((m) => (
                  <option key={m.choice} value={m.choice}>
                    {m.label}
                    {m.bytes ? ` · ${(m.bytes / 1e9).toFixed(2)} GB` : ""}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {opened && <p className="muted">
            {choice === "small"
              ? t("Small: lower memory use.")
              : t("Turbo: larger model; needs more memory.")}{" "}
            {t(
              "Recognition can make mistakes. Listen and correct important names.",
            )}
          </p>}
          {opened && <p className="muted">{t("Up to six hours per source. Transcription tasks run one at a time.")}</p>}
          {opened && <div className="vocabulary-settings"><label>
            {t("Names and vocabulary")}
            <textarea
              aria-label={t("Names and vocabulary")}
              value={values.vocabulary}
              maxLength={1000}
              disabled={active}
              rows={2}
              placeholder={t("Names, technical terms, places")}
              onChange={(e) => update({ vocabulary: e.target.value })}
            />
          </label>
          <small>
            {t(
              "Optional comma-separated terms guide recognition; they are not verified words.",
            )}
          </small>
          </div>}
          {!modelReady && (
            <div className="model-first-run">
              <p>
                {t(
                  "Prepare this model once, then transcribe offline. The model choices above are not installed-model claims.",
                )}
              </p>
              <div className="button-row">
                <button disabled={modelPending} onClick={() => void model()}>
                  {t("Download selected model")}
                </button>
                <button
                  disabled={modelPending}
                  onClick={() => void model(true)}
                >
                  {t("Use local model")}
                </button>
              </div>
              {modelPending && (
                <>
                  <progress
                    aria-label={t("Model download progress")}
                    max={1}
                    {...(snapshot.model.progress === null
                      ? {}
                      : { value: snapshot.model.progress })}
                  />
                  <p>{snapshot.model.message}</p>
                  {snapshot.jobs
                    .filter(
                      (j) => j.kind === "modelDownload" && working(j.status),
                    )
                    .map((j) => (
                      <button
                        key={j.id}
                        disabled={j.cancelRequested}
                        onClick={() =>
                          void api.cancelJob(j.id).catch((error) => {
                            modelAttempt.current.error = message(error);
                            refresh((n) => n + 1);
                          })
                        }
                      >
                        {t("Cancel model download")}
                      </button>
                    ))}
                </>
              )}
              {(modelAttempt.current.error ||
                snapshot.model.status === "failed") && (
                <p role="alert">
                  {modelAttempt.current.error ?? snapshot.model.message}
                </p>
              )}
            </div>
          )}
          <div className="transcription-action-row">
          {modelReady && (
            <p className="model-ready">
              {t("Verified model:")}
              <span title={snapshot.model.id ?? undefined}>{snapshot.model.id}</span>
            </p>
          )}
          <button
            className="primary"
            disabled={
              active || !modelReady || !snapshot.capabilities.transcription
            }
            onClick={() => void transcribe()}
          >
            {active
              ? t("Transcribing\u2026")
              : transcript
                ? t("Transcribe again")
                : t("Transcribe source")}
          </button>
          </div>
          {!snapshot.capabilities.transcription && (
            <p>
              {t(
                "Local transcription is unavailable. You can still select time ranges.",
              )}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

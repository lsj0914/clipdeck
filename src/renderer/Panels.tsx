import { useLocale } from "./locale";
import React, { useEffect, useId, useRef, useState } from "react";
import type { Cut, Job, SafeAsset } from "../shared/contracts";
import { excerpt, range, seconds, time, parseSeconds, RangeInputError } from "./format";
import { Icon } from "./Icon";
export function RangeEditor({
  asset,
  currentMs,
  onAdd,
  onAudition,
  canAudition,
  busy,
  initialRange,
  reviewTiming = false,
}: {
  asset: SafeAsset;
  currentMs: number;
  onAdd: (start: number, end: number) => void;
  onAudition: (start: number, end: number) => void;
  busy: boolean;
  canAudition: boolean;
  initialRange?: { startMs: number; endMs: number };
  reviewTiming?: boolean;
}) {
  const { t } = useLocale();
  const [start, setStart] = useState(time(initialRange?.startMs ?? 0, true)),
    [end, setEnd] = useState(time(initialRange?.endMs ?? asset.durationMs, true)),
    [error, setError] = useState("");
  const alert = useRef<HTMLParagraphElement>(null);
  function submit(action: (a: number, b: number) => void) {
    try {
      const r = range(start, end, asset.durationMs);
      setError("");
      action(r.startMs, r.endMs);
    } catch (e) {
      setError((e as Error).message);
      requestAnimationFrame(() => alert.current?.focus());
    }
  }
  return (
    <div className="range-editor">
      <p className="muted">
        {reviewTiming
          ? t("This suggested range includes up to two seconds of context on each side. Listen and adjust In and Out before adding it.")
          : asset.hasAudio
          ? t("Make a selection by time, including pauses.")
          : t(
              "This source has no audio. Set an in and out point to add video.",
            )}
      </p>
      <div className="range-fields">
        <label>
          {t("In")}
          <span>{t("MM:SS.MMM / seconds")}</span>
          <input
            aria-label={t("Selection in")}
            inputMode="decimal"
            autoFocus={reviewTiming}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <button
            className="text-button"
            onClick={() => setStart(time(currentMs, true))}
          >
            {t("Use playhead")}
          </button>
        </label>
        <label>
          {t("Out")}
          <span>{t("MM:SS.MMM / seconds")}</span>
          <input
            aria-label={t("Selection out")}
            inputMode="decimal"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
          <button
            className="text-button"
            onClick={() => setEnd(time(currentMs, true))}
          >
            {t("Use playhead")}
          </button>
        </label>
      </div>
      {error && (
        <p ref={alert} tabIndex={-1} role="alert" className="field-error">
          {t(error)}
        </p>
      )}
      <div className="button-row">
        <button
          disabled={busy || !canAudition || asset.status !== "ready"}
          onClick={() => submit(onAudition)}
        >
          <Icon name="play" />
          {t("Audition range")}
        </button>
        <button
          className="primary"
          disabled={busy || asset.status !== "ready"}
          onClick={() => submit(onAdd)}
        >
          <Icon name="plus" />
          {t("Add range")}
        </button>
      </div>
    </div>
  );
}
export type CutDraft = {
  start: string;
  end: string;
  note: string;
  text: string;
  baseText: string;
};
export const cutDraft = (cut: Cut): CutDraft => ({
  start: time(cut.startMs, true),
  end: time(cut.endMs, true),
  note: cut.note,
  text: cut.text,
  baseText: cut.text,
});
export function CutInspector({
  cut,
  asset,
  busy,
  onUpdate,
  onAudition,
  canAudition,
  looping,
  onLoop,
  draft,
  ordinal,
  onDraft,
  currentMs = 0,
  validation,
}: {
  cut: Cut;
  ordinal: number;
  draft: CutDraft;
  onDraft: (draft: CutDraft) => void;
  currentMs?: number;
  validation?: { field: "start" | "end"; message: string; request: number } | undefined;
  asset: SafeAsset | undefined;
  busy: boolean;
  canAudition: boolean;
  onUpdate: (changes: {
    startMs: number;
    endMs: number;
    note: string;
    text: string;
  }) => void;
  onAudition: () => void;
  looping: boolean;
  onLoop: () => void;
}) {
  const { t } = useLocale();
  const { start, end, note } = draft;
  const text = draft.text === draft.baseText ? cut.text : draft.text;
  const setStart = (start: string) => { setError(""); setErrorField(null); onDraft({ ...draft, start }); };
  const setEnd = (end: string) => { setError(""); setErrorField(null); onDraft({ ...draft, end }); };
  const setText = (text: string) => onDraft({ ...draft, text });
  const setNote = (note: string) => onDraft({ ...draft, note });
  const [editingFullText, setEditingFullText] = useState(false),
    [error, setError] = useState(""),
    [errorField, setErrorField] = useState<"start" | "end" | null>(null);
  const fullTextId = useId();
  const errorId = useId();
  const startInput = useRef<HTMLInputElement>(null), endInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setEditingFullText(false);
    setError("");
    setErrorField(null);
  }, [cut.id]);
  useEffect(() => {
    if (!validation || busy) return;
    setError(validation.message);
    setErrorField(validation.field);
    (validation.field === "start" ? startInput : endInput).current?.focus();
  }, [validation, busy]);
  const dirty =
    start !== time(cut.startMs, true) ||
    end !== time(cut.endMs, true) ||
    note !== cut.note ||
    text !== cut.text;
  function nudge(which: "start" | "end", delta: number) {
    try {
      const value = Math.max(
        0,
        Math.min(
          asset?.durationMs ?? 0,
          parseSeconds(which === "start" ? start : end) + delta,
        ),
      );
      (which === "start" ? setStart : setEnd)(time(value, true));
    } catch (e) {
      setError((e as Error).message);
      setErrorField(which);
      (which === "start" ? startInput : endInput).current?.focus();
    }
  }
  function save() {
    try {
      if (!asset)
        throw new Error("Relink this source before changing its range.");
      const r = range(start, end, asset.durationMs);
      setError("");
      setErrorField(null);
      onUpdate({ ...r, note, text });
    } catch (e) {
      setError((e as Error).message);
      const field = e instanceof RangeInputError ? e.field : null;
      setErrorField(field);
      if (field) (field === "start" ? startInput : endInput).current?.focus();
    }
  }
  return (
    <section className="cut-inspector" aria-label={t("Cut inspector")}>
      <div className="section-heading">
        <h2>
          {t("Cut inspector")} · {ordinal}
        </h2>
        {dirty && (
          <span className="draft-state">
            {t("Unapplied \u00b7 kept on switch")}
          </span>
        )}
        <span className="duration">{time(cut.endMs - cut.startMs, true)}</span>
      </div>
      <p className="source-caption" title={asset?.name}>
        {asset?.name ?? t("Missing source")}
      </p>
      {cut.needsReview && (
        <p className="warning">
          {t(
            "Source or transcript changed. Remove this cut and select the passage again before export.",
          )}
        </p>
      )}
      <div className="range-fields">
        <label>
          {t("In")}
          <span>{t("MM:SS.MMM / seconds")}</span>
          <input
            disabled={busy}
            aria-label={t("Cut in")}
            ref={startInput}
            aria-invalid={errorField === "start" || undefined}
            aria-describedby={errorField === "start" ? errorId : undefined}
            inputMode="decimal"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
          <div className="boundary-actions">
            <button onClick={() => setStart(time(currentMs, true))}>
              {t("Use playhead")}
            </button>
            <button
              aria-label={t("Nudge start earlier")}
              onClick={() => nudge("start", -33)}
            >
              {t("\u221233 ms")}
            </button>
            <button
              aria-label={t("Nudge start later")}
              onClick={() => nudge("start", 33)}
            >
              {t("+33 ms")}
            </button>
          </div>
        </label>
        <label>
          {t("Out")}
          <span>{t("MM:SS.MMM / seconds")}</span>
          <input
            disabled={busy}
            aria-label={t("Cut out")}
            ref={endInput}
            aria-invalid={errorField === "end" || undefined}
            aria-describedby={errorField === "end" ? errorId : undefined}
            inputMode="decimal"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
          <div className="boundary-actions">
            <button onClick={() => setEnd(time(currentMs, true))}>
              {t("Use playhead")}
            </button>
            <button
              aria-label={t("Nudge end earlier")}
              onClick={() => nudge("end", -33)}
            >
              {t("\u221233 ms")}
            </button>
            <button
              aria-label={t("Nudge end later")}
              onClick={() => nudge("end", 33)}
            >
              {t("+33 ms")}
            </button>
          </div>
        </label>
      </div>
      {cut.text.length > 512 ? (
        <div className="note-label long-cut-label">
          <span>{t("Cut label")}</span>
          <div id={fullTextId}>
            {editingFullText ? (
              <textarea
                disabled={busy}
                aria-label={t("Cut label")}
                value={text}
                maxLength={5000000}
                onChange={(event) => setText(event.target.value)}
                rows={5}
                autoFocus
              />
            ) : (
              <>
                <p>{excerpt(text, 280)}</p>
                <small>
                  {t("Full text is kept. Open it to read or edit.")}
                </small>
              </>
            )}
          </div>
          <button
            aria-expanded={editingFullText}
            aria-controls={fullTextId}
            onClick={() => setEditingFullText(!editingFullText)}
          >
            {editingFullText
              ? t("Hide full text")
              : t("Read or edit full text")}
          </button>
        </div>
      ) : (
        <label className="note-label">
          {t("Cut label")}
          <input
            disabled={busy}
            aria-label={t("Cut label")}
            value={text}
            maxLength={10000}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("Name this beat")}
          />
        </label>
      )}
      <label className="note-label">
        {t("Note")}
        <textarea
          disabled={busy}
          aria-label={t("Cut note")}
          value={note}
          maxLength={10000}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t("What belongs in this beat?")}
          rows={2}
        />
      </label>
      {error && (
        <p id={errorId} role="alert" className="field-error">
          {t(error)}
        </p>
      )}
      <div className="button-row">
        <button
          disabled={busy || !canAudition || asset?.status !== "ready" || dirty}
          onClick={onAudition}
        >
          <Icon name="play" />
          {t("Audition cut")}
        </button>
        <button
          disabled={busy || !canAudition || asset?.status !== "ready" || dirty}
          aria-pressed={looping}
          onClick={onLoop}
        >
          {looping ? t("Stop loop") : t("Loop audition")}
        </button>
        <button
          disabled={busy || !asset || asset.status !== "ready"}
          onClick={save}
        >
          {t("Apply changes")}
        </button>
      </div>
    </section>
  );
}
export function JobList({
  jobs,
  assets = [],
  onCancel,
  onRetry,
  onReveal,
  onPlay,
}: {
  jobs: Job[];
  assets?: SafeAsset[];
  onCancel: (j: Job) => void;
  onRetry: (j: Job) => void;
  onReveal: (j: Job) => void;
  onPlay: (j: Job) => void;
}) {
  const { t } = useLocale();
  const labels = {
    transcription: t("Transcription"),
    modelDownload: t("Model preparation"),
    preview: t("Assembly preview"),
    sourcePreview: t("Source preview"),
    export: t("Video export"),
  };
  return (
    <div className="jobs-list">
      {jobs.length === 0 ? (
        <p className="muted">
          {t("No processing jobs. Your edits stay on this computer.")}
        </p>
      ) : (
        [...jobs].reverse().map((job) => (
          <div className="job" key={job.id}>
            <div className="job-heading">
              <strong>
                {labels[job.kind]}
                {job.assetId && (
                  <small>
                    {" "}
                    · {assets.find((a) => a.id === job.assetId)?.name}
                  </small>
                )}
              </strong>
              <span className={`job-status ${job.status}`}>
                {t(job.status)}
              </span>
            </div>
            <p>{t(job.error ?? job.stage)}</p>
            {["queued", "running", "cancelling"].includes(job.status) && (
              <>
                <progress
                  aria-label={`${labels[job.kind]} progress`}
                  max={1}
                  {...(job.progress === null ? {} : { value: job.progress })}
                />
                <div className="job-footer">
                  <span>
                    {time(job.processedMs)}
                    {job.totalMs !== null ? ` / ${time(job.totalMs)}` : ""}
                  </span>
                  <button
                    disabled={
                      job.cancelRequested || job.status === "cancelling"
                    }
                    onClick={() => onCancel(job)}
                  >
                    {job.cancelRequested ? t("Cancelling\u2026") : t("Cancel")}
                  </button>
                </div>
              </>
            )}
            {["failed", "cancelled"].includes(job.status) && (
              <button onClick={() => onRetry(job)}>
                {t("Retry")} {labels[job.kind].toLowerCase()}
              </button>
            )}
            {job.kind === "export" &&
              job.status === "completed" &&
              job.outputUrl && (
                <div className="button-row">
                  <button onClick={() => onPlay(job)}>
                    {t("Play exported video")}
                  </button>
                  <button onClick={() => onReveal(job)}>
                    <Icon name="folder" />
                    {t("Show exported video")}
                  </button>
                </div>
              )}
          </div>
        ))
      )}
    </div>
  );
}

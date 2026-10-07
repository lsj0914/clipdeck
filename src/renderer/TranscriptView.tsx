import { useLocale } from "./locale";
import { transcriptRows, transcriptMatches, wordSeparator } from "./reading";
import React, { useMemo, useRef, useState, useEffect, useId } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { TimedWord, Transcript } from "../shared/contracts";
import { time } from "./format";
import { Icon } from "./Icon";
export interface WordSelection {
  anchor: string;
  focus: string;
}
interface Props {
  transcript: Pick<Transcript, "words" | "segments">;
  selection: WordSelection | null;
  onSelect: (id: string, extend: boolean) => void;
  currentMs: number;
  addedWords: Set<string>;
  draft?: boolean;
  timingProvenanceKnown?: boolean;
  onReviewTimingRange?: (startMs: number, endMs: number) => void;
}
export function TranscriptView({
  transcript,
  selection,
  onSelect,
  currentMs,
  addedWords,
  draft = false,
  timingProvenanceKnown = false,
  onReviewTimingRange,
}: Props) {
  const { t } = useLocale();
  const timingNoteId = useId();
  const hasTimingIssues = useMemo(
    () => transcript.words.some((w) => w.timingNeedsReview),
    [transcript.words],
  );
  const scroller = useRef<HTMLDivElement>(null),
    dragging = useRef(false),
    [query, setQuery] = useState(""),
    [matchIndex, setMatchIndex] = useState(0),
    [focused, setFocused] = useState(0);
  const groups = useMemo(
    () => transcriptRows(transcript),
    [transcript.words, transcript.segments],
  );
  const hasUntimedText = groups.some((row) => row.kind === "untimed");
  const index = useMemo(
    () => new Map(transcript.words.map((w, i) => [w.id, i])),
    [transcript],
  );
  const wordGroup = useMemo(
    () => new Map(groups.flatMap((g, i) =>
      g.kind === "timed" ? g.words.map((w) => [w.id, i] as const) : [],
    )),
    [groups],
  );
  const virtual = useVirtualizer({
    // Scroll notifications can originate during React's layout/selection effects.
    // Let React schedule the range update instead of forcing a nested flush.
    useFlushSync: false,
    count: groups.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 160,
    overscan: 2,
    initialRect: { width: 600, height: 600 },
  });
  const virtualRows = virtual.getVirtualItems();
  const focusedWord = transcript.words[focused];
  const focusedWordMounted =
    !!focusedWord &&
    virtualRows.some((row) => row.index === wordGroup.get(focusedWord.id));
  const a = selection ? (index.get(selection.anchor) ?? -1) : -1,
    b = selection ? (index.get(selection.focus) ?? -1) : -1;
  const matches = useMemo(
    () => transcriptMatches(groups, transcript.words, query),
    [query, transcript.words, groups],
  );
  const match = matches[matchIndex % (matches.length || 1)];
  function focusWord(position: number, extend: boolean) {
    const next = Math.max(0, Math.min(transcript.words.length - 1, position));
    const word = transcript.words[next];
    if (!word) return;
    setFocused(next);
    onSelect(word.id, extend);
    virtual.scrollToIndex(wordGroup.get(word.id) ?? 0, { align: "auto" });
    requestAnimationFrame(() =>
      scroller.current
        ?.querySelector<HTMLButtonElement>(`[data-position="${next}"]`)
        ?.focus(),
    );
  }
  useEffect(() => {
    const end = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("blur", end);
    };
  }, []);
  useEffect(() => {
    if (selection) {
      const position = index.get(selection.focus);
      if (position !== undefined) {
        setFocused(position);
        if (!dragging.current)
          virtual.scrollToIndex(wordGroup.get(selection.focus) ?? 0, {
            align: "auto",
          });
      }
    }
  }, [selection?.focus]);
  useEffect(() => {
    setMatchIndex(0);
    const first = matches[0];
    if (first)
      virtual.scrollToIndex(
        first.row,
        { align: "center" },
      );
  }, [query]);
  function findNext(delta = 1) {
    if (!matches.length) return;
    const nextIndex = (matchIndex + delta + matches.length) % matches.length;
    setMatchIndex(nextIndex);
    virtual.scrollToIndex(
      matches[nextIndex]!.row,
      { align: "center" },
    );
  }
  function verticalPosition(position: number, direction: number) {
    const buttons = Array.from(
      scroller.current?.querySelectorAll<HTMLButtonElement>(
        "[data-position]",
      ) ?? [],
    );
    const current = buttons
      .find((b) => Number(b.dataset.position) === position)
      ?.getBoundingClientRect();
    if (!current) return position + direction;
    const candidates = buttons
      .map((button) => ({ button, rect: button.getBoundingClientRect() }))
      .filter(({ rect }) =>
        direction > 0 ? rect.top > current.top + 2 : rect.top < current.top - 2,
      );
    candidates.sort(
      (a, b) =>
        Math.abs(a.rect.top - current.top) -
          Math.abs(b.rect.top - current.top) ||
        Math.abs(a.rect.left - current.left) -
          Math.abs(b.rect.left - current.left),
    );
    return candidates[0]
      ? Number(candidates[0].button.dataset.position)
      : position + direction;
  }
  const pointerY = useRef<number | null>(null);
  const onDragSelect = useRef(onSelect);
  onDragSelect.current = onSelect;
  useEffect(() => {
    let frame = 0;
    const move = (event: PointerEvent) => {
      pointerY.current = event.clientY;
      if (dragging.current && !frame) frame = requestAnimationFrame(tick);
    };
    const tick = () => {
      frame = 0;
      const el = scroller.current;
      if (!dragging.current || !el || pointerY.current === null) return;
      const rect = el.getBoundingClientRect(),
        y = pointerY.current;
      const speed = y < rect.top + 36 ? -14 : y > rect.bottom - 36 ? 14 : 0;
      if (speed) {
        el.scrollTop += speed;
        el.dispatchEvent(new Event("scroll"));
        const buttons = Array.from(
          el.querySelectorAll<HTMLButtonElement>("[data-word]"),
        );
        const visible = buttons.filter((button) => {
          const r = button.getBoundingClientRect();
          return r.bottom > rect.top && r.top < rect.bottom;
        });
        const target = speed > 0 ? visible.at(-1) : visible[0];
        if (target?.dataset.word)
          onDragSelect.current(target.dataset.word, true);
      }
      frame = requestAnimationFrame(tick);
    };
    window.addEventListener("pointermove", move);
    return () => {
      window.removeEventListener("pointermove", move);
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <>
      <div className="transcript-tools">
        <div className="search-field">
          <Icon name="search" />
          <input
            aria-label={t("Find in transcript")}
            placeholder={t("Find in transcript")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setMatchIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                findNext();
              }
            }}
          />
          {query && (
            <span>
              {matches.length ? (matchIndex % matches.length) + 1 : 0} /{" "}
              {matches.length}
            </span>
          )}
        </div>
        {query && (
          <div className="search-actions">
            <button
              aria-label={t("Previous match")}
              onClick={() => findNext(-1)}
              disabled={!matches.length}
            >
              {t("Previous")}
            </button>
            <button
              aria-label={t("Next match")}
              onClick={() => findNext()}
              disabled={!matches.length}
            >
              {t("Next")}
            </button>
            <button
              disabled={!match || match.kind === "untimed" || draft}
              onClick={() => {
                if (match?.kind === "timed") {
                  onSelect(transcript.words[match.start]!.id, false);
                  onSelect(transcript.words[match.end]!.id, true);
                }
              }}
            >
              {t("Select match")}
            </button>
          </div>
        )}
        <button
          disabled={draft || !transcript.words.length}
          onClick={() => {
            onSelect(transcript.words[0]!.id, false);
            onSelect(transcript.words.at(-1)!.id, true);
          }}
        >
          {t(hasUntimedText ? "Select all timed text" : "Select all text")}
        </button>
        <span className="reading-hint">
          {t("Click to seek \u00b7 Shift-click to select")}
        </span>
      </div>
      {(hasTimingIssues || (!draft && !timingProvenanceKnown)) && (
        <details id={timingNoteId} className="transcript-timing-note" role="note">
          <summary>{t("Timing needs review")}</summary>
          <p>{hasTimingIssues
            ? t("Underlined passages have uncertain word timing. Use a time range to check them.")
            : t("This saved transcript does not identify uncertain word timing. Listen before cutting, or transcribe again.")}</p>
        </details>
      )}
      <div
        ref={scroller}
        className="transcript-scroll"
        tabIndex={draft || focusedWordMounted ? -1 : 0}
        onFocus={(event) => {
          if (event.target !== event.currentTarget || draft) return;
          const rows = virtual.getVirtualItems();
          const visible =
            rows.find((row) => row.end > event.currentTarget.scrollTop) ??
            rows[0];
          const currentWord = transcript.words[focused];
          const currentRow = rows.find(
            (row) =>
              row.index === (currentWord ? wordGroup.get(currentWord.id) : -1),
          );
          const viewportHeight =
            event.currentTarget.clientHeight ||
            event.currentTarget.getBoundingClientRect().height;
          const currentIsVisible =
            currentRow &&
            currentRow.end > event.currentTarget.scrollTop &&
            currentRow.start < event.currentTarget.scrollTop + viewportHeight;
          const current = currentIsVisible
            ? event.currentTarget.querySelector<HTMLButtonElement>(
                `[data-position="${focused}"]`,
              )
            : null;
          const target =
            current ??
            (visible
              ? event.currentTarget.querySelector<HTMLButtonElement>(
                  `[data-index="${visible.index}"] [data-word]`,
                )
              : null);
          if (target) {
            setFocused(Number(target.dataset.position));
            target.focus({ preventScroll: true });
          }
        }}
        aria-label={draft ? t("Transcription in progress") : t("Transcript")}
      >
        <div
          className="transcript-virtual"
          style={{ height: virtual.getTotalSize() }}
        >
          {virtual.getVirtualItems().map((row) => {
            const group = groups[row.index]!;
            if (group.kind === "untimed") {
              const segment = group.segment;
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtual.measureElement}
                  className="transcript-paragraph transcript-untimed"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <span className="paragraph-time">{time(segment.startMs)}</span>
                  <div>
                    <p className={match?.kind === "untimed" && match.row === row.index ? "search-match" : undefined}>
                      {segment.text}
                    </p>
                    <div className="untimed-review">
                      <span>{t("This passage has no word timing. Listen and set a time range.")}</span>
                      <button
                        disabled={draft || !onReviewTimingRange}
                        onClick={() => onReviewTimingRange?.(segment.startMs, segment.endMs)}
                      >
                        {t("Review passage timing")}
                      </button>
                    </div>
                  </div>
                </div>
              );
            }
            const words = group.words;
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtual.measureElement}
                className="transcript-paragraph"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <span className="paragraph-time">
                  {time(words[0]!.startMs)}
                </span>
                <p>
                  {words.map((word) => {
                    const position = index.get(word.id)!;
                    const selected =
                      a >= 0 &&
                      position >= Math.min(a, b) &&
                      position <= Math.max(a, b);
                    const active =
                      currentMs >= word.startMs && currentMs < word.endMs;
                    return (
                      <React.Fragment key={word.id}>
                        <button
                          data-position={position}
                          data-word={word.id}
                          tabIndex={focused === position ? 0 : -1}
                          className={`word${selected ? " selected" : ""}${selected && position === Math.min(a, b) ? " selection-start" : ""}${selected && position === Math.max(a, b) ? " selection-end" : ""}${match?.kind === "timed" && position >= match.start && position <= match.end ? " search-match" : ""}${active ? " playing" : ""}${addedWords.has(word.id) ? " added" : ""}${word.timingNeedsReview ? " timing-review" : ""}`}
                          aria-label={word.timingNeedsReview ? `${word.text} · ${t("Timing needs review")}` : undefined}
                          aria-describedby={word.timingNeedsReview ? timingNoteId : undefined}
                          title={word.timingNeedsReview ? t("Timing needs review") : undefined}
                          aria-pressed={selected}
                          onClick={(e) => {
                            if (!draft && e.detail === 0) {
                              setFocused(position);
                              onSelect(word.id, e.shiftKey);
                            }
                          }}
                          onPointerDown={(e) => {
                            if (!draft && e.button === 0) {
                              dragging.current = true;
                              setFocused(position);
                              onSelect(word.id, e.shiftKey);
                            }
                          }}
                          onDoubleClick={() => {
                            if (!draft) {
                              onSelect(words[0]!.id, false);
                              onSelect(words.at(-1)!.id, true);
                            }
                          }}
                          onPointerEnter={() => {
                            if (dragging.current && !draft)
                              onSelect(word.id, true);
                          }}
                          onKeyDown={(e) => {
                            if (
                              [
                                "ArrowRight",
                                "ArrowLeft",
                                "ArrowDown",
                                "ArrowUp",
                                "Home",
                                "End",
                              ].includes(e.key)
                            ) {
                              e.preventDefault();
                              const target =
                                e.key === "Home"
                                  ? 0
                                  : e.key === "End"
                                    ? transcript.words.length - 1
                                    : ["ArrowUp", "ArrowDown"].includes(e.key)
                                      ? verticalPosition(
                                          position,
                                          e.key === "ArrowUp" ? -1 : 1,
                                        )
                                      : position +
                                        (["ArrowLeft", "ArrowUp"].includes(
                                          e.key,
                                        )
                                          ? -1
                                          : 1);
                              focusWord(target, e.shiftKey);
                            }
                          }}
                        >
                          {word.text}
                        </button>
                        {wordSeparator(
                          word.text,
                          transcript.words[position + 1]?.text,
                        )}
                      </React.Fragment>
                    );
                  })}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

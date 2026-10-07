import { useLocale, LocaleProvider } from "./locale";
import { TranscriptionPanel } from "./TranscriptionPanel";
import { AssemblyScript } from "./AssemblyScript";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ClipDeckAPI,
  Cut,
  EditCommand,
  Job,
  OutputPreset,
  WorkspaceSnapshot,
  CloseAction,
  ClosePreparation,
} from "../shared/contracts";
import {
  selectionToCut,
  selectionBoundaryNeedsTimingReview,
} from "../domain/selection";
import { TranscriptView, type WordSelection } from "./TranscriptView";
import {
  CutInspector,
  JobList,
  RangeEditor,
  cutDraft,
  type CutDraft,
} from "./Panels";
import { Icon } from "./Icon";
import { useSourcePreview } from "./useSourcePreview";
import {
  range,
  RangeInputError,
  assemblyDuration,
  assemblyPosition,
  excerpt,
  message,
  time,
} from "./format";

type DraftProblem = { cutId: string; assetId: string; ordinal: number; field: "start" | "end"; message: string };
class CutDraftFailure extends Error {
  constructor(readonly problem: DraftProblem) { super(problem.message); }
}
type Failure = { message: string; retry: (() => void) | null; retryLabel?: string; cutOrdinal?: number };
type ExportReview = {
  projectId: string;
  revision: number;
  cutCount: number;
  durationMs: number;
  width: number;
  height: number;
};
const isSnapshot = (value: unknown): value is WorkspaceSnapshot =>
  typeof value === "object" &&
  value !== null &&
  "project" in value &&
  "save" in value;
const isWorking = (job: Job) =>
  ["queued", "running", "cancelling"].includes(job.status);
export function App(props: { api?: ClipDeckAPI }) {
  return (
    <LocaleProvider>
      <Workbench {...props} />
    </LocaleProvider>
  );
}
function Workbench({ api = window.clipdeck }: { api?: ClipDeckAPI }) {
  const { t, locale, setLocale } = useLocale();
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null),
    [failure, setFailure] = useState<Failure | null>(null),
    [busy, setBusy] = useState(false),
    [activity, setActivity] = useState<"import" | "open" | null>(null),
    [sourceId, setSourceId] = useState(""),
    [selection, setSelection] = useState<WordSelection | null>(null),
    [cutId, setCutId] = useState(""),
    [view, setView] = useState<"source" | "assembly">("source"),
    [panel, setPanel] = useState<"video" | "inspector">("video"),
    [previewExpanded, setPreviewExpanded] = useState(false),
    [rangeMode, setRangeMode] = useState(false),
    [timingRange, setTimingRange] = useState<{
      assetId: string;
      startMs: number;
      endMs: number;
    } | null>(null),
    [sourcesOpen, setSourcesOpen] = useState(false),
    [queueOpen, setQueueOpen] = useState(false),
    [helpOpen, setHelpOpen] = useState(false),
    [dropActive, setDropActive] = useState(false),
    [currentMs, setCurrentMs] = useState(0),
    [playing, setPlaying] = useState(false),
    [loopingCutId, setLoopingCutId] = useState(""),
    [decodedSource, setDecodedSource] = useState(""),
    [decodeFailure, setDecodeFailure] = useState<{
      key: string;
      message: string;
    } | null>(null),
    [sourceReload, setSourceReload] = useState(0),
    [pendingAudition, setPendingAudition] = useState<{
      cut: Cut;
      repeat: boolean;
      projectId: string;
    } | null>(null),
    [announcement, setAnnouncement] = useState(""),
    [readingMode, setReadingMode] = useState<"source" | "script">("source"),
    [drafts, setDraftsState] = useState<Record<string, CutDraft>>({}),
    [exportReview, setExportReview] = useState<ExportReview | null>(null),
    [completedExport, setCompletedExport] = useState<Job | null>(null),
    [settingsRequest, setSettingsRequest] = useState(0),
    [correctionOpen, setCorrectionOpen] = useState(false),
    [corrections, setCorrections] = useState<Record<string, string>>({}),
    [closing, setClosing] = useState(false),
    [draftProblem, setDraftProblem] = useState<(DraftProblem & { request: number }) | null>(null);
  const closingRef = useRef(false);
  const projectNameInput = useRef<HTMLInputElement>(null);
  const closeHandler = useRef<(action: CloseAction) => Promise<ClosePreparation>>(async () => ({ ready: false, locale: "en" }));
  const workspaceRef = useRef<WorkspaceSnapshot | null>(null);
  const draftsRef = useRef<Record<string, CutDraft>>({});
  function setDrafts(update: React.SetStateAction<Record<string, CutDraft>>) {
    const next =
      typeof update === "function" ? update(draftsRef.current) : update;
    if (next !== draftsRef.current) setAnnouncement("");
    draftsRef.current = next;
    setDraftsState(next);
  }
  const errorRef = useRef<HTMLDivElement>(null),
    video = useRef<HTMLVideoElement>(null),
    rejectedVideoKey = useRef(""),
    previousSourceMedia = useRef<{ identity: string; url: string | null }>({
      identity: "",
      url: null,
    }),
    auditionEnd = useRef<number | null>(null),
    auditionLoop = useRef<{
      startMs: number;
      cutId: string;
      assetId: string;
    } | null>(null),
    dragCut = useRef<string | null>(null),
    pendingSeek = useRef<number | null>(null),
    pendingPlay = useRef(false),
    busyRef = useRef(false);
  const revealDraft = useCallback((problem: DraftProblem) => {
    setPreviewExpanded(false);
    setSourceId(problem.assetId);
    setCutId(problem.cutId);
    setView("source");
    setReadingMode("source");
    setRangeMode(false);
    setPanel("inspector");
    setDraftProblem((previous) => ({ ...problem, request: (previous?.request ?? 0) + 1 }));
  }, []);
  const accept = useCallback((next: WorkspaceSnapshot) => {
    const previous = workspaceRef.current;
    if (previous && (next.project.id !== previous.project.id || next.project.revision !== previous.project.revision))
      setAnnouncement("");
    if (previous?.project.id === next.project.id && next.transcriptVersions) {
      const transcripts = new Map(
        previous.project.transcripts.map((transcript) => [transcript.assetId, transcript]),
      );
      // IPC copies invalidate reading memoization even when the main-owned
      // transcript is unchanged. Reopen and recognition create new tokens.
      next = {
        ...next,
        project: {
          ...next.project,
          transcripts: next.project.transcripts.map((transcript) => {
            const version = next.transcriptVersions?.[transcript.assetId];
            return version && version === previous.transcriptVersions?.[transcript.assetId]
              ? (transcripts.get(transcript.assetId) ?? transcript)
              : transcript;
          }),
        },
      };
    }
    workspaceRef.current = next;
    setSnapshot(next);
  }, []);
  const run = useCallback(
    async <T,>(
      task: () => Promise<T>,
      options: { blocking?: boolean; success?: string; activity?: "import" | "open" } = {},
    ): Promise<T | undefined> => {
      if (closingRef.current || (options.blocking && busyRef.current)) return;
      if (options.blocking) {
        busyRef.current = true;
        setBusy(true);
        setActivity(options.activity ?? null);
      }
      setFailure(null);
      try {
        const result = await task();
        if (isSnapshot(result)) {
          accept(result);
          if (
            options.success &&
            result.save.displayName &&
            !result.save.dirty &&
            !result.save.error
          )
            setAnnouncement(options.success);
        }
        return result;
      } catch (error) {
        setPreviewExpanded(false);
        setFailure(error instanceof CutDraftFailure ? {
          message: "Review this cut's range before saving.",
          cutOrdinal: error.problem.ordinal,
          retryLabel: "Review edit",
          retry: () => revealDraft(error.problem),
        } : {
          message: message(error),
          retry: () => { void run(task, options); },
        });
        return undefined;
      } finally {
        if (options.blocking) {
          busyRef.current = false;
          setBusy(false);
          setActivity(null);
        }
      }
    },
    [accept, revealDraft],
  );
  useEffect(() => {
    if (!api) {
      setFailure({
        message:
          "The desktop connection is unavailable. Open ClipDeck in the desktop app.",
        retry: null,
      });
      return;
    }
    let live = true;
    let received = false;
    const unsubscribe = api.subscribe((next) => {
      received = true;
      if (live) accept(next);
    });
    api
      .getSnapshot()
      .then((next) => {
        if (live && !received) accept(next);
      })
      .catch((error) => {
        if (live)
          setFailure({
            message: message(error),
            retry: () => {
              void run(() => api.getSnapshot());
            },
          });
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [api, accept, run]);
  useEffect(() => {
    if (api) return api.onCloseRequested((action) => closeHandler.current(action));
  }, [api]);
  useEffect(() => {
    if (failure && !failure.cutOrdinal) errorRef.current?.focus({ preventScroll: true });
  }, [failure]);
  const project = snapshot?.project;
  const asset =
    project?.assets.find((a) => a.id === sourceId) ?? project?.assets[0];
  const sourcePreview = useSourcePreview(api, snapshot, asset);
  const sourceVideoKey = `${sourcePreview.key}-${asset?.mediaUrl ?? ""}-${sourceReload}`;
  const sourceReady =
    !!asset?.mediaUrl &&
    asset.status === "ready" &&
    decodedSource === sourceVideoKey;
  const sourceVideoError =
    decodeFailure?.key === sourceVideoKey ? decodeFailure.message : null;
  const transcript = project?.transcripts.find(
    (t) => t.assetId === asset?.id && t.fingerprint === asset?.fingerprint,
  );
  const transcriptOrigin =
    transcript?.originId && !transcript.originId.startsWith("legacy-")
      ? transcript.originId
      : `${transcript?.words[0]?.id}-${transcript?.words.at(-1)?.id}`;
  const draft = snapshot?.transcriptionDrafts?.[asset?.id ?? ""];
  const cuts = useMemo(() => {
    const byId = new Map(project?.cuts.map((c) => [c.id, c]));
    return project?.cutOrder.map((id) => byId.get(id)!).filter(Boolean) ?? [];
  }, [project?.cuts, project?.cutOrder]);
  const selectedCut = cuts.find((c) => c.id === cutId);
  const sourceJob = snapshot?.jobs.find(
    (j) =>
      j.assetId === asset?.id && j.kind === "transcription" && isWorking(j),
  );
  const activeJobs = snapshot?.jobs.filter(isWorking) ?? [];
  const blocked = cuts.some(
    (c) =>
      c.needsReview ||
      !project?.assets.some(
        (a) =>
          a.id === c.assetId &&
          a.status === "ready" &&
          a.fingerprint === c.fingerprint,
      ),
  );
  const previewJob = snapshot?.jobs.findLast(
    (j) =>
      j.kind === "preview" &&
      j.status === "completed" &&
      j.outputUrl &&
      j.projectId === project?.id &&
      j.projectRevision === project?.revision,
  );
  const previewUrl = !blocked ? previewJob?.outputUrl : null;
  const playbackPosition =
    view === "assembly" && previewUrl
      ? assemblyPosition(cuts, currentMs)
      : null;
  const preparingPreview = activeJobs.find((j) => j.kind === "preview");
  const previewBusy = !!preparingPreview;
  const exportBusy = activeJobs.some((j) => j.kind === "export");
  const addedWords = useMemo(
    () =>
      new Set(
        cuts
          .filter((c) => c.assetId === asset?.id && !c.needsReview)
          .flatMap((c) => c.wordIds),
      ),
    [cuts, asset?.id],
  );
  const selectedWords = useMemo(() => {
    if (!selection || !transcript) return [];
    const a = transcript.words.findIndex((w) => w.id === selection.anchor),
      b = transcript.words.findIndex((w) => w.id === selection.focus);
    return a >= 0 && b >= 0
      ? transcript.words.slice(Math.min(a, b), Math.max(a, b) + 1)
      : [];
  }, [selection, transcript]);
  const selectionEnd = selectedWords.reduce(
    (end, w) => Math.max(end, w.endMs),
    0,
  );
  const selectionDuration = selectedWords.length
    ? selectionEnd - selectedWords[0]!.startMs
    : 0;
  const inspectingSelection = !!selectedCut && selectedCut.assetId === asset?.id &&
    selectedCut.transcriptRevision === transcript?.revision && selectedWords.length > 0 &&
    selectedCut.wordIds.length === selectedWords.length &&
    selectedCut.wordIds.every((id, index) => id === selectedWords[index]?.id);
  const selectionAction = inspectingSelection ? "Add another cut" : "Add selection";
  const savedAnnouncement = announcement === "Project saved." || announcement === "Project copy saved.";
  const selectionTimingUnsafe = selectionBoundaryNeedsTimingReview(selectedWords);
  const selectionHasTimingIssues = selectedWords.some((w) => w.timingNeedsReview);
  const currentTimingRange = timingRange?.assetId === asset?.id ? timingRange : null;
  useEffect(() => {
    setSelection(null);
    setCorrectionOpen(false);
    setCurrentMs(0);
    setRangeMode(false);
    setTimingRange(null);
    setView("source");
    setPlaying(false);
    stopAudition(true);
    pendingSeek.current = null;
  }, [
    asset?.id,
    asset?.status,
    asset?.fingerprint,
    project?.id,
  ]);
  useEffect(() => {
    // New recognition replaces word IDs, but the source and the user's editing
    // workspace remain the same. Only selections tied to those words expire.
    setSelection(null);
    setCorrectionOpen(false);
  }, [transcriptOrigin]);
  useEffect(() => {
    if (view !== "source" || !asset?.mediaUrl || asset.status !== "ready")
      return;
    const element = video.current;
    if (!element) return;
    let live = true;
    let frame = 0;
    setDecodedSource("");
    setDecodeFailure(null);
    rejectedVideoKey.current = "";
    let decoded = false,
      seekVerified = false,
      probeStarted = false;
    let restoreTime = 0;
    const fail = () => {
      if (!live || video.current !== element || rejectedVideoKey.current === sourceVideoKey)
        return;
      rejectedVideoKey.current = sourceVideoKey;
      stopAudition(true);
      setPendingAudition(null);
      pendingSeek.current = null;
      setDecodedSource("");
      const fallback = sourcePreview.fallback();
      setDecodeFailure({
        key: sourceVideoKey,
        message: fallback
          ? "Preparing a compatible preview. Text editing stays available."
          : "This video could not be decoded or seeked. Retry source preview or relink the recording.",
      });
    };
    const timeout = window.setTimeout(fail, 15000);
    const ready = () => {
      if (
        !live ||
        video.current !== element ||
        rejectedVideoKey.current === sourceVideoKey ||
        !decoded ||
        !seekVerified
      )
        return;
      window.clearTimeout(timeout);
      setDecodedSource(sourceVideoKey);
      setDecodeFailure(null);
      if (pendingPlay.current) {
        pendingPlay.current = false;
        void element
          .play()
          .catch((error) =>
            setFailure({ message: message(error), retry: null }),
          );
      }
    };
    const onSeeked = () => {
      if (
        seekVerified ||
        !probeStarted ||
        element.seeking ||
        !Number.isFinite(element.currentTime) ||
        element.currentTime < 0 ||
        element.currentTime > asset.durationMs / 1000
      )
        return;
      seekVerified = true;
      if (
        Math.abs(element.currentTime - restoreTime) <= 0.0015 &&
        element.currentTime !== restoreTime
      )
        element.currentTime = restoreTime;
      ready();
    };
    element.addEventListener("seeked", onSeeked);
    const checkFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (
        !live ||
        video.current !== element ||
        rejectedVideoKey.current === sourceVideoKey
      )
        return;
      if (
        element.videoWidth > 0 &&
        element.videoHeight > 0 &&
        metadata.width > 0 &&
        metadata.height > 0
      ) {
        decoded = true;
        if (!probeStarted) {
          restoreTime =
            pendingSeek.current !== null
              ? pendingSeek.current / 1000
              : element.currentTime;
          pendingSeek.current = null;
          probeStarted = true;
          // A real current-URL seek must complete, even when the requested position is zero.
          const probe =
            restoreTime === element.currentTime
              ? Math.min((asset.durationMs - 1) / 1000, restoreTime + 0.001)
              : restoreTime;
          element.currentTime = Math.max(0, probe);
        }
        ready();
      } else frame = element.requestVideoFrameCallback(checkFrame);
    };
    frame = element.requestVideoFrameCallback(checkFrame);
    return () => {
      live = false;
      window.clearTimeout(timeout);
      element.cancelVideoFrameCallback(frame);
      element.removeEventListener("seeked", onSeeked);
      element.pause();
      pendingPlay.current = false;
      auditionEnd.current = null;
      auditionLoop.current = null;
      pendingSeek.current = null;
    };
  }, [sourceVideoKey, view, asset?.status]);
  useEffect(() => {
    const previous = previousSourceMedia.current;
    if (
      previous.identity === sourcePreview.key &&
      previous.url &&
      previous.url !== asset?.mediaUrl
    ) {
      stopAudition(true);
      setPendingAudition(null);
      pendingSeek.current = null;
      setCurrentMs(0);
    }
    previousSourceMedia.current = {
      identity: sourcePreview.key,
      url: asset?.mediaUrl ?? null,
    };
    setPlaying(false);
    setLoopingCutId("");
  }, [sourceVideoKey]);
  useEffect(() => {
    stopAudition();
  }, [view, cutId, selectedCut?.startMs, selectedCut?.endMs]);
  useEffect(() => {
    if (snapshot?.save.error) setAnnouncement("");
  }, [snapshot?.save.error]);
  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(""), 5000);
    return () => window.clearTimeout(timer);
  }, [announcement]);
  const overlay = helpOpen ? ".shortcuts-panel" : exportReview ? ".export-summary:not(.completed-export)" :
    completedExport ? ".completed-export" : correctionOpen ? ".correction-panel" : previewExpanded ? ".preview-expanded" : null;
  useEffect(() => {
    if (!overlay) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = document.querySelector<HTMLElement>(overlay);
    (element?.querySelector<HTMLElement>("[data-overlay-initial-focus]") ?? element?.querySelector<HTMLElement>("input:not(:disabled)") ?? element?.querySelector<HTMLElement>("button:not(:disabled),[tabindex='0']"))?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [overlay]);
  useEffect(() => {
    if (view === "assembly" && !previewUrl) {
      video.current?.pause();
      setPlaying(false);
    }
  }, [previewUrl, view]);
  useEffect(() => {
    if (!playing || view !== "source") return;
    let frame = 0;
    const stopAtBoundary = () => {
      if (checkAuditionBoundary()) return;
      frame = requestAnimationFrame(stopAtBoundary);
    };
    frame = requestAnimationFrame(stopAtBoundary);
    return () => cancelAnimationFrame(frame);
  }, [playing, view]);
  async function openProject() {
    const current = await flushDrafts();
    const untouchedNewWorkspace =
      current.project.revision === 0 &&
      current.project.name === "Untitled project" &&
      current.project.assets.length === 0 &&
      current.project.transcripts.length === 0 &&
      current.project.cuts.length === 0 &&
      current.project.cutOrder.length === 0 &&
      current.project.savedAt === null &&
      current.save.displayName === null &&
      !current.save.recovered &&
      !current.save.error &&
      !current.canUndo &&
      !current.canRedo;
    // Native marks a never-saved initial workspace dirty despite no user edits.
    if (!untouchedNewWorkspace && (current.save.dirty || current.save.error)) {
      const saved = await api.saveProject();
      const latest = workspaceRef.current;
      if (
        latest?.project.id !== current.project.id ||
        (latest?.project.revision ?? 0) > saved.project.revision
      )
        throw new Error(
          "The project changed while saving. Save the latest edits before opening another project.",
        );
      accept(saved);
      if (saved.save.error || saved.save.dirty || !saved.save.displayName)
        throw new Error(
          "Save the current project before opening another project.",
        );
    }
    if (Object.keys(draftsRef.current).length)
      throw new Error(
        "New edits were entered while saving. Save them before opening another project.",
      );
    const next = await api.openProject();
    sourcePreview.reset();
    setPendingAudition(null);
    return next;
  }
  async function relinkSource(id: string) {
    const next = await api.relinkMedia(id);
    sourcePreview.reset();
    return next;
  }
  async function flushDrafts() {
    const name = projectNameInput.current?.value.trim();
    const currentProject = workspaceRef.current?.project;
    if (name === "") throw new Error("Project name cannot be empty.");
    if (name && currentProject && name !== currentProject.name)
      accept(await api.applyEdit({ type: "renameProject", name }));
    if (correctionOpen && transcript) {
      const changes = Object.entries(corrections)
        .filter(([id, text]) => transcript.words.find((w) => w.id === id)?.text !== text)
        .map(([wordId, text]) => {
          if (!text.trim()) throw new Error("Corrected words cannot be empty.");
          const prefix = /^\s+/.exec(transcript.words.find((w) => w.id === wordId)?.text ?? "")?.[0] ?? "";
          return { wordId, text: prefix && !/^\s/.test(text) ? prefix + text : text };
        });
      if (changes.length)
        accept(await api.applyEdit({ type: "correctTranscript", assetId: transcript.assetId,
          fingerprint: transcript.fingerprint, transcriptRevision: transcript.revision, changes }));
      setCorrectionOpen(false);
    }
    for (const [id, draft] of Object.entries(draftsRef.current)) {
      const current = workspaceRef.current;
      const cut = current?.project.cuts.find((c) => c.id === id);
      if (!cut) continue;
      const source = current?.project.assets.find((a) => a.id === cut.assetId);
      if (!source)
        throw new Error("Relink this source before applying its draft.");
      let bounds: ReturnType<typeof range>;
      try { bounds = range(draft.start, draft.end, source.durationMs); }
      catch (error) {
        if (!(error instanceof RangeInputError)) throw error;
        const problem = { cutId: id, assetId: source.id, ordinal: current!.project.cutOrder.indexOf(id) + 1,
          field: error.field, message: error.message };
        revealDraft(problem);
        throw new CutDraftFailure(problem);
      }
      accept(
        await api.applyEdit({
          type: "updateCut",
          cutId: id,
          changes: {
            ...bounds,
            note: draft.note,
            ...(draft.text !== draft.baseText ? { text: draft.text } : {}),
          },
        }),
      );
      setDrafts((old) => {
        if (old[id] !== draft) return old;
        const next = { ...old };
        delete next[id];
        return next;
      });
    }
    if (Object.keys(draftsRef.current).length)
      throw new Error(
        "New edits arrived while applying changes. Review them and try again.",
      );
    if (!workspaceRef.current) throw new Error("The workspace is not ready.");
    return workspaceRef.current;
  }
  closeHandler.current = async (action) => {
    if (action === "resume") {
      closingRef.current = false;
      setClosing(false);
      return { ready: true, locale };
    }
    closingRef.current = true;
    setClosing(true);
    if (busyRef.current || !workspaceRef.current)
      return { ready: false, locale, error: t("Another operation is still running. Wait for it to finish, then close again.") };
    if (action === "discard") {
      setDrafts({});
      setCorrections({});
      setCorrectionOpen(false);
      if (projectNameInput.current) projectNameInput.current.value = workspaceRef.current.project.name;
      return { ready: true, locale };
    }
    try {
      await flushDrafts();
      return { ready: true, locale };
    } catch (error) {
      return { ready: false, locale,
        canDiscard: Object.keys(draftsRef.current).length > 0 || correctionOpen || projectNameInput.current?.value !== workspaceRef.current.project.name,
        error: t(message(error)) };
    }
  };
  async function reviewExport() {
    await run(
      async () => {
        setExportReview(null);
        const current = await flushDrafts();
        const byId = new Map(current.project.cuts.map((c) => [c.id, c]));
        const ordered = current.project.cutOrder
          .map((id) => byId.get(id)!)
          .filter(Boolean);
        setExportReview({
          projectId: current.project.id,
          revision: current.project.revision,
          cutCount: ordered.length,
          durationMs: assemblyDuration(ordered),
          width: current.project.output.width,
          height: current.project.output.height,
        });
      },
      { blocking: true },
    );
  }
  async function saveProject(asNew = false) {
    await flushDrafts();
    return api.saveProject(asNew);
  }
  useEffect(() => {
    setDrafts({});
    setReadingMode("source");
    setCompletedExport(null);
    setExportReview(null);
  }, [project?.id]);
  useEffect(() => {
    setDrafts((old) => {
      const ids = new Set(cuts.map((c) => c.id));
      const entries = Object.entries(old).filter(([id]) => ids.has(id));
      return entries.length === Object.keys(old).length
        ? old
        : Object.fromEntries(entries);
    });
  }, [project?.cuts]);
  function edit(command: EditCommand) {
    return run(() => api.applyEdit(command), { blocking: true });
  }
  function stopAudition(forcePause = false) {
    pendingPlay.current = false;
    const wasAuditioning =
      auditionEnd.current !== null || auditionLoop.current !== null;
    auditionEnd.current = null;
    auditionLoop.current = null;
    if (wasAuditioning || forcePause) {
      video.current?.pause();
      setPlaying(false);
    }
    setLoopingCutId("");
  }
  function checkAuditionBoundary(restartAtMediaEnd = false) {
    const element = video.current;
    if (
      !element ||
      (element.paused && !(restartAtMediaEnd && element.ended)) ||
      auditionEnd.current === null ||
      element.currentTime * 1000 < auditionEnd.current
    )
      return false;
    const loop = auditionLoop.current;
    if (
      loop &&
      view === "source" &&
      element.dataset.assetId === loop.assetId &&
      loop.cutId === cutId
    ) {
      const needsRestart = element.paused && restartAtMediaEnd && element.ended;
      element.currentTime = loop.startMs / 1000;
      setCurrentMs(loop.startMs);
      if (needsRestart)
        void element.play().catch((error) => {
          stopAudition(true);
          setFailure({ message: message(error), retry: null });
        });
      return false;
    }
    const end = auditionEnd.current;
    element.pause();
    element.currentTime = end / 1000;
    setCurrentMs(end);
    auditionEnd.current = null;
    return true;
  }
  function startCutAudition(repeat: boolean) {
    if (!selectedCut) return;
    chooseSource(selectedCut.assetId);
    setPendingAudition({ cut: selectedCut, repeat, projectId: project!.id });
  }
  useEffect(() => {
    if (!pendingAudition) return;
    const { cut: requestedCut, repeat } = pendingAudition;
    const cut = selectedCut;
    if (
      !cut ||
      cut.id !== requestedCut.id ||
      cut.assetId !== requestedCut.assetId ||
      cut.fingerprint !== requestedCut.fingerprint ||
      cut.startMs !== requestedCut.startMs ||
      cut.endMs !== requestedCut.endMs ||
      cut.needsReview ||
      view !== "source" ||
      asset?.id !== cut.assetId ||
      asset.status !== "ready" ||
      cutId !== cut.id ||
      pendingAudition.projectId !== project?.id ||
      cut.fingerprint !== asset.fingerprint
    ) {
      setPendingAudition(null);
      return;
    }
    if (!sourceReady) return;
    setPendingAudition(null);
    seek(cut.startMs, true, cut.endMs, cut.assetId, repeat ? cut.id : null);
  }, [
    pendingAudition,
    view,
    asset?.id,
    asset?.status,
    asset?.fingerprint,
    cutId,
    sourceReady,
    project?.id,
    selectedCut,
  ]);
  function chooseSource(id: string) {
    stopAudition();
    setPendingAudition(null);
    video.current?.pause();
    setPlaying(false);
    pendingSeek.current = null;
    pendingPlay.current = false;
    setSourceId(id);
    setView("source");
    setReadingMode("source");
    setPanel("video");
    setSourcesOpen(false);
  }
  function seek(
    ms: number,
    play = false,
    end: number | null = null,
    targetAssetId = asset?.id,
    repeatCutId: string | null = null,
  ) {
    setPendingAudition(null);
    stopAudition();
    if (view !== "source") setPlaying(false);
    setView("source");
    setPanel("video");
    setCurrentMs(ms);
    pendingSeek.current = ms;
    pendingPlay.current = play;
    auditionEnd.current = end;
    auditionLoop.current =
      repeatCutId && targetAssetId
        ? { startMs: ms, cutId: repeatCutId, assetId: targetAssetId }
        : null;
    setLoopingCutId(repeatCutId ?? "");
    const el = video.current;
    if (
      el &&
      view === "source" &&
      el.dataset.assetId === targetAssetId &&
      el.readyState >= 1
    ) {
      el.currentTime = ms / 1000;
      pendingSeek.current = null;
      if (play && sourceReady) {
        pendingPlay.current = false;
        void el
          .play()
          .catch((e) => setFailure({ message: message(e), retry: null }));
      }
    }
  }
  function selectWord(id: string, extend: boolean) {
    if (!transcript || asset?.status !== "ready") return;
    setSelection((old) => ({
      anchor: extend && old ? old.anchor : id,
      focus: id,
    }));
    if (!extend) {
      const word = transcript.words.find((w) => w.id === id);
      if (word) seek(word.startMs);
    }
  }
  async function addSelection() {
    if (rangeMode || readingMode !== "source") return;
    if (
      !asset ||
      asset.status !== "ready" ||
      !transcript ||
      !selection ||
      !selectedWords.length ||
      busyRef.current
    ) {
      setSelection(null);
      return;
    }
    if (selectionTimingUnsafe) {
      setAnnouncement(t("Word timing needs review; select a time range instead."));
      return;
    }
    let addedId = "";
    const result = await run(
      async () => {
        try {
          const cut = {
            ...selectionToCut(
              { ...asset, fileRef: "" },
              transcript.words,
              selection.anchor,
              selection.focus,
            ),
            id: crypto.randomUUID(),
            transcriptRevision: transcript.revision,
          };
          addedId = cut.id;
          return await api.applyEdit({ type: "addCut", cut });
        } catch (error) {
          setSelection(null);
          throw error;
        }
      },
      { blocking: true },
    );
    if (result) {
      setCutId(addedId);
      setAnnouncement(
        `${t("Added cut")} ${result.project.cutOrder.length} · ${time(selectionDuration, true)}`,
      );
    }
  }
  async function addRange(startMs: number, endMs: number) {
    if (!asset) return;
    const cut: Cut = {
      id: crypto.randomUUID(),
      assetId: asset.id,
      fingerprint: asset.fingerprint,
      transcriptRevision: null,
      startMs,
      endMs,
      wordIds: [],
      text: "",
      note: "",
      needsReview: false,
    };
    const result = await edit({ type: "addCut", cut });
    if (result) {
      setCutId(cut.id);
      setAnnouncement(
        `${t("Added cut")} ${result.project.cutOrder.length} · ${time(endMs - startMs, true)}`,
      );
    }
  }
  function reviewTimingWindow(fromMs: number, toMs: number) {
    if (!asset || asset.status !== "ready") return;
    // This is an editable listening window, not a replacement word alignment.
    const startMs = Math.max(0, fromMs - 2000);
    const endMs = Math.min(asset.durationMs, toMs + 2000);
    setTimingRange({ assetId: asset.id, startMs, endMs });
    setRangeMode(true);
    setView("source");
    setPanel("video");
    seek(startMs);
  }
  function reviewSelectionTiming() {
    if (selectedWords.length)
      reviewTimingWindow(selectedWords[0]!.startMs, selectionEnd);
  }
  function auditionSelection() {
    if (selectionTimingUnsafe) {
      setAnnouncement(t("Word timing needs review; select a time range instead."));
      return;
    }
    if (selectedWords.length)
      seek(selectedWords[0]!.startMs, true, selectionEnd);
  }
  function inspectCut(cut: Cut) {
    if (readingMode === "script") {
      setCutId(cut.id);
      setPanel("inspector");
      return;
    }
    chooseSource(cut.assetId);
    setCutId(cut.id);
    setPanel("inspector");
    const t = project?.transcripts.find((t) => t.assetId === cut.assetId);
    setTimeout(() => {
      seek(cut.startMs, false, null, cut.assetId);
      setPanel("inspector");
      if (cut.wordIds.length && t?.revision === cut.transcriptRevision)
        setSelection({ anchor: cut.wordIds[0]!, focus: cut.wordIds.at(-1)! });
    }, 0);
  }
  function moveCut(id: string, delta: number) {
    if (!project) return;
    const ids = [...project.cutOrder],
      from = ids.indexOf(id),
      to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(from, 1);
    ids.splice(to, 0, id);
    void edit({ type: "reorderCuts", cutIds: ids });
  }
  function dropCut(target: string) {
    const from = dragCut.current;
    dragCut.current = null;
    if (!project || !from || from === target) return;
    const ids = project.cutOrder.filter((id) => id !== from);
    ids.splice(ids.indexOf(target), 0, from);
    void edit({ type: "reorderCuts", cutIds: ids });
  }
  async function preparePreview() {
    if (view !== "assembly") setCurrentMs(0);
    setView("assembly");
    setPanel("video");
    await run(
      async () => {
        await flushDrafts();
        return api.preparePreview();
      },
      { blocking: true },
    );
  }
  function showModelSettings() {
    if (asset) {
      setRangeMode(false);
      setReadingMode("source");
      setSettingsRequest((n) => n + 1);
    }
    setQueueOpen(false);
  }
  function retryJob(job: Job) {
    if (job.kind === "transcription" && job.assetId) {
      chooseSource(job.assetId);
      setRangeMode(false);
      setQueueOpen(false);
    } else if (job.kind === "modelDownload") showModelSettings();
    else if (job.kind === "sourcePreview" && job.assetId) {
      void sourcePreview.request(job.assetId);
    } else if (job.kind === "preview") void preparePreview();
    else if (job.kind === "export")
      void run(
        async () => {
          await flushDrafts();
          return api.exportVideo();
        },
        { blocking: true },
      );
  }
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (closingRef.current) { event.preventDefault(); return; }
      if (event.key === "Escape") {
        event.preventDefault();
        if (helpOpen) setHelpOpen(false);
        else if (exportReview) setExportReview(null);
        else if (completedExport) setCompletedExport(null);
        else if (correctionOpen) { if (!busyRef.current) setCorrectionOpen(false); }
        else if (previewExpanded) setPreviewExpanded(false);
        else if (queueOpen) setQueueOpen(false);
        else if (sourcesOpen) setSourcesOpen(false);
        else setSelection(null);
        return;
      }
      const input =
        event.target instanceof HTMLElement &&
        !!event.target.closest(
          'input,textarea,select,[contenteditable="true"]',
        );
      if (previewExpanded && event.key === "Tab") {
        const controls = Array.from(document.querySelectorAll<HTMLElement>(
          ".preview-expanded button:not(:disabled),.preview-expanded input:not(:disabled)",
        ));
        const first = controls[0], last = controls.at(-1);
        if (first && last && ((event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last) ||
          !controls.includes(document.activeElement as HTMLElement))) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void run(() => saveProject(event.shiftKey), {
          blocking: true,
          success: "Project saved.",
        });
      } else if (overlay) {
        return;
      } else if (
        !input &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        if (event.shiftKey ? snapshot?.canRedo : snapshot?.canUndo)
          void edit({ type: event.shiftKey ? "redo" : "undo" });
      } else if (
        !input &&
        !event.metaKey &&
        !event.ctrlKey &&
        event.key.toLowerCase() === "e"
      ) {
        event.preventDefault();
        void addSelection();
      } else if (
        !input &&
        event.code === "Space" &&
        (event.target === document.body ||
          (event.target instanceof HTMLElement &&
            !!event.target.closest(".word,.assembly-cut,.transcript-scroll")))
      ) {
        event.preventDefault();
        togglePlayback();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  });
  function togglePlayback() {
    const el = video.current;
    if (!el || (view === "source" && !sourceReady)) return;
    if (el.paused)
      void el
        .play()
        .catch((error) => setFailure({ message: message(error), retry: null }));
    else el.pause();
  }
  const displayedUrl =
    view === "source"
      ? asset?.status === "ready"
        ? asset.mediaUrl
        : null
      : previewUrl;
  const duration =
    view === "source" ? (asset?.durationMs ?? 0) : assemblyDuration(cuts);
  function onTime() {
    const el = video.current;
    if (!el) return;
    const ms = el.currentTime * 1000;
    setCurrentMs(ms);
    if (view === "source") checkAuditionBoundary();
  }
  return (
    <div
      inert={closing || undefined}
      className={`app${sourcesOpen ? " sources-open" : ""}${cuts.length ? " has-cuts" : " empty-assembly"}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDropActive(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node))
          setDropActive(false);
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          setDropActive(false);
          void run(
            () => api.importDroppedFiles(Array.from(e.dataTransfer.files)),
            { blocking: true, activity: "import" },
          );
        }
      }}
    >
      <header className="project-toolbar" inert={previewExpanded || undefined}>
        <div className="brand">
          <Icon name="scissors" />
          <span>{t("ClipDeck")}</span>
        </div>
        <div className="project-identity">
          <input
            ref={projectNameInput}
            aria-label={t("Project name")}
            key={`${project?.id}-${project?.name}`}
            defaultValue={project?.name ?? "Loading workspace"}
            disabled={!project || busy}
            onBlur={(e) => {
              const name = e.target.value.trim();
              if (name && name !== project?.name)
                void edit({ type: "renameProject", name });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <span className="save-state">
            {snapshot?.save.error
              ? t("Save needs attention")
              : Object.keys(drafts).length
                ? t("Unapplied edits \u00b7 save to apply")
                : snapshot?.save.recovered
                  ? snapshot.save.dirty
                    ? `${t("Recovered project")} · ${t("Unsaved changes")}`
                    : t("Recovered project")
                  : snapshot?.save.dirty
                    ? t("Unsaved changes")
                    : snapshot?.save.displayName
                      ? t("Saved locally")
                      : t("Local project")}
          </span>
          {Object.keys(drafts).length > 0 && (
            <button className="draft-link" onClick={() => {
              const id = Object.keys(drafts)[0]!;
              const cut = project?.cuts.find((cut) => cut.id === id);
              if (cut) inspectCut(cut);
            }}>{t("Review edit")}</button>
          )}
        </div>
        <div className="toolbar-actions">
          <select
            className="locale-select"
            aria-label={t("Interface language")}
            value={locale}
            onChange={(e) => setLocale(e.target.value as "en" | "zh")}
          >
            <option value="en">{t("EN")}</option>
            <option value="zh">中文</option>
          </select>
          <button
            aria-label={t("Open project")}
            title={t("Open project")}
            disabled={busy || !snapshot?.capabilities.persistence}
            onClick={() => void run(() => openProject(), { blocking: true, activity: "open" })}
          >
            <Icon name="folder" />
            <span className="wide-label">{t(activity === "open" ? "Opening…" : "Open")}</span>
          </button>
          <button
            aria-label={t("Save project")}
            title={t(
              "Save project (\u2318S) \u00b7 Project files reference original media; they do not contain videos.",
            )}
            disabled={busy || !snapshot?.capabilities.persistence}
            onClick={() =>
              void run(() => saveProject(), {
                blocking: true,
                success: "Project saved.",
              })
            }
          >
            <Icon name="save" />
            <span className="wide-label">{t("Save")}</span>
          </button>
          <button
            className="save-as"
            title={t("Save a copy (\u21e7\u2318S)")}
            disabled={busy || !snapshot?.capabilities.persistence}
            onClick={() =>
              void run(() => saveProject(true), {
                blocking: true,
                success: "Project copy saved.",
              })
            }
          >
            {t("Save as")}
          </button>
          <span className="toolbar-divider" />
          <button
            aria-label={t("Undo")}
            title={t("Undo (\u2318Z)")}
            disabled={busy || !snapshot?.canUndo}
            onClick={() => void edit({ type: "undo" })}
          >
            <Icon name="undo" />
          </button>
          <button
            aria-label={t("Redo")}
            title={t("Redo (\u21e7\u2318Z)")}
            disabled={busy || !snapshot?.canRedo}
            onClick={() => void edit({ type: "redo" })}
          >
            <Icon name="redo" />
          </button>
          <button
            className="primary export-button"
            disabled={
              busy ||
              !cuts.length ||
              blocked ||
              exportBusy ||
              !snapshot?.capabilities.rendering
            }
            onClick={() => void reviewExport()}
          >
            <Icon name="export" />
            {exportBusy ? t("Exporting\u2026") : t("Export video")}
          </button>
        </div>
      </header>
      {failure && (
        <div className="error-banner" role="alert" tabIndex={-1} ref={errorRef}>
          <span>{failure.cutOrdinal ? `${t("Cut")} ${failure.cutOrdinal} · ` : ""}{t(failure.message)}</span>
          {failure.retry && (
            <button onClick={failure.retry}>{t(failure.retryLabel ?? "Retry")}</button>
          )}
          <button
            aria-label={t("Dismiss error")}
            onClick={() => setFailure(null)}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {!!snapshot?.importFailures?.length && (
        <section
          className="import-errors"
          role="alert"
          aria-label={t("Videos not imported")}
        >
          <div>
            <strong>{t("Videos not imported")}</strong>
            <ul>
              {snapshot.importFailures.map((failure, index) => (
                <li key={`${index}-${failure.name}`}>
                  <strong>{failure.name}</strong>: {t(failure.message)}
                </li>
              ))}
            </ul>
          </div>
          <button
            disabled={busy || !snapshot.capabilities.media}
            onClick={() =>
              void run(() => api.importMedia(), { blocking: true, activity: "import" })
            }
          >
            {t("Choose videos again")}
          </button>
        </section>
      )}
      {!!snapshot?.cleanupWarnings?.length && (
        <div className="error-banner" role="alert">
          <span>{snapshot.cleanupWarnings.map(t).join(" ")}</span>
        </div>
      )}
      {snapshot?.save.error && (
        <div className="error-banner save-error" role="alert">
          <span>{snapshot.save.error}</span>
          <button
            disabled={busy || !snapshot.capabilities.persistence}
            onClick={() =>
              void run(() => saveProject(true), {
                blocking: true,
                success: "Recovery copy saved.",
              })
            }
          >
            {t("Save a recovery copy")}
          </button>
          <button
            disabled={busy || !snapshot.capabilities.persistence}
            onClick={() => void run(() => openProject(), { blocking: true })}
          >
            {t("Open saved project")}
          </button>
        </div>
      )}
      {!snapshot ? (
        <div className="workspace-loading">
          <h1>{t("Opening your workspace")}</h1>
          <p>{t("Connecting to the local editor\u2026")}</p>
          <div className="loading-lines" />
        </div>
      ) : (
        <>
          <div className="workspace">
            <aside className="sources" inert={previewExpanded || undefined}>
              <div className="section-heading">
                <h2>
                  {t("Sources")}
                  <span>{project?.assets.length}</span>
                </h2>
                <button
                  aria-label={t("Import videos")}
                  title={t("Import videos")}
                  disabled={busy || !snapshot.capabilities.media}
                  onClick={() =>
                    void run(() => api.importMedia(), { blocking: true, activity: "import" })
                  }
                >
                  <Icon name="plus" />
                </button>
              </div>
              <div className="source-list">
                {project?.assets.map((source, i) => (
                  <div
                    className={`source-item${source.id === asset?.id ? " active" : ""}`}
                    key={source.id}
                  >
                    <button
                      className="source-button"
                      title={source.name}
                      aria-pressed={source.id === asset?.id}
                      onClick={() => chooseSource(source.id)}
                    >
                      <span className="source-index">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="source-detail">
                        <strong>{source.name}</strong>
                        <span>
                          {time(source.durationMs)}{" "}
                          <span className="source-status">
                            {snapshot.jobs.findLast(
                              (j) =>
                                j.kind === "transcription" &&
                                j.assetId === source.id,
                            )?.status !== undefined &&
                            snapshot.jobs.findLast(
                              (j) =>
                                j.kind === "transcription" &&
                                j.assetId === source.id,
                            )?.status !== "completed"
                              ? `${t(snapshot.jobs.findLast((j) => j.kind === "transcription" && j.assetId === source.id)?.status ?? "")} · ${t(snapshot.jobs.findLast((j) => j.kind === "transcription" && j.assetId === source.id)?.stage ?? "Waiting for local processing")}`
                              : source.status !== "ready"
                                ? t(source.status === "missing" ? "Source missing" : "Source changed")
                                : project.transcripts.some(
                                      (t) => t.assetId === source.id,
                                    )
                                  ? t("Transcribed")
                                  : source.hasAudio
                                    ? t("Ready to transcribe")
                                    : t("Video only")}
                          </span>
                        </span>
                      </span>
                    </button>
                    {source.status !== "ready" && (
                      <button
                        className="relink"
                        disabled={busy}
                        onClick={() =>
                          void run(() => relinkSource(source.id), {
                            blocking: true,
                          })
                        }
                      >
                        {t("Relink source")}
                      </button>
                    )}
                  </div>
                ))}
                {!project?.assets.length && (
                  <p className="rail-empty">
                    {t("Your imported recordings will appear here.")}
                  </p>
                )}
              </div>
              <div className="source-footer">
                <Icon name="video" />
                <span>{t("Originals stay untouched")}</span>
              </div>
            </aside>
            <section className="reading-pane" inert={previewExpanded || undefined}>
              <div className="reading-heading">
                <button
                  className="sources-toggle"
                  aria-label={t("Toggle sources")}
                  aria-expanded={sourcesOpen}
                  onClick={() => setSourcesOpen(!sourcesOpen)}
                >
                  <Icon name="list" />
                </button>
                <div>
                  <h1>
                    {readingMode === "script"
                      ? t("Assembly script")
                      : asset
                        ? t("Transcript")
                        : t("Start with your footage")}
                  </h1>
                  {asset && <p title={asset.name}>{asset.name}</p>}
                </div>
                {asset && (
                  <div className="mode-switch">
                    <button
                      aria-pressed={!rangeMode}
                      onClick={() => setRangeMode(false)}
                    >
                      {t("Text")}
                    </button>
                    <button
                      aria-pressed={rangeMode}
                      onClick={() => {
                        setTimingRange(null);
                        setRangeMode(true);
                      }}
                    >
                      {t("Range")}
                    </button>
                  </div>
                )}
              </div>
              <div className="reading-views">
                <button
                  aria-pressed={readingMode === "source"}
                  onClick={() => setReadingMode("source")}
                >
                  {t("Source text")}
                </button>
                <button
                  aria-pressed={readingMode === "script"}
                  disabled={!cuts.length}
                  onClick={() => {
                    setReadingMode("script");
                    setView("assembly");
                    setCurrentMs(0);
                  }}
                >
                  {t("Assembly script")}
                </button>
              </div>
              <div className="reading-body">
                {asset && (
                  <div
                    hidden={
                      asset.status !== "ready" ||
                      !asset.hasAudio ||
                      rangeMode ||
                      readingMode !== "source"
                    }
                    className="transcription-host"
                  >
                    <TranscriptionPanel
                      api={api}
                      snapshot={snapshot}
                      asset={asset}
                      accept={accept}
                      settingsRequest={settingsRequest}
                    />
                  </div>
                )}
                {readingMode === "script" ? (
                  <AssemblyScript
                    cuts={cuts}
                    assets={project?.assets ?? []}
                    selected={cutId}
                    onInspect={inspectCut}
                    onSource={(cut) => {
                      setReadingMode("source");
                      chooseSource(cut.assetId);
                      setCutId(cut.id);
                    }}
                    onMove={(id, position) => {
                      if (
                        Number.isInteger(position) &&
                        position >= 0 &&
                        position < cuts.length
                      )
                        moveCut(
                          id,
                          position - cuts.findIndex((c) => c.id === id),
                        );
                    }}
                  />
                ) : !asset ? (
                  <div className="empty-workspace">
                    <div className="import-mark">
                      <Icon name="video" />
                    </div>
                    <h2>
                      {t("A rough cut starts with")}
                      <br />
                      {t("the words worth keeping.")}
                    </h2>
                    <p>
                      {t(
                        "Choose your videos. Find a passage, select it, and build your assembly below.",
                      )}
                    </p>
                    <button
                      className="primary"
                      disabled={busy || !snapshot.capabilities.media}
                      onClick={() =>
                        void run(() => api.importMedia(), { blocking: true, activity: "import" })
                      }
                    >
                      <Icon name="plus" />
                      {activity === "import" ? t("Importing\u2026") : t("Choose videos")}
                    </button>
                    <span className="drop-hint">
                      {t("or drop video files anywhere in this window")}
                    </span>
                    {!snapshot.capabilities.media && (
                      <p className="warning">
                        {t("Media import is unavailable in this build.")}
                      </p>
                    )}
                  </div>
                ) : asset.status !== "ready" ? (
                  <div className="transcript-empty">
                    <h2>
                      {asset.status === "missing"
                        ? t("Find this recording")
                        : t("This recording has changed")}
                    </h2>
                    <p>
                      {t(
                        "Relink the original file to continue. Selections from changed media need to be made again.",
                      )}
                    </p>
                    <button
                      onClick={() =>
                        void run(() => relinkSource(asset.id), {
                          blocking: true,
                        })
                      }
                    >
                      {t("Relink source")}
                    </button>
                  </div>
                ) : rangeMode || !asset.hasAudio ? (
                  <div className="manual-pane">
                    <h2>
                      {currentTimingRange
                        ? t("Review passage timing")
                        : asset.hasAudio
                          ? t("Select a time range")
                          : t("Cut video without a transcript")}
                    </h2>
                    <RangeEditor
                      canAudition={sourceReady}
                      key={asset.id}
                      asset={asset}
                      currentMs={view === "source" ? currentMs : 0}
                      {...(currentTimingRange ? { initialRange: currentTimingRange } : {})}
                      reviewTiming={!!currentTimingRange}
                      onAdd={(a, b) => void addRange(a, b)}
                      onAudition={(a, b) => seek(a, true, b)}
                      busy={busy}
                    />
                  </div>
                ) : transcript && (transcript.words.length > 0 || transcript.segments.some(segment => segment.text.trim())) ? (
                  <TranscriptView
                    key={`${asset.id}-${transcriptOrigin}`}
                    transcript={transcript}
                    selection={selection}
                    onSelect={selectWord}
                    currentMs={view === "source" ? currentMs : -1}
                    addedWords={addedWords}
                    timingProvenanceKnown={transcript.parameters.wordTimingReview === true}
                    onReviewTimingRange={reviewTimingWindow}
                  />
                ) : (
                  <>
                    {draft && (draft.words.length > 0 || draft.segments.some((segment) => segment.text.trim())) ? (
                      <TranscriptView
                        transcript={draft}
                        selection={null}
                        onSelect={() => {}}
                        currentMs={-1}
                        addedWords={new Set()}
                        draft
                      />
                    ) : (
                      !sourceJob && (
                        <div className="transcript-empty quiet">
                          <Icon name="audio" />
                          <p>
                            {t(transcript
                              ? "No clear speech was detected. Listen to the source or select a time range."
                              : "Your transcript will appear here. Select timed passages, or use a time range.")}
                          </p>
                          <button
                            className="text-button"
                            onClick={() => setRangeMode(true)}
                          >
                            {t("Select a time range instead")}
                          </button>
                        </div>
                      )
                    )}
                  </>
                )}
              </div>
              {asset &&
                readingMode === "source" &&
                !rangeMode &&
                asset.status === "ready" &&
                selectedWords.length > 0 && (
                  <div className="selection-tray">
                    {selectionHasTimingIssues && (
                      <p className="selection-timing-note" role="note">
                        {selectionTimingUnsafe
                          ? t("Selection boundaries have uncertain timing. Listen and set a time range.")
                          : t("Some selected text has uncertain word timing. Listen to the passage before keeping it.")}
                      </p>
                    )}
                    <div>
                      {selectedWords.length > 0 ? (
                        <>
                          <strong>
                            {inspectingSelection ? `${t("Viewing cut")} ${cuts.indexOf(selectedCut!) + 1}` : selectedWords.length}{" "}
                            {!inspectingSelection && t(selectedWords.length === 1 ? "word selected" : "words selected")}
                          </strong>
                          <span>
                            {time(selectedWords[0]!.startMs, true)} —{" "}
                            {time(selectionEnd, true)}{" "}
                            <b>{time(selectionDuration, true)}</b>
                          </span>
                        </>
                      ) : (
                        <>
                          <strong>
                            {draft
                              ? t("Transcription in progress")
                              : rangeMode || !asset.hasAudio
                                ? t("Set your range above")
                                : t("Select a passage to keep")}
                          </strong>
                          <span>
                            {draft
                              ? t(
                                  "Editing opens when the transcript is complete.",
                                )
                              : t(
                                  "Click a word, then Shift-click the end of a passage.",
                                )}
                          </span>
                        </>
                      )}
                    </div>
                    <button
                      disabled={busy || selectedWords.length > 1000}
                      title={t("Select up to 1000 words to correct at once.")}
                      onClick={() => {
                        setCorrections(
                          Object.fromEntries(
                            selectedWords.map((w) => [w.id, w.text]),
                          ),
                        );
                        setCorrectionOpen(true);
                      }}
                    >
                      {t("Correct text")}
                    </button>
                    <button
                      disabled={!selectedWords.length || !sourceReady || selectionTimingUnsafe}
                      aria-label={t("Audition")}
                      title={t("Audition")}
                      onClick={auditionSelection}
                    >
                      <Icon name="play" />
                      <span>{t("Audition")}</span>
                    </button>
                    {selectionHasTimingIssues && (
                      <button onClick={reviewSelectionTiming} disabled={busy}>
                        {t("Review time range")}
                      </button>
                    )}
                    <button
                      className="primary"
                      aria-label={t(selectionAction)}
                      title={t(inspectingSelection ? "Add another cut (E)" : "Add selection (E)")}
                      disabled={
                        busy ||
                        !selectedWords.length ||
                        selectionTimingUnsafe ||
                        asset.status !== "ready"
                      }
                      onClick={() => void addSelection()}
                    >
                      <Icon name="plus" />
                      <span>{t(selectionAction)}</span>
                      <kbd>{t("E")}</kbd>
                    </button>
                  </div>
                )}
            </section>
            <aside className={`monitor-pane showing-${panel}${previewExpanded ? " preview-expanded" : ""}`}
              role={previewExpanded ? "dialog" : undefined}
              aria-modal={previewExpanded || undefined}
              aria-label={previewExpanded ? t("Expanded preview") : undefined}>
              <div className="monitor-heading">
                <div className="mode-switch">
                  <button
                    aria-pressed={view === "source"}
                    onClick={() => {
                      setView("source");
                      setPanel("video");
                      setCurrentMs(0);
                    }}
                  >
                    {t("Source")}
                  </button>
                  <button
                    aria-pressed={view === "assembly"}
                    onClick={() => {
                      setView("assembly");
                      setPanel("video");
                      setCurrentMs(0);
                    }}
                  >
                    {t("Assembly")}
                  </button>
                </div>
                <button
                  className="inspector-toggle"
                  hidden={previewExpanded}
                  aria-pressed={panel === "inspector"}
                  onClick={() =>
                    setPanel(panel === "video" ? "inspector" : "video")
                  }
                >
                  {t("Inspector")}
                </button>
                <span className="monitor-caption">
                  {view === "source"
                    ? (asset?.name ?? t("Original footage"))
                    : t("Continuous preview")}
                </span>
                <button className="preview-expand" aria-label={t(previewExpanded ? "Return to editing" : "Expand preview")}
                  title={t(previewExpanded ? "Return to editing (Esc)" : "Expand preview")}
                  data-overlay-initial-focus={previewExpanded ? "true" : undefined}
                  onClick={() => { setPanel("video"); setPreviewExpanded(!previewExpanded); }}>
                  <Icon name={previewExpanded ? "close" : "expand"} />
                  <span>{t(previewExpanded ? "Return to editing" : "Expand")}</span>
                </button>
              </div>
              <div className="video-section">
                <div
                  className={`video-stage ${view === "assembly" ? project?.output.preset : ""}`}
                >
                  {displayedUrl ? (
                    <video
                      ref={video}
                      data-asset-id={view === "source" ? asset?.id : undefined}
                      data-portrait={
                        view === "source" && asset && asset.height > asset.width
                          ? "true"
                          : undefined
                      }
                      key={
                        view === "source"
                          ? sourceVideoKey
                          : `${view}-${displayedUrl}`
                      }
                      src={displayedUrl}
                      aria-label={
                        view === "source"
                          ? t("Source video")
                          : t("Assembly video")
                      }
                      onTimeUpdate={onTime}
                      onPlay={() => setPlaying(true)}
                      onPause={() => {
                        setPlaying(false);
                        if (video.current)
                          setCurrentMs(video.current.currentTime * 1000);
                      }}
                      onEnded={() => {
                        if (view === "source") checkAuditionBoundary(true);
                      }}
                      onLoadedMetadata={() => {
                        if (video.current && view === "assembly")
                          setCurrentMs(video.current.currentTime * 1000);
                        if (
                          video.current &&
                          pendingSeek.current !== null &&
                          view === "source"
                        ) {
                          video.current.currentTime =
                            pendingSeek.current / 1000;
                          pendingSeek.current = null;
                        }
                      }}
                      onError={(event) => {
                        if (event.currentTarget !== video.current) return;
                        if (view === "source") {
                          if (rejectedVideoKey.current === sourceVideoKey) return;
                          rejectedVideoKey.current = sourceVideoKey;
                          stopAudition(true);
                          setDecodedSource("");
                          setPendingAudition(null);
                          pendingSeek.current = null;
                          const fallback = sourcePreview.fallback();
                          setDecodeFailure({
                            key: sourceVideoKey,
                            message: fallback || sourcePreview.pending
                              ? "Preparing a compatible preview. Text editing stays available."
                              : "This source preview could not be decoded. Retry or relink the recording.",
                          });
                          return;
                        }
                        setPreviewExpanded(false);
                        setFailure({
                          message:
                            "This video could not be played. Relink the source or prepare the assembly again.",
                          retry:
                            view === "assembly"
                              ? () => void preparePreview()
                              : null,
                        });
                      }}
                    />
                  ) : (
                    <div className="monitor-empty">
                      <Icon name="video" />
                      <p
                        hidden={
                          view === "source" &&
                          asset?.status === "ready" &&
                          sourcePreview.available
                        }
                      >
                        {view === "assembly"
                          ? previewBusy
                            ? t("Preparing continuous preview\u2026")
                            : cuts.length
                              ? snapshot.capabilities.rendering
                                ? t(
                                    "Prepare a preview of your current assembly.",
                                  )
                                : t(
                                    "Assembly preview is unavailable in this build.",
                                  )
                              : t("Your assembly preview appears here.")
                          : asset
                            ? asset.status !== "ready"
                              ? t(
                                  "Relink this recording to prepare its preview.",
                                )
                              : !sourcePreview.available
                                ? t(
                                    "Source preview is unavailable in this build.",
                                  )
                                : t("Preparing source preview\u2026")
                            : t("Original footage appears here.")}
                      </p>
                      {view === "assembly" && preparingPreview && (
                        <div className="assembly-preview-status" role="status">
                          <p>{t(preparingPreview.stage)}</p>
                          <progress aria-label={t("Assembly preview preparation")} max={1}
                            {...(preparingPreview.progress == null ? {} : { value: preparingPreview.progress })} />
                          <button disabled={preparingPreview.cancelRequested || preparingPreview.status === "cancelling"}
                            onClick={() => void run(() => api.cancelJob(preparingPreview.id))}>
                            {t(preparingPreview.status === "cancelling" ? "Cancelling…" : "Cancel preview")}
                          </button>
                        </div>
                      )}
                      {view === "assembly" && cuts.length > 0 && !previewBusy && (
                        <button
                          disabled={
                            previewBusy ||
                            blocked ||
                            !snapshot.capabilities.rendering
                          }
                          onClick={() => void preparePreview()}
                        >
                          {t("Prepare preview")}
                        </button>
                      )}
                    </div>
                  )}
                  {view === "source" &&
                    asset?.status === "ready" &&
                    sourcePreview.available &&
                    (!asset.mediaUrl || !sourceReady) && (
                      <div
                        className="source-preview-status"
                        role={
                          sourcePreview.error || (sourceVideoError && !sourcePreview.pending && sourcePreview.job?.status !== "cancelled")
                            ? "alert"
                            : "status"
                        }
                      >
                        <p>
                          {sourcePreview.error
                            ? t(sourcePreview.error)
                            : sourcePreview.job?.status === "cancelled"
                              ? t("Source preview cancelled.")
                            : sourceVideoError
                              ? t(sourceVideoError)
                              : (
                              (asset.mediaUrl
                                ? t("Decoding source video\u2026")
                                : t(sourcePreview.job?.stage ??
                                    "Preparing source preview\u2026")))}
                        </p>
                        {sourcePreview.pending && (
                          <progress
                            aria-label={t("Source preview preparation")}
                            max={1}
                            {...(sourcePreview.job?.progress == null
                              ? {}
                              : { value: sourcePreview.job.progress })}
                          />
                        )}
                        {sourcePreview.job && isWorking(sourcePreview.job) ? (
                          <button
                            disabled={
                              sourcePreview.job.cancelRequested ||
                              sourcePreview.job.status === "cancelling"
                            }
                            onClick={() =>
                              void run(() =>
                                api.cancelJob(sourcePreview.job!.id),
                              )
                            }
                          >
                            {t("Cancel source preview")}
                          </button>
                        ) : (
                          (sourceVideoError ||
                            (!sourcePreview.pending && !asset.mediaUrl)) && (
                            <button
                              onClick={() => {
                                stopAudition(true);
                                setPendingAudition(null);
                                setSourceReload((n) => n + 1);
                                void sourcePreview.request();
                              }}
                            >
                              {t("Retry source preview")}
                            </button>
                          )
                        )}
                      </div>
                    )}
                </div>
                <div className="transport">
                  <button
                    aria-label={
                      playing ? t("Pause playback") : t("Play playback")
                    }
                    disabled={
                      !displayedUrl || (view === "source" && !sourceReady)
                    }
                    onClick={togglePlayback}
                  >
                    <Icon name={playing ? "pause" : "play"} />
                  </button>
                  <span>{time(currentMs, true)}</span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(1, duration)}
                    step={1}
                    value={Math.min(currentMs, duration)}
                    aria-label={
                      view === "source"
                        ? t("Source playhead")
                        : t("Assembly playhead")
                    }
                    disabled={
                      !displayedUrl || (view === "source" && !sourceReady)
                    }
                    onChange={(e) => {
                      const ms = Number(e.target.value);
                      setCurrentMs(ms);
                      if (view === "source") stopAudition(true);
                      if (video.current) video.current.currentTime = ms / 1000;
                    }}
                  />
                  <span className="muted">{time(duration)}</span>
                </div>
                {playbackPosition && (
                  <div
                    className="playback-context"
                    aria-label={t("Assembly playback context")}
                  >
                    <strong>
                      {t("Cut")} {playbackPosition.index + 1} ·{" "}
                      {project?.assets.find(
                        (a) => a.id === playbackPosition.cut.assetId,
                      )?.name ?? t("Missing source")}
                    </strong>
                    <span>
                      {t("Source")} {time(playbackPosition.sourceMs, true)}{" "}
                      <span>
                        {t("Assembly")} {time(currentMs, true)}
                      </span>
                    </span>
                  </div>
                )}
                <div className="monitor-meta">
                  <span>
                    {view === "source" && asset
                      ? `${asset.width} × ${asset.height}`
                      : view === "assembly"
                        ? `${project?.output.width} × ${project?.output.height}`
                        : t("No source selected")}
                  </span>
                  <span>
                    {view === "source" && asset
                      ? `${asset.fps.toFixed(2).replace(/\.00$/, "")} fps`
                      : "30 fps"}
                  </span>
                </div>
              </div>
              {!previewExpanded && (selectedCut ? (
                <CutInspector
                  canAudition={
                    selectedCut.assetId === asset?.id
                      ? sourceReady
                      : !!project?.assets.find(
                          (a) => a.id === selectedCut.assetId,
                        )?.mediaUrl
                  }
                  cut={selectedCut}
                  ordinal={cuts.indexOf(selectedCut) + 1}
                  draft={drafts[selectedCut.id] ?? cutDraft(selectedCut)}
                  validation={draftProblem?.cutId === selectedCut.id ? draftProblem : undefined}
                  onDraft={(draft) => {
                    setDraftProblem(null);
                    setDrafts((old) => ({ ...old, [selectedCut.id]: draft }));
                  }}
                  currentMs={
                    view === "source" && asset?.id === selectedCut.assetId
                      ? currentMs
                      : selectedCut.startMs
                  }
                  asset={project?.assets.find(
                    (a) => a.id === selectedCut.assetId,
                  )}
                  busy={busy || closing}
                  onUpdate={(changes) => {
                    const appliedDraft = drafts[selectedCut.id];
                    void (async () => {
                      const result = await edit({
                        type: "updateCut",
                        cutId: selectedCut.id,
                        changes: {
                          startMs: changes.startMs,
                          endMs: changes.endMs,
                          note: changes.note,
                          ...(changes.text !== selectedCut.text
                            ? { text: changes.text }
                            : {}),
                        },
                      });
                      if (result)
                        setDrafts((old) => {
                          if (old[selectedCut.id] !== appliedDraft) return old;
                          const next = { ...old };
                          delete next[selectedCut.id];
                          return next;
                        });
                    })();
                  }}
                  onAudition={() => startCutAudition(false)}
                  looping={loopingCutId === selectedCut.id}
                  onLoop={() =>
                    loopingCutId === selectedCut.id
                      ? stopAudition(true)
                      : startCutAudition(true)
                  }
                />
              ) : (
                <div className="inspector-empty">
                  <h2>{t("Cut inspector")}</h2>
                  <p>
                    {t(
                      "Select a cut in your assembly to fine-tune its boundaries and add a note.",
                    )}
                  </p>
                </div>
              ))}
            </aside>
          </div>
          <section className="assembly" aria-label={t("Assembly")} inert={previewExpanded || undefined}>
            <div className="assembly-heading">
              <h2>
                {t("Assembly")}{" "}
                <span>
                  {cuts.length} {t(cuts.length === 1 ? "cut" : "cuts")}
                </span>
              </h2>
              <strong className="assembly-duration">
                {time(assemblyDuration(cuts), true)}
              </strong>
              <div className="assembly-actions">
                <button
                  aria-label={t("Move selected cut earlier")}
                  title={t("Move selected cut earlier")}
                  disabled={
                    busy || !selectedCut || cuts.indexOf(selectedCut) === 0
                  }
                  onClick={() => moveCut(cutId, -1)}
                >
                  <Icon name="left" />
                </button>
                <button
                  aria-label={t("Move selected cut later")}
                  title={t("Move selected cut later")}
                  disabled={
                    busy ||
                    !selectedCut ||
                    cuts.indexOf(selectedCut) === cuts.length - 1
                  }
                  onClick={() => moveCut(cutId, 1)}
                >
                  <Icon name="right" />
                </button>
                <button
                  aria-label={t("Remove selected cut")}
                  title={t("Remove selected cut")}
                  disabled={busy || !selectedCut}
                  onClick={() => void edit({ type: "removeCut", cutId })}
                >
                  <Icon name="trash" />
                </button>
                <span className="toolbar-divider" />
                <label className="output-label">
                  <span>{t("Frame")}</span>
                  <select
                    aria-label={t("Output frame")}
                    value={project?.output.preset}
                    disabled={busy}
                    onChange={(e) =>
                      void edit({
                        type: "setOutput",
                        preset: e.target.value as OutputPreset,
                      })
                    }
                  >
                    <option value="landscape">{t("16:9 Landscape")}</option>
                    <option value="portrait">{t("9:16 Portrait")}</option>
                    <option value="square">{t("1:1 Square")}</option>
                  </select>
                </label>
                <button
                  aria-label={t("Prepare assembly preview")}
                  disabled={
                    !cuts.length ||
                    blocked ||
                    previewBusy ||
                    !snapshot.capabilities.rendering
                  }
                  onClick={() => void preparePreview()}
                >
                  <Icon name="play" />
                  <span>
                    {previewBusy ? t("Preparing\u2026") : t("Preview assembly")}
                  </span>
                </button>
              </div>
            </div>
            {blocked && (
              <p className="assembly-warning">
                {t(
                  "Review changed cuts or relink missing sources before preview and export.",
                )}
              </p>
            )}
            <div
              className="assembly-strip"
              role="list"
              aria-label={t("Ordered cuts")}
            >
              {cuts.map((cut, i) => {
                const label = excerpt(cut.text) || t("Video range");
                const source = project?.assets.find(
                  (a) => a.id === cut.assetId,
                );
                return (
                  <button
                    key={cut.id}
                    role="listitem"
                    draggable={!busy}
                    aria-label={`${t("Cut")} ${i + 1}: ${label}`}
                    title={label}
                    aria-current={cut.id === cutId ? "true" : undefined}
                    data-playback-current={
                      cut.id === playbackPosition?.cut.id ? "true" : undefined
                    }
                    className={`assembly-cut${cut.id === playbackPosition?.cut.id ? " playback-current" : ""}${cut.id === cutId ? " active" : ""}${cut.needsReview ? " needs-review" : ""}`}
                    onClick={() => inspectCut(cut)}
                    onDragStart={(e) => {
                      dragCut.current = cut.id;
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", cut.id);
                    }}
                    onDragEnd={() => {
                      dragCut.current = null;
                    }}
                    onDragOver={(e) => {
                      if (dragCut.current) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }
                    }}
                    onDrop={(e) => {
                      if (dragCut.current) {
                        e.preventDefault();
                        e.stopPropagation();
                        dropCut(cut.id);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (
                        e.altKey &&
                        ["ArrowLeft", "ArrowRight"].includes(e.key)
                      ) {
                        e.preventDefault();
                        moveCut(cut.id, e.key === "ArrowLeft" ? -1 : 1);
                      }
                    }}
                  >
                    <span className="cut-topline">
                      <span className="cut-number">
                        {cut.id === playbackPosition?.cut.id && (
                          <Icon name="play" />
                        )}
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="cut-source" title={source?.name}>
                        {source?.name ?? t("Missing source")}
                      </span>
                      {drafts[cut.id] && <span className="cut-draft-marker">{t("Unapplied")}</span>}
                      <Icon name="grip" />
                    </span>
                    <span className="cut-text">
                      {cut.needsReview ? t("Review required \u00b7 ") : ""}
                      {label}
                    </span>
                    <span className="cut-time">
                      <span>
                        {time(cut.startMs, true)} — {time(cut.endMs, true)}
                      </span>
                      <strong>{time(cut.endMs - cut.startMs, true)}</strong>
                    </span>
                  </button>
                );
              })}
              {!cuts.length && (
                <div className="assembly-empty">
                  <Icon name="scissors" />
                  <div>
                    <strong>{t("Your story, in the order you choose.")}</strong>
                    <p>
                      {t(
                        "Add a passage or a time range. Drag cuts to arrange them.",
                      )}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>
          <footer className="status-bar" inert={previewExpanded || undefined}>
            <button
              className={`model-status ${snapshot.model.status}`}
              onClick={() => setQueueOpen(!queueOpen)}
            >
              <span className="status-dot" />
              {snapshot.model.status === "ready"
                ? t("Local transcription ready")
                : snapshot.model.status === "downloading"
                  ? t("Preparing model\u2026")
                  : t("Set up local transcription")}
            </button>
            <span
              className="local-note"
              title={t(
                "Project files reference original media; keep both together.",
              )}
            >
              {t("Project files reference original media; keep both together.")}
            </span>
            <button
              onClick={() => setQueueOpen(!queueOpen)}
              aria-expanded={queueOpen}
            >
              <Icon name="list" />
              {t("Processing")}{" "}
              {activeJobs.length > 0 && (
                <span className="count-badge">{activeJobs.length}</span>
              )}
            </button>
            <button
              aria-label={t("Keyboard shortcuts")}
              onClick={() => setHelpOpen(!helpOpen)}
            >
              <Icon name="help" />
            </button>
          </footer>
        </>
      )}
      {queueOpen && snapshot && (
        <aside className="queue-panel" aria-label={t("Processing queue")}>
          <div className="section-heading">
            <h2>{t("Processing")}</h2>
            <button
              aria-label={t("Close processing queue")}
              onClick={() => setQueueOpen(false)}
            >
              <Icon name="close" />
            </button>
          </div>
          <section className="model-setup">
            <h3>{t("Local transcription model")}</h3>
            <p>
              {t(snapshot.model.message ||
                "Prepare a multilingual model once, then transcribe offline.")}
            </p>
            <p>
              {snapshot.model.status === "ready"
                ? snapshot.model.id
                : t("Prepare text after importing a source.")}
            </p>
            {asset && (
              <button onClick={showModelSettings}>
                {t("Transcription settings")}
              </button>
            )}
          </section>
          <JobList
            jobs={snapshot.jobs}
            assets={snapshot.project.assets}
            onCancel={(j) => void run(() => api.cancelJob(j.id))}
            onRetry={retryJob}
            onReveal={(j) => void run(() => api.revealExport(j.id))}
            onPlay={(j) => {
              setCompletedExport(j);
              setQueueOpen(false);
            }}
          />
        </aside>
      )}
      {correctionOpen && transcript && (
        <aside
          className="correction-panel"
          aria-label={t("Correct transcript")}
        >
          <div className="section-heading">
            <h2>{t("Correct text")}</h2>
            <button disabled={busy} onClick={() => setCorrectionOpen(false)}>
              {t("Close")}
            </button>
          </div>
          <p>
            {t(
              "Correct recognition only. Original sound and time anchors stay unchanged.",
            )}
          </p>
          <div className="correction-words">
            {Object.entries(corrections).map(([id, text], index) => (
              <label key={id}>
                {time(
                  transcript.words.find((w) => w.id === id)?.startMs ?? 0,
                  true,
                )}
                <input
                  aria-label={`${t("Word")} ${index + 1}`}
                  disabled={busy}
                  value={text}
                  maxLength={1000}
                  onChange={(e) => {
                    if (!busyRef.current)
                      setCorrections((old) => ({
                        ...old,
                        [id]: e.target.value,
                      }));
                  }}
                />
              </label>
            ))}
          </div>
          <button
            className="primary"
            disabled={
              busy ||
              Object.values(corrections).some((text) => !text.trim()) ||
              Object.entries(corrections).every(
                ([id, text]) =>
                  transcript.words.find((w) => w.id === id)?.text === text,
              )
            }
            onClick={() => {
              void (async () => {
                const result = await edit({
                  type: "correctTranscript",
                  assetId: transcript.assetId,
                  fingerprint: transcript.fingerprint,
                  transcriptRevision: transcript.revision,
                  changes: Object.entries(corrections)
                    .filter(
                      ([id, text]) =>
                        transcript.words.find((w) => w.id === id)?.text !==
                        text,
                    )
                    .map(([wordId, text]) => {
                      const original =
                        transcript.words.find((word) => word.id === wordId)
                          ?.text ?? "";
                      const prefix = /^\s+/.exec(original)?.[0] ?? "";
                      return {
                        wordId,
                        text:
                          prefix && !/^\s/.test(text) ? prefix + text : text,
                      };
                    }),
                });
                if (result) {
                  setCorrectionOpen(false);
                  setAnnouncement("Text corrected. Timing unchanged.");
                }
              })();
            }}
          >
            {t("Apply correction")}
          </button>
        </aside>
      )}
      {completedExport?.outputUrl && (
        <aside
          className="export-summary completed-export"
          aria-label={t("Completed export")}
        >
          <div className="section-heading">
            <h2>{t("Export complete")}</h2>
            <button onClick={() => setCompletedExport(null)}>
              {t("Back to editing")}
            </button>
          </div>
          <video
            controls
            src={completedExport.outputUrl}
            aria-label={t("Exported video")}
            preload="metadata"
          />
          <p>
            {t(
              "Saved at the destination you chose. Show the file to see its name and location.",
            )}
          </p>
          <button
            onClick={() => void run(() => api.revealExport(completedExport.id))}
          >
            {t("Show exported video")}
          </button>
        </aside>
      )}
      {exportReview && (
        <aside className="export-summary" aria-label={t("Export summary")}>
          <div className="section-heading">
            <h2>{t("Export video")}</h2>
            <button onClick={() => setExportReview(null)}>{t("Close")}</button>
          </div>
          <p>
            {exportReview.cutCount}{" "}
            {t(exportReview.cutCount === 1 ? "cut" : "cuts")} ·{" "}
            {time(exportReview.durationMs, true)}
          </p>
          <p>
            {exportReview.width} × {exportReview.height}
            {t("· 30 fps · MP4 / H.264 / AAC")}
          </p>
          <p>{t("Full picture preserved. Bars fill any unused frame area.")}</p>
          <p>
            {t("Choose where to save the finished video in the next window.")}
          </p>
          {(project?.id !== exportReview.projectId ||
            project?.revision !== exportReview.revision ||
            Object.keys(drafts).length > 0) && (
            <p role="status">
              {t("Assembly changed. Update the summary before exporting.")}
              <button disabled={busy} onClick={() => void reviewExport()}>
                {t("Update export summary")}
              </button>
            </p>
          )}
          <button
            className="primary"
            disabled={
              busy ||
              blocked ||
              exportBusy ||
              project?.id !== exportReview.projectId ||
              project?.revision !== exportReview.revision ||
              Object.keys(drafts).length > 0
            }
            onClick={() => {
              setExportReview(null);
              setQueueOpen(true);
              void run(
                async () => {
                  const latest = workspaceRef.current;
                  if (
                    latest?.project.id !== exportReview.projectId ||
                    latest.project.revision !== exportReview.revision ||
                    Object.keys(draftsRef.current).length
                  )
                    throw new Error(
                      "Assembly changed. Update the summary before exporting.",
                    );
                  return api.exportVideo();
                },
                { blocking: true },
              );
            }}
          >
            {t("Choose destination and export")}
          </button>
        </aside>
      )}
      {helpOpen && (
        <aside className="shortcuts-panel" aria-label={t("Keyboard shortcuts")}>
          <div className="section-heading">
            <h2>{t("Keyboard shortcuts")}</h2>
            <button
              aria-label={t("Close keyboard shortcuts")}
              onClick={() => setHelpOpen(false)}
            >
              <Icon name="close" />
            </button>
          </div>
          <dl>
            <dt>{t("Seek / move between words")}</dt>
            <dd>{t("Arrow keys")}</dd>
            <dt>{t("Extend a passage")}</dt>
            <dd>{t("Shift + Arrow")}</dd>
            <dt>{t("Add selected passage")}</dt>
            <dd>{t("E")}</dd>
            <dt>{t("Move a focused cut")}</dt>
            <dd>{t("Alt + Left / Right")}</dd>
            <dt>{t("Save / save a copy")}</dt>
            <dd>{t("\u2318S / \u21e7\u2318S")}</dd>
            <dt>{t("Undo / redo")}</dt>
            <dd>{t("\u2318Z / \u21e7\u2318Z")}</dd>
            <dt>{t("Close panels / clear selection")}</dt>
            <dd>{t("Esc")}</dd>
          </dl>
        </aside>
      )}
      {dropActive && (
        <div className="drop-overlay">
          <Icon name="plus" />
          <h2>{t("Drop videos to add sources")}</h2>
          <p>{t("Your original files stay in place.")}</p>
        </div>
      )}
      <div
        role="status"
        className={`feedback ${savedAnnouncement ? "saved-feedback" : announcement ? "visible" : ""}`}
        aria-live="polite"
      >
        {t(announcement)}
        {announcement && !savedAnnouncement && snapshot?.canUndo && (
          <button
            onClick={() => {
              void edit({ type: "undo" });
              setAnnouncement("Undone.");
            }}
          >
            {t("Undo last edit")}
          </button>
        )}
        {announcement && !savedAnnouncement && (
          <button
            aria-label={t("Dismiss feedback")}
            onClick={() => setAnnouncement("")}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

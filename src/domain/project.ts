import type {
  Project,
  EditCommand,
  ProjectData,
  OutputSettings,
  OutputPreset,
  Asset,
  Cut,
  TimedWord,
  Transcript,
} from "../shared/contracts";
import {
  record,
  text,
  id,
  integer,
  finite,
  bool,
  list,
  oneOf,
  unique,
  interval,
} from "./validation";
import { joinTranscriptText } from "./transcript-text";
const MAX_PROJECT_CUTS = 10000;
const MAX_SEGMENT_TEXT = 100000;
const MAX_CUT_TEXT = 5000000;
const PROJECT_KEYS = [
  "formatVersion",
  "id",
  "revision",
  "name",
  "assets",
  "transcripts",
  "cuts",
  "cutOrder",
  "output",
  "savedAt",
] as const;
export function outputSettings(preset: OutputPreset): OutputSettings {
  oneOf(preset, ["landscape", "portrait", "square"]);
  return {
    preset,
    width: preset === "landscape" ? 1920 : 1080,
    height: preset === "portrait" ? 1920 : 1080,
    fps: 30,
    sampleRate: 48000,
  };
}
function fileReference(input: unknown): string {
  const ref = text(input, 4096);
  if (/^(?:[\/\\]|[A-Za-z][A-Za-z0-9+.-]*:)/.test(ref) || ref.includes("\0"))
    throw new Error("Expected a relative media reference");
  return ref;
}
export function parseAsset(input: unknown): Asset {
  const v = record(input, [
    "id",
    "name",
    "fileRef",
    "status",
    "fingerprint",
    "durationMs",
    "width",
    "height",
    "rotation",
    "fps",
    "sampleAspectRatio",
    "hasAudio",
  ]);
  return {
    id: id(v.id),
    name: text(v.name, 2000),
    fileRef: fileReference(v.fileRef),
    status: oneOf(v.status, ["ready", "missing", "changed"]),
    fingerprint: text(v.fingerprint, 200),
    durationMs: integer(v.durationMs, 1),
    width: integer(v.width, 1, 65536),
    height: integer(v.height, 1, 65536),
    rotation: finite(v.rotation, -360, 360),
    fps: finite(v.fps, 0.001, 1000),
    hasAudio: bool(v.hasAudio),
    ...(v.sampleAspectRatio === undefined
      ? {}
      : { sampleAspectRatio: finite(v.sampleAspectRatio, 0.001, 1000) }),
  };
}
export function parseWord(input: unknown): TimedWord {
  const v = record(input, ["id", "text", "startMs", "endMs"]);
  const w = {
    id: id(v.id),
    text: text(v.text, 10000),
    startMs: integer(v.startMs),
    endMs: integer(v.endMs),
  };
  interval(w.startMs, w.endMs, Number.MAX_SAFE_INTEGER);
  return w;
}
export function parseCut(input: unknown): Cut {
  const v = record(input, [
    "id",
    "assetId",
    "fingerprint",
    "transcriptRevision",
    "startMs",
    "endMs",
    "wordIds",
    "text",
    "note",
    "needsReview",
    "textSource",
  ]);
  const cut = {
    id: id(v.id),
    assetId: id(v.assetId),
    fingerprint: text(v.fingerprint, 200),
    transcriptRevision:
      v.transcriptRevision === null ? null : integer(v.transcriptRevision),
    startMs: integer(v.startMs),
    endMs: integer(v.endMs),
    wordIds: list(v.wordIds, id, 500000),
    text: text(v.text, MAX_CUT_TEXT, true),
    note: text(v.note, 10000, true),
    needsReview: bool(v.needsReview),
    ...(v.textSource === undefined
      ? {}
      : { textSource: oneOf(v.textSource, ["derived", "custom"]) }),
  };
  unique(cut.wordIds);
  interval(cut.startMs, cut.endMs, Number.MAX_SAFE_INTEGER);
  return cut;
}
function parseTranscript(input: unknown): Transcript {
  const v = record(input, [
    "assetId",
    "fingerprint",
    "revision",
    "language",
    "segments",
    "words",
    "model",
    "engine",
    "parameters",
    "originId",
  ]);
  const model = record(v.model, ["id", "digest"]),
    engine = record(v.engine, ["name", "version"]),
    parameters = record(v.parameters, [
      "vad",
      "vocabulary",
      "simplifiedChinese",
      "conditionOnPreviousText",
    ]);
  const words = list(v.words, parseWord, 500000);
  unique(words.map((w) => w.id));
  const segments = list(
    v.segments,
    (item) => {
      const s = record(item, ["id", "text", "startMs", "endMs", "wordIds"]);
      interval(s.startMs, s.endMs, Number.MAX_SAFE_INTEGER);
      return {
        id: id(s.id),
        text: text(s.text, MAX_SEGMENT_TEXT, true),
        startMs: integer(s.startMs),
        endMs: integer(s.endMs),
        wordIds: list(s.wordIds, id, 500000),
      };
    },
    100000,
  );
  unique(segments.map((s) => s.id));
  const wordSet = new Set(words.map((w) => w.id));
  for (const s of segments) {
    unique(s.wordIds);
    if (s.wordIds.some((w) => !wordSet.has(w)))
      throw new Error("Unknown segment word");
  }
  for (let i = 1; i < words.length; i++)
    if (words[i]!.startMs < words[i - 1]!.startMs)
      throw new Error("Words must be chronological");
  return {
    assetId: id(v.assetId),
    fingerprint: text(v.fingerprint, 200),
    revision: integer(v.revision),
    language: oneOf(v.language, ["auto", "en", "zh"]),
    segments,
    words,
    model: { id: text(model.id, 200), digest: text(model.digest, 200) },
    engine: {
      name: text(engine.name, 200),
      version: text(engine.version, 200),
    },
    ...(v.originId === undefined ? {} : { originId: text(v.originId, 400) }),
    parameters: {
      vad: bool(parameters.vad),
      ...(parameters.vocabulary === undefined
        ? {}
        : { vocabulary: text(parameters.vocabulary, 2000, true) }),
      ...(parameters.simplifiedChinese === undefined
        ? {}
        : { simplifiedChinese: bool(parameters.simplifiedChinese) }),
      ...(parameters.conditionOnPreviousText === undefined
        ? {}
        : {
            conditionOnPreviousText: bool(parameters.conditionOnPreviousText),
          }),
    },
  };
}
export function reconcileCut(
  cut: Cut,
  assets: readonly Asset[],
  transcripts: readonly Transcript[],
  wordIdsCache: Map<Transcript, Set<string>> = new Map(),
): Cut {
  const asset = assets.find((a) => a.id === cut.assetId);
  if (!asset) throw new Error("Unknown cut asset");
  const stale =
    cut.fingerprint !== asset.fingerprint || asset.status === "changed";
  interval(cut.startMs, cut.endMs, asset.durationMs);
  let needsReview = cut.needsReview || stale;
  if (cut.transcriptRevision !== null) {
    const transcript = transcripts.find((t) => t.assetId === asset.id);
    if (
      !transcript ||
      transcript.fingerprint !== cut.fingerprint ||
      transcript.revision !== cut.transcriptRevision
    )
      needsReview = true;
    else {
      let ids = wordIdsCache.get(transcript);
      if (!ids) {
        ids = new Set(transcript.words.map((w) => w.id));
        wordIdsCache.set(transcript, ids);
      }
      if (cut.wordIds.some((word) => !ids.has(word)))
        throw new Error("Unknown cut word");
    }
  } else if (cut.wordIds.length) needsReview = true;
  return needsReview === cut.needsReview ? cut : { ...cut, needsReview };
}
export function validateProject(input: unknown): Project {
  const v = record(input, PROJECT_KEYS);
  if (v.formatVersion !== 1) throw new Error("Unsupported project version");
  const assets = list(v.assets, parseAsset, 10000);
  unique(assets.map((a) => a.id));
  const transcripts = list(v.transcripts, parseTranscript, 10000);
  unique(transcripts.map((t) => t.assetId));
  const validTranscripts = transcripts.filter((t) => {
    const a = assets.find((a) => a.id === t.assetId);
    if (!a) throw new Error("Unknown transcript asset");
    if (t.fingerprint !== a.fingerprint || a.status === "changed") return false;
    for (const w of t.words) interval(w.startMs, w.endMs, a.durationMs);
    for (const s of t.segments) interval(s.startMs, s.endMs, a.durationMs);
    return true;
  });
  const wordIdsCache = new Map<Transcript, Set<string>>();
  const cuts = list(v.cuts, parseCut, MAX_PROJECT_CUTS).map((c) =>
    reconcileCut(c, assets, validTranscripts, wordIdsCache),
  );
  unique(cuts.map((c) => c.id));
  const cutOrder = list(v.cutOrder, id, MAX_PROJECT_CUTS);
  unique(cutOrder);
  if (
    cutOrder.length !== cuts.length ||
    cutOrder.some((c) => !cuts.some((cut) => cut.id === c))
  )
    throw new Error("Cut order must contain each cut exactly once");
  const o = record(v.output, [
    "preset",
    "width",
    "height",
    "fps",
    "sampleRate",
  ]);
  const output = outputSettings(
    oneOf(o.preset, ["landscape", "portrait", "square"]),
  );
  if (
    o.width !== output.width ||
    o.height !== output.height ||
    o.fps !== 30 ||
    o.sampleRate !== 48000
  )
    throw new Error("Invalid output settings");
  const savedAt = v.savedAt === null ? null : text(v.savedAt, 40);
  if (savedAt !== null && !/^\d{4}-\d{2}-\d{2}T/.test(savedAt))
    throw new Error("Invalid save timestamp");
  return {
    formatVersion: 1,
    id: id(v.id),
    revision: integer(v.revision),
    name: text(v.name, 2000),
    assets,
    transcripts: validTranscripts,
    cuts,
    cutOrder,
    output,
    savedAt,
    history: { past: [], future: [] },
  };
}
export function serializeProject(project: Project): ProjectData {
  const { history: _, ...data } = project;
  return data;
}
export function createProject(): Project {
  return {
    formatVersion: 1,
    id: globalThis.crypto.randomUUID(),
    revision: 0,
    name: "Untitled project",
    assets: [],
    transcripts: [],
    cuts: [],
    cutOrder: [],
    output: outputSettings("landscape"),
    savedAt: null,
    history: { past: [], future: [] },
  };
}
export function parseEditCommand(input: unknown): EditCommand {
  const base = record(input, [
    "type",
    "cut",
    "cutId",
    "changes",
    "cutIds",
    "preset",
    "name",
    "assetId",
    "fingerprint",
    "transcriptRevision",
  ]);
  const type = oneOf(base.type, [
    "correctTranscript",
    "addCut",
    "updateCut",
    "removeCut",
    "reorderCuts",
    "setOutput",
    "renameProject",
    "undo",
    "redo",
  ]);
  const fields = {
    correctTranscript: [
      "type",
      "assetId",
      "fingerprint",
      "transcriptRevision",
      "changes",
    ],
    addCut: ["type", "cut"],
    updateCut: ["type", "cutId", "changes"],
    removeCut: ["type", "cutId"],
    reorderCuts: ["type", "cutIds"],
    setOutput: ["type", "preset"],
    renameProject: ["type", "name"],
    undo: ["type"],
    redo: ["type"],
  }[type];
  const v = record(input, fields);
  switch (type) {
    case "correctTranscript": {
      const changes = list(
        v.changes,
        (item) => {
          const change = record(item, ["wordId", "text"]);
          return { wordId: id(change.wordId), text: text(change.text, 2000) };
        },
        1000,
      );
      if (
        !changes.length ||
        changes.some((change) => Array.from(change.text).length > 1000)
      )
        throw new Error("Invalid correction size");
      unique(changes.map((change) => change.wordId));
      return {
        type,
        assetId: id(v.assetId),
        fingerprint: text(v.fingerprint, 200),
        transcriptRevision: integer(v.transcriptRevision),
        changes,
      };
    }
    case "addCut":
      return { type, cut: parseCut(v.cut) };
    case "updateCut": {
      const c = record(v.changes, ["startMs", "endMs", "text", "note"]);
      if (!Object.keys(c).length) throw new Error("Empty cut edit");
      const changes: Extract<EditCommand, { type: "updateCut" }>["changes"] =
        {};
      if ("startMs" in c) changes.startMs = integer(c.startMs);
      if ("endMs" in c) changes.endMs = integer(c.endMs);
      if ("text" in c) changes.text = text(c.text, MAX_CUT_TEXT, true);
      if ("note" in c) changes.note = text(c.note, 10000, true);
      return { type, cutId: id(v.cutId), changes };
    }
    case "removeCut":
      return { type, cutId: id(v.cutId) };
    case "reorderCuts":
      return { type, cutIds: list(v.cutIds, id, MAX_PROJECT_CUTS) };
    case "setOutput":
      return {
        type,
        preset: oneOf(v.preset, ["landscape", "portrait", "square"]),
      };
    case "renameProject":
      return { type, name: text(v.name, 2000) };
    case "undo":
    case "redo":
      return { type };
  }
}
function origin(transcript: Transcript): string {
  return (
    transcript.originId ?? `legacy-${transcript.assetId}-${transcript.revision}`
  );
}
function boundedDerivedText(
  value: string,
  maximum: number,
  label: string,
): string {
  // Match persisted UTF-16 limits without reparsing/copying the immutable transcript.
  if (value.length > maximum)
    throw new Error(`Corrected ${label} is too long; shorten replacement text`);
  return value;
}
function synchronizeCutText(
  cut: Cut,
  before: Transcript,
  after: Transcript,
  cache: Map<Transcript, Map<string, string>>,
): Cut {
  if (
    cut.transcriptRevision !== before.revision ||
    cut.fingerprint !== before.fingerprint ||
    cut.needsReview
  )
    return cut;
  const index = (transcript: Transcript) => {
    let texts = cache.get(transcript);
    if (!texts) {
      texts = new Map(transcript.words.map((word) => [word.id, word.text]));
      cache.set(transcript, texts);
    }
    return texts;
  };
  const previous = index(before),
    next = index(after);
  if (cut.wordIds.some((id) => !previous.has(id) || !next.has(id))) return cut;
  const oldWords = cut.wordIds.map((id) => previous.get(id)!);
  const newWords = cut.wordIds.map((id) => next.get(id)!);
  const natural = cut.text === joinTranscriptText(oldWords);
  const spaced = cut.text === oldWords.join(" ");
  const joined = cut.text === oldWords.join("").trim();
  const derived =
    cut.textSource === "derived" ||
    (cut.textSource === undefined && (natural || spaced || joined));
  return {
    ...cut,
    transcriptRevision: after.revision,
    textSource: derived ? "derived" : "custom",
    text: boundedDerivedText(
      derived
        ? natural
          ? joinTranscriptText(newWords)
          : spaced
            ? newWords.join(" ")
            : joined
              ? newWords.join("").trim()
              : joinTranscriptText(newWords)
        : cut.text,
      MAX_CUT_TEXT,
      "cut label",
    ),
  };
}
function restoreTranscriptText(
  project: Project,
  restored: Project["history"]["past"][number],
): Transcript[] {
  let changed = false;
  const transcripts = project.transcripts.map((current) => {
    const prior = restored.transcripts.find(
      (transcript) => transcript.assetId === current.assetId,
    );
    if (
      !prior ||
      prior === current ||
      origin(prior) !== origin(current) ||
      prior.fingerprint !== current.fingerprint ||
      project.assets.find((asset) => asset.id === current.assetId)?.status ===
        "changed"
    )
      return current;
    changed = true;
    return {
      ...prior,
      originId: origin(current),
      revision: integer(current.revision + 1),
    };
  });
  return changed ? transcripts : project.transcripts;
}
export function applyProjectEdit(
  project: Project,
  input: EditCommand,
): Project {
  const command = parseEditCommand(input);
  const current = serializeProject(project);
  const editable = {
    name: project.name,
    cuts: project.cuts,
    cutOrder: project.cutOrder,
    output: project.output,
    transcripts: project.transcripts,
  };
  const revision = integer(project.revision + 1);
  if (command.type === "undo" || command.type === "redo") {
    const undo = command.type === "undo",
      from = undo ? project.history.past : project.history.future;
    const restored = from.at(-1);
    if (!restored) return project;
    const wordIdsCache = new Map<Transcript, Set<string>>();
    const transcripts = restoreTranscriptText(project, restored);
    const textCache = new Map<Transcript, Map<string, string>>();
    const cuts = restored.cuts.map((cut) => {
      const before = restored.transcripts.find(
          (transcript) => transcript.assetId === cut.assetId,
        ),
        after = transcripts.find(
          (transcript) => transcript.assetId === cut.assetId,
        );
      const synchronized =
        before && after && origin(before) === origin(after)
          ? synchronizeCutText(cut, before, after, textCache)
          : cut;
      return reconcileCut(
        synchronized,
        project.assets,
        transcripts,
        wordIdsCache,
      );
    });
    return {
      ...project,
      ...restored,
      transcripts,
      cuts,
      revision,
      history: undo
        ? {
            past: from.slice(0, -1),
            future: [...project.history.future, editable].slice(-100),
          }
        : {
            past: [...project.history.past, editable].slice(-100),
            future: from.slice(0, -1),
          },
    };
  }
  let next: ProjectData = current;
  switch (command.type) {
    case "correctTranscript": {
      const asset = project.assets.find(
        (asset) => asset.id === command.assetId,
      );
      const before = project.transcripts.find(
        (transcript) => transcript.assetId === command.assetId,
      );
      if (
        !asset ||
        asset.status !== "ready" ||
        asset.fingerprint !== command.fingerprint ||
        !before ||
        before.fingerprint !== command.fingerprint ||
        before.revision !== command.transcriptRevision
      )
        throw new Error(
          "Transcript correction is stale; refresh the source and transcript",
        );
      const changes = new Map(
        command.changes.map((change) => [change.wordId, change.text]),
      );
      const known = new Set(before.words.map((word) => word.id));
      if ([...changes.keys()].some((id) => !known.has(id)))
        throw new Error("Unknown correction word");
      const words = before.words.map((word) =>
        changes.has(word.id) ? { ...word, text: changes.get(word.id)! } : word,
      );
      const texts = new Map(words.map((word) => [word.id, word.text]));
      const after = {
        ...before,
        originId: origin(before),
        revision: integer(before.revision + 1),
        words,
        segments: before.segments.map((segment) =>
          segment.wordIds.length
            ? {
                ...segment,
                text: boundedDerivedText(
                  segment.wordIds
                    .map((id) => texts.get(id)!)
                    .join("")
                    .trim(),
                  MAX_SEGMENT_TEXT,
                  "sentence",
                ),
              }
            : segment,
        ),
      };
      const textCache = new Map<Transcript, Map<string, string>>();
      next = {
        ...current,
        transcripts: project.transcripts.map((transcript) =>
          transcript === before ? after : transcript,
        ),
        cuts: project.cuts.map((cut) =>
          cut.assetId === before.assetId
            ? synchronizeCutText(cut, before, after, textCache)
            : cut,
        ),
      };
      break;
    }
    case "addCut":
      if (
        project.cuts.length >= MAX_PROJECT_CUTS ||
        project.cutOrder.length >= MAX_PROJECT_CUTS
      )
        throw new Error("Project cut limit reached");
      if (project.cuts.some((c) => c.id === command.cut.id))
        throw new Error("Duplicate cut");
      next = {
        ...current,
        cuts: [
          ...project.cuts,
          reconcileCut(command.cut, project.assets, project.transcripts),
        ],
        cutOrder: [...project.cutOrder, command.cut.id],
      };
      break;
    case "updateCut": {
      const existing = project.cuts.find((c) => c.id === command.cutId);
      if (!existing) throw new Error("Unknown cut");
      const updated = reconcileCut(
        parseCut({
          ...existing,
          ...command.changes,
          ...("text" in command.changes ? { textSource: "custom" } : {}),
        }),
        project.assets,
        project.transcripts,
      );
      next = {
        ...current,
        cuts: project.cuts.map((c) => (c.id === command.cutId ? updated : c)),
      };
      break;
    }
    case "removeCut":
      if (!project.cuts.some((c) => c.id === command.cutId))
        throw new Error("Unknown cut");
      next = {
        ...current,
        cuts: project.cuts.filter((c) => c.id !== command.cutId),
        cutOrder: project.cutOrder.filter((id) => id !== command.cutId),
      };
      break;
    case "reorderCuts":
      unique(command.cutIds);
      if (
        command.cutIds.length !== project.cuts.length ||
        command.cutIds.some((id) => !project.cuts.some((c) => c.id === id))
      )
        throw new Error("Incomplete cut order");
      next = { ...current, cutOrder: command.cutIds };
      break;
    case "setOutput":
      next = { ...current, output: outputSettings(command.preset) };
      break;
    case "renameProject":
      next = { ...current, name: command.name };
      break;
  }
  return {
    ...next,
    revision,
    history: {
      past: [...project.history.past, editable].slice(-100),
      future: [],
    },
  };
}

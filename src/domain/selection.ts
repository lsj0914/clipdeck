import type { Asset, TimedWord, Cut } from "../shared/contracts";
import { parseWord } from "./project";
import { joinTranscriptText } from "./transcript-text";
import { unique, interval } from "./validation";
export function selectionToCut(
  asset: Asset,
  words: TimedWord[],
  fromId: string,
  toId: string,
): Cut {
  if (asset.status !== "ready") throw new Error("Source is unavailable");
  const valid = words.map(parseWord);
  unique(valid.map((w) => w.id));
  for (let i = 0; i < valid.length; i++) {
    interval(valid[i]!.startMs, valid[i]!.endMs, asset.durationMs);
    if (i && valid[i]!.startMs < valid[i - 1]!.startMs)
      throw new Error("Words must be chronological");
  }
  const from = valid.findIndex((w) => w.id === fromId),
    to = valid.findIndex((w) => w.id === toId);
  if (from < 0 || to < 0) throw new Error("Unknown selection word");
  const selected = valid.slice(Math.min(from, to), Math.max(from, to) + 1);
  return {
    id: `cut-${asset.id}-${selected[0]!.id}-${selected.at(-1)!.id}`,
    assetId: asset.id,
    fingerprint: asset.fingerprint,
    transcriptRevision: null,
    startMs: selected[0]!.startMs,
    endMs: selected.reduce((end, w) => Math.max(end, w.endMs), 0),
    wordIds: selected.map((w) => w.id),
    text: joinTranscriptText(selected.map((w) => w.text)),
    textSource: "derived",
    note: "",
    needsReview: false,
  };
}

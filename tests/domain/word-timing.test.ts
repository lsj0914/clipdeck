import { expect, it } from "vitest";
import * as selection from "../../src/domain/selection";
import { applyProjectEdit, parseWord, serializeProject, validateProject } from "../../src/domain/project";
import type { TimedWord } from "../../src/shared/contracts";
import { asset, data } from "./fixtures";

const safe = { id: "safe", text: "Opening", startMs: 100, endMs: 300 };
const middle = { id: "middle", text: "Context", startMs: 200, endMs: 400 };
const last = { id: "last", text: "Ending", startMs: 300, endMs: 500 };

it.each([
  [[], false],
  [[safe, middle, last], false],
  [[{ ...safe, timingNeedsReview: true }, middle, last], true],
  [[safe, middle, { ...last, timingNeedsReview: true }], true],
  [[safe, { ...middle, endMs: 600, timingNeedsReview: true }, last], true],
  [[safe, { ...middle, endMs: 500, timingNeedsReview: true }, last], true],
  [[{ ...safe, endMs: 600 }, { ...middle, timingNeedsReview: true }, { ...last, timingNeedsReview: true }], false],
  [[safe, { ...middle, timingNeedsReview: true }, last], false],
  [[{ ...safe, timingNeedsReview: false }, { ...last, timingNeedsReview: false }], false],
] as const)("identifies uncertainty only at the actual start or maximum-end authority: %j", (words, expected) => {
  const helper = (selection as Partial<{ selectionBoundaryNeedsTimingReview(words: readonly TimedWord[]): boolean }>).selectionBoundaryNeedsTimingReview;
  expect(helper?.(words)).toBe(expected);
});

it("refuses a folded anchor as a tiny ordinary derived cut and directs manual-range recovery", () => {
  const words = [{ ...safe, text: "A long folded clause", endMs: 140, timingNeedsReview: true }];
  const before = structuredClone(words);
  expect(() => selection.selectionToCut(asset, words, "safe", "safe")).toThrow("Word timing needs review; select a time range instead.");
  expect(words).toEqual(before);
});

it("guards the overlapping interior maximum end even when gesture endpoints are unflagged", () => {
  const words = [safe, { ...middle, endMs: 700, timingNeedsReview: true }, last];
  expect(() => selection.selectionToCut(asset, words, "last", "safe")).toThrow("Word timing needs review; select a time range instead.");
});

it("allows uncertain interior text when reliable words supply both actual cut boundaries", () => {
  const words = [safe, { ...middle, timingNeedsReview: true }, last];
  const cut = selection.selectionToCut(asset, words, "safe", "last");
  expect(cut).toMatchObject({ startMs: 100, endMs: 500, needsReview: false, wordIds: ["safe", "middle", "last"] });
});

function projectInput() {
  return { ...data(), transcripts: [{
    assetId: asset.id, fingerprint: asset.fingerprint, revision: 1, language: "en" as const,
    words: [{ ...safe, timingNeedsReview: true }, { ...last, timingNeedsReview: false }],
    segments: [{ id: "sentence", text: "OpeningEnding", startMs: 100, endMs: 500, wordIds: ["safe", "last"] }],
    model: { id: "local", digest: "verified" }, engine: { name: "faster-whisper", version: "1.2.1" },
    parameters: { vad: true, wordTimingReview: true },
  }] };
}

it("retains strict true/false timing flags and supported provenance through save, correction and history", () => {
  const original = validateProject(projectInput());
  const corrected = applyProjectEdit(original, { type: "correctTranscript", assetId: asset.id, fingerprint: asset.fingerprint, transcriptRevision: 1, changes: [{ wordId: "safe", text: "Corrected" }] });
  const undone = applyProjectEdit(corrected, { type: "undo" });
  const redone = applyProjectEdit(undone, { type: "redo" });
  expect(original.transcripts[0]!.words[0]!.text).toBe("Opening");
  expect(undone.transcripts[0]!.words[0]!.text).toBe("Opening");
  expect(redone.transcripts[0]!.words[0]!.text).toBe("Corrected");
  for (const project of [original, corrected, undone, redone, validateProject(serializeProject(redone))]) {
    expect(project.transcripts[0]!.parameters).toHaveProperty("wordTimingReview", true);
    expect(project.transcripts[0]!.words.map(w => ({ id: w.id, startMs: w.startMs, endMs: w.endMs, timingNeedsReview: (w as typeof safe & { timingNeedsReview?: boolean }).timingNeedsReview }))).toEqual([
      { id: "safe", startMs: 100, endMs: 300, timingNeedsReview: true },
      { id: "last", startMs: 300, endMs: 500, timingNeedsReview: false },
    ]);
  }
});

it("keeps legacy absence unknown rather than manufacturing verification", () => {
  const input = projectInput(), transcript = input.transcripts[0]!;
  const legacy = validateProject({ ...input, transcripts: [{ ...transcript, words: [safe, last], parameters: { vad: true } }] });
  const reopened = validateProject(serializeProject(legacy));
  expect(reopened.transcripts[0]!.parameters).not.toHaveProperty("wordTimingReview");
  expect(reopened.transcripts[0]!.words[0]).not.toHaveProperty("timingNeedsReview");
  expect(parseWord({ ...safe, timingNeedsReview: false })).toHaveProperty("timingNeedsReview", false);
  const unsupported = validateProject({ ...input, transcripts: [{ ...transcript, parameters: { vad: true, wordTimingReview: false } }] });
  expect(serializeProject(unsupported).transcripts[0]!.parameters).toHaveProperty("wordTimingReview", false);
});

it.each(["true", 1, null, {}])("rejects nonboolean word/provenance metadata: %j", invalid => {
  expect(() => parseWord({ ...safe, timingNeedsReview: invalid })).toThrow();
  const input = projectInput(), transcript = input.transcripts[0]!;
  expect(() => validateProject({ ...input, transcripts: [{ ...transcript, parameters: { vad: true, wordTimingReview: invalid } }] })).toThrow();
});

it("cannot clear uncertainty through a text-correction payload", () => {
  const project = validateProject(projectInput()), before = JSON.stringify(project);
  expect(() => applyProjectEdit(project, { type: "correctTranscript", assetId: asset.id, fingerprint: asset.fingerprint, transcriptRevision: 1, changes: [{ wordId: "safe", text: "Corrected", timingNeedsReview: false }] } as never)).toThrow();
  expect(JSON.stringify(project)).toBe(before);
});

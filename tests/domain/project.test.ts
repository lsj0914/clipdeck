import { describe, it, expect } from "vitest";
import {
  validateProject,
  applyProjectEdit,
  serializeProject,
} from "../../src/domain/project";
import { asset, cut, data } from "./fixtures";
describe("project invariants", () => {
  it("accepts valid JSON with session history initialized", () => {
    const p = validateProject(data());
    expect(p.id).toBe("project-a");
    expect(p.history).toEqual({ past: [], future: [] });
  });
  it.each([
    [NaN, 500],
    [100, Infinity],
    [-1, 500],
    [500, 100],
    [100, 5001],
    [1.5, 500],
    [100, 100],
  ])("rejects invalid selected source interval %s to %s", (start, end) => {
    const p = data();
    p.cuts = [cut("a", start, end)];
    p.cutOrder = ["a"];
    expect(() => validateProject(p)).toThrow();
  });
  it("rejects malformed schema instead of trusting project JSON", () => {
    for (const p of [
      null,
      [],
      { ...data(), formatVersion: 2 },
      { ...data(), assets: [{ ...asset, durationMs: NaN }] },
      { ...data(), cutOrder: ["unknown"] },
      { ...data(), __proto__: null, constructor: { dangerous: true } },
    ])
      expect(() => validateProject(p)).toThrow();
  });
  it("marks equal-duration changed-content selections for review and drops stale transcript", () => {
    const p = data();
    p.assets[0]!.fingerprint = "sha256:bbb";
    p.cuts = [cut()];
    p.cutOrder = ["cut-a"];
    const result = validateProject(p);
    expect(result.cuts[0]!.needsReview).toBe(true);
  });
  it("edits deterministically and undo/redo restores content without mutating earlier state", () => {
    const original = validateProject(data());
    const command = { type: "addCut" as const, cut: cut() };
    const a = applyProjectEdit(original, command);
    expect(a).toEqual(applyProjectEdit(original, command));
    expect(original.cuts).toEqual([]);
    expect(a.cutOrder).toEqual(["cut-a"]);
    const undone = applyProjectEdit(a, { type: "undo" });
    expect(undone.cuts).toEqual([]);
    expect(undone.revision).toBe(2);
    const redone = applyProjectEdit(undone, { type: "redo" });
    expect(redone.cuts).toEqual([cut()]);
    expect(redone.revision).toBe(3);
    expect(serializeProject(redone)).not.toHaveProperty("history");
  });
  it("rejects duplicate/missing reorder IDs and invalid edits before adding history", () => {
    const p = applyProjectEdit(validateProject(data()), {
      type: "addCut",
      cut: cut(),
    });
    expect(() =>
      applyProjectEdit(p, { type: "reorderCuts", cutIds: [] }),
    ).toThrow();
    expect(() =>
      applyProjectEdit(p, {
        type: "updateCut",
        cutId: "cut-a",
        changes: { endMs: 6000 },
      }),
    ).toThrow();
    expect(() =>
      applyProjectEdit(p, { type: "removeCut", cutId: "unknown" }),
    ).toThrow();
  });
  it("clears redo after a new edit and constrains output to supported frame settings", () => {
    let p = applyProjectEdit(validateProject(data()), {
      type: "renameProject",
      name: "New name",
    });
    p = applyProjectEdit(p, { type: "undo" });
    p = applyProjectEdit(p, { type: "setOutput", preset: "portrait" });
    expect(p.output).toEqual({
      preset: "portrait",
      width: 1080,
      height: 1920,
      fps: 30,
      sampleRate: 48000,
    });
    expect(p.history.future).toEqual([]);
  });
});
it("undo never restores older imported media or asynchronous source identity", () => {
  let p = applyProjectEdit(validateProject(data()), {
    type: "addCut",
    cut: cut(),
  });
  p = applyProjectEdit(p, { type: "renameProject", name: "New name" });
  p = { ...p, assets: [{ ...asset, fingerprint: "sha256:replacement" }] };
  const undone = applyProjectEdit(p, { type: "undo" });
  expect(undone.name).toBe("Interview");
  expect(undone.assets[0]!.fingerprint).toBe("sha256:replacement");
  expect(undone.cuts[0]!.needsReview).toBe(true);
});
it("discards a stale transcript and reviews its associated cut on content replacement", () => {
  const p = data();
  p.assets[0]!.fingerprint = "sha256:replacement";
  p.transcripts = [
    {
      assetId: "asset-a",
      fingerprint: "sha256:aaa",
      revision: 1,
      language: "en",
      words: [{ id: "w1", text: "Hello", startMs: 100, endMs: 500 }],
      segments: [
        { id: "s1", text: "Hello", startMs: 100, endMs: 500, wordIds: ["w1"] },
      ],
      model: { id: "small", digest: "model-digest" },
      engine: { name: "faster-whisper", version: "1" },
      parameters: { vad: false },
    },
  ];
  p.cuts = [{ ...cut(), transcriptRevision: 1, wordIds: ["w1"] }];
  p.cutOrder = ["cut-a"];
  const result = validateProject(p);
  expect(result.transcripts).toEqual([]);
  expect(result.cuts[0]!.needsReview).toBe(true);
});
it("rejects host paths and URLs in persisted file references", () => {
  for (const fileRef of [
    "/etc/passwd",
    "C:\\Windows\\secret",
    "file:///etc/passwd",
    "https://example.com/media.mp4",
    "media/\u0000bad",
  ]) {
    const p = data();
    p.assets[0]!.fileRef = fileRef;
    expect(() => validateProject(p)).toThrow();
  }
});
it.each(["fingerprint", "status"] as const)(
  "rejects out-of-duration cuts despite stale source %s in validation and edits",
  (staleKind) => {
    const input = data();
    if (staleKind === "fingerprint")
      input.assets[0]!.fingerprint = "sha256:replacement";
    else input.assets[0]!.status = "changed";
    input.cuts = [cut("stale", 100, 5001)];
    input.cutOrder = ["stale"];
    expect(() => validateProject(input)).toThrow();

    input.cuts = [cut("stale", 100, 500)];
    const project = validateProject(input);
    const before = JSON.stringify(project);
    expect(() =>
      applyProjectEdit(project, { type: "addCut", cut: cut("new", 100, 5001) }),
    ).toThrow();
    expect(() =>
      applyProjectEdit(project, {
        type: "updateCut",
        cutId: "stale",
        changes: { endMs: 5001 },
      }),
    ).toThrow();
    expect(JSON.stringify(project)).toBe(before);
  },
);
it("round-trips an edit at 10000 cuts and rejects the next cut without changing history", () => {
  const input = data();
  input.cuts = Array.from({ length: 9999 }, (_, index) => cut(`cut-${index}`));
  input.cutOrder = input.cuts.map((item) => item.id);
  const project = applyProjectEdit(validateProject(input), {
    type: "addCut",
    cut: cut("last-cut"),
  });
  expect(project.cuts).toHaveLength(10000);
  expect(project.cutOrder.at(-1)).toBe("last-cut");
  const reopened = validateProject(serializeProject(project));
  expect(reopened.cuts).toHaveLength(10000);
  expect(reopened.cutOrder.at(-1)).toBe("last-cut");
  const before = JSON.stringify(project);
  expect(() =>
    applyProjectEdit(project, { type: "addCut", cut: cut("overflow") }),
  ).toThrow();
  expect(JSON.stringify(project)).toBe(before);
  expect(project.history.past).toHaveLength(1);
  expect(project.history.future).toEqual([]);
  expect(project.revision).toBe(1);
});

it("persists optional previous-text decoding provenance and preserves legacy omission", () => {
  const input = data();
  input.transcripts = [{
    assetId: "asset-a", fingerprint: "sha256:aaa", revision: 1, language: "en",
    words: [{ id: "w1", text: "Hello", startMs: 100, endMs: 500 }],
    segments: [{ id: "s1", text: "Hello", startMs: 100, endMs: 500, wordIds: ["w1"] }],
    model: { id: "small", digest: "model-digest" },
    engine: { name: "faster-whisper", version: "1.2.1" },
    parameters: { vad: true },
  }];
  const legacy = validateProject(input);
  expect(serializeProject(legacy).transcripts[0]!.parameters).not.toHaveProperty("conditionOnPreviousText");
  const explicit = {
    ...input,
    transcripts: input.transcripts.map((transcript) => ({
      ...transcript, parameters: { ...transcript.parameters, conditionOnPreviousText: false },
    })),
  };
  const roundTrip = validateProject(serializeProject(validateProject(explicit)));
  expect(roundTrip.transcripts[0]!.parameters).toHaveProperty("conditionOnPreviousText", false);
  expect(roundTrip.transcripts[0]!.words).toEqual(input.transcripts[0]!.words);
  expect(roundTrip.transcripts[0]!.segments).toEqual(input.transcripts[0]!.segments);
  for (const invalid of ["false", 0, null]) {
    expect(() => validateProject({ ...explicit, transcripts: [{
      ...explicit.transcripts[0], parameters: { vad: true, conditionOnPreviousText: invalid },
    }] })).toThrow();
  }
});

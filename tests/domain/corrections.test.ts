import { it, expect } from "vitest";
import {
  applyProjectEdit,
  validateProject,
  serializeProject,
  parseEditCommand,
} from "../../src/domain/project";
import { data, asset } from "./fixtures";
function fixture() {
  const base = data();
  base.transcripts = [
    {
      assetId: asset.id,
      fingerprint: asset.fingerprint,
      revision: 1,
      language: "zh",
      words: [
        { id: "w1", text: "跑", startMs: 0, endMs: 200 },
        { id: "w2", text: "不", startMs: 200, endMs: 500 },
      ],
      segments: [
        {
          id: "s1",
          text: "跑不",
          startMs: 0,
          endMs: 500,
          wordIds: ["w1", "w2"],
        },
      ],
      model: { id: "small", digest: "verified" },
      engine: { name: "faster-whisper", version: "1.2.1" },
      parameters: { vad: true },
    },
  ];
  base.cuts = [
    {
      id: "derived",
      assetId: asset.id,
      fingerprint: asset.fingerprint,
      transcriptRevision: 1,
      startMs: 0,
      endMs: 500,
      wordIds: ["w1", "w2"],
      text: "跑不",
      note: "",
      needsReview: false,
    },
    {
      id: "custom",
      assetId: asset.id,
      fingerprint: asset.fingerprint,
      transcriptRevision: 1,
      startMs: 0,
      endMs: 500,
      wordIds: ["w1", "w2"],
      text: "My explicit label",
      textSource: "custom",
      note: "",
      needsReview: false,
    },
  ];
  base.cutOrder = ["derived", "custom"];
  return validateProject(base);
}
const command = {
  type: "correctTranscript" as const,
  assetId: asset.id,
  fingerprint: asset.fingerprint,
  transcriptRevision: 1,
  changes: [{ wordId: "w2", text: "步" }],
};
it("keeps natural mixed-language derived cuts readable through correction, undo, redo and save", () => {
  const base = fixture();
  const words = ["Hello", "world", "，", "世界"].map((text, index) => ({
    id: `mixed-${index}`,
    text,
    startMs: index * 100,
    endMs: (index + 1) * 100,
  }));
  const labels = [
    {
      id: "natural",
      text: "Hello world，世界",
      textSource: "derived" as const,
    },
    { id: "natural-legacy", text: "Hello world，世界" },
    { id: "spaced-legacy", text: "Hello world ， 世界" },
    { id: "joined-legacy", text: "Helloworld，世界" },
    { id: "custom", text: "Hello world，世界", textSource: "custom" as const },
  ];
  const original = validateProject({
    ...serializeProject(base),
    transcripts: [
      {
        ...base.transcripts[0]!,
        words,
        segments: [
          {
            id: "mixed-segment",
            text: "Hello world，世界",
            startMs: 0,
            endMs: 400,
            wordIds: words.map((w) => w.id),
          },
        ],
      },
    ],
    cuts: labels.map((label) => ({
      ...base.cuts[0]!,
      ...label,
      endMs: 400,
      wordIds: words.map((w) => w.id),
    })),
    cutOrder: labels.map((label) => label.id),
  });
  const corrected = applyProjectEdit(original, {
    ...command,
    changes: [{ wordId: "mixed-1", text: "there" }],
  });
  const expected = [
    "Hello there，世界",
    "Hello there，世界",
    "Hello there ， 世界",
    "Hellothere，世界",
    "Hello world，世界",
  ];
  expect(corrected.cuts.map((cut) => cut.text)).toEqual(expected);
  expect(
    corrected.transcripts[0]!.words.map(({ id, startMs, endMs }) => ({
      id,
      startMs,
      endMs,
    })),
  ).toEqual(words.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })));
  const undone = applyProjectEdit(corrected, { type: "undo" });
  expect(undone.cuts.map((cut) => cut.text)).toEqual(
    labels.map((label) => label.text),
  );
  const redone = applyProjectEdit(undone, { type: "redo" });
  expect(
    validateProject(serializeProject(redone)).cuts.map((cut) => cut.text),
  ).toEqual(expected);
});
it("corrects only immutable anchored word text, derived rows/cuts, and persists while preserving custom intent", () => {
  const original = fixture(),
    corrected = applyProjectEdit(original, command);
  expect(corrected.transcripts[0]!.words).toEqual([
    { id: "w1", text: "跑", startMs: 0, endMs: 200 },
    { id: "w2", text: "步", startMs: 200, endMs: 500 },
  ]);
  expect(corrected.transcripts[0]!.segments[0]).toMatchObject({
    text: "跑步",
    startMs: 0,
    endMs: 500,
    wordIds: ["w1", "w2"],
  });
  expect(corrected.cuts[0]).toMatchObject({
    text: "跑步",
    transcriptRevision: 2,
    needsReview: false,
  });
  expect(corrected.cuts[1]).toMatchObject({
    text: "My explicit label",
    transcriptRevision: 2,
  });
  expect(original.transcripts[0]!.words[1]!.text).toBe("不");
  expect(corrected.transcripts[0]!.words[0]).toBe(
    original.transcripts[0]!.words[0],
  );
  expect(validateProject(serializeProject(corrected)).transcripts[0]).toEqual(
    corrected.transcripts[0],
  );
  expect(corrected.history.past[0]!.transcripts).toBe(original.transcripts);
});
it("undo/redo restore text with increasing revisions and reconcile against restored transcript", () => {
  const corrected = applyProjectEdit(fixture(), command),
    undone = applyProjectEdit(corrected, { type: "undo" }),
    redone = applyProjectEdit(undone, { type: "redo" });
  expect(undone.transcripts[0]).toMatchObject({
    revision: 3,
    segments: [
      { id: "s1", text: "跑不", startMs: 0, endMs: 500, wordIds: ["w1", "w2"] },
    ],
  });
  expect(undone.cuts[0]).toMatchObject({
    text: "跑不",
    transcriptRevision: 3,
    needsReview: false,
  });
  expect(redone.transcripts[0]!.words[1]!.text).toBe("步");
  expect(redone.transcripts[0]!.revision).toBe(4);
  expect(redone.cuts[0]).toMatchObject({
    text: "跑步",
    transcriptRevision: 4,
    needsReview: false,
  });
});
it("later ASR prevents undo from resurrecting old recognized text and marks old cuts reviewable", () => {
  const corrected = applyProjectEdit(fixture(), command),
    old = corrected.transcripts[0]!;
  const replaced = {
    ...corrected,
    transcripts: [
      {
        ...old,
        originId: "new-ASR",
        revision: 3,
        words: old.words.map((w) => ({ ...w, id: `new-${w.id}`, text: "新" })),
        segments: [
          { ...old.segments[0]!, text: "新新", wordIds: ["new-w1", "new-w2"] },
        ],
      },
    ],
  };
  const undone = applyProjectEdit(replaced, { type: "undo" });
  expect(undone.transcripts).toBe(replaced.transcripts);
  expect(undone.cuts.every((c) => c.needsReview)).toBe(true);
  expect(undone.transcripts[0]!.words[0]!.id).toBe("new-w1");
  const redone = applyProjectEdit(undone, { type: "redo" });
  expect(redone.transcripts).toBe(replaced.transcripts);
  expect(redone.cuts.every((c) => c.needsReview)).toBe(true);
});
it("rejects stale source/revision/word identity, duplicate IDs and timestamp mutation", () => {
  const original = fixture();
  for (const change of [
    { fingerprint: "changed" },
    { transcriptRevision: 0 },
    { assetId: "unknown" },
    { changes: [{ wordId: "missing", text: "步" }] },
    {
      changes: [
        { wordId: "w2", text: "步" },
        { wordId: "w2", text: "步" },
      ],
    },
    { changes: [{ wordId: "w2", text: "步", startMs: 100 }] },
  ])
    expect(() =>
      applyProjectEdit(original, { ...command, ...change } as any),
    ).toThrow();
  expect(() => parseEditCommand({ ...command, changes: [] })).toThrow();
});
it("an explicit cut label edit remains custom even if it equals the prior generated label", () => {
  const edited = applyProjectEdit(fixture(), {
    type: "updateCut",
    cutId: "derived",
    changes: { text: "跑不" },
  });
  expect(applyProjectEdit(edited, command).cuts[0]?.text).toBe("跑不");
});
function longSegment(count: number) {
  const original = fixture();
  const words = Array.from({ length: count }, (_, index) => ({
    id: `long-${index}`,
    text: "x",
    startMs: index,
    endMs: index + 1,
  }));
  return validateProject({
    ...serializeProject(original),
    cuts: [],
    cutOrder: [],
    transcripts: [
      {
        ...original.transcripts[0]!,
        words,
        segments: [
          {
            id: "long-segment",
            text: "x".repeat(count),
            startMs: 0,
            endMs: count,
            wordIds: words.map((word) => word.id),
          },
        ],
      },
    ],
  });
}
for (const [count, replacement] of [
  [101, "a".repeat(1000)],
  [51, "😀".repeat(1000)],
] as const) {
  it(`rejects permitted ${count}-word corrections exceeding persisted UTF-16 segment limits without mutating history`, () => {
    const original = longSegment(count);
    const serialized = JSON.stringify(serializeProject(original));
    const words = original.transcripts[0]!.words;
    const edit = {
      ...command,
      changes: words.map((word) => ({ wordId: word.id, text: replacement })),
    };
    expect(parseEditCommand(edit).type).toBe("correctTranscript");
    expect(() => applyProjectEdit(original, edit)).toThrow(/too long|limit/i);
    expect(JSON.stringify(serializeProject(original))).toBe(serialized);
    expect(original.transcripts[0]!.words).toBe(words);
    expect(original.history.past).toEqual([]);
  });
}
it("checks cumulative segment growth across individually valid corrections", () => {
  const original = longSegment(101);
  const first = applyProjectEdit(original, {
    ...command,
    changes: original.transcripts[0]!.words.slice(0, 99).map((word) => ({
      wordId: word.id,
      text: "a".repeat(1000),
    })),
  });
  expect(first.transcripts[0]!.segments[0]!.text.length).toBe(99002);
  expect(
    validateProject(serializeProject(first)).transcripts[0]!.revision,
  ).toBe(2);
  const history = first.history;
  expect(() =>
    applyProjectEdit(first, {
      ...command,
      transcriptRevision: 2,
      changes: [{ wordId: "long-99", text: "b".repeat(1000) }],
    }),
  ).toThrow(/too long|limit/i);
  expect(first.history).toBe(history);
  expect(first.transcripts[0]!.revision).toBe(2);
  expect(first.transcripts[0]!.words[99]!.text).toBe("x");
});
it("rejects derived cut labels exceeding the persisted cut limit even when all segments fit", () => {
  const original = fixture();
  const words = Array.from({ length: 5001 }, (_, index) => ({
    id: `cut-word-${index}`,
    text: "a".repeat(index < 4999 ? 1000 : 500),
    startMs: index,
    endMs: index + 1,
  }));
  const segments = Array.from({ length: 51 }, (_, index) => {
    const batch = words.slice(index * 100, (index + 1) * 100);
    return {
      id: `cut-segment-${index}`,
      text: batch.map((word) => word.text).join(""),
      startMs: batch[0]!.startMs,
      endMs: batch.at(-1)!.endMs,
      wordIds: batch.map((word) => word.id),
    };
  });
  const project = validateProject({
    ...serializeProject(original),
    assets: [{ ...asset, durationMs: 6000 }],
    transcripts: [{ ...original.transcripts[0]!, words, segments }],
    cuts: [
      {
        ...original.cuts[0]!,
        startMs: 0,
        endMs: 5001,
        textSource: "derived",
        text: "a".repeat(5000000),
        wordIds: words.map((word) => word.id),
      },
    ],
    cutOrder: ["derived"],
  });
  expect(() =>
    applyProjectEdit(project, {
      ...command,
      changes: [{ wordId: "cut-word-4999", text: "b".repeat(501) }],
    }),
  ).toThrow(/too long|limit/i);
  expect(project.cuts[0]!.text.length).toBe(5000000);
  expect(project.transcripts[0]!.words[4999]!.text.length).toBe(500);
});

import { it, expect } from "vitest";
import { groupSentences } from "../../src/main/services/sentences";
import type { TimedWord, TranscriptSegment } from "../../src/shared/contracts";
const w = (
  id: string,
  text: string,
  startMs: number,
  endMs: number,
): TimedWord => ({ id, text, startMs, endMs });
const raw = (words: TimedWord[]): TranscriptSegment[] => [
  {
    id: "raw",
    text: words.map((word) => word.text).join(""),
    startMs: words[0]!.startMs,
    endMs: words.at(-1)!.endMs,
    wordIds: words.map((word) => word.id),
  },
];
it("English and Chinese punctuation splits one engine segment without changing word anchors", () => {
  const words = [
    w("a", "Hello.", 0, 300),
    w("b", " Next!", 300, 600),
    w("c", "你好。", 600, 900),
    w("d", "再见！", 900, 1200),
  ];
  const groups = groupSentences(words, raw(words), "job");
  expect(groups.map((group) => group.text)).toEqual([
    "Hello.",
    "Next!",
    "你好。",
    "再见！",
  ]);
  expect(groups.flatMap((group) => group.wordIds)).toEqual([
    "a",
    "b",
    "c",
    "d",
  ]);
  expect(groups.map((group) => [group.startMs, group.endMs])).toEqual([
    [0, 300],
    [300, 600],
    [600, 900],
    [900, 1200],
  ]);
});
it("continuations join across engine boundaries and keep the progressive sentence ID stable", () => {
  const first = [w("a", "Hello", 100, 300)];
  const firstDraft = groupSentences(first, raw(first), "job");
  const all = [
    ...first,
    w("b", " world.", 350, 600),
    w("c", " Next", 650, 900),
  ];
  const secondDraft = groupSentences(
    all,
    [
      ...raw(first),
      {
        id: "second",
        text: " world. Next",
        startMs: 350,
        endMs: 900,
        wordIds: ["b", "c"],
      },
    ],
    "job",
  );
  expect(secondDraft.map((group) => group.text)).toEqual([
    "Hello world.",
    "Next",
  ]);
  expect(secondDraft[0]!.id).toBe(firstDraft[0]!.id);
  expect(secondDraft[0]!.wordIds).toEqual(["a", "b"]);
});
it("a real 800ms pause creates a sentence boundary even without punctuation", () => {
  const words = [
    w("a", "one", 0, 200),
    w("b", " two", 999, 1200),
    w("c", " three", 2000, 2300),
  ];
  expect(
    groupSentences(words, raw(words), "job").map((group) => group.wordIds),
  ).toEqual([["a", "b"], ["c"]]);
});
it("untimed display text stays visible without creating a fake word anchor", () => {
  const words = [w("a", "Hello.", 0, 200)];
  const groups = groupSentences(
    words,
    [
      ...raw(words),
      {
        id: "untimed",
        text: "无词级时间",
        startMs: 400,
        endMs: 600,
        wordIds: [],
      },
    ],
    "job",
  );
  expect(groups.map((group) => group.text)).toEqual(["Hello.", "无词级时间"]);
  expect(groups[1]!.wordIds).toEqual([]);
});

it("late untimed punctuation changes the text of the same stable sentence without changing anchors", () => {
  const words = [
    { id: "a", text: " Hello", startMs: 0, endMs: 300 },
    { id: "b", text: " world", startMs: 300, endMs: 700 },
  ];
  const raw = [
    {
      id: "raw",
      text: " Hello world",
      startMs: 0,
      endMs: 700,
      wordIds: ["a", "b"],
    },
  ];
  const initial = groupSentences(words, raw, "job");
  const updated = groupSentences(
    [
      { ...words[0]! },
      { ...words[1]!, text: " world." },
      { id: "c", text: " Next", startMs: 750, endMs: 1000 },
    ],
    raw,
    "job",
  );
  expect(updated[0]).toMatchObject({
    id: initial[0]!.id,
    text: "Hello world.",
    startMs: 0,
    endMs: 700,
    wordIds: ["a", "b"],
  });
  expect(updated[1]?.wordIds).toEqual(["c"]);
  expect(initial[0]?.text).toBe("Hello world");
});

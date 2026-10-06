import { it, expect } from "vitest";
import { selectionToCut } from "../../src/domain/selection";
import { asset } from "./fixtures";
const words = [
  { id: "w1", text: "Hello", startMs: 100, endMs: 300 },
  { id: "w2", text: "世界", startMs: 310, endMs: 500 },
];
it("maps a backwards gesture to a chronological inclusive word range", () => {
  const c = selectionToCut(asset, words, "w2", "w1");
  expect(c).toMatchObject({
    assetId: "asset-a",
    fingerprint: "sha256:aaa",
    startMs: 100,
    endMs: 500,
    wordIds: ["w1", "w2"],
    text: "Hello世界",
    needsReview: false,
  });
});
it("rejects unknown IDs, malformed word intervals and missing media", () => {
  expect(() => selectionToCut(asset, words, "bad", "w2")).toThrow();
  expect(() =>
    selectionToCut(asset, [{ ...words[0]!, endMs: 9000 }], "w1", "w1"),
  ).toThrow();
  expect(() =>
    selectionToCut({ ...asset, status: "missing" }, words, "w1", "w2"),
  ).toThrow();
});

it.each([
  [["我", "是", "张", "示", "例", ",", "今", "天", "好"], "我是张示例,今天好"],
  [
    ["使用", "ClipDeck", "编辑", "video", "today", "。"],
    "使用ClipDeck编辑video today。",
  ],
  [[" Hello", " world", ",", " again", "!"], "Hello world, again!"],
  [["Hello", ",", "world", "!"], "Hello, world!"],
  [["(", "Hello", ",", "world", ")"], "(Hello, world)"],
  [["使用 ", "ClipDeck", " 编辑"], "使用 ClipDeck 编辑"],
])(
  "derives readable labels without changing timed anchors: %j",
  (tokens, expected) => {
    const selected = tokens.map((text, index) => ({
      id: `token-${index}`,
      text,
      startMs: index * 100,
      endMs: (index + 1) * 100,
    }));
    const original = structuredClone(selected);
    const cut = selectionToCut(
      asset,
      selected,
      selected[0]!.id,
      selected.at(-1)!.id,
    );
    expect(cut.text).toBe(expected);
    expect(cut.textSource).toBe("derived");
    expect(cut.wordIds).toEqual(selected.map((word) => word.id));
    expect(cut.startMs).toBe(0);
    expect(cut.endMs).toBe(selected.length * 100);
    expect(selected).toEqual(original);
  },
);

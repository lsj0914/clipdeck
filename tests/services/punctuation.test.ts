import { expect, it } from "vitest";
import { applyPunctuation, restorePunctuation } from "../../src/main/services/punctuation";
import path from "node:path";

it("restores punctuation while preserving word IDs, times and uncertain timing flags", () => {
  const words = [
    { id: "one", text: "你好,", startMs: 0, endMs: 300, timingNeedsReview: true },
    { id: "two", text: " 今天开始", startMs: 400, endMs: 900 },
  ];
  expect(applyPunctuation(words, ["你好，", " 今天开始。"]))
    .toEqual(words.map((word, index) => ({ ...word, text: ["你好，", " 今天开始。"][index] })));
  expect(words[0]!.text).toBe("你好,");
});

it("rejects lexical rewriting, text moved between anchors, and missing words", () => {
  const words = [{id:"one", text:"你好", startMs:0,endMs:10}, {id:"two",text:"老师",startMs:10,endMs:20}];
  for (const fragments of [["您好，", "老师。"], ["你", "好老师。"], ["你好老师。"]])
    expect(() => applyPunctuation(words, fragments)).toThrow(/Punctuation/);
});

it("protects decimal and thousands punctuation even when ASR splits an identifier", () => {
  const words = ["版本v1.", "2", "价值1", ",000元!"].map((text, index) => ({id:String(index),text,startMs:index*10,endMs:(index+1)*10}));
  expect(applyPunctuation(words, ["版本v1.", "2，", "价值1", ",000元!"])).toHaveLength(4);
  expect(() => applyPunctuation(words, ["版本v1", "2，", "价值1", "000元!"])).toThrow(/content/);
});

it.runIf(process.platform === "darwin" && !!process.env.CLIPDECK_PUNCTUATION_MODEL)("runs the real punctuation worker offline and preserves native anchors", async () => {
  const words = ["大家好", "我是老师", "今天我们学习如何使用电脑", "你们准备好了吗"].map((text, index) => ({id:String(index),text,startMs:index*1000,endMs:(index+1)*1000}));
  const result = await restorePunctuation({
    python: path.resolve(".runtime/worker/bin/python3.12"), worker: path.resolve("worker/transcribe.py"),
    directory: process.env.CLIPDECK_PUNCTUATION_MODEL!, words, signal: new AbortController().signal,
  });
  expect(result.map(({text, ...anchor}) => anchor)).toEqual(words.map(({text, ...anchor}) => anchor));
  expect(result.map(word => word.text).join("")).toContain("？");
}, 30000);

it.runIf(process.platform === "darwin" && !!process.env.CLIPDECK_PUNCTUATION_MODEL)("reports a missing local punctuation resource without a fallback or private path", async () => {
  const missing = path.resolve(".runtime/missing-punctuation-resource");
  await expect(restorePunctuation({
    python: path.resolve(".runtime/worker/bin/python3.12"), worker: path.resolve("worker/transcribe.py"),
    directory: missing, words: [{id:"one",text:"你好",startMs:0,endMs:1000}], signal: new AbortController().signal,
  })).rejects.toThrow("Missing or invalid local punctuation resource: model_quant.onnx");
}, 30000);

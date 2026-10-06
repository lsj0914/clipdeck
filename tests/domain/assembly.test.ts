import { it, expect } from "vitest";
import { validateProject } from "../../src/domain/project";
import { buildAssemblyPlan } from "../../src/domain/assembly";
import { data, cut } from "./fixtures";
it("quantizes two 400 ms cuts to exactly 24 frames and 38400 samples", () => {
  const p = data();
  p.cuts = [cut("a"), cut("b")];
  p.cutOrder = ["b", "a"];
  const plan = buildAssemblyPlan(validateProject(p));
  expect(plan.segments[0]).toMatchObject({
    cutId: "b",
    frameCount: 12,
    sampleCount: 19200,
    startFrame: 0,
    endFrame: 12,
    startSample: 0,
    endSample: 19200,
  });
  expect(plan.segments[1]).toMatchObject({
    startFrame: 12,
    endFrame: 24,
    startSample: 19200,
    endSample: 38400,
  });
  expect(plan.totalFrames).toBe(24);
  expect(plan.totalSamples).toBe(38400);
  expect(plan.durationMs).toBe(800);
});
it("accumulates integer boundaries for dozens of short cuts", () => {
  const p = data();
  p.cuts = Array.from({ length: 60 }, (_, i) => cut(`c${i}`, 0, 101));
  p.cutOrder = p.cuts.map((c) => c.id);
  const plan = buildAssemblyPlan(validateProject(p));
  expect(plan.totalFrames).toBe(240);
  expect(plan.totalSamples).toBe(384000);
  expect(plan.durationMs).toBe(8000);
});
it("blocks empty, missing, changed and review-pending assemblies", () => {
  expect(() => buildAssemblyPlan(validateProject(data()))).toThrow();
  for (const status of ["missing", "changed", "ready"] as const) {
    const p = data();
    p.cuts = [{ ...cut(), needsReview: status === "ready" }];
    p.cutOrder = ["cut-a"];
    p.assets[0]!.status = status;
    expect(() => buildAssemblyPlan(validateProject(p))).toThrow();
  }
});
it("rejects a transcript revision changed asynchronously after cut creation", () => {
  const p = data();
  p.transcripts = [
    {
      assetId: "asset-a",
      fingerprint: "sha256:aaa",
      revision: 1,
      language: "en",
      words: [{ id: "w1", text: "Hello", startMs: 100, endMs: 500 }],
      segments: [],
      model: { id: "small", digest: "digest" },
      engine: { name: "faster-whisper", version: "1" },
      parameters: { vad: false },
    },
  ];
  p.cuts = [{ ...cut(), transcriptRevision: 1, wordIds: ["w1"] }];
  p.cutOrder = ["cut-a"];
  const project = validateProject(p);
  project.transcripts = [{ ...project.transcripts[0]!, revision: 2 }];
  expect(() => buildAssemblyPlan(project)).toThrow();
});

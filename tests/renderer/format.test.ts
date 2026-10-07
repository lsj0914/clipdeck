import { describe, expect, it } from "vitest";
import type { Cut } from "../../src/shared/contracts";
import { assemblyPosition, assemblyTime } from "../../src/renderer/format";

const cut = (id: string, frames: number): Cut => ({
  id, assetId: id, fingerprint: "sha256:a", transcriptRevision: null,
  startMs: 0, endMs: Math.floor(frames * 1000 / 30), wordIds: [],
  text: id, note: "", needsReview: false,
});

describe("native assembly clock readback", () => {
  it.each([125, 392, 577, 829])("keeps the next cut at a microsecond-truncated frame %s boundary", frames => {
    const cuts = [cut("before", frames), cut("after", 30)];
    const target = assemblyTime(cuts, "after")!;
    const chromiumReadback = Math.floor(target * 1000) / 1000;
    expect(assemblyPosition(cuts, chromiumReadback)?.cut.id).toBe("after");
    expect(assemblyPosition(cuts, target - 0.1)?.cut.id).toBe("before");
  });
});

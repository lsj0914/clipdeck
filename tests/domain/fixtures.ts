import type { Asset, ProjectData, Cut } from "../../src/shared/contracts";
export const asset: Asset = {
  id: "asset-a",
  name: "Interview.mp4",
  fileRef: "media/Interview.mp4",
  status: "ready",
  fingerprint: "sha256:aaa",
  durationMs: 5000,
  width: 1920,
  height: 1080,
  rotation: 0,
  fps: 29.97,
  hasAudio: true,
};
export function cut(id = "cut-a", startMs = 100, endMs = 500): Cut {
  return {
    id,
    assetId: asset.id,
    fingerprint: asset.fingerprint,
    transcriptRevision: null,
    startMs,
    endMs,
    wordIds: [],
    text: "Opening",
    note: "",
    needsReview: false,
  };
}
export function data(): ProjectData {
  return {
    formatVersion: 1,
    id: "project-a",
    revision: 0,
    name: "Interview",
    assets: [{ ...asset }],
    transcripts: [],
    cuts: [],
    cutOrder: [],
    output: {
      preset: "landscape",
      width: 1920,
      height: 1080,
      fps: 30,
      sampleRate: 48000,
    },
    savedAt: null,
  };
}

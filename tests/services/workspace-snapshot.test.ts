import { expect, it } from "vitest";
import { WorkspaceService } from "../../src/main/services/workspace";
import { applyProjectEdit, validateProject } from "../../src/domain/project";
import { data } from "../domain/fixtures";

function workspace() {
  const service = new WorkspaceService({
    runtime: { ffmpeg: "/unavailable", ffprobe: "/unavailable", python: "/unavailable", worker: "/unavailable" },
    dataRoot: "/unavailable",
    notify: () => {},
    dialogs: { media: async () => [], open: async () => null, save: async () => null, relink: async () => null, model: async () => null },
  });
  service.project = validateProject({ ...data(), transcripts: [{
    assetId: "asset-a", fingerprint: "sha256:aaa", revision: 1, language: "en",
    words: [{ id: "word-a", text: "Hello.", startMs: 100, endMs: 500 }],
    segments: [{ id: "sentence-a", text: "Hello.", startMs: 100, endMs: 500, wordIds: ["word-a"] }],
    model: { id: "local", digest: "test" }, engine: { name: "test", version: "1" }, parameters: { vad: true },
  }] });
  return service;
}

it("keeps unchanged transcript handles across edits while preserving complete safe snapshots", () => {
  const service = workspace(), before = service.snapshot();
  expect(before.transcriptVersions?.["asset-a"]).toEqual(expect.any(String));
  service.project = applyProjectEdit(service.project, { type: "renameProject", name: "Renamed" });
  const next = service.snapshot();
  expect(next.transcriptVersions).toEqual(before.transcriptVersions);
  expect(next.project.name).toBe("Renamed");
  expect(next.project.transcripts[0]?.words[0]?.text).toBe("Hello.");
  expect(next.project.assets[0]).not.toHaveProperty("fileRef");
});

it("invalidates transcript handles after text correction and undo", () => {
  const service = workspace(), original = service.snapshot().transcriptVersions?.["asset-a"];
  service.project = applyProjectEdit(service.project, { type: "correctTranscript", assetId: "asset-a", fingerprint: "sha256:aaa", transcriptRevision: 1, changes: [{ wordId: "word-a", text: "Welcome!" }] });
  const corrected = service.snapshot();
  expect(corrected.transcriptVersions?.["asset-a"]).not.toBe(original);
  expect(corrected.project.transcripts[0]?.words[0]?.text).toBe("Welcome!");
  service.project = applyProjectEdit(service.project, { type: "undo" });
  const undone = service.snapshot();
  expect(undone.transcriptVersions?.["asset-a"]).not.toBe(corrected.transcriptVersions?.["asset-a"]);
  expect(undone.project.transcripts[0]?.words[0]?.text).toBe("Hello.");
});

it("does not confuse reopened files or another workspace with matching project and transcript revisions", () => {
  const service = workspace(), original = service.snapshot().transcriptVersions?.["asset-a"];
  service.project = validateProject({ ...data(), transcripts: [{ ...service.project.transcripts[0]!, words: [{ id: "word-a", text: "Changed outside.", startMs: 100, endMs: 500 }] }] });
  expect(service.snapshot().transcriptVersions?.["asset-a"]).not.toBe(original);
  expect(workspace().snapshot().transcriptVersions?.["asset-a"]).not.toBe(original);
  service.project = { ...service.project, transcripts: [] };
  expect(service.snapshot().transcriptVersions).toEqual({});
});

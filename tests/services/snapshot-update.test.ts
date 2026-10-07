import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { safeSnapshot } from "../../src/main/ipc";
import { createProject } from "../../src/domain/project";
import type { ClipDeckAPI, Transcript, WorkspaceSnapshot, WorkspaceUpdate } from "../../src/shared/contracts";
import { hydrateSnapshot, snapshotBasis } from "../../src/renderer/snapshot-update";

function snapshot(projectId = "project-one", version = "token-one") {
  const result = safeSnapshot(createProject());
  result.project.id = projectId;
  result.transcriptVersions = { "source-one": version };
  result.project.assets = [{ id: "source-one", name: "Synthetic speech.mp4", status: "ready",
    fingerprint: "source-hash", durationMs: 1000000, width: 640, height: 360, rotation: 0,
    fps: 30, hasAudio: true, mediaUrl: "clipdeck-media://source/one" }];
  result.capabilities.persistence = true;
  const words = Array.from({ length: 50000 }, (_, i) => ({
    id: `word-${i}`, text: `word${i} `, startMs: i * 20, endMs: i * 20 + 20,
  }));
  const transcript: Transcript = {
    assetId: "source-one", fingerprint: "source-hash", revision: 1,
    language: "en", words, segments: [],
    model: { id: "fixture", digest: "fixture" },
    engine: { name: "fixture", version: "1" }, parameters: { vad: true },
  };
  result.project.transcripts = [transcript];
  return result;
}
function preload(current: () => WorkspaceSnapshot) {
  let exposed!: ClipDeckAPI;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  vm.runInNewContext(readFileSync(new URL("../../src/main/preload.cjs", import.meta.url), "utf8"), {
    require(name: string) {
      if (name !== "electron") throw new Error("Unexpected preload import");
      return {
        contextBridge: { exposeInMainWorld(_name: string, api: ClipDeckAPI) { exposed = api; } },
        webUtils: {},
        ipcRenderer: {
          invoke: async () => ({ ok: true, value: current() }),
          on(channel: string, fn: (...args: unknown[]) => void) {
            if (!listeners.has(channel)) listeners.set(channel, new Set());
            listeners.get(channel)!.add(fn);
          },
          removeListener: (channel: string, fn: (...args: unknown[]) => void) => listeners.get(channel)?.delete(fn),
        },
      };
    },
  });
  return { api: exposed, publish: (value: WorkspaceSnapshot) => {
    for (const fn of listeners.get("clipdeck:snapshot") ?? []) fn({}, value);
  } };
}

describe("preload transcript reuse without changing the native snapshot API", () => {
  it("returns only references for unchanged text while restoring all 50,000 words in the renderer", async () => {
    const before = snapshot(), after = structuredClone(before);
    after.project.revision = 1;
    after.project.name = "Renamed";
    const p = preload(() => after);
    const update = await p.api.applyEditUpdate!({ type: "renameProject", name: "Renamed" }, snapshotBasis(before));
    expect(update.project.transcripts).toEqual([{ assetId: "source-one", referenceVersion: "token-one" }]);
    expect(JSON.stringify(update)).not.toContain("word49999");
    const full = hydrateSnapshot(update, before);
    expect(full.project.name).toBe("Renamed");
    expect(full.project.transcripts[0]).toBe(before.project.transcripts[0]);
    expect(full.project.transcripts[0]!.words).toHaveLength(50000);
    expect(full.project.transcripts[0]!.words.at(-1)?.text).toBe("word49999 ");
    const legacy = await p.api.applyEdit({ type: "renameProject", name: "Renamed" });
    expect(legacy.project.transcripts[0]!.words).toHaveLength(50000);
  });
  it("starts each update subscription with full text, then retains order, removed text and changed tokens exactly", () => {
    const first = snapshot(), p = preload(() => first);
    const legacy: WorkspaceSnapshot[] = [], updates: WorkspaceUpdate[] = [];
    p.api.subscribe(value => legacy.push(value));
    const unsubscribe = p.api.subscribeUpdates!(value => updates.push(value));
    p.publish(first);
    expect(hydrateSnapshot(updates[0]!, null).project.transcripts[0]!.words).toHaveLength(50000);
    const unchanged = structuredClone(first);
    unchanged.project.revision = 1;
    p.publish(unchanged);
    expect(updates[1]!.project.transcripts).toEqual([{ assetId: "source-one", referenceVersion: "token-one" }]);
    const changed = snapshot("project-one", "token-two");
    changed.project.transcripts[0]!.words[0]!.text = "Corrected。";
    p.publish(changed);
    expect(hydrateSnapshot(updates[2]!, first).project.transcripts[0]!.words[0]!.text).toBe("Corrected。");
    const removed = structuredClone(changed);
    removed.project.transcripts = [];
    removed.transcriptVersions = {};
    p.publish(removed);
    expect(hydrateSnapshot(updates[3]!, changed).project.transcripts).toEqual([]);
    expect(legacy.every(value => value.project.transcripts.length === 0 || value.project.transcripts[0]!.words.length === 50000)).toBe(true);
    unsubscribe();
    p.publish(first);
    expect(updates).toHaveLength(4);
    const next: WorkspaceUpdate[] = [];
    p.api.subscribeUpdates!(value => next.push(value));
    p.publish(first);
    expect(hydrateSnapshot(next[0]!, null).project.transcripts[0]!.words).toHaveLength(50000);
  });
  it("preserves the new order when one of two transcripts changes and the other is reused", async () => {
    const before = snapshot();
    const second = { ...before.project.transcripts[0]!, assetId: "source-two", words: [{ id: "second-word", text: "Second。", startMs: 0, endMs: 20 }] };
    before.project.transcripts.push(second);
    before.project.assets.push({ ...before.project.assets[0]!, id: "source-two", name: "Second.mp4" });
    before.transcriptVersions!["source-two"] = "second-old";
    const after = structuredClone(before);
    after.project.transcripts = [{ ...second, words: [{ id: "second-word", text: "Changed。", startMs: 0, endMs: 20 }] }, after.project.transcripts[0]!];
    after.transcriptVersions!["source-two"] = "second-new";
    const update = await preload(() => after).api.applyEditUpdate!({ type: "undo" }, snapshotBasis(before));
    const full = hydrateSnapshot(update, before);
    expect(full.project.transcripts.map(value => value.assetId)).toEqual(["source-two", "source-one"]);
    expect(full.project.transcripts[0]!.words[0]!.text).toBe("Changed。");
    expect(full.project.transcripts[1]).toBe(before.project.transcripts[0]);
  });
  it("sends full text for a different project or absent versions", async () => {
    const before = snapshot(), after = snapshot("project-two");
    const p = preload(() => after);
    const switched = await p.api.applyEditUpdate!({ type: "undo" }, snapshotBasis(before));
    expect(hydrateSnapshot(switched, before).project.transcripts[0]!.words).toHaveLength(50000);
    after.project.id = before.project.id;
    delete after.transcriptVersions;
    const old = await p.api.applyEditUpdate!({ type: "undo" }, snapshotBasis(before));
    expect(hydrateSnapshot(old, before).project.transcripts[0]!.words).toHaveLength(50000);
  });
  it("rejects missing, mismatched and cross-project cached references instead of inventing text", () => {
    const before = snapshot();
    const update = { ...before, project: { ...before.project, transcripts: [{ assetId: "source-one", referenceVersion: "token-one" }] } };
    expect(() => hydrateSnapshot(update, null)).toThrow(/reference/i);
    expect(() => hydrateSnapshot(update, snapshot("project-two"))).toThrow(/reference/i);
    expect(() => hydrateSnapshot(update, snapshot("project-one", "token-other"))).toThrow(/reference/i);
    expect(() => hydrateSnapshot({ ...update, transcriptVersions: { "source-one": "token-other" } }, before)).toThrow(/reference/i);
  });
});

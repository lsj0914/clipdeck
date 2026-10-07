// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import type {
  ClipDeckAPI,
  WorkspaceSnapshot,
  WorkspaceUpdate,
  EditCommand,
  CloseAction,
  ClosePreparation,
} from "../../src/shared/contracts";
import { App } from "../../src/renderer/App";
import * as reading from "../../src/renderer/reading";

describe("reviewed editing workflow", () => {
  it("uses compact edit and subscription results while keeping the transcript selectable", async () => {
    const initial = fixture();
    initial.transcriptVersions = { "source-one": "session-a-1" };
    const b = bridge(initial);
    let receive!: (update: WorkspaceUpdate) => void;
    b.api.subscribeUpdates = vi.fn(listener => { receive = listener; return () => {}; });
    b.api.applyEditUpdate = vi.fn(async (command, basis) => {
      expect(basis).toEqual({ projectId: initial.project.id, versions: [{ assetId: "source-one", version: "session-a-1" }] });
      const full = await b.api.applyEdit(command);
      const update = { ...full, project: { ...full.project, transcripts: [{ assetId: "source-one", referenceVersion: "session-a-1" }] } };
      receive(update);
      return update;
    });
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add another cut" })).toHaveProperty("disabled", false));
    expect(b.api.applyEditUpdate).toHaveBeenCalledTimes(1);
    expect(b.api.subscribeUpdates).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("list", { name: "Ordered cuts" }).textContent).toContain("今天");
    expect(screen.getByRole("button", { name: "今天" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("reloads a full snapshot for an unavailable text reference without overwriting a later update", async () => {
    const initial = fixture();
    initial.transcriptVersions = { "source-one": "session-a-1" };
    const b = bridge(initial);
    let receive!: (update: WorkspaceUpdate) => void;
    b.api.subscribeUpdates = listener => { receive = listener; return () => {}; };
    render(<App api={b.api} />);
    await screen.findByRole("button", { name: "今天" });
    let resolveReload!: (snapshot: WorkspaceSnapshot) => void;
    vi.mocked(b.api.getSnapshot).mockImplementation(() => new Promise(resolve => { resolveReload = resolve; }));
    const stale = { ...initial, transcriptVersions: { "source-one": "unknown" }, project: { ...initial.project, transcripts: [{ assetId: "source-one", referenceVersion: "unknown" }] } };
    act(() => receive(stale));
    await waitFor(() => expect(b.api.getSnapshot).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "今天" })).toBeTruthy();
    const newer = structuredClone(initial);
    newer.project.revision++;
    newer.transcriptVersions = { "source-one": "newer" };
    newer.project.transcripts[0]!.words[0]!.text = "后天，";
    act(() => receive(newer));
    await screen.findByRole("button", { name: "后天，" });
    await act(async () => resolveReload(initial));
    expect(screen.getByRole("button", { name: "后天，" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "今天" })).toBeNull();
  });
  it("keeps newer recognition when an edit-reference reload returns late", async () => {
    const initial = fixture();
    initial.transcriptVersions = { "source-one": "token-a" };
    const b = bridge(initial);
    let receive!: (value: WorkspaceUpdate) => void;
    let resolveEdit!: (value: WorkspaceUpdate) => void;
    let resolveReload!: (value: WorkspaceSnapshot) => void;
    b.api.subscribeUpdates = listener => { receive = listener; return () => {}; };
    b.api.applyEditUpdate = vi.fn(() => new Promise<WorkspaceUpdate>(resolve => { resolveEdit = resolve; }));
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    vi.mocked(b.api.getSnapshot).mockImplementation(() => new Promise(resolve => { resolveReload = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() => expect(b.api.applyEditUpdate).toHaveBeenCalledTimes(1));
    const command = vi.mocked(b.api.applyEditUpdate!).mock.calls[0]![0];
    if (command.type !== "addCut") throw new Error("Expected passage edit");
    const addedCut = command.cut;
    function recognition(label: string, token: string, revision: number) {
      const next = structuredClone(initial);
      next.project.revision = revision;
      next.transcriptVersions = { "source-one": token };
      next.project.transcripts[0]!.originId = token;
      next.project.transcripts[0]!.words[0]!.text = label;
      next.project.cuts = [{ ...addedCut, needsReview: true }];
      next.project.cutOrder = [addedCut.id];
      return next;
    }
    const middle = recognition("Recognition B", "token-b", 2);
    act(() => receive(middle));
    await screen.findByRole("button", { name: "Recognition B" });
    const edit = structuredClone(initial);
    edit.project.revision++;
    edit.project.cuts = [command.cut];
    edit.project.cutOrder = [command.cut.id];
    await act(async () => resolveEdit({ ...edit, project: { ...edit.project, transcripts: [{ assetId: "source-one", referenceVersion: "token-a" }] } }));
    await waitFor(() => expect(b.api.getSnapshot).toHaveBeenCalledTimes(2));
    act(() => receive(recognition("Recognition C", "token-c", 3)));
    await screen.findByRole("button", { name: "Recognition C" });
    await act(async () => resolveReload(middle));
    expect(screen.getByRole("button", { name: "Recognition C" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Recognition B" })).toBeNull();
  });
  it("retains the latest missing-reference resync when the older reply arrives first", async () => {
    const initial = fixture();
    initial.transcriptVersions = { "source-one": "token-a" };
    const b = bridge(initial);
    let receive!: (value: WorkspaceUpdate) => void;
    const replies: Array<(value: WorkspaceSnapshot) => void> = [];
    b.api.subscribeUpdates = listener => { receive = listener; return () => {}; };
    render(<App api={b.api} />);
    await screen.findByRole("button", { name: "今天" });
    vi.mocked(b.api.getSnapshot).mockImplementation(() => new Promise(resolve => { replies.push(resolve); }));
    const first = structuredClone(initial);
    first.project.name = "Older resync";
    first.project.revision++;
    first.transcriptVersions = { "source-one": "token-b" };
    const newer = structuredClone(first);
    newer.project.name = "Newest resync";
    newer.project.revision++;
    const reference = (full: WorkspaceSnapshot): WorkspaceUpdate => ({ ...full, project: { ...full.project, transcripts: [{ assetId: "source-one", referenceVersion: "token-b" }] } });
    act(() => receive(reference(first)));
    await waitFor(() => expect(replies).toHaveLength(1));
    act(() => receive(reference(newer)));
    await waitFor(() => expect(replies).toHaveLength(2));
    await act(async () => replies[0]!(first));
    await act(async () => replies[1]!(newer));
    expect(screen.getByLabelText("Project name")).toHaveProperty("value", "Newest resync");
  });
  it("retries only the snapshot read after a committed compact edit cannot recover its reference", async () => {
    const initial = fixture();
    initial.transcriptVersions = { "source-one": "token-a" };
    const b = bridge(initial);
    let receive!: (value: WorkspaceUpdate) => void;
    b.api.subscribeUpdates = listener => { receive = listener; return () => {}; };
    const committed = structuredClone(initial);
    committed.project.revision = 1;
    committed.transcriptVersions = { "source-one": "token-b" };
    committed.project.transcripts[0]!.words[0]!.text = "Recognition B";
    b.api.applyEditUpdate = vi.fn(async command => {
      if (command.type !== "addCut") throw new Error("Expected passage edit");
      committed.project.cuts = [{ ...command.cut, needsReview: true }];
      committed.project.cutOrder = [command.cut.id];
      receive(committed);
      return { ...initial, project: { ...committed.project, transcripts: [{ assetId: "source-one", referenceVersion: "token-a" }] } };
    });
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    vi.mocked(b.api.getSnapshot).mockRejectedValueOnce(new Error("Refresh unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Refresh unavailable");
    vi.mocked(b.api.getSnapshot).mockResolvedValue(committed);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(b.api.getSnapshot).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(b.api.applyEditUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("list", { name: "Ordered cuts" }).textContent).toContain("今天");
  });
  it("keeps the reading index and selection when an edit delivers an unchanged transcript", async () => {
    const initial = fixture();
    initial.transcriptVersions = { "source-one": "session-a-1" };
    const b = bridge(initial), rows = vi.spyOn(reading, "transcriptRows");
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add selection" }).hasAttribute("disabled")).toBe(false));
    rows.mockClear();
    await act(async () => b.emit({ ...structuredClone(b.get()), project: { ...structuredClone(b.get().project), name: "Renamed", revision: 1 } }));
    expect(screen.getByLabelText("Project name")).toHaveProperty("value", "Renamed");
    expect(screen.getByRole("button", { name: "今天" }).getAttribute("aria-pressed")).toBe("true");
    expect(rows).not.toHaveBeenCalled();
    const changed = structuredClone(b.get());
    changed.transcriptVersions = { "source-one": "session-a-2" };
    changed.project.transcripts[0]!.words[0]!.text = "明天，";
    await act(async () => b.emit(changed));
    expect(screen.getByRole("button", { name: "明天，" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "今天" })).toBeNull();
    expect(rows).toHaveBeenCalled();
  });
  it("starts assembly preparation on its own clock and synchronizes a newly loaded preview", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    const source = await screen.findByLabelText("Source video") as HTMLVideoElement;
    source.currentTime = 5.85;
    fireEvent.timeUpdate(source);
    fireEvent.click(screen.getByRole("button", { name: "Prepare assembly preview" }));
    await waitFor(() => expect(b.api.preparePreview).toHaveBeenCalled());
    expect(screen.getByLabelText("Assembly playhead")).toHaveProperty("value", "0");
    await act(async () => b.emit({ ...b.get(), jobs: [{ id: "ready-preview", kind: "preview", status: "completed", stage: "completed", processedMs: 1800, totalMs: 1800, progress: 1, error: null, cancelRequested: false, assetId: null, outputUrl: "clipdeck-media://preview/ready", projectId: b.get().project.id, projectRevision: b.get().project.revision }] }));
    const assembly = await screen.findByLabelText("Assembly video") as HTMLVideoElement;
    assembly.currentTime = 0.2;
    fireEvent.loadedMetadata(assembly);
    expect(screen.getByLabelText("Assembly playhead")).toHaveProperty("value", "200");
    assembly.currentTime = 0.25;
    fireEvent.timeUpdate(assembly);
    expect(screen.getByLabelText("Assembly playhead")).toHaveProperty("value", "250");
    expect(b.get().project.cuts).toHaveLength(2);
  });
  it("leaves the enlarged assembly player when playback fails so its recovery is visible", async () => {
    const state = assemblyFixture();
    state.jobs = [{ id: "ready-preview", kind: "preview", status: "completed", stage: "completed", processedMs: 1800, totalMs: 1800, progress: 1, error: null, cancelRequested: false, assetId: null, outputUrl: "clipdeck-media://preview/ready", projectId: state.project.id, projectRevision: state.project.revision }];
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    const player = await screen.findByLabelText("Assembly video");
    fireEvent.click(screen.getByRole("button", { name: "Expand preview" }));
    fireEvent.error(player);
    const error = await screen.findByRole("alert");
    expect(screen.queryByRole("dialog", { name: "Expanded preview" })).toBeNull();
    expect(error.textContent).toContain("This video could not be played");
    expect(document.activeElement).toBe(error);
    expect(b.get().project.cuts).toHaveLength(2);
  });
  it("returns from enlarged preview to the invalid draft when saving fails", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("listitem", { name: /Cut 1:/ }));
    fireEvent.change(screen.getByLabelText("Cut out"), { target: { value: "00:00.000" } });
    fireEvent.click(screen.getByRole("button", { name: "Expand preview" }));
    expect(screen.getByRole("dialog", { name: "Expanded preview" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Expanded preview" })).toBeNull());
    const input = screen.getByLabelText("Cut out");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input).toHaveProperty("value", "00:00.000");
    expect(b.api.saveProject).not.toHaveBeenCalled();
  });
  it("keeps a rejected save visible after leaving the enlarged player", async () => {
    const b = bridge();
    b.api.saveProject = vi.fn(async () => { throw new Error("Cannot save this project"); });
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Expand preview" }));
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    const error = await screen.findByRole("alert");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Expanded preview" })).toBeNull());
    expect(error.textContent).toContain("Cannot save this project");
    expect(document.activeElement).toBe(error);
  });
  it("shows actual assembly preparation progress and lets the user cancel from the player", async () => {
    const state = assemblyFixture();
    state.jobs = [{ id: "pending-preview", kind: "preview", status: "running", stage: "rendering cut 1 of 2", processedMs: 5000, totalMs: 36300, progress: 0.25, error: null, cancelRequested: false, assetId: null, outputUrl: null, projectId: state.project.id, projectRevision: state.project.revision }];
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    const progress = screen.getByRole("progressbar", { name: "Assembly preview preparation" });
    expect(progress).toHaveProperty("value", 0.25);
    expect(screen.getByText("rendering cut 1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel preview" }));
    await waitFor(() => expect(b.api.cancelJob).toHaveBeenCalledWith("pending-preview"));
  });
  it("expands the same player without losing its position and Escape returns to editing", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    const player = await screen.findByLabelText("Source video") as HTMLVideoElement;
    await waitFor(() => expect(screen.getByRole("button", { name: "Play playback" }).hasAttribute("disabled")).toBe(false));
    player.currentTime = 4.125;
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    // Position is deliberately set after selecting, which seeks to the chosen word.
    player.currentTime = 4.125;
    fireEvent.timeUpdate(player);
    const expand = screen.getByRole("button", { name: "Expand preview" });
    expand.focus();
    fireEvent.click(expand);
    const dialog = screen.getByRole("dialog", { name: "Expanded preview" });
    expect(dialog.contains(player)).toBe(true);
    expect(screen.getByLabelText("Source video")).toBe(player);
    expect(player.currentTime).toBe(4.125);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Return to editing" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Expanded preview" })).toBeNull();
    expect(screen.getByLabelText("Source video")).toBe(player);
    expect(player.currentTime).toBe(4.125);
    expect(screen.getByRole("button", { name: "今天" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(expand);
  });
  it("contains keyboard focus within the enlarged preview and its return button", async () => {
    render(<App api={bridge().api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Expand preview" }));
    const dialog = screen.getByRole("dialog", { name: "Expanded preview" });
    const enabled = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled)"));
    enabled.at(-1)!.focus();
    fireEvent.keyDown(enabled.at(-1)!, { key: "Tab" });
    expect(document.activeElement).toBe(enabled[0]);
    fireEvent.keyDown(enabled[0]!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(enabled.at(-1));
    fireEvent.click(screen.getByRole("button", { name: "Return to editing" }));
    expect(screen.queryByRole("dialog", { name: "Expanded preview" })).toBeNull();
  });
  it("takes a failed save back to the invalid retained draft and its field", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("listitem", { name: /Cut 1:/ }));
    fireEvent.change(screen.getByLabelText("Cut out"), { target: { value: "00:00.000" } });
    fireEvent.click(screen.getByRole("listitem", { name: /Cut 2:/ }));
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    const input = await screen.findByLabelText("Cut out");
    await waitFor(() => expect(input).toHaveProperty("value", "00:00.000"));
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Cut 1 · Review this cut's range before saving.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Review edit" })).toHaveLength(2);
    expect(b.api.saveProject).not.toHaveBeenCalled();
    expect(b.get().project.cuts[0]?.endMs).toBe(1101);
    fireEvent.change(input, { target: { value: "00:03.125" } });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => expect(b.api.saveProject).toHaveBeenCalledTimes(1));
    expect(b.get().project.cuts[0]?.endMs).toBe(3125);
  });
  it("distinguishes inspecting an existing passage from adding a fresh selection", async () => {
    const state = assemblyFixture();
    Object.assign(state.project.cuts[0]!, { wordIds: ["w1", "w2", "w3"], transcriptRevision: 3, endMs: 2600 });
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("listitem", { name: /Cut 1:/ }));
    await screen.findByRole("button", { name: "Add another cut" });
    expect(screen.getByText("Viewing cut 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "一起" }));
    expect(screen.getByRole("button", { name: "Add selection" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add another cut" })).toBeNull();
  });
  it("closes word correction with Escape, preserving selection and returning focus", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    const trigger = screen.getByRole("button", { name: "Correct text" });
    trigger.focus();
    fireEvent.click(trigger);
    const input = screen.getByLabelText("Word 1");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: "明天" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText("Correct transcript")).toBeNull();
    expect(screen.getByRole("button", { name: "今天" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(trigger);
    expect(b.api.applyEdit).not.toHaveBeenCalled();
  });
});

describe("first-use and replacement transcription feedback", () => {
  it.each(["notReady", "downloading", "failed"] as const)(
    "offers model preparation without diagnosing an unavailable worker while the model is %s",
    async (status) => {
      const initial = fixture();
      initial.project.transcripts = [];
      initial.capabilities.transcription = false;
      initial.model = { ...initial.model, status, id: null, message: "Model needs preparation" };
      render(<App api={bridge(initial).api} />);
      await screen.findByRole("button", { name: "Download selected model" });
      expect(screen.queryByText("Local transcription is unavailable. You can still select time ranges.")).toBeNull();
      expect(screen.getByRole("button", { name: "Transcribe source" })).toHaveProperty("disabled", true);
      expect(screen.getByRole("button", { name: "Use local model" })).toBeTruthy();
    },
  );
  it("reports actual worker unavailability after a verified model is ready", async () => {
    const initial = fixture();
    initial.project.transcripts = [];
    initial.capabilities.transcription = false;
    render(<App api={bridge(initial).api} />);
    await screen.findByText("Local transcription is unavailable. You can still select time ranges.");
    expect(screen.getByRole("button", { name: "Transcribe source" })).toHaveProperty("disabled", true);
  });
  const priorJob = (status: "completed" | "cancelled" | "failed"): WorkspaceSnapshot["jobs"][number] => ({
    id: "previous-asr", kind: "transcription", status, stage: status === "completed" ? "complete" : "cancelled",
    processedMs: 10000, totalMs: 10000, progress: status === "completed" ? 1 : null, error: null,
    cancelRequested: status === "cancelled", assetId: "source-one", outputUrl: null,
  });
  it("does not show or cancel the previous completed job while a replacement request is unpublished", async () => {
    const initial = fixture();
    initial.jobs = [priorJob("completed")];
    const b = bridge(initial);
    let release!: (id: string) => void;
    vi.mocked(b.api.transcribe).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Transcription settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Transcribe again" }));
    expect(screen.getByText("Transcribing · Waiting for local processing")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Transcription progress" }).hasAttribute("value")).toBe(false);
    expect(screen.queryByRole("button", { name: "Cancel transcription" })).toBeNull();
    expect(screen.getByRole("button", { name: "今天" })).toBeTruthy();
    const running = { ...priorJob("completed"), id: "new-asr", status: "running" as const, stage: "loading local model", progress: null, processedMs: 0 };
    await act(async () => { b.emit({ ...b.get(), jobs: [...initial.jobs, running] }); release("new-asr"); });
    fireEvent.click(screen.getByRole("button", { name: "Cancel transcription" }));
    expect(b.api.cancelJob).toHaveBeenCalledExactlyOnceWith("new-asr");
  });
  it.each(["failed", "completed"] as const)("clears historical errors while waiting and reports the new job when %s", async (outcome) => {
    const initial = fixture();
    initial.jobs = [{ ...priorJob("failed"), error: "Previous attempt could not check local storage" }];
    const b = bridge(initial);
    let release!: (id: string) => void;
    vi.mocked(b.api.transcribe).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    render(<App api={b.api} />);
    await screen.findByText("Previous attempt could not check local storage");
    fireEvent.click(screen.getByRole("button", { name: "Retry transcription" }));
    expect(screen.getByText("Transcribing · Waiting for local processing")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry transcription" })).toBeNull();
    const running = { ...priorJob("completed"), id: "new-asr", status: "running" as const, stage: "loading local model", progress: null, processedMs: 0 };
    await act(async () => { b.emit({ ...b.get(), jobs: [...initial.jobs, running] }); release("new-asr"); });
    expect(screen.queryByRole("alert")).toBeNull();
    const terminal = { ...running, status: outcome, stage: outcome === "failed" ? "failed" : "complete", progress: outcome === "failed" ? null : 1, error: outcome === "failed" ? "New attempt could not read the source" : null };
    await act(async () => b.emit({ ...b.get(), jobs: [...initial.jobs, terminal] }));
    if (outcome === "failed") {
      expect(screen.getByRole("alert").textContent).toContain("New attempt could not read the source");
      expect(screen.getByRole("button", { name: "Retry transcription" })).toHaveProperty("disabled", false);
    } else expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Previous attempt could not check local storage")).toBeNull();
  });
  it("reports a rejected new request instead of a historical error", async () => {
    const initial = fixture();
    initial.jobs = [{ ...priorJob("failed"), error: "Historical failure" }];
    const b = bridge(initial);
    vi.mocked(b.api.transcribe).mockRejectedValue(new Error("Current request cannot start"));
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry transcription" }));
    await screen.findByText("Current request cannot start");
    expect(screen.queryByText("Historical failure")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry transcription" })).toHaveProperty("disabled", false);
  });
  it("keeps the source visibly transcribed after a replacement is cancelled", async () => {
    const initial = fixture();
    initial.jobs = [priorJob("cancelled")];
    render(<App api={bridge(initial).api} />);
    await screen.findByText("Transcription cancelled. Your previous text is kept.");
    const source = screen.getByRole("button", { name: /^01采访 interview/ });
    expect(source.textContent).toContain("Transcribed");
    expect(source.textContent).not.toContain("cancelled");
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    expect(screen.getByRole("button", { name: "Add selection" })).toHaveProperty("disabled", false);
  });
  it("shows a single cancelled state when there is no retained transcript", async () => {
    const initial = fixture();
    initial.project.transcripts = [];
    initial.jobs = [priorJob("cancelled")];
    render(<App api={bridge(initial).api} />);
    await screen.findByRole("button", { name: "Transcribe source" });
    const source = screen.getByRole("button", { name: /^01采访 interview/ });
    expect(source.textContent).toContain("cancelled");
    expect(source.textContent).not.toContain(" · ");
    expect(screen.queryByText("Transcription cancelled. Your previous text is kept.")).toBeNull();
    expect(screen.getByText("Transcription cancelled. You can try again.")).toBeTruthy();
  });
  it.each(["missing", "changed"] as const)("prioritizes a %s source over an older cancelled transcription", async (status) => {
    const initial = fixture();
    initial.project.assets[0]!.status = status;
    initial.jobs = [priorJob("cancelled")];
    render(<App api={bridge(initial).api} />);
    const source = await screen.findByRole("button", { name: /^01采访 interview/ });
    expect(source.textContent).toContain(status === "missing" ? "Source missing" : "Source changed");
    expect(source.textContent).not.toContain("cancelled");
  });
});

function fixture(silent = false): WorkspaceSnapshot {
  return {
    project: {
      formatVersion: 1,
      id: "project-one",
      revision: 0,
      name: "Interview edit",
      assets: [
        {
          id: "source-one",
          name: "采访 interview with a very long source name.mp4",
          status: "ready",
          fingerprint: "sha256:a",
          durationMs: 10000,
          width: 1920,
          height: 1080,
          rotation: 0,
          fps: 30,
          hasAudio: !silent,
          mediaUrl: "clipdeck-media://source/source-one",
        },
      ],
      transcripts: silent
        ? []
        : [
            {
              assetId: "source-one",
              fingerprint: "sha256:a",
              revision: 3,
              language: "zh",
              words: [
                { id: "w1", text: "今天", startMs: 1000, endMs: 1500 },
                { id: "w2", text: "一起", startMs: 1500, endMs: 2000 },
                { id: "w3", text: "开始。", startMs: 2000, endMs: 2600 },
              ],
              segments: [
                {
                  id: "s1",
                  text: "今天一起开始。",
                  startMs: 1000,
                  endMs: 2600,
                  wordIds: ["w1", "w2", "w3"],
                },
              ],
              model: { id: "m", digest: "x" },
              engine: { name: "whisper", version: "1" },
              parameters: { vad: true },
            },
          ],
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
    },
    model: { status: "ready", id: "m", message: "Ready", progress: null },
    jobs: [],
    save: { dirty: false, displayName: null, recovered: false },
    canUndo: false,
    canRedo: false,
    capabilities: {
      media: true,
      transcription: true,
      rendering: true,
      persistence: true,
    },
  };
}
function bridge(initial = fixture()) {
  let state = initial;
  const listeners = new Set<(s: WorkspaceSnapshot) => void>();
  let prepareClose: ((action: CloseAction) => Promise<ClosePreparation>) | undefined;
  const emit = (next: WorkspaceSnapshot) => {
    state = next;
    listeners.forEach((l) => l(next));
  };
  const api: ClipDeckAPI = {
    getSnapshot: vi.fn(async () => state),
    subscribe: vi.fn((l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
    importMedia: vi.fn(async () => state),
    importDroppedFiles: vi.fn(async () => state),
    applyEdit: vi.fn(async (command: EditCommand) => {
      const p = structuredClone(state.project);
      p.revision++;
      if (command.type === "addCut") {
        p.cuts.push(command.cut);
        p.cutOrder.push(command.cut.id);
      }
      if (command.type === "updateCut")
        Object.assign(
          p.cuts.find((c) => c.id === command.cutId)!,
          command.changes,
        );
      if (command.type === "reorderCuts") p.cutOrder = command.cutIds;
      if (command.type === "removeCut") {
        p.cuts = p.cuts.filter((c) => c.id !== command.cutId);
        p.cutOrder = p.cutOrder.filter((id) => id !== command.cutId);
      }
      emit({
        ...state,
        project: p,
        canUndo: true,
        save: { ...state.save, dirty: true },
      });
      return state;
    }),
    transcribe: vi.fn(async () => "transcribe-1"),
    preparePreview: vi.fn(async () => "preview-1"),
    prepareSourcePreview: vi.fn(async () => "source-preview-1"),
    exportVideo: vi.fn(async () => "export-1"),
    cancelJob: vi.fn(async () => {}),
    openProject: vi.fn(async () => state),
    saveProject: vi.fn(async () => state),
    relinkMedia: vi.fn(async () => state),
    chooseModel: vi.fn(async () => state),
    downloadModel: vi.fn(async () => "model-1"),
    revealExport: vi.fn(async () => {}),
    onCloseRequested: vi.fn((listener) => {
      prepareClose = listener;
      return () => { prepareClose = undefined; };
    }),
  };
  return { api, emit, get: () => state, requestClose: (action: CloseAction) => {
    if (!prepareClose) throw new Error("Close preparation is not connected");
    return prepareClose(action);
  } };
}
let autoDecode = true;
let autoSeek = true;
let frameCallbacks: Map<HTMLVideoElement, VideoFrameRequestCallback>;
function decodedFrame(element: HTMLVideoElement, width = 1920, height = 1080) {
  act(() =>
    frameCallbacks.get(element)?.(0, {
      width,
      height,
      mediaTime: element.currentTime,
    } as VideoFrameCallbackMetadata),
  );
}
beforeEach(() => {
  autoDecode = true;
  autoSeek = true;
  localStorage.clear();
  const mediaTimes = new WeakMap<HTMLMediaElement, number>();
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockImplementation(
    function (this: HTMLMediaElement) {
      return mediaTimes.get(this) ?? 0;
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(
    function (this: HTMLMediaElement, value: number) {
      mediaTimes.set(this, value);
      if (autoSeek) this.dispatchEvent(new Event("seeked"));
    },
  );
  frameCallbacks = new Map();
  vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockReturnValue(
    1920,
  );
  vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockReturnValue(
    1080,
  );
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
  HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
    frameCallbacks.set(this, callback);
    if (autoDecode)
      queueMicrotask(() =>
        callback(0, {
          width: 1920,
          height: 1080,
          mediaTime: this.currentTime,
        } as VideoFrameCallbackMetadata),
      );
    return 1;
  };
  HTMLVideoElement.prototype.cancelVideoFrameCallback = vi.fn();
  HTMLElement.prototype.scrollTo = function (
    options?: ScrollToOptions | number,
  ) {
    if (typeof options === "object") {
      this.scrollTop = options.top ?? 0;
      this.dispatchEvent(new Event("scroll"));
    }
  };
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 600,
    height: 160,
    top: 0,
    left: 0,
    bottom: 160,
    right: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const paused = new WeakMap<HTMLMediaElement, boolean>();
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(
    function (this: HTMLMediaElement) {
      return paused.get(this) ?? true;
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
    async function (this: HTMLMediaElement) {
      paused.set(this, false);
    },
  );
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    paused.set(this, true);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.unstubAllGlobals();
});
describe("uncertain word timing recovery", () => {
  it("blocks a packed phrase cut and audition, then adds an explicitly adjusted manual range", async () => {
    const state = fixture();
    const transcript = state.project.transcripts[0]!;
    transcript.parameters.wordTimingReview = true;
    transcript.words[0] = {
      id: "w1",
      text: "A phrase without word timing",
      startMs: 1000,
      endMs: 1040,
      timingNeedsReview: true,
    };
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", {
      name: "A phrase without word timing · Timing needs review",
    }));
    expect(screen.getByRole("button", { name: "Add selection" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Audition" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    fireEvent.keyDown(window, { key: "e" });
    expect(b.api.applyEdit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review time range" }));
    expect(screen.getByRole("heading", { name: "Review passage timing" })).toBeTruthy();
    expect(screen.getByLabelText("Selection in")).toHaveProperty("value", "00:00.000");
    expect(screen.getByLabelText("Selection out")).toHaveProperty("value", "00:03.040");
    fireEvent.change(screen.getByLabelText("Selection in"), { target: { value: "1.000" } });
    fireEvent.change(screen.getByLabelText("Selection out"), { target: { value: "2.500" } });
    fireEvent.click(screen.getByRole("button", { name: "Audition source range" }));
    expect(screen.getByLabelText("Source video")).toHaveProperty("currentTime", 1);
    fireEvent.click(screen.getByRole("button", { name: "Add range" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    expect(b.get().project.cuts[0]).toMatchObject({
      startMs: 1000, endMs: 2500, wordIds: [], transcriptRevision: null,
    });
    expect(b.get().project.transcripts[0]!.words[0]).toEqual(transcript.words[0]);
  });
  it("blocks an uncertain overlapping interior word that supplies the actual out boundary", async () => {
    const state = fixture();
    const transcript = state.project.transcripts[0]!;
    transcript.parameters.wordTimingReview = true;
    transcript.words[1] = { ...transcript.words[1]!, endMs: 4500, timingNeedsReview: true };
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    fireEvent.click(screen.getByRole("button", { name: "开始。" }), { shiftKey: true });
    expect(screen.getByRole("button", { name: "Add selection" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Audition" })).toHaveProperty("disabled", true);
    fireEvent.keyDown(window, { key: "e" });
    expect(b.api.applyEdit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Review time range" })).toBeTruthy();
  });
  it("retains an interior timing warning while allowing healthy passage boundaries", async () => {
    const state = fixture();
    const transcript = state.project.transcripts[0]!;
    transcript.parameters.wordTimingReview = true;
    transcript.words[1]!.timingNeedsReview = true;
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    fireEvent.click(screen.getByRole("button", { name: "开始。" }), { shiftKey: true });
    expect(screen.getByText("Some selected text has uncertain word timing. Listen to the passage before keeping it.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add selection" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    expect(b.get().project.cuts[0]).toMatchObject({ startMs: 1000, endMs: 2600, wordIds: ["w1", "w2", "w3"] });
  });
  it("explains legacy timing provenance without rewriting a saved transcript", async () => {
    const state = fixture();
    const before = structuredClone(state.project.transcripts);
    const b = bridge(state);
    render(<App api={b.api} />);
    expect(await screen.findByText("This saved transcript does not identify uncertain word timing. Listen before cutting, or transcribe again.")).toBeTruthy();
    expect(b.get().project.transcripts).toEqual(before);
    expect(b.api.applyEdit).not.toHaveBeenCalled();
  });
  it("does not carry a timing-review draft into a different project", async () => {
    const state = fixture();
    state.project.transcripts[0]!.parameters.wordTimingReview = true;
    state.project.transcripts[0]!.words[0]!.timingNeedsReview = true;
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天 · Timing needs review" }));
    fireEvent.click(screen.getByRole("button", { name: "Review time range" }));
    fireEvent.change(screen.getByLabelText("Selection in"), { target: { value: "3.000" } });
    const next = fixture();
    next.project.id = "another-project";
    act(() => b.emit(next));
    await screen.findByRole("button", { name: "今天" });
    fireEvent.click(screen.getByRole("button", { name: "Range" }));
    expect(screen.getByLabelText("Selection in")).toHaveProperty("value", "00:00.000");
    expect(screen.getByLabelText("Selection out")).toHaveProperty("value", "00:10.000");
    expect(screen.queryByRole("heading", { name: "Review passage timing" })).toBeNull();
    expect(b.api.applyEdit).not.toHaveBeenCalled();
  });
});
describe("actual bridge workbench interactions", () => {
  it("seeks words, extends backward inclusively and adds distinct revision-bound cuts", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    await screen.findByRole("button", { name: "开始。" });
    fireEvent.click(screen.getByRole("button", { name: "开始。" }));
    expect(
      (screen.getByLabelText("Source video") as HTMLVideoElement).currentTime,
    ).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "今天" }), {
      shiftKey: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Add another cut" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(2));
    const [first, second] = b.get().project.cuts;
    expect(first).toMatchObject({
      wordIds: ["w1", "w2", "w3"],
      startMs: 1000,
      endMs: 2600,
      transcriptRevision: 3,
    });
    expect(first!.id).not.toBe(second!.id);
  });
  it("validates silent ranges without discarding invalid input, then adds a manual cut", async () => {
    const b = bridge(fixture(true));
    render(<App api={b.api} />);
    const out = await screen.findByLabelText("Selection out");
    const input = screen.getByLabelText("Selection in");
    fireEvent.change(input, { target: { value: "5.000" } });
    fireEvent.change(out, { target: { value: "4.000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add range" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /after the in/i,
    );
    expect((out as HTMLInputElement).value).toBe("4.000");
    expect(b.api.applyEdit).not.toHaveBeenCalled();
    fireEvent.change(out, { target: { value: "6.000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add range" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    expect(b.get().project.cuts[0]).toMatchObject({
      startMs: 5000,
      endMs: 6000,
      wordIds: [],
      transcriptRevision: null,
    });
  });
  it("explains invalid time ranges in Chinese and retains them for correction", async () => {
    localStorage.setItem("clipdeck.locale", "zh");
    const b = bridge(fixture(true));
    render(<App api={b.api} />);
    const start = await screen.findByLabelText("选区入点");
    const end = screen.getByLabelText("选区出点");
    fireEvent.change(start, { target: { value: "2.000" } });
    fireEvent.change(end, { target: { value: "1.000" } });
    fireEvent.click(screen.getByRole("button", { name: "加入时间段" }));
    expect(screen.getByRole("alert").textContent).toBe("出点必须晚于入点。");
    expect(end).toHaveProperty("value", "1.000");
    expect(b.api.applyEdit).not.toHaveBeenCalled();
    fireEvent.change(end, { target: { value: "11.000" } });
    fireEvent.click(screen.getByRole("button", { name: "加入时间段" }));
    expect(screen.getByRole("alert").textContent).toBe("出点不能超过原素材时长（10.000 秒）。");
    fireEvent.change(end, { target: { value: "3.000" } });
    fireEvent.click(screen.getByRole("button", { name: "加入时间段" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("reorders cuts with keyboard alternatives and invokes undo", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "一起" }));
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(2));
    const before = [...b.get().project.cutOrder];
    fireEvent.click(
      screen.getByRole("button", { name: "Move selected cut earlier" }),
    );
    await waitFor(() =>
      expect(b.get().project.cutOrder).toEqual(before.reverse()),
    );
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(b.api.applyEdit).toHaveBeenLastCalledWith({ type: "undo" }),
    );
  });
  it("focuses structured service errors and offers a working retry", async () => {
    const b = bridge({
      ...fixture(),
      project: { ...fixture().project, assets: [], transcripts: [] },
    });
    vi.mocked(b.api.importMedia).mockRejectedValueOnce({
      code: "FAILED",
      message: "This video could not be read.",
    });
    render(<App api={b.api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Choose videos" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This video could not be read.");
    await waitFor(() => expect(document.activeElement).toBe(alert));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(b.api.importMedia).toHaveBeenCalledTimes(2));
  });
  it("invalidates a completed assembly preview immediately after an edit", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    fireEvent.click(
      screen.getByRole("button", { name: "Prepare assembly preview" }),
    );
    await waitFor(() => expect(b.api.preparePreview).toHaveBeenCalled());
    await act(async () => {
      b.emit({
        ...b.get(),
        jobs: [
          {
            id: "preview-1",
            kind: "preview",
            status: "completed",
            stage: "Ready",
            processedMs: 500,
            totalMs: 500,
            progress: 1,
            error: null,
            cancelRequested: false,
            assetId: null,
            outputUrl: "clipdeck-media://preview/one",
            projectId: b.get().project.id,
            projectRevision: b.get().project.revision,
          },
        ],
      });
    });
    expect(await screen.findByLabelText("Assembly video")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add another cut" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(2));
    await waitFor(() =>
      expect(screen.queryByLabelText("Assembly video")).toBeNull(),
    );
  });
});

describe("keyboard and asynchronous workspace states", () => {
  it("gives an actionable range-editing path after an empty recognition result", async () => {
    const value = fixture();
    value.project.transcripts[0]!.words = [];
    value.project.transcripts[0]!.segments = [];
    const b = bridge(value);
    render(<App api={b.api} />);
    expect(await screen.findByText("No clear speech was detected. Listen to the source or select a time range.")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Play playback" })).toHaveProperty("disabled", false));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Select a time range instead" }));
    });
    expect(screen.getByRole("heading", { name: "Select a time range" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Range" }).getAttribute("aria-pressed")).toBe("true");
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "Select a time range" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Range" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("keeps range editing available when recognition publishes an empty result after the source is open", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    await screen.findByRole("button", { name: "今天" });
    const empty = structuredClone(b.get());
    empty.project.transcripts[0]!.words = [];
    empty.project.transcripts[0]!.segments = [];
    empty.project.transcripts[0]!.revision++;
    await act(async () => b.emit(empty));
    expect(screen.getByText("No clear speech was detected. Listen to the source or select a time range.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Select a time range instead" }));
    });
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "Select a time range" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Range" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("extends a passage by keyboard and auditions the inclusive range", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    const first = await screen.findByRole("button", { name: "今天" });
    fireEvent.click(first);
    fireEvent.keyDown(first, { key: "ArrowRight", shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Audition" }));
    const player = screen.getByLabelText("Source video") as HTMLVideoElement;
    expect(player.currentTime).toBe(1);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    player.currentTime = 2.1;
    fireEvent.timeUpdate(player);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(player.currentTime).toBe(2);
    fireEvent.keyDown(document.body, { key: "e" });
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    expect(b.get().project.cuts[0]!.wordIds).toEqual(["w1", "w2"]);
  });
  it("keeps pointer-drag endpoints after the browser dispatches the final click", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    const first = await screen.findByRole("button", { name: "今天" }),
      last = screen.getByRole("button", { name: "开始。" });
    fireEvent.pointerDown(first, { button: 0 });
    fireEvent.pointerEnter(last);
    fireEvent.pointerUp(last);
    fireEvent.click(last, { detail: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    expect(b.get().project.cuts[0]!.wordIds).toEqual(["w1", "w2", "w3"]);
  });
  it("shows an untimed live passage without allowing draft text into the assembly", async () => {
    const state = fixture();
    state.project.transcripts = [];
    state.transcriptionDrafts = {
      "source-one": {
        assetId: "source-one",
        language: "zh",
        words: [],
        segments: [{ id: "untimed-live", text: "A live passage awaiting word timing", startMs: 1000, endMs: 2000, wordIds: [] }],
      },
    };
    const b = bridge(state);
    render(<App api={b.api} />);
    expect(await screen.findByText("A live passage awaiting word timing")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review passage timing" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Select all timed text" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Add selection" })).toBeNull();
    fireEvent.keyDown(window, { key: "e" });
    expect(b.api.applyEdit).not.toHaveBeenCalled();
  });
  it("renders partial transcription without allowing draft words into the assembly", async () => {
    const state = fixture(),
      transcript = state.project.transcripts[0]!;
    state.project.transcripts = [];
    state.transcriptionDrafts = {
      "source-one": {
        assetId: "source-one",
        language: "zh",
        words: transcript.words,
        segments: transcript.segments,
      },
    };
    state.jobs = [
      {
        id: "transcribe-1",
        kind: "transcription",
        status: "running",
        stage: "Listening to source",
        processedMs: 2600,
        totalMs: 10000,
        progress: 0.26,
        error: null,
        cancelRequested: false,
        assetId: "source-one",
        outputUrl: null,
      },
    ];
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    expect(screen.queryByRole("button", { name: "Add selection" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel transcription" }),
    );
    await waitFor(() =>
      expect(b.api.cancelJob).toHaveBeenCalledWith("transcribe-1"),
    );
    await act(async () =>
      b.emit({
        ...b.get(),
        transcriptionDrafts: {},
        jobs: [{ ...state.jobs[0]!, status: "cancelled" }],
      }),
    );
    expect(screen.queryByRole("button", { name: "今天" })).toBeNull();
  });
  it("keeps already transcribed sources editable while another source is processing", async () => {
    const state = fixture();
    state.project.assets.push({
      ...state.project.assets[0]!,
      id: "second",
      name: "Second recording.mp4",
    });
    state.jobs = [
      {
        id: "t2",
        kind: "transcription",
        status: "running",
        stage: "Listening",
        processedMs: 1000,
        totalMs: 10000,
        progress: 0.1,
        error: null,
        cancelRequested: false,
        assetId: "second",
        outputUrl: null,
      },
    ];
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
  });
  it("forwards open, save and relink commands to the provided bridge", async () => {
    const state = fixture();
    state.project.assets[0]!.status = "missing";
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Relink source" }))[0]!,
    );
    await waitFor(() =>
      expect(b.api.relinkMedia).toHaveBeenCalledWith("source-one"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(b.api.openProject).toHaveBeenCalled());
    fireEvent.keyDown(document.body, {
      key: "s",
      metaKey: true,
      shiftKey: true,
    });
    await waitFor(() => expect(b.api.saveProject).toHaveBeenCalledWith(true));
  });
});

it("selects across virtualized transcript groups without mounting every word", async () => {
  const state = fixture(),
    transcript = state.project.transcripts[0]!;
  state.project.assets[0]!.durationMs = 200000;
  transcript.words = Array.from({ length: 1000 }, (_, i) => ({
    id: `word-${i}`,
    text: `word${i}`,
    startMs: i * 100,
    endMs: i * 100 + 90,
  }));
  transcript.segments = [
    {
      id: "long",
      text: "Long recording",
      startMs: 0,
      endMs: 99990,
      wordIds: transcript.words.map((w) => w.id),
    },
  ];

  const b = bridge(state);
  render(<App api={b.api} />);
  const first = await screen.findByRole("button", { name: "word0" });
  expect(document.querySelectorAll("[data-word]").length).toBeLessThan(1000);
  fireEvent.click(first);
  fireEvent.keyDown(first, { key: "End", shiftKey: true });
  fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
  await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
  expect(b.get().project.cuts[0]!.wordIds).toHaveLength(1000);
  expect(b.get().project.cuts[0]).toMatchObject({ startMs: 0, endMs: 99990 });
});

function assemblyFixture() {
  const state = fixture();
  state.project.assets.push({
    ...state.project.assets[0]!,
    id: "source-two",
    name: "Second source.mp4",
    mediaUrl: "clipdeck-media://source/source-two",
  });
  state.project.cuts = [
    {
      id: "cut-one",
      assetId: "source-one",
      fingerprint: "sha256:a",
      transcriptRevision: null,
      startMs: 1000,
      endMs: 1101,
      wordIds: [],
      text: "First beat",
      note: "",
      needsReview: false,
    },
    {
      id: "cut-two",
      assetId: "source-two",
      fingerprint: "sha256:a",
      transcriptRevision: null,
      startMs: 5000,
      endMs: 5201,
      wordIds: [],
      text: "Second beat",
      note: "",
      needsReview: false,
    },
  ];
  state.project.cutOrder = ["cut-one", "cut-two"];
  state.jobs = [
    {
      id: "preview-current",
      kind: "preview",
      status: "completed",
      stage: "Ready",
      processedMs: 367,
      totalMs: 367,
      progress: 1,
      error: null,
      cancelRequested: false,
      assetId: null,
      outputUrl: "clipdeck-media://preview/current",
      projectId: state.project.id,
      projectRevision: state.project.revision,
    },
  ];
  return state;
}
function navigationFixture() {
  const state = assemblyFixture();
  state.project.cuts[0] = { ...state.project.cuts[0]!, startMs: 800, endMs: 1401,
    text: "Opening", wordIds: ["w1"], transcriptRevision: 3 };
  state.project.cuts[1] = { ...state.project.cuts[1]!, assetId: "source-one",
    startMs: 1500, endMs: 2601, text: "Ending", wordIds: ["w2", "w3"], transcriptRevision: 3 };
  return state;
}
function expectAssemblySeek(player: HTMLVideoElement, frame: number) {
  const readback = Math.floor(player.currentTime * 1e6) / 1e6;
  expect(readback).toBeGreaterThanOrEqual(frame / 30);
  expect(readback - frame / 30).toBeLessThan(0.0000011);
}
describe("preview-mode navigation", () => {
  it.each([62, 123, 124, 125, 392, 577, 829])("seeks and loops after a microsecond-truncated native frame %s boundary", async frames => {
    const state = assemblyFixture();
    state.project.assets[0]!.durationMs = 60000;
    state.project.cuts[0] = { ...state.project.cuts[0]!, startMs: 0, endMs: Math.floor(frames * 1000 / 30) };
    render(<App api={bridge(state).api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    fireEvent.click(screen.getByRole("listitem", { name: "Cut 2: Second beat" }));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    const nativeClock = () => Math.floor(player.currentTime * 1e6) / 1e6;
    expect(nativeClock()).toBeGreaterThanOrEqual(frames / 30);
    expect(nativeClock() - frames / 30).toBeLessThan(0.0000011);
    fireEvent.click(screen.getByRole("button", { name: "Loop audition" }));
    await screen.findByRole("button", { name: "Stop loop" });
    player.currentTime += 1;
    fireEvent.timeUpdate(player);
    expect(nativeClock()).toBeGreaterThanOrEqual(frames / 30);
    expect(nativeClock() - frames / 30).toBeLessThan(0.0000011);
  });
  it("auditions a complete selection in a different containing cut", async () => {
    const state = navigationFixture();
    state.project.cuts.push({ ...state.project.cuts[1]!, id: "wide", text: "Whole passage",
      startMs: 1000, endMs: 2600, wordIds: ["w1", "w2", "w3"] });
    state.project.cutOrder.push("wide");
    render(<App api={bridge(state).api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    fireEvent.click(screen.getByRole("button", { name: "开始。" }), { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Audition" }));
    expect(screen.getByLabelText("Assembly playback context").textContent).toContain("Cut 3");
    expect((screen.getByLabelText("Assembly video") as HTMLVideoElement).paused).toBe(false);
  });
  it("retires an old loop before ordinary playback of a reordered preview", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    fireEvent.click(screen.getByRole("listitem", { name: "Cut 1: First beat" }));
    fireEvent.click(screen.getByRole("button", { name: "Loop audition" }));
    await screen.findByRole("button", { name: "Stop loop" });
    const next = structuredClone(b.get());
    next.project.revision++;
    next.project.cutOrder.reverse();
    act(() => b.emit(next));
    expect(screen.queryByRole("button", { name: "Stop loop" })).toBeNull();
    next.jobs[0]!.projectRevision = next.project.revision;
    next.jobs[0]!.outputUrl = "clipdeck-media://preview/reordered";
    act(() => b.emit({ ...next }));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    fireEvent.loadedMetadata(player);
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    player.currentTime = 0.15;
    fireEvent.timeUpdate(player);
    expect(player.paused).toBe(false);
    expect(player.currentTime).toBe(0.15);
  });
  it("extends text without cancelling a cut jump waiting for metadata", async () => {
    render(<App api={bridge(navigationFixture()).api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(0);
    fireEvent.click(screen.getByRole("listitem", { name: "Cut 2: Ending" }));
    fireEvent.click(screen.getByRole("button", { name: "开始。" }), { shiftKey: true });
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
    fireEvent.loadedMetadata(player);
    expectAssemblySeek(player, 19);
  });
  it("lets a new word target inherit playing intent while its source is still decoding", async () => {
    const state = assemblyFixture();
    state.project.transcripts.push({ ...state.project.transcripts[0]!, assetId: "source-two",
      words: [{ id: "second-word", text: "Secondword", startMs: 5500, endMs: 5900 },
        { id: "third-word", text: "Thirdword", startMs: 6000, endMs: 6500 }],
      segments: [{ id: "second-segment", text: "Secondword Thirdword", startMs: 5500, endMs: 6500, wordIds: ["second-word", "third-word"] }] });
    render(<App api={bridge(state).api} />);
    const first = await screen.findByLabelText("Source video") as HTMLVideoElement;
    await act(async () => { await first.play(); fireEvent.play(first); });
    autoDecode = false;
    fireEvent.click(screen.getByRole("listitem", { name: "Cut 2: Second beat" }));
    fireEvent.click(await screen.findByRole("button", { name: "Secondword" }));
    fireEvent.click(screen.getByRole("button", { name: "Thirdword" }));
    const last = screen.getByLabelText("Source video") as HTMLVideoElement;
    decodedFrame(last);
    await waitFor(() => expect(last.paused).toBe(false));
    expect(last.currentTime).toBe(6);
  });
  it("ignores an obsolete play rejection after switching preview modes", async () => {
    render(<App api={bridge(assemblyFixture()).api} />);
    await screen.findByLabelText("Source video");
    let reject!: (error: Error) => void;
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    fireEvent.click(screen.getByRole("button", { name: "Play playback" }));
    fireEvent.click(screen.getByRole("button", { name: "Assembly" }));
    await act(async () => reject(new Error("Interrupted obsolete source playback")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Assembly" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("keeps the preview visible when navigating a script passage", async () => {
    render(<App api={bridge(assemblyFixture()).api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly script" }));
    fireEvent.click(screen.getByRole("button", { name: /Go to cut 2/ }));
    expect(screen.getByRole("button", { name: "Inspector" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /First beat/ })).toBeTruthy();
  });
  it.each([false, true])("carries playing intent through rapid cross-source navigation (intervening word: %s)", async interveningWord => {
    const state = assemblyFixture();
    state.project.transcripts.push({ ...state.project.transcripts[0]!, assetId: "source-two",
      words: [{ id: "second-word", text: "Secondword", startMs: 5500, endMs: 5900 }],
      segments: [{ id: "second-segment", text: "Secondword", startMs: 5500, endMs: 5900, wordIds: ["second-word"] }] });
    render(<App api={bridge(state).api} />);
    const first = await screen.findByLabelText("Source video") as HTMLVideoElement;
    await act(async () => { await first.play(); fireEvent.play(first); });
    autoDecode = false;
    fireEvent.click(screen.getByRole("listitem", { name: "Cut 2: Second beat" }));
    if (interveningWord) fireEvent.click(await screen.findByRole("button", { name: "Secondword" }));
    fireEvent.click(screen.getByRole("listitem", { name: "Cut 1: First beat" }));
    const last = screen.getByLabelText("Source video") as HTMLVideoElement;
    decodedFrame(last);
    await waitFor(() => expect(last.currentTime).toBe(1));
    expect(last.paused).toBe(false);
  });
  it("auditions and loops the selected cut on the assembly clock", async () => {
    render(<App api={bridge(assemblyFixture()).api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    fireEvent.click(screen.getByRole("listitem", { name: "Cut 2: Second beat" }));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    fireEvent.click(screen.getByRole("button", { name: "Audition cut" }));
    expect(screen.getByLabelText("Assembly video")).toBe(player);
    await waitFor(() => expect(player.paused).toBe(false));
    player.currentTime = 11 / 30;
    fireEvent.timeUpdate(player);
    expect(player.paused).toBe(true);
    expect(player.currentTime).toBeCloseTo(11 / 30, 8);
    fireEvent.click(screen.getByRole("button", { name: "Loop audition" }));
    await waitFor(() => expect(player.paused).toBe(false));
    player.currentTime = 11 / 30;
    fireEvent.timeUpdate(player);
    expectAssemblySeek(player, 4);
    expect(player.paused).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Stop loop" }));
    expect(player.paused).toBe(true);
  });
  it("auditions selected text in its assembly occurrence", async () => {
    render(<App api={bridge(navigationFixture()).api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    fireEvent.click(screen.getByRole("button", { name: "开始。" }));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    fireEvent.click(screen.getByRole("button", { name: "Audition" }));
    expect(screen.getByLabelText("Assembly video")).toBe(player);
    await waitFor(() => expect(player.paused).toBe(false));
    expectAssemblySeek(player, 34);
  });
  it("lets a newer scrub supersede a metadata-delayed cut jump", async () => {
    render(<App api={bridge(assemblyFixture()).api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(0);
    fireEvent.click(screen.getByRole("listitem", { name: "Cut 2: Second beat" }));
    fireEvent.change(screen.getByLabelText("Assembly playhead"), { target: { value: "250" } });
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
    fireEvent.loadedMetadata(player);
    expect(player.currentTime).toBe(0.25);
  });
  it("keeps a pending cut jump across a name change with the same edit plan", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(0);
    fireEvent.click(screen.getByRole("listitem", { name: "Cut 2: Second beat" }));
    const next = structuredClone(b.get());
    next.project.name = "Renamed";
    next.project.revision++;
    next.jobs[0]!.projectRevision = next.project.revision;
    next.jobs[0]!.outputUrl = "clipdeck-media://preview/renamed";
    await act(async () => b.emit(next));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
    fireEvent.loadedMetadata(player);
    expectAssemblySeek(player, 4);
  });
  it.each(["Cut 1: First beat", "Cut 2: Second beat"])("preserves Source playback when navigating %s", async name => {
    render(<App api={bridge(assemblyFixture()).api} />);
    const player = await screen.findByLabelText("Source video") as HTMLVideoElement;
    await act(async () => { await player.play(); fireEvent.play(player); });
    fireEvent.click(screen.getByRole("listitem", { name }));
    await waitFor(() => expect(screen.getByLabelText("Source video")).toHaveProperty("currentTime", name.includes("Cut 2") ? 5 : 1));
    expect((screen.getByLabelText("Source video") as HTMLVideoElement).paused).toBe(false);
    expect(screen.getByRole("button", { name: "Source" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("jumps a bottom cut to its quantized assembly start without replacing the player", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    fireEvent.click(screen.getByRole("listitem", { name: "Cut 2: Second beat" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Assembly" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByLabelText("Assembly video")).toBe(player);
    expectAssemblySeek(player, 4);
    expect(screen.getByLabelText("Assembly playback context").textContent).toContain("Cut 2");
    expect(b.api.applyEdit).not.toHaveBeenCalled();
  });
  it("keeps assembly playback running across a cut from another source", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    await act(async () => { await player.play(); fireEvent.play(player); });
    fireEvent.click(screen.getByRole("listitem", { name: "Cut 2: Second beat" }));
    await waitFor(() => expect(screen.queryByLabelText("Source video")).toBeNull());
    expect(player.paused).toBe(false);
    expect(screen.getByRole("button", { name: "Pause playback" })).toBeTruthy();
  });
  it("jumps an original-text word within its assembly cut and extends without moving playback", async () => {
    const b = bridge(navigationFixture());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    fireEvent.click(screen.getByRole("button", { name: "开始。" }));
    // 601 ms -> 19 output frames; 500 ms into the next cut -> 15 frames.
    expect(screen.getByLabelText("Assembly video")).toBe(player);
    expectAssemblySeek(player, 34);
    fireEvent.click(screen.getByRole("button", { name: "一起" }), { shiftKey: true });
    expectAssemblySeek(player, 34);
    expect(screen.getByRole("button", { name: "一起" }).getAttribute("aria-pressed")).toBe("true");
  });
  it("explains text excluded by trimming while leaving assembly playback untouched", async () => {
    const state = navigationFixture();
    state.project.cuts[1]!.endMs = 1900;
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    player.currentTime = 0.3;
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole("button", { name: "开始。" }));
    expect(screen.getByLabelText("Assembly video")).toBe(player);
    expect(player.currentTime).toBe(0.3);
    expect(screen.getByRole("status").textContent).toContain("not in the assembly");
    expect(b.api.applyEdit).not.toHaveBeenCalled();
  });
  it("uses the selected occurrence when a transcript word appears in repeated cuts", async () => {
    const state = navigationFixture();
    state.project.cuts.push({ ...state.project.cuts[1]!, id: "repeat", text: "Repeated ending" });
    state.project.cutOrder.push("repeat");
    render(<App api={bridge(state).api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    fireEvent.click(screen.getByRole("listitem", { name: "Cut 3: Repeated ending" }));
    fireEvent.click(await screen.findByRole("button", { name: "开始。" }));
    expect(screen.getByLabelText("Assembly video")).toBe(player);
    expectAssemblySeek(player, 68);
    expect(screen.getByLabelText("Assembly playback context").textContent).toContain("Cut 3");
  });
  it("seeks assembly-script text and its edit action in the selected preview mode", async () => {
    render(<App api={bridge(assemblyFixture()).api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly script" }));
    fireEvent.click(screen.getByRole("button", { name: "Assembly" }));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    fireEvent.click(screen.getByRole("button", { name: "Edit cut 2" }));
    expectAssemblySeek(player, 4);
    fireEvent.click(screen.getByRole("button", { name: /Go to cut 1/ }));
    expect(player.currentTime).toBe(0);
    expect(screen.getByRole("region", { name: "Assembly script" })).toBeTruthy();
  });
  it("retains a cut target until a newly prepared assembly has loaded metadata", async () => {
    const state = assemblyFixture();
    state.jobs = [];
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    fireEvent.click(screen.getByRole("listitem", { name: "Cut 2: Second beat" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Assembly" }).getAttribute("aria-pressed")).toBe("true"));
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(0);
    await act(async () => b.emit({ ...b.get(), jobs: assemblyFixture().jobs }));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(4);
    fireEvent.loadedMetadata(player);
    expectAssemblySeek(player, 4);
    expect(screen.getByLabelText("Assembly playback context").textContent).toContain("Cut 2");
  });
  it("retires a pending cross-source inspection when the user explicitly changes mode", async () => {
    render(<App api={bridge(assemblyFixture()).api} />);
    fireEvent.click(await screen.findByRole("listitem", { name: "Cut 2: Second beat" }));
    fireEvent.click(screen.getByRole("button", { name: "Assembly" }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
    expect(screen.getByRole("button", { name: "Assembly" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByLabelText("Source video")).toBeNull();
  });
  it("does not reset the displayed clock when the active preview tab is clicked again", async () => {
    render(<App api={bridge(assemblyFixture()).api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly" }));
    const player = screen.getByLabelText("Assembly video") as HTMLVideoElement;
    player.currentTime = 0.2;
    fireEvent.timeUpdate(player);
    fireEvent.click(screen.getByRole("button", { name: "Assembly" }));
    expect(player.currentTime).toBe(0.2);
    expect(screen.getByLabelText("Assembly playhead")).toHaveProperty("value", "200");
  });
});
describe("review round one regressions", () => {
  it("clears unavailable-source selections and safely ignores the E shortcut", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    await act(async () =>
      b.emit({
        ...b.get(),
        project: {
          ...b.get().project,
          assets: [{ ...b.get().project.assets[0]!, status: "missing" }],
        },
      }),
    );
    expect(screen.queryByText("1 words selected")).toBeNull();
    fireEvent.keyDown(document.body, { key: "e" });
    await act(async () => {});
    expect(b.api.applyEdit).not.toHaveBeenCalled();
  });
  it("shows selection-helper failures without an unhandled rejection", async () => {
    const state = fixture();
    state.project.assets[0]!.durationMs = 1200;
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    fireEvent.keyDown(document.body, { key: "e" });
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(b.api.applyEdit).not.toHaveBeenCalled();
  });
  it("restores a visible keyboard entry after the focused virtual row unmounts without changing selection", async () => {
    const state = fixture(),
      t = state.project.transcripts[0]!;
    t.words = Array.from({ length: 1000 }, (_, i) => ({
      id: `word-${i}`,
      text: `word${i}`,
      startMs: i * 100,
      endMs: i * 100 + 90,
    }));
    t.segments = [];
    state.project.assets[0]!.durationMs = 100000;
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "word0" }));
    const viewport = screen.getByLabelText("Transcript");
    viewport.scrollTop = 8000;
    fireEvent.scroll(viewport);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "word0" })).toBeNull(),
    );
    screen.getByLabelText("Find in transcript").focus();
    expect(viewport.tabIndex).toBe(0);
    viewport.focus();
    expect(document.activeElement?.hasAttribute("data-word")).toBe(true);
    expect(document.activeElement?.getAttribute("data-word")).not.toBe(
      "word-0",
    );
    fireEvent.keyDown(document.body, { key: "e" });
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    expect(b.get().project.cuts[0]!.wordIds).toEqual(["word-0"]);
  });
  it("persists cut labels and loops bounded audition through multiple cycles until view changes", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(
      await screen.findByRole("listitem", { name: "Cut 1: First beat" }),
    );
    const label = await screen.findByLabelText("Cut label");
    fireEvent.change(label, { target: { value: "Opening thought" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() =>
      expect(b.get().project.cuts[0]!.text).toBe("Opening thought"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Loop audition" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop loop" })).toBeTruthy(),
    );
    const player = screen.getByLabelText("Source video") as HTMLVideoElement;
    player.currentTime = 1.15;
    fireEvent.timeUpdate(player);
    expect(player.currentTime).toBe(1);
    player.currentTime = 1.12;
    fireEvent.timeUpdate(player);
    expect(player.currentTime).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Assembly" }));
    expect(screen.queryByRole("button", { name: "Stop loop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Loop audition" })).toHaveProperty("disabled", true);
    // Editing the label advanced the project revision. Load its current preview;
    // audition must now loop that assembly rather than silently switching Source.
    await act(async () => b.emit({ ...b.get(), jobs: [{ ...assemblyFixture().jobs[0]!,
      projectRevision: b.get().project.revision }] }));
    fireEvent.click(screen.getByRole("button", { name: "Loop audition" }));
    await screen.findByRole("button", { name: "Stop loop" });
    fireEvent.click(
      screen.getByRole("listitem", { name: "Cut 2: Second beat" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop loop" })).toBeNull(),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    fireEvent.click(screen.getByRole("button", { name: "Loop audition" }));
    await screen.findByRole("button", { name: "Stop loop" });
    fireEvent.click(screen.getByRole("button", { name: /01.*采访/ }));
    expect(screen.queryByRole("button", { name: "Stop loop" })).toBeNull();
  });
  it("maps assembly frames to the active source while preserving the selected inspector cut", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(
      await screen.findByRole("listitem", { name: "Cut 1: First beat" }),
    );
    await screen.findByLabelText("Cut in");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    fireEvent.click(screen.getByRole("button", { name: "Assembly" }));
    const player = (await screen.findByLabelText(
      "Assembly video",
    )) as HTMLVideoElement;
    player.currentTime = 0.13;
    fireEvent.timeUpdate(player);
    expect(
      screen.getByLabelText("Assembly playback context").textContent,
    ).toContain("Cut 1");
    player.currentTime = 4 / 30;
    fireEvent.timeUpdate(player);
    const context = screen.getByLabelText("Assembly playback context");
    expect(context.textContent).toContain("Cut 2");
    expect(context.textContent).toContain("Second source.mp4");
    expect(context.textContent).toContain("00:05.000");
    expect(
      screen
        .getByRole("listitem", { name: "Cut 2: Second beat" })
        .getAttribute("data-playback-current"),
    ).toBe("true");
    expect(
      screen
        .getByRole("listitem", { name: "Cut 1: First beat" })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect((screen.getByLabelText("Cut in") as HTMLInputElement).value).toBe(
      "00:01.000",
    );
    fireEvent.change(screen.getByLabelText("Assembly playhead"), {
      target: { value: "200" },
    });
    expect(context.textContent).toContain("00:05.067");
    fireEvent.pause(player);
    expect(context.textContent).toContain("Cut 2");
    await act(async () =>
      b.emit({ ...b.get(), project: { ...b.get().project, revision: 1 } }),
    );
    expect(screen.queryByLabelText("Assembly playback context")).toBeNull();
  });
  it("keeps snapshot save failures visible and suppresses success until a native save clears them", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    await screen.findByRole("button", { name: "今天" });
    await act(async () =>
      b.emit({
        ...b.get(),
        save: {
          dirty: false,
          displayName: "edit.clipdeck",
          recovered: false,
          error: "Recovery file could not be saved.",
        },
      }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Recovery file could not be saved."),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save project" }));
    await waitFor(() => expect(b.api.saveProject).toHaveBeenCalled());
    expect(screen.getByRole("status").textContent).not.toContain(
      "Project saved.",
    );
    await act(async () => b.emit({ ...b.get(), jobs: [] }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Recovery file could not be saved.",
    );
    vi.mocked(b.api.saveProject).mockImplementationOnce(async () => {
      const next = { ...b.get(), save: { ...b.get().save, error: null } };
      b.emit(next);
      return next;
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save a recovery copy" }),
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(b.api.saveProject).toHaveBeenLastCalledWith(true);
  });
});

describe("review round two lifecycle regressions", () => {
  it("cancels a loop completely on source scrub and keeps explicit stop effective", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(
      await screen.findByRole("listitem", { name: "Cut 1: First beat" }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    fireEvent.click(screen.getByRole("button", { name: "Loop audition" }));
    await screen.findByRole("button", { name: "Stop loop" });
    const player = screen.getByLabelText("Source video") as HTMLVideoElement;
    const pauses = vi.mocked(HTMLMediaElement.prototype.pause).mock.calls
      .length;
    fireEvent.change(screen.getByLabelText("Source playhead"), {
      target: { value: "9000" },
    });
    expect(screen.queryByRole("button", { name: "Stop loop" })).toBeNull();
    expect(
      vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length,
    ).toBeGreaterThan(pauses);
    expect(player.currentTime).toBe(9);
    const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
    fireEvent.timeUpdate(player);
    expect(player.currentTime).toBe(9);
    expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBe(
      plays,
    );
    fireEvent.click(screen.getByRole("button", { name: "Loop audition" }));
    await screen.findByRole("button", { name: "Stop loop" });
    const nextPauses = vi.mocked(HTMLMediaElement.prototype.pause).mock.calls
      .length;
    fireEvent.click(screen.getByRole("button", { name: "Stop loop" }));
    expect(
      vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length,
    ).toBeGreaterThan(nextPauses);
  });
  it("does not restart playback when the user pauses at the loop out point", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(
      await screen.findByRole("listitem", { name: "Cut 1: First beat" }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    fireEvent.click(screen.getByRole("button", { name: "Loop audition" }));
    await screen.findByRole("button", { name: "Stop loop" });
    const player = screen.getByLabelText("Source video") as HTMLVideoElement;
    player.currentTime = 1.15;
    const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
    player.pause();
    fireEvent.pause(player);
    fireEvent.timeUpdate(player);
    expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBe(
      plays,
    );
    expect(player.currentTime).toBe(1.15);
    fireEvent.ended(player);
    expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBe(
      plays,
    );
    vi.spyOn(player, "ended", "get").mockReturnValue(true);
    player.currentTime = 10;
    fireEvent.ended(player);
    expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBe(
      plays + 1,
    );
    expect(player.currentTime).toBe(1);
  });
  it("allows forward and backward transcript traversal with one sequential keyboard entry", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    const word = await screen.findByRole("button", { name: "今天" });
    fireEvent.click(word);
    const search = screen.getByLabelText("Find in transcript");
    const selectAll = screen.getByRole("button", { name: "Select all text" });
    function tab(backward = false) {
      const active = document.activeElement as HTMLElement;
      const event = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: backward,
        bubbles: true,
        cancelable: true,
      });
      active.dispatchEvent(event);
      if (event.defaultPrevented) return;
      const stops = Array.from(
        document.querySelectorAll<HTMLElement>(
          "button,input,select,textarea,[tabindex]",
        ),
      ).filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled);
      const i = stops.indexOf(active);
      stops[i + (backward ? -1 : 1)]?.focus();
    }
    search.focus();
    await act(async () => tab());
    expect(document.activeElement).toBe(selectAll);
    await act(async () => tab());
    expect(document.activeElement).toBe(word);
    await act(async () => tab(true));
    expect(document.activeElement).toBe(selectAll);
    await act(async () => tab(true));
    expect(document.activeElement).toBe(search);
    await act(async () => tab());
    await act(async () => tab());
    await act(async () => tab());
    expect(document.activeElement).not.toBe(word);
    expect(document.activeElement).not.toBe(
      screen.getByLabelText("Transcript"),
    );
    await act(async () => tab(true));
    expect(document.activeElement).toBe(word);
    await act(async () => tab(true));
    expect(document.activeElement).toBe(selectAll);
    await act(async () => tab(true));
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(document.body, { key: "e" });
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    expect(b.get().project.cuts[0]!.wordIds).toEqual(["w1"]);
  });
});

it("keeps successfully imported sources usable while reporting each failed file", async () => {
  const state = fixture();
  state.project.assets = [];
  state.project.transcripts = [];
  const b = bridge(state);
  vi.mocked(b.api.importMedia).mockImplementation(async () => {
    const next = {
      ...fixture(),
      importFailures: [
        {
          name: "broken-video.mp4",
          message: "This file has no decodable video. Choose another file.",
        },
      ],
    };
    b.emit(next);
    return next;
  });
  render(<App api={b.api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Choose videos" }));
  expect(await screen.findByRole("button", { name: "今天" })).toBeTruthy();
  const alert = await screen.findByRole("alert", {
    name: "Videos not imported",
  });
  expect(alert.textContent).toContain("broken-video.mp4");
  expect(alert.textContent).toContain("no decodable video");
  fireEvent.click(screen.getByRole("button", { name: "Choose videos again" }));
  await waitFor(() => expect(b.api.importMedia).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("status").textContent).not.toMatch(/all.*imported/i);
});

describe("native source preview lifecycle", () => {
  function withoutProxy() {
    const s = fixture();
    s.project.assets[0]!.mediaUrl = null;
    return s;
  }
  function job(
    status: "queued" | "running" | "failed" | "cancelled" = "running",
  ) {
    return {
      id: "source-preview-1",
      projectId: "project-one",
      kind: "sourcePreview" as const,
      assetId: "source-one",
      status,
      stage: "Preparing source video",
      processedMs: 2500,
      totalMs: 10000,
      progress: 0.25,
      error: status === "failed" ? "Source conversion failed" : null,
      cancelRequested: false,
      outputUrl: null,
    };
  }
  it("keeps the active fallback message when the original decoder deadline arrives", async () => {
    autoDecode = false;
    let deadline: (() => void) | undefined;
    const original = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation((handler, delay, ...args) => {
      if (delay === 15000) {
        deadline = handler as () => void;
        return 12345 as unknown as ReturnType<typeof window.setTimeout>;
      }
      return original(handler, delay, ...args) as unknown as ReturnType<typeof window.setTimeout>;
    });
    const b = bridge();
    render(<App api={b.api} />);
    fireEvent.error(await screen.findByLabelText("Source video"));
    await waitFor(() => expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1));
    act(() => b.emit({ ...b.get(), jobs: [job()] }));
    expect(deadline).toBeTypeOf("function");
    act(() => deadline!());
    expect(screen.getByText("Preparing a compatible preview. Text editing stays available.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel source preview" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry source preview" })).toBeNull();
    expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1);
  });
  it.each(["failed", "cancelled"] as const)("clears direct fallback progress after its matching job is %s", async (status) => {
    autoDecode = false;
    const b = bridge();
    render(<App api={b.api} />);
    fireEvent.error(await screen.findByLabelText("Source video"));
    await waitFor(() => expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1));
    act(() => b.emit({ ...b.get(), jobs: [job()] }));
    expect(screen.getByRole("progressbar", { name: "Source preview preparation" })).toBeTruthy();
    act(() => b.emit({ ...b.get(), jobs: [job(status)] }));
    expect(screen.queryByRole("progressbar", { name: "Source preview preparation" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry source preview" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel source preview" })).toBeNull();
    expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1);
    if (status === "failed") expect(screen.getByRole("alert").textContent).toContain("Source conversion failed");
    else {
      expect(screen.getByText("Source preview cancelled.")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
    }
  });
  it("prepares once through delayed job publication, exposes cancellation and retries a failed job only explicitly", async () => {
    const b = bridge(withoutProxy());
    render(
      <React.StrictMode>
        <App api={b.api} />
      </React.StrictMode>,
    );
    await waitFor(() =>
      expect(b.api.prepareSourcePreview).toHaveBeenCalledExactlyOnceWith(
        "source-one",
      ),
    );
    act(() =>
      b.emit({ ...b.get(), project: { ...b.get().project, revision: 1 } }),
    );
    expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1);
    act(() => b.emit({ ...b.get(), jobs: [job()] }));
    expect(
      await screen.findByRole("progressbar", {
        name: "Source preview preparation",
      }),
    ).toHaveProperty("value", 0.25);
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel source preview" }),
    );
    expect(b.api.cancelJob).toHaveBeenCalledWith("source-preview-1");
    act(() => b.emit({ ...b.get(), jobs: [job("failed")] }));
    expect(await screen.findByText("Source conversion failed")).toBeTruthy();
    expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry source preview" }),
    );
    await waitFor(() =>
      expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(2),
    );
  });
  it("ignores late request errors from an old project and prepares a relinked source again", async () => {
    const b = bridge(withoutProxy());
    let rejectOld!: (error: unknown) => void;
    vi.mocked(b.api.prepareSourcePreview).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOld = reject;
        }),
    );
    render(<App api={b.api} />);
    await waitFor(() =>
      expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1),
    );
    const next = withoutProxy();
    next.project.id = "new-project";
    act(() => b.emit(next));
    await waitFor(() =>
      expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(2),
    );
    await act(async () => rejectOld({ message: "Old project failed" }));
    expect(screen.queryByText("Old project failed")).toBeNull();
    act(() =>
      b.emit({
        ...b.get(),
        jobs: [{ ...job("failed"), projectId: "new-project" }],
      }),
    );
    act(() =>
      b.emit({
        ...b.get(),
        jobs: [],
        project: {
          ...b.get().project,
          assets: b
            .get()
            .project.assets.map((a) => ({ ...a, status: "missing" as const })),
        },
      }),
    );
    act(() =>
      b.emit({
        ...b.get(),
        project: {
          ...b.get().project,
          assets: b
            .get()
            .project.assets.map((a) => ({ ...a, status: "ready" as const })),
        },
      }),
    );
    await waitFor(() =>
      expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(3),
    );
  });
  it("keeps playback disabled for metadata or audio-only frames and opens it only for a decoded video frame", async () => {
    autoDecode = false;
    const b = bridge();
    render(<App api={b.api} />);
    const player = (await screen.findByLabelText(
      "Source video",
    )) as HTMLVideoElement;
    const play = screen.getByRole("button", {
      name: "Play playback",
    }) as HTMLButtonElement;
    expect(play.disabled).toBe(true);
    fireEvent.loadedMetadata(player);
    fireEvent.canPlay(player);
    expect(play.disabled).toBe(true);
    decodedFrame(player, 0, 0);
    expect(play.disabled).toBe(true);
    decodedFrame(player);
    await waitFor(() => expect(play.disabled).toBe(false));
  });
  it("retains a same-source pending word seek, but replacing a URL invalidates old frames and an active audition", async () => {
    autoDecode = false;
    const b = bridge(withoutProxy());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "开始。" }));
    act(() =>
      b.emit({
        ...b.get(),
        project: {
          ...b.get().project,
          assets: b.get().project.assets.map((a) => ({
            ...a,
            mediaUrl: "clipdeck-media://proxy/one",
          })),
        },
      }),
    );
    const player = (await screen.findByLabelText(
      "Source video",
    )) as HTMLVideoElement;
    fireEvent.loadedMetadata(player);
    expect(player.currentTime).toBe(2);
    decodedFrame(player);
    fireEvent.click(screen.getByRole("button", { name: "Audition" }));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    const plays = vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length;
    const oldFrame = frameCallbacks.get(player)!;
    act(() =>
      b.emit({
        ...b.get(),
        project: {
          ...b.get().project,
          assets: b.get().project.assets.map((a) => ({
            ...a,
            mediaUrl: "clipdeck-media://proxy/two",
          })),
        },
      }),
    );
    const replacement = screen.getByLabelText(
      "Source video",
    ) as HTMLVideoElement;
    expect(replacement).not.toBe(player);
    expect(
      (screen.getByLabelText("Source playhead") as HTMLInputElement).value,
    ).toBe("0");
    expect(
      (
        screen.getByRole("button", {
          name: "Play playback",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    act(() =>
      oldFrame(0, { width: 1920, height: 1080 } as VideoFrameCallbackMetadata),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Play playback",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.loadedMetadata(replacement);
    decodedFrame(replacement);
    expect(vi.mocked(HTMLMediaElement.prototype.play).mock.calls.length).toBe(
      plays,
    );
  });
  it("reprepares after same-fingerprint proxy revocation and job retirement without spinning on cancellation", async () => {
    const initial = fixture();
    initial.jobs = [job("cancelled")];
    const b = bridge(initial);
    render(<App api={b.api} />);
    await screen.findByLabelText("Source video");
    act(() =>
      b.emit({
        ...b.get(),
        jobs: [],
        project: {
          ...b.get().project,
          assets: b.get().project.assets.map((a) => ({ ...a, mediaUrl: null })),
        },
      }),
    );
    await waitFor(() =>
      expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1),
    );
    act(() => b.emit({ ...b.get(), jobs: [job("cancelled")] }));
    expect(await screen.findByText("Source preview cancelled.")).toBeTruthy();
    expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1);
    act(() => b.emit({ ...b.get(), jobs: [] }));
    await waitFor(() =>
      expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(2),
    );
  });
  it("does not revive an errored source from a late decoded callback and retry remounts the video", async () => {
    autoDecode = false;
    const b = bridge();
    render(<App api={b.api} />);
    const player = (await screen.findByLabelText(
      "Source video",
    )) as HTMLVideoElement;
    fireEvent.error(player);
    decodedFrame(player);
    expect(
      (
        screen.getByRole("button", {
          name: "Play playback",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText("Preparing a compatible preview. Text editing stays available.")).toBeTruthy();
    await waitFor(() => expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1));
    act(() => b.emit({ ...b.get(), jobs: [job("failed")] }));
    expect(screen.getByRole("alert").textContent).toContain("Source conversion failed");
    fireEvent.click(
      screen.getByRole("button", { name: "Retry source preview" }),
    );
    const next = screen.getByLabelText("Source video") as HTMLVideoElement;
    expect(next).not.toBe(player);
    decodedFrame(next);
    expect(
      (
        screen.getByRole("button", {
          name: "Play playback",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("waits for a new source's decoded frame before auditioning an inspected cut from another source", async () => {
    autoDecode = false;
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(
      await screen.findByRole("listitem", { name: "Cut 1: First beat" }),
    );
    await screen.findByLabelText("Cut label");
    fireEvent.click(screen.getByRole("button", { name: /Second source.mp4/ }));
    const other = screen.getByLabelText("Source video") as HTMLVideoElement;
    decodedFrame(other);
    fireEvent.click(screen.getByRole("button", { name: "Loop audition" }));
    const target = screen.getByLabelText("Source video") as HTMLVideoElement;
    expect(target.dataset.assetId).toBe("source-one");
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    decodedFrame(target);
    await waitFor(() =>
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled(),
    );
    expect(target.currentTime).toBe(1);
    expect(screen.getByRole("button", { name: "Stop loop" })).toBeTruthy();
  });
  it("allows a fresh request when reopening the same project after an unpublished request failure", async () => {
    const b = bridge(withoutProxy());
    vi.mocked(b.api.prepareSourcePreview).mockRejectedValueOnce({
      message: "Could not start conversion",
    });
    render(<App api={b.api} />);
    expect(await screen.findByText("Could not start conversion")).toBeTruthy();
    vi.mocked(b.api.openProject).mockResolvedValue(withoutProxy());
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() =>
      expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(2),
    );
  });
  it("does not enqueue another conversion from a historic retry card while a new source job is active", async () => {
    const initial = withoutProxy();
    initial.jobs = [job("failed")];
    const b = bridge(initial);
    vi.mocked(b.api.prepareSourcePreview).mockResolvedValue("source-preview-2");
    render(<App api={b.api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry source preview" }),
    );
    await waitFor(() =>
      expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1),
    );
    act(() =>
      b.emit({
        ...b.get(),
        jobs: [job("failed"), { ...job("queued"), id: "source-preview-2" }],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Processing/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Retry source preview" }),
    );
    await act(async () => {});
    expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1);
  });
  it("settles a terminal job published before its request promise resolves", async () => {
    const b = bridge(withoutProxy());
    let resolve!: (id: string) => void;
    vi.mocked(b.api.prepareSourcePreview).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    render(<App api={b.api} />);
    await waitFor(() =>
      expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1),
    );
    act(() => b.emit({ ...b.get(), jobs: [job("failed")] }));
    await act(async () => resolve("source-preview-1"));
    expect(
      await screen.findByRole("button", { name: "Retry source preview" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("progressbar", { name: "Source preview preparation" }),
    ).toBeNull();
  });
});

describe("large cut label presentation", () => {
  it("bounds card and accessible text while preserving full saved content and explicit full-text editing", async () => {
    const state = assemblyFixture();
    const full = "采访 passage ".repeat(22000) + "Original ending";
    state.project.cuts[0]!.text = full;
    state.project.cuts[0]!.wordIds = ["w1", "w2", "w3"];
    const b = bridge(state);
    render(<App api={b.api} />);
    const card = (await screen.findAllByRole("listitem"))[0]!;
    expect(card.textContent!.length).toBeLessThan(400);
    expect(card.getAttribute("aria-label")!.length).toBeLessThan(240);
    expect((card.getAttribute("title") ?? "").length).toBeLessThan(240);
    fireEvent.click(card);
    expect(screen.queryByRole("textbox", { name: "Cut label" })).toBeNull();
    expect(screen.queryByDisplayValue(full)).toBeNull();
    fireEvent.change(screen.getByLabelText("Cut out"), {
      target: { value: "1.200" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(b.get().project.cuts[0]!.endMs).toBe(1200));
    expect(b.get().project.cuts[0]!.text).toBe(full);
    expect(b.get().project.cuts[0]!.wordIds).toEqual(["w1", "w2", "w3"]);
    fireEvent.click(
      screen.getByRole("button", { name: "Read or edit full text" }),
    );
    const editor = screen.getByRole("textbox", {
      name: "Cut label",
    }) as HTMLTextAreaElement;
    expect(editor.value).toBe(full);
    expect(editor.maxLength).toBeGreaterThan(full.length);
    fireEvent.change(editor, { target: { value: full + " corrected" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() =>
      expect(b.get().project.cuts[0]!.text).toBe(full + " corrected"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide full text" }));
    expect(screen.queryByRole("textbox", { name: "Cut label" })).toBeNull();
    expect(card.textContent!.length).toBeLessThan(400);
    expect(b.get().project.cuts[0]!.wordIds).toEqual(["w1", "w2", "w3"]);
  });
});

describe("source integration review regressions", () => {
  async function waitingCrossSourceAudition() {
    autoDecode = false;
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(
      await screen.findByRole("listitem", { name: "Cut 1: First beat" }),
    );
    await screen.findByLabelText("Cut label");
    fireEvent.click(screen.getByRole("button", { name: /Second source.mp4/ }));
    decodedFrame(screen.getByLabelText("Source video") as HTMLVideoElement);
    fireEvent.click(screen.getByRole("button", { name: "Loop audition" }));
    const target = screen.getByLabelText("Source video") as HTMLVideoElement;
    expect(target.dataset.assetId).toBe("source-one");
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    return { b, target };
  }

  it("cancels a deferred audition when its saved cut boundaries change before the frame arrives", async () => {
    const { b, target } = await waitingCrossSourceAudition();
    fireEvent.change(screen.getByLabelText("Cut in"), {
      target: { value: "2.000" },
    });
    fireEvent.change(screen.getByLabelText("Cut out"), {
      target: { value: "3.000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(b.get().project.cuts[0]!.startMs).toBe(2000));
    decodedFrame(target);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Stop loop" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Loop audition" }));
    await waitFor(() =>
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1),
    );
    expect(target.currentTime).toBe(2);
    target.currentTime = 3;
    fireEvent.timeUpdate(target);
    expect(target.currentTime).toBe(2);
  });

  it("keeps a newer word seek instead of reviving the deferred audition on a late frame", async () => {
    const { target } = await waitingCrossSourceAudition();
    fireEvent.click(screen.getByRole("button", { name: "开始。" }));
    expect(target.currentTime).toBe(2);
    decodedFrame(target);
    expect(target.currentTime).toBe(2);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Stop loop" })).toBeNull();
  });

  it.each(["failed", "cancelled"] as const)(
    "can retry an offscreen source again after its replacement job is %s",
    async (status) => {
      const state = assemblyFixture();
      state.project.assets[1]!.mediaUrl = null;
      const failed: WorkspaceSnapshot["jobs"][number] = {
        id: "b-original",
        projectId: state.project.id,
        kind: "sourcePreview",
        assetId: "source-two",
        status: "failed",
        stage: "Source conversion failed",
        processedMs: 0,
        totalMs: 10000,
        progress: null,
        error: "Source conversion failed",
        cancelRequested: false,
        outputUrl: null,
      };
      state.jobs = [failed];
      const b = bridge(state);
      vi.mocked(b.api.prepareSourcePreview)
        .mockResolvedValueOnce("b-retry-one")
        .mockResolvedValueOnce("b-retry-two");
      render(<App api={b.api} />);
      await screen.findByLabelText("Source video");
      fireEvent.click(screen.getByRole("button", { name: /Processing/ }));
      fireEvent.click(
        screen.getByRole("button", { name: "Retry source preview" }),
      );
      await waitFor(() =>
        expect(b.api.prepareSourcePreview).toHaveBeenCalledExactlyOnceWith(
          "source-two",
        ),
      );
      act(() =>
        b.emit({
          ...b.get(),
          jobs: [
            { ...failed, id: "b-retry-one", status: "running", error: null },
          ],
        }),
      );
      act(() =>
        b.emit({
          ...b.get(),
          jobs: [{ ...failed, id: "b-retry-one", status }],
        }),
      );
      expect(
        (screen.getByLabelText("Source video") as HTMLVideoElement).dataset
          .assetId,
      ).toBe("source-one");
      fireEvent.click(
        screen.getByRole("button", { name: "Retry source preview" }),
      );
      await waitFor(() =>
        expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(2),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Retry source preview" }),
      );
      expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(2);
      expect(
        (screen.getByLabelText("Source video") as HTMLVideoElement).dataset
          .assetId,
      ).toBe("source-one");
    },
  );

  it("keeps keyboard focus on the long-text disclosure when hiding its editor", async () => {
    const state = assemblyFixture();
    state.project.cuts[0]!.text = "Long passage ".repeat(100);
    render(<App api={bridge(state).api} />);
    fireEvent.click((await screen.findAllByRole("listitem"))[0]!);
    const open = screen.getByRole("button", { name: "Read or edit full text" });
    fireEvent.click(open);
    const editor = screen.getByRole("textbox", { name: "Cut label" });
    expect(document.activeElement).toBe(editor);
    const hide = screen.getByRole("button", { name: "Hide full text" });
    hide.focus();
    fireEvent.click(hide);
    const disclosure = screen.getByRole("button", {
      name: "Read or edit full text",
    });
    expect(document.activeElement).toBe(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(
      document.getElementById(disclosure.getAttribute("aria-controls")!),
    ).toBeTruthy();
    fireEvent.click(disclosure);
    expect(
      screen
        .getByRole("button", { name: "Hide full text" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });
});

describe("Task 7 complete editing workflow", () => {
  it("finds a cross-token phrase without replacing the edit selection", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "开始。" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Find in transcript" }),
      { target: { value: "今天一起" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(
      screen
        .getByRole("button", { name: "开始。" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByText("1 / 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select match" }));
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() =>
      expect(b.get().project.cuts[0]?.wordIds).toEqual(["w1", "w2"]),
    );
  });
  it("keeps inspector drafts across cut switches and flushes them before keyboard save", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("listitem", { name: /Cut 1:/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cut note" }), {
      target: { value: "Keep this thought" },
    });
    fireEvent.click(screen.getByRole("listitem", { name: /Cut 2:/ }));
    fireEvent.click(screen.getByRole("listitem", { name: /Cut 1:/ }));
    expect(
      (screen.getByRole("textbox", { name: "Cut note" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Keep this thought");
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => expect(b.api.saveProject).toHaveBeenCalled());
    expect(b.get().project.cuts[0]?.note).toBe("Keep this thought");
    expect(vi.mocked(b.api.applyEdit).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(b.api.saveProject).mock.invocationCallOrder[0]!,
    );
  });
  it("blocks project save on invalid retained boundaries and accepts timecode input", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("listitem", { name: /Cut 1:/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cut out" }), {
      target: { value: "00:00.500" },
    });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await screen.findByText(/out point must be after/);
    expect(b.api.saveProject).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Cut out" }), {
      target: { value: "00:03.125" },
    });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => expect(b.api.saveProject).toHaveBeenCalled());
    expect(b.get().project.cuts[0]?.endMs).toBe(3125);
  });
  it("corrects selected anchored words while retaining the playhead and selection", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    fireEvent.click(screen.getByRole("button", { name: "Correct text" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Word 1" }), {
      target: { value: "明天" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply correction" }));
    await waitFor(() =>
      expect(b.api.applyEdit).toHaveBeenCalledWith({
        type: "correctTranscript",
        assetId: "source-one",
        fingerprint: "sha256:a",
        transcriptRevision: 3,
        changes: [{ wordId: "w1", text: "明天" }],
      }),
    );
    const next = structuredClone(b.get());
    next.project.transcripts[0]!.revision++;
    next.project.transcripts[0]!.words[0]!.text = "明天";
    act(() => b.emit(next));
    expect(
      (
        screen.getByRole("slider", {
          name: "Source playhead",
        }) as HTMLInputElement
      ).value,
    ).toBe("1000");
    expect(
      screen.getByRole("button", { name: "明天" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });
  it("retains the transcript during re-recognition and guards unpublished duplicate requests", async () => {
    const b = bridge();
    let release!: (id: string) => void;
    vi.mocked(b.api.transcribe).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(<App api={b.api} />);
    await screen.findByRole("button", { name: "今天" });
    fireEvent.click(
      screen.getByRole("button", { name: "Transcription settings" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Names and vocabulary" }),
      { target: { value: "张示例, project management" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Transcribe again" }));
    expect(screen.getByRole("button", { name: "今天" })).toBeTruthy();
    expect(b.api.transcribe).toHaveBeenCalledTimes(1);
    expect(b.api.transcribe).toHaveBeenCalledWith("source-one", "zh", {
      vocabulary: "张示例, project management",
    });
    act(() => release("new-asr"));
  });
  it("shows full ordered assembly script without switching back to source playback", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Assembly script" }),
    );
    const script = screen.getByRole("region", { name: "Assembly script" });
    expect(script.textContent?.indexOf("First beat")).toBeLessThan(
      script.textContent?.indexOf("Second beat")!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit cut 2" }));
    expect(
      screen.getByRole("region", { name: "Assembly script" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "View in source" })).toBeTruthy();
  });
  it("persists a separate Chinese interface locale without changing recognition language", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    await screen.findByRole("button", { name: "今天" });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Interface language" }),
      { target: { value: "zh" } },
    );
    expect(screen.getByRole("button", { name: "导出视频" })).toBeTruthy();
    expect(localStorage.getItem("clipdeck.locale")).toBe("zh");
    expect(b.api.transcribe).not.toHaveBeenCalled();
    localStorage.clear();
  });
  it("automatically requests one fallback after direct video failure and does not loop on proxy failure", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    const direct = await screen.findByLabelText("Source video");
    expect(b.api.prepareSourcePreview).not.toHaveBeenCalled();
    fireEvent.error(direct);
    fireEvent.error(direct);
    await waitFor(() =>
      expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1),
    );
    const next = structuredClone(b.get());
    next.project.assets[0]!.mediaUrl = "clipdeck-media://source/proxy";
    act(() => b.emit(next));
    fireEvent.error(screen.getByLabelText("Source video"));
    expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1);
  });
  it("describes a live compatible-preview recovery before offering a terminal retry", async () => {
    autoDecode = false;
    const b = bridge();
    render(<App api={b.api} />);
    const direct = await screen.findByLabelText("Source video");
    fireEvent.error(direct);
    fireEvent.error(direct);
    await waitFor(() => expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1));
    const job: WorkspaceSnapshot["jobs"][number] = {
      id: "source-preview-1", kind: "sourcePreview", assetId: "source-one",
      status: "running", stage: "preparing source video", processedMs: 0,
      totalMs: 10000, progress: 0, error: null, outputUrl: null,
      cancelRequested: false,
    };
    act(() => b.emit({ ...b.get(), jobs: [job] }));
    expect(screen.getByText("Preparing a compatible preview. Text editing stays available.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel source preview" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry source preview" })).toBeNull();
    act(() => b.emit({ ...b.get(), jobs: [{ ...job, status: "failed", error: "Neutral preview failure" }] }));
    expect(screen.getByRole("alert").textContent).toContain("Neutral preview failure");
    expect(screen.getByRole("button", { name: "Retry source preview" })).toBeTruthy();
  });
});

describe("Task 7 readiness and long reading regressions", () => {
  it("explains excessive vocabulary in Chinese and retains it for correction and retry", async () => {
    const b = bridge();
    vi.mocked(b.api.transcribe).mockRejectedValueOnce(new Error(
      "Vocabulary is too long for this model. Keep only the most important names and terms.",
    ));
    render(<App api={b.api} />);
    await screen.findByRole("button", { name: "今天" });
    fireEvent.change(screen.getByLabelText("Interface language"), { target: { value: "zh" } });
    fireEvent.click(screen.getByRole("button", { name: "转写设置" }));
    const field = screen.getByLabelText("人名与术语提示");
    fireEvent.change(field, { target: { value: "复杂".repeat(200) } });
    fireEvent.click(screen.getByRole("button", { name: "重新转写" }));
    expect((await screen.findByRole("alert")).textContent).toContain("提示词过长，请只保留最重要的人名与术语");
    expect(field).toHaveProperty("value", "复杂".repeat(200));
    expect(screen.getByRole("button", { name: "今天" })).toBeTruthy();
    fireEvent.change(field, { target: { value: "张示例，项目管理" } });
    fireEvent.click(screen.getByRole("button", { name: "重试转写" }));
    await waitFor(() => expect(b.api.transcribe).toHaveBeenLastCalledWith("source-one", "zh", { vocabulary: "张示例，项目管理" }));
  });
  it("keeps a manual range and source playhead when background transcription finishes", async () => {
    const initial = fixture();
    initial.project.transcripts = [];
    const b = bridge(initial);
    render(<App api={b.api} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Play playback" })).toHaveProperty("disabled", false));
    fireEvent.click(await screen.findByRole("button", { name: "Range" }));
    fireEvent.change(screen.getByLabelText("Selection in"), { target: { value: "5.125" } });
    fireEvent.change(screen.getByLabelText("Selection out"), { target: { value: "8.375" } });
    fireEvent.change(screen.getByLabelText("Source playhead"), { target: { value: "7500" } });
    const next = structuredClone(b.get());
    next.project.revision++;
    next.project.transcripts = fixture().project.transcripts;
    act(() => b.emit(next));
    expect(screen.getByRole("button", { name: "Range" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Selection in")).toHaveProperty("value", "5.125");
    expect(screen.getByLabelText("Selection out")).toHaveProperty("value", "8.375");
    expect(screen.getByLabelText("Source playhead")).toHaveProperty("value", "7500");
    fireEvent.click(screen.getByRole("button", { name: "Add range" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    expect(b.get().project.cuts[0]).toMatchObject({ startMs: 5125, endMs: 8375, wordIds: [] });
  });
  it("keeps the assembly workspace when replacement transcription invalidates its preview", async () => {
    const initial = assemblyFixture();
    initial.project.transcripts[0]!.originId = "old-recognition";
    const b = bridge(initial);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Assembly script" }));
    expect(screen.getByLabelText("Assembly video")).toBeTruthy();
    const next = structuredClone(b.get());
    next.project.revision++;
    next.project.transcripts[0]!.originId = "replacement-recognition";
    act(() => b.emit(next));
    expect(screen.getByRole("region", { name: "Assembly script" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Assembly" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByLabelText("Source video")).toBeNull();
    expect(screen.queryByLabelText("Assembly video")).toBeNull();
    expect(screen.getByText("Prepare a preview of your current assembly.")).toBeTruthy();
  });
  it("keeps first-source actions visible while optional vocabulary settings can open and close", async () => {
    const initial = fixture();
    initial.project.transcripts = [];
    const b = bridge(initial);
    render(<App api={b.api} />);
    const action = await screen.findByRole("button", { name: "Transcribe source" });
    const settings = screen.getByRole("button", { name: "Transcription settings" });
    expect(settings.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("textbox", { name: "Names and vocabulary" })).toBeNull();
    fireEvent.click(settings);
    fireEvent.change(screen.getByRole("textbox", { name: "Names and vocabulary" }), {
      target: { value: "A retained term" },
    });
    fireEvent.click(settings);
    expect(settings.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("textbox", { name: "Names and vocabulary" })).toBeNull();
    expect((action as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(action);
    expect(b.api.transcribe).toHaveBeenCalledWith("source-one", "auto", {
      vocabulary: "A retained term",
    });
  });
  it("requires a completed real seek as well as a decoded frame for the current URL", async () => {
    autoDecode = false;
    autoSeek = false;
    const b = bridge();
    render(<App api={b.api} />);
    const el = (await screen.findByLabelText(
      "Source video",
    )) as HTMLVideoElement;
    decodedFrame(el);
    expect(
      (
        screen.getByRole("button", {
          name: "Play playback",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.loadedMetadata(el);
    fireEvent.canPlay(el);
    expect(
      (
        screen.getByRole("button", {
          name: "Play playback",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.seeked(el);
    expect(
      (
        screen.getByRole("button", {
          name: "Play playback",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    const next = structuredClone(b.get());
    next.project.assets[0]!.mediaUrl = "clipdeck-media://source/new";
    act(() => b.emit(next));
    fireEvent.seeked(el);
    decodedFrame(el);
    expect(
      (
        screen.getByRole("button", {
          name: "Play playback",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("keeps an unpublished transcription flight guarded after leaving and returning to text", async () => {
    const initial = fixture();
    initial.project.transcripts = [];
    const b = bridge(initial);
    let release!: (id: string) => void;
    vi.mocked(b.api.transcribe).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    render(<App api={b.api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Transcribe source" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Range" }));
    fireEvent.click(screen.getByRole("button", { name: "Text" }));
    expect(
      (
        screen.getByRole("button", {
          name: "Transcribing…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(b.api.transcribe).toHaveBeenCalledTimes(1);
    act(() => release("asr-new"));
  });
  it("selects the whole transcript explicitly and searches an English phrase across punctuation rows", async () => {
    const initial = fixture();
    const transcript = initial.project.transcripts[0]!;
    transcript.words = Array.from({ length: 160 }, (_, index) => ({
      id: `en-${index}`,
      text:
        index === 119
          ? "project"
          : index === 120
            ? "management"
            : `phrase${index}.`,
      startMs: index * 30,
      endMs: (index + 1) * 30,
    }));
    const b = bridge(initial);
    render(<App api={b.api} />);
    await screen.findByRole("textbox", { name: "Find in transcript" });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Find in transcript" }),
      { target: { value: "project management" } },
    );
    expect(screen.getByText("1 / 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select all text" }));
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() =>
      expect(b.get().project.cuts[0]?.wordIds).toHaveLength(160),
    );
  });
  it("prepares a chosen model with a guarded request instead of assuming catalog means installed", async () => {
    const initial = fixture();
    initial.project.transcripts = [];
    initial.model = {
      status: "notReady",
      id: null,
      message: "Choose a model",
      progress: null,
      available: [
        { choice: "small", label: "Whisper small", bytes: 500000000 },
        { choice: "turbo", label: "Whisper turbo", bytes: 1600000000 },
      ],
    };
    const b = bridge(initial);
    render(<App api={b.api} />);
    await screen.findByRole("button", { name: "Transcribe source" });
    expect(
      (
        screen.getByRole("button", {
          name: "Transcribe source",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(
      screen.getByRole("combobox", { name: "Recognition model" }),
      { target: { value: "turbo" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Download selected model" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Download selected model" }),
    );
    await waitFor(() => expect(b.api.downloadModel).toHaveBeenCalledTimes(1));
    expect(b.api.downloadModel).toHaveBeenCalledWith("turbo");
  });
  it("keeps failed draft commits unsaved and allows corrected retry without losing user input", async () => {
    const b = bridge(assemblyFixture());
    vi.mocked(b.api.applyEdit).mockRejectedValueOnce(
      new Error("Local edit failed; retry."),
    );
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("listitem", { name: /Cut 1:/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cut note" }), {
      target: { value: "Retain despite failure" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save project" }));
    await screen.findByText("Local edit failed; retry.");
    expect(b.api.saveProject).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("textbox", { name: "Cut note" }) as HTMLTextAreaElement)
        .value,
    ).toBe("Retain despite failure");
    fireEvent.click(screen.getByRole("button", { name: "Save project" }));
    await waitFor(() => expect(b.api.saveProject).toHaveBeenCalled());
    expect(b.get().project.cuts[0]?.note).toBe("Retain despite failure");
  });
});

describe("Task 7 recovery and completed delivery", () => {
  it("shows a local cleanup warning in the selected interface language", async () => {
    const state = fixture();
    state.cleanupWarnings = ["Some temporary files could not be cleared. Check that your export folder is available and your disk has free space, then restart ClipDeck."];
    localStorage.setItem("clipdeck.locale", "zh");
    render(<App api={bridge(state).api} />);
    await screen.findByText("部分临时文件未能清理。请确认导出文件夹可用且磁盘有剩余空间，再重新打开 ClipDeck。");
  });
  it("flushes a focused project name, cut draft and correction before native close", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("listitem", { name: /Cut 1:/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cut note" }), { target: { value: "Preserve on close" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Named before closing" } });
    let result: ClosePreparation | undefined;
    await act(async () => { result = await b.requestClose("apply"); });
    expect(result).toEqual({ ready: true, locale: "en" });
    expect(b.get().project.cuts[0]?.note).toBe("Preserve on close");
    expect(b.api.applyEdit).toHaveBeenCalledWith({ type: "renameProject", name: "Named before closing" });
    expect(document.querySelector(".app")?.hasAttribute("inert")).toBe(true);
    await act(async () => { await b.requestClose("resume"); });
    expect(document.querySelector(".app")?.hasAttribute("inert")).toBe(false);
  });
  it("keeps invalid close drafts available for correction or explicit discard", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("listitem", { name: /Cut 1:/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cut out" }), { target: { value: "00:00.100" } });
    let result: ClosePreparation | undefined;
    await act(async () => { result = await b.requestClose("apply"); });
    expect(result).toMatchObject({ ready: false, canDiscard: true });
    expect(b.api.applyEdit).not.toHaveBeenCalled();
    await act(async () => { await b.requestClose("resume"); });
    expect((screen.getByRole("textbox", { name: "Cut out" }) as HTMLInputElement).value).toBe("00:00.100");
    await act(async () => { result = await b.requestClose("discard"); await b.requestClose("resume"); });
    expect(result?.ready).toBe(true);
    expect((screen.getByRole("textbox", { name: "Cut out" }) as HTMLInputElement).value).toBe("00:01.101");
  });
  it("preserves unapplied word corrections during native close", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    fireEvent.click(screen.getByRole("button", { name: "Correct text" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Word 1" }), { target: { value: "明天" } });
    await act(async () => { expect((await b.requestClose("apply")).ready).toBe(true); });
    expect(b.api.applyEdit).toHaveBeenCalledWith({
      type: "correctTranscript", assetId: "source-one", fingerprint: "sha256:a", transcriptRevision: 3,
      changes: [{ wordId: "w1", text: "明天" }],
    });
  });
  it("falls back once when no decoded frame arrives before the deadline", async () => {
    autoDecode = false;
    let timeout: TimerHandler | undefined;
    const original = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation(
      (handler, delay, ...args) => {
        if (delay === 15000) {
          timeout = handler;
          return 12345 as unknown as ReturnType<typeof window.setTimeout>;
        }
        return original(handler, delay, ...args) as unknown as ReturnType<
          typeof window.setTimeout
        >;
      },
    );
    const b = bridge();
    render(<App api={b.api} />);
    await screen.findByLabelText("Source video");
    expect(typeof timeout).toBe("function");
    act(() => {
      (timeout as () => void)();
      (timeout as () => void)();
    });
    await waitFor(() =>
      expect(b.api.prepareSourcePreview).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
  });
  it("continues edge dragging until pointer release without requiring repeated mouse movement", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    const first = await screen.findByRole("button", { name: "今天" });
    const viewport = screen.getByLabelText("Transcript");
    fireEvent.pointerDown(first, { button: 0, clientY: 30 });
    fireEvent.pointerMove(window, { clientY: 180 });
    await waitFor(() => expect(viewport.scrollTop).toBeGreaterThan(14));
    fireEvent.pointerUp(window);
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() =>
      expect(b.get().project.cuts[0]?.wordIds).toEqual(["w1", "w2", "w3"]),
    );
  });
  it("shows export parameters before native destination selection and plays only a completed job URL", async () => {
    const state = assemblyFixture();
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Export video" }),
    );
    expect(b.api.exportVideo).not.toHaveBeenCalled();
    expect(
      (await screen.findByLabelText("Export summary")).textContent,
    ).toContain("1920 × 1080");
    fireEvent.click(
      screen.getByRole("button", { name: "Choose destination and export" }),
    );
    await waitFor(() => expect(b.api.exportVideo).toHaveBeenCalledTimes(1));
    const completed = {
      ...state.jobs[0]!,
      id: "delivered",
      kind: "export" as const,
      status: "completed" as const,
      outputUrl: "clipdeck-media://approved/export-result",
    };
    act(() => b.emit({ ...b.get(), jobs: [completed] }));
    fireEvent.click(
      screen.getByRole("button", { name: "Play exported video" }),
    );
    expect(screen.getByLabelText("Exported video").getAttribute("src")).toBe(
      completed.outputUrl,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show exported video" }),
    );
    await waitFor(() =>
      expect(b.api.revealExport).toHaveBeenCalledWith("delivered"),
    );
  });
  it("enlarges the delivered file in place and Escape restores its player before returning to editing", async () => {
    const state = assemblyFixture();
    state.jobs = [{ ...state.jobs[0]!, id: "delivered", kind: "export", status: "completed",
      outputUrl: "clipdeck-media://approved/export-result" }];
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Processing" }));
    const open = screen.getByRole("button", { name: "Play exported video" });
    open.focus();
    fireEvent.click(open);
    const player = screen.getByLabelText("Exported video") as HTMLVideoElement;
    vi.spyOn(player, "duration", "get").mockReturnValue(116.8);
    fireEvent.loadedMetadata(player);
    player.currentTime = 4.125;
    const dialog = screen.getByRole("dialog", { name: "Completed export" });
    const expand = dialog.querySelector<HTMLButtonElement>('button[aria-label="Expand preview"]')!;
    expect(expand).toBeTruthy();
    fireEvent.click(expand);
    expect(expand.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("Exported video")).toBe(player);
    expect(player.currentTime).toBe(4.125);
    expect(player.controls).toBe(false);
    expect(screen.getByRole("button", { name: "Play exported file" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export video" }).closest("header")?.hasAttribute("inert")).toBe(true);
    // The app owns transport controls instead of relying on browser shadow controls.
    const play = screen.getByRole("button", { name: "Play exported file" });
    expect(play).toHaveProperty("disabled", false);
    play.addEventListener("keydown", (event) => event.stopPropagation());
    play.focus();
    fireEvent.keyDown(play, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Completed export" })).toBe(dialog);
    expect(expand.getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByLabelText("Exported video")).toBe(player);
    expect(player.currentTime).toBe(4.125);
    fireEvent.keyDown(play, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Completed export" })).toBeNull();
    expect(b.api.exportVideo).not.toHaveBeenCalled();
    expect(b.api.applyEdit).not.toHaveBeenCalled();
  });
  it("keeps delivered-file keyboard focus inside its viewer and starts the next viewing unexpanded", async () => {
    const state = assemblyFixture();
    state.jobs = [{ ...state.jobs[0]!, id: "delivered", kind: "export", status: "completed",
      outputUrl: "clipdeck-media://approved/export-result" }];
    render(<App api={bridge(state).api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Processing" }));
    fireEvent.click(screen.getByRole("button", { name: "Play exported video" }));
    const dialog = screen.getByRole("dialog", { name: "Completed export" });
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button,video"));
    controls.at(-1)!.focus();
    fireEvent.keyDown(controls.at(-1)!, { key: "Tab" });
    expect(document.activeElement).toBe(controls[0]);
    fireEvent.keyDown(controls[0]!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(controls.at(-1));
    const expand = dialog.querySelector<HTMLButtonElement>('button[aria-label="Expand preview"]')!;
    fireEvent.click(expand);
    fireEvent.click(screen.getByRole("button", { name: "Back to editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Processing" }));
    fireEvent.click(screen.getByRole("button", { name: "Play exported video" }));
    expect(screen.getByRole("dialog", { name: "Completed export" }).querySelector('button[aria-label="Expand preview"]')?.getAttribute("aria-pressed")).toBe("false");
  });
  it("keeps original English token separators when correcting a word", async () => {
    const state = fixture();
    state.project.transcripts[0]!.words[0]!.text = " today";
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "today" }));
    fireEvent.click(screen.getByRole("button", { name: "Correct text" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Word 1" }), {
      target: { value: "tomorrow" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply correction" }));
    await waitFor(() =>
      expect(b.api.applyEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "correctTranscript",
          changes: [{ wordId: "w1", text: " tomorrow" }],
        }),
      ),
    );
  });
});

it("retains rejected correction input and selection with an actionable native error", async () => {
  const b = bridge();
  vi.mocked(b.api.applyEdit).mockRejectedValueOnce(
    new Error(
      "Correction would exceed the project text limit. Shorten the replacement.",
    ),
  );
  render(<App api={b.api} />);
  fireEvent.click(await screen.findByRole("button", { name: "今天" }));
  fireEvent.click(screen.getByRole("button", { name: "Correct text" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Word 1" }), {
    target: { value: "明天" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply correction" }));
  await screen.findByText(/Correction would exceed/);
  expect(
    (screen.getByRole("textbox", { name: "Word 1" }) as HTMLInputElement).value,
  ).toBe("明天");
  expect(
    screen.getByRole("button", { name: "今天" }).getAttribute("aria-pressed"),
  ).toBe("true");
  expect(b.api.saveProject).not.toHaveBeenCalled();
});

it("retains a pending note without turning a newer derived correction back into a custom old label", async () => {
  const state = assemblyFixture();
  const b = bridge(state);
  render(<App api={b.api} />);
  fireEvent.click(await screen.findByRole("listitem", { name: /Cut 1:/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Cut note" }), {
    target: { value: "Keep this note" },
  });
  const next = structuredClone(b.get());
  next.project.cuts[0]!.text = "Corrected derived words";
  act(() => b.emit(next));
  expect(
    (screen.getByRole("textbox", { name: "Cut label" }) as HTMLInputElement)
      .value,
  ).toBe("Corrected derived words");
  fireEvent.keyDown(window, { key: "s", metaKey: true });
  await waitFor(() => expect(b.api.saveProject).toHaveBeenCalled());
  expect(b.get().project.cuts[0]?.text).toBe("Corrected derived words");
  expect(b.get().project.cuts[0]?.note).toBe("Keep this note");
  expect(vi.mocked(b.api.applyEdit).mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({
      changes: { startMs: 1000, endMs: 1101, note: "Keep this note" },
    }),
  );
});

it("keeps phrase navigation and selection scrolling outside nested React flushes", async () => {
  const errors = vi.spyOn(console, "error");
  const state = fixture();
  state.project.transcripts[0]!.words = Array.from(
    { length: 1000 },
    (_, i) => ({
      id: `scroll-${i}`,
      text: `reading${i}.`,
      startMs: i * 8,
      endMs: i * 8 + 7,
    }),
  );
  const b = bridge(state);
  render(<App api={b.api} />);
  const search = await screen.findByLabelText("Find in transcript");
  const viewport = screen.getByLabelText("Transcript");
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () =>
      Number.parseFloat(
        (viewport.firstElementChild as HTMLElement).style.height,
      ),
  });
  fireEvent.change(search, { target: { value: "reading900." } });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "reading900." })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Select match" }));
  fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
  await waitFor(() =>
    expect(b.get().project.cuts[0]?.wordIds).toEqual(["scroll-900"]),
  );
  fireEvent.click(screen.getByRole("button", { name: "Assembly script" }));
  expect(
    screen.getByRole("region", { name: "Assembly script" }).textContent,
  ).toContain("reading900.");
  expect(
    errors.mock.calls.filter((args) =>
      args.some((arg) => String(arg).includes("flushSync")),
    ),
  ).toEqual([]);
});

describe("Task 7 review round one persistence and submission boundaries", () => {
  it.each(["cancelled", "failed"])(
    "rechecks canonical dirty work on repeated Open after a %s save",
    async (outcome) => {
      const b = bridge(assemblyFixture());
      vi.mocked(b.api.saveProject).mockImplementation(async () => {
        if (outcome === "failed") throw new Error("Save failed. Retry saving.");
        return b.get();
      });
      render(<App api={b.api} />);
      fireEvent.click(await screen.findByRole("listitem", { name: /Cut 1:/ }));
      fireEvent.change(screen.getByRole("textbox", { name: "Cut note" }), {
        target: { value: "Persist before leaving" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Open project" }));
      await screen.findByText(
        outcome === "failed"
          ? "Save failed. Retry saving."
          : "Save the current project before opening another project.",
      );
      fireEvent.click(screen.getByRole("button", { name: "Open project" }));
      await waitFor(() => expect(b.api.saveProject).toHaveBeenCalledTimes(2));
      expect(b.api.openProject).not.toHaveBeenCalled();
      expect(b.get().project.cuts[0]?.note).toBe("Persist before leaving");
      vi.mocked(b.api.saveProject).mockImplementation(async () => {
        const next = {
          ...b.get(),
          save: {
            dirty: false,
            displayName: "safe.clipdeck",
            recovered: false,
          },
        };
        b.emit(next);
        return next;
      });
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(b.api.openProject).toHaveBeenCalledTimes(1));
    },
  );
  it("keeps a newly accepted draft when an older navigation save resolves", async () => {
    const b = bridge(assemblyFixture());
    let resolveSave!: (s: WorkspaceSnapshot) => void;
    vi.mocked(b.api.saveProject).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("listitem", { name: /Cut 1:/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cut note" }), {
      target: { value: "First draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(b.api.saveProject).toHaveBeenCalledTimes(1));
    // Exercise the accepted-change handler even though normal busy UI prevents typing.
    fireEvent.change(screen.getByRole("textbox", { name: "Cut note" }), {
      target: { value: "Newer unsaved draft" },
    });
    const saved = {
      ...b.get(),
      save: { dirty: false, displayName: "safe.clipdeck", recovered: false },
    };
    await act(async () => resolveSave(saved));
    expect(b.api.openProject).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("textbox", { name: "Cut note" }) as HTMLInputElement)
        .value,
    ).toBe("Newer unsaved draft");
  });
  it("locks correction inputs while the submitted correction is pending and restores them on rejection", async () => {
    const b = bridge();
    let rejectEdit!: (error: Error) => void;
    vi.mocked(b.api.applyEdit).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectEdit = reject;
        }),
    );
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    fireEvent.click(screen.getByRole("button", { name: "Correct text" }));
    const input = screen.getByRole("textbox", {
      name: "Word 1",
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "明天" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply correction" }));
    expect(input.disabled).toBe(true);
    await act(async () =>
      rejectEdit(new Error("Correction failed. Try again.")),
    );
    expect(input.disabled).toBe(false);
    expect(input.value).toBe("明天");
    expect(screen.getByLabelText("Correct transcript")).toBeTruthy();
  });
  it("validates and applies boundaries before displaying the export summary", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("listitem", { name: /Cut 1:/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cut out" }), {
      target: { value: "00:08.000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export video" }));
    const summary = await screen.findByLabelText("Export summary");
    expect(summary.textContent).toContain("00:07.233");
    expect(summary.textContent).not.toContain("00:00.367");
    expect(b.get().project.cuts[0]?.endMs).toBe(8000);
    expect(b.api.exportVideo).not.toHaveBeenCalled();
  });
  it("keeps invalid export drafts actionable without showing an old summary", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("listitem", { name: /Cut 1:/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cut out" }), {
      target: { value: "0.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export video" }));
    await screen.findByText("The out point must be after the in point.");
    expect(screen.queryByLabelText("Export summary")).toBeNull();
    expect(b.api.exportVideo).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("textbox", { name: "Cut out" }) as HTMLInputElement)
        .value,
    ).toBe("0.5");
  });
  it("requires a fresh export review after the reviewed assembly changes", async () => {
    const b = bridge(assemblyFixture());
    render(<App api={b.api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Export video" }),
    );
    await screen.findByLabelText("Export summary");
    const next = structuredClone(b.get());
    next.project.revision++;
    next.project.cuts[0]!.endMs = 8000;
    act(() => b.emit(next));
    fireEvent.click(
      screen.getByRole("button", { name: "Choose destination and export" }),
    );
    expect(b.api.exportVideo).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Update export summary" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Export summary").textContent).toContain(
        "00:07.233",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Choose destination and export" }),
    );
    await waitFor(() => expect(b.api.exportVideo).toHaveBeenCalledTimes(1));
  });
});

it("does not accept newer correction typing before an earlier successful Apply completes", async () => {
  const b = bridge();
  let resolveEdit!: (s: WorkspaceSnapshot) => void;
  vi.mocked(b.api.applyEdit).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveEdit = resolve;
      }),
  );
  render(<App api={b.api} />);
  fireEvent.click(await screen.findByRole("button", { name: "今天" }));
  fireEvent.click(screen.getByRole("button", { name: "Correct text" }));
  const input = screen.getByRole("textbox", {
    name: "Word 1",
  }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "明天" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply correction" }));
  expect(input.disabled).toBe(true);
  fireEvent.change(input, { target: { value: "后天" } });
  expect(input.value).toBe("明天");
  expect(
    (screen.getByRole("button", { name: "Close" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => resolveEdit(b.get()));
  expect(screen.queryByLabelText("Correct transcript")).toBeNull();
  expect(vi.mocked(b.api.applyEdit).mock.calls[0]?.[0]).toEqual(
    expect.objectContaining({ changes: [{ wordId: "w1", text: "明天" }] }),
  );
});

describe("Task 7 first-run Open guard", () => {
  function untouchedWorkspace() {
    const state = fixture();
    state.project.name = "Untitled project";
    state.project.assets = [];
    state.project.transcripts = [];
    state.project.cuts = [];
    state.project.cutOrder = [];
    state.project.revision = 0;
    state.project.savedAt = null;
    state.save = { dirty: true, displayName: null, recovered: false };
    return state;
  }
  it("shows Opening rather than Importing while loading a saved project", async () => {
    const b = bridge(untouchedWorkspace());
    let resolveOpen!: (snapshot: WorkspaceSnapshot) => void;
    vi.mocked(b.api.openProject).mockImplementation(() => new Promise(resolve => { resolveOpen = resolve; }));
    render(<App api={b.api} />);
    const open = await screen.findByRole("button", { name: "Open project" });
    await waitFor(() => expect(open).toHaveProperty("disabled", false));
    fireEvent.click(open);
    await waitFor(() => expect(b.api.openProject).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Open project" }).textContent).toContain("Opening…");
    expect(screen.getByRole("button", { name: "Choose videos" })).toHaveProperty("disabled", true);
    expect(screen.queryByText("Importing…")).toBeNull();
    expect(b.api.importMedia).not.toHaveBeenCalled();
    await act(async () => resolveOpen(fixture()));
    await screen.findByRole("button", { name: "今天" });
  });
  it("opens the native project picker directly from an untouched new empty workspace", async () => {
    const b = bridge(untouchedWorkspace());
    let resolveInitial!: (snapshot: WorkspaceSnapshot) => void;
    vi.mocked(b.api.getSnapshot).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve;
        }),
    );
    render(<App api={b.api} />);
    const open = (await screen.findByRole("button", {
      name: "Open project",
    })) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    fireEvent.click(open);
    expect(b.api.openProject).not.toHaveBeenCalled();
    expect(b.api.saveProject).not.toHaveBeenCalled();
    await act(async () => resolveInitial(b.get()));
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    await waitFor(() => expect(b.api.openProject).toHaveBeenCalledTimes(1));
    expect(b.api.saveProject).not.toHaveBeenCalled();
  });
  it.each([
    "renamed",
    "imported",
    "edited",
    "recovered",
    "save error",
    "previously saved",
    "undo history",
  ])("still saves a %s workspace before Open", async (kind) => {
    const state = untouchedWorkspace();
    if (kind === "renamed") state.project.name = "My empty edit";
    if (kind === "imported") state.project.assets = fixture().project.assets;
    if (kind === "edited") state.project.revision = 1;
    if (kind === "recovered") state.save.recovered = true;
    if (kind === "save error") state.save.error = "Local save failed";
    if (kind === "previously saved") {
      state.save.displayName = "empty.clipdeck";
      state.project.savedAt = "2026-10-06T12:00:00.000Z";
    }
    if (kind === "undo history") state.canUndo = true;
    const b = bridge(state);
    render(<App api={b.api} />);
    const open = (await screen.findByRole("button", {
      name: "Open project",
    })) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(false));
    fireEvent.click(open);
    await waitFor(() => expect(b.api.saveProject).toHaveBeenCalledTimes(1));
    expect(b.api.openProject).not.toHaveBeenCalled();
    await screen.findByText(
      "Save the current project before opening another project.",
    );
  });
});

describe("Task 7 natural derived text and localized assembly", () => {
  it.each(["__proto__", "constructor", "toString"])(
    "preserves an unknown model error %s as literal text",
    async (message) => {
      localStorage.setItem("clipdeck.locale", "zh");
      const initial = fixture();
      initial.model = { ...initial.model, status: "failed", message };
      const b = bridge(initial);
      render(<App api={b.api} />);
      fireEvent.click(await screen.findByRole("button", { name: /^任务进度/ }));
      expect(screen.getByLabelText("任务进度").textContent).toContain(message);
    },
  );
  it("keeps recovered edits visibly unsaved until a successful save", async () => {
    localStorage.setItem("clipdeck.locale", "zh");
    const initial = fixture();
    initial.save.recovered = true;
    const b = bridge(initial);
    render(<App api={b.api} />);
    await screen.findByText("已恢复项目");
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    fireEvent.click(screen.getByRole("button", { name: "加入成片" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    expect(screen.getByText("已恢复项目 · 有未保存修改")).toBeTruthy();
    b.api.saveProject = vi.fn(async () => {
      b.emit({ ...b.get(), save: {
        dirty: false, recovered: false, displayName: "recovered.clipdeck",
      } });
      return b.get();
    });
    fireEvent.click(screen.getByRole("button", { name: "保存项目" }));
    await screen.findByText("已保存到本地");
    expect(screen.queryByText("已恢复项目 · 有未保存修改")).toBeNull();
  });

  it("localizes live transcription stages in the source, settings and task queue", async () => {
    localStorage.setItem("clipdeck.locale", "zh");
    const initial = fixture();
    initial.jobs = [{
      id: "live-transcription", kind: "transcription", assetId: "source-one",
      status: "running", stage: "loading local model", processedMs: 0,
      totalMs: 10000, progress: null, error: null, cancelRequested: false,
      outputUrl: null,
    }];
    const b = bridge(initial);
    const { container } = render(<App api={b.api} />);
    await screen.findByText("进行中 · 正在加载本地模型");
    fireEvent.click(screen.getByRole("button", { name: /^任务进度/ }));
    for (const [stage, translated] of [
      ["decoding audio", "正在读取音频"],
      ["transcribing", "正在识别语音"],
      ["restoring punctuation", "正在恢复标点"],
    ]) {
      act(() => b.emit({ ...b.get(), jobs: [{ ...b.get().jobs[0]!, stage: stage! }] }));
      expect(screen.getByText(`进行中 · ${translated}`)).toBeTruthy();
      expect(screen.getByLabelText("素材转写").textContent).toContain(translated);
      expect(screen.getByLabelText("任务进度").textContent).toContain(translated);
      expect(container.textContent).not.toContain(stage);
    }
  });
  it.each([
    [
      ["我", "是", "张", "示", "例", ",", "今", "天", "好"],
      "我是张示例,今天好",
    ],
    [
      ["使用", "ClipDeck", "编辑", "video", "today", "。"],
      "使用ClipDeck编辑video today。",
    ],
    [[" Hello", " world", ",", " again", "!"], "Hello world, again!"],
  ])(
    "keeps source reading, Add and assembly labels consistent for %j",
    async (tokens, expected) => {
      const state = fixture();
      const transcript = state.project.transcripts[0]!;
      transcript.words = tokens.map((text, index) => ({
        id: `token-${index}`,
        text,
        startMs: index * 100,
        endMs: (index + 1) * 100,
      }));
      transcript.segments[0] = {
        id: "s1",
        text: expected,
        startMs: 0,
        endMs: tokens.length * 100,
        wordIds: transcript.words.map((word) => word.id),
      };
      const b = bridge(state);
      const { container } = render(<App api={b.api} />);
      fireEvent.click(
        await screen.findByRole("button", { name: "Select all text" }),
      );
      expect(
        container.querySelector(".transcript-paragraph p")?.textContent?.trim(),
      ).toBe(expected);
      fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
      await waitFor(() => expect(b.get().project.cuts[0]?.text).toBe(expected));
      expect(b.get().project.cuts[0]?.wordIds).toEqual(
        transcript.words.map((word) => word.id),
      );
      fireEvent.click(screen.getByRole("button", { name: "Assembly script" }));
      expect(
        screen.getByRole("region", { name: "Assembly script" }).textContent,
      ).toContain(expected);
      fireEvent.click(screen.getByRole("button", { name: "Edit cut 1" }));
      expect(
        (screen.getByRole("textbox", { name: "Cut label" }) as HTMLInputElement)
          .value,
      ).toBe(expected);
    },
  );
  it("localizes script heading, edit and correction labels without rewriting custom text", async () => {
    localStorage.setItem("clipdeck.locale", "zh");
    const state = assemblyFixture();
    const custom = "自 定义  ClipDeck , title!";
    state.project.cuts[0]!.text = custom;
    state.project.cuts[0]!.textSource = "custom";
    const b = bridge(state);
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "成片稿" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "成片稿" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "成片稿" }).textContent,
    ).toContain(custom);
    fireEvent.click(screen.getByRole("button", { name: "编辑片段 1" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "片段显示文字",
        }) as HTMLInputElement
      ).value,
    ).toBe(custom);
    expect(b.api.applyEdit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "原文" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "原文" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "今天" }));
    fireEvent.click(screen.getByRole("button", { name: "校正文字" }));
    expect(screen.getByRole("textbox", { name: "词 1" })).toBeTruthy();
    expect(b.get().project.cuts[0]!.text).toBe(custom);
  });
  it("uses singular English word and cut counts for one selected token", async () => {
    const b = bridge();
    render(<App api={b.api} />);
    fireEvent.click(await screen.findByRole("button", { name: "今天" }));
    expect(screen.getByText("1 word selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add selection" }));
    await waitFor(() => expect(b.get().project.cuts).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Export video" }));
    expect(
      (await screen.findByLabelText("Export summary")).textContent,
    ).toContain("1 cut ·");
  });
});

describe("independent completed-export recovery controls", () => {
  function delivered(state = assemblyFixture()) {
    state.jobs = [{...state.jobs[0]!,id:"delivered",kind:"export",status:"completed",outputUrl:"clipdeck-media://approved/export-result"}];
    return state;
  }
  async function openExport() {
    fireEvent.click(await screen.findByRole("button",{name:"Processing"}));
    const play=screen.getByRole("button",{name:"Play exported video"});play.focus();fireEvent.click(play);
    const d=screen.getByRole("dialog",{name:"Completed export"});
    fireEvent.click(d.querySelector<HTMLButtonElement>('button[aria-label="Expand preview"]')!);
  }
  it("independent: restores invalid retained draft after Save in expanded completed export",async()=>{
    const b=bridge(delivered());render(<App api={b.api}/>);
    fireEvent.click(await screen.findByRole("listitem",{name:/Cut 1:/}));
    fireEvent.change(screen.getByLabelText("Cut out"),{target:{value:"00:00.000"}});
    await openExport();fireEvent.keyDown(window,{key:"s",metaKey:true});
    await screen.findByRole("alert");
    expect(screen.queryByRole("dialog",{name:"Completed export"})).toBeNull();
    const input=screen.getByLabelText("Cut out");expect(input).toHaveProperty("value","00:00.000");
    await waitFor(()=>expect(document.activeElement).toBe(input));
    expect(input.closest('[inert]')).toBeNull();expect(b.api.saveProject).not.toHaveBeenCalled();
  });
  it("independent: exposes Show file failure rather than covering alert with expanded completed export",async()=>{
    const b=bridge(delivered());b.api.revealExport=vi.fn(async()=>{throw new Error("Export file no longer exists");});
    render(<App api={b.api}/>);await openExport();fireEvent.click(screen.getByRole("button",{name:"Show exported video"}));
    const alert=await screen.findByRole("alert");expect(alert.textContent).toContain("Export file no longer exists");
    expect(screen.queryByRole("dialog",{name:"Completed export"})).toBeNull();
    await waitFor(()=>expect(document.activeElement).toBe(alert));expect(b.get().project.cuts).toHaveLength(2);
  });
  it("independent: returns focus to a connected editing control after closing delivered viewer",async()=>{
    const b=bridge(delivered());render(<App api={b.api}/>);await openExport();
    fireEvent.keyDown(window,{key:"Escape"});fireEvent.keyDown(window,{key:"Escape"});
    expect(screen.queryByRole("dialog",{name:"Completed export"})).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button",{name:"Processing"}));
  });
});

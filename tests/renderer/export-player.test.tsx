// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExportPlayer } from "../../src/renderer/ExportPlayer";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function readyPlayer() {
  const player = screen.getByLabelText("Exported video") as HTMLVideoElement;
  vi.spyOn(player, "duration", "get").mockReturnValue(116.8);
  fireEvent.loadedMetadata(player);
  return player;
}
describe("export file inspection controls", () => {
  it.each([false, true])("keeps inspection usable when a paused pending play rejects (resumed: %s)", async (resume) => {
    render(<ExportPlayer src="clipdeck-media://approved/result" />);
    const player = readyPlayer();
    player.currentTime = 21.961;
    let paused = true;
    let attempts = 0;
    let rejectFirst!: (error: unknown) => void;
    vi.spyOn(player, "paused", "get").mockImplementation(() => paused);
    vi.spyOn(player, "play").mockImplementation(() => {
      paused = false;
      fireEvent.play(player);
      return ++attempts === 1 ? new Promise<void>((_, reject) => { rejectFirst = reject; }) : Promise.resolve();
    });
    vi.spyOn(player, "pause").mockImplementation(() => { paused = true; fireEvent.pause(player); });
    fireEvent.click(screen.getByRole("button", { name: "Play exported file" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause exported file" }));
    if (resume) fireEvent.click(screen.getByRole("button", { name: "Play exported file" }));
    await act(async () => { rejectFirst(new DOMException("Previous play interrupted by pause", "AbortError")); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: resume ? "Pause exported file" : "Play exported file" })).toHaveProperty("disabled", false);
    expect(screen.getByRole("slider", { name: "Exported video position" })).toHaveProperty("disabled", false);
    expect(player.currentTime).toBe(21.961);
  });
  it("waits for finite media metadata and uses the same file for play, pause and precise seeking", async () => {
    render(<ExportPlayer src="clipdeck-media://approved/result" />);
    expect(screen.getByRole("button", { name: "Play exported file" })).toHaveProperty("disabled", true);
    const player = readyPlayer();
    const play = vi.spyOn(player, "play").mockImplementation(async () => { fireEvent.play(player); });
    const pause = vi.spyOn(player, "pause").mockImplementation(() => { fireEvent.pause(player); });
    fireEvent.click(screen.getByRole("button", { name: "Play exported file" }));
    await waitFor(() => expect(play).toHaveBeenCalledOnce());
    fireEvent.play(player);
    vi.spyOn(player, "paused", "get").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Pause exported file" }));
    expect(pause).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("slider", { name: "Exported video position" }), { target: { value: "21961" } });
    expect(player.currentTime).toBe(21.961);
    expect(screen.getByText("00:21.961 / 01:56")).toBeTruthy();
    expect(screen.getByLabelText("Exported video")).toBe(player);
    expect(player.getAttribute("src")).toBe("clipdeck-media://approved/result");
    expect(player.controls).toBe(false);
  });
  it("changes volume and mute on the actual video without changing its position", () => {
    render(<ExportPlayer src="clipdeck-media://approved/result" />);
    const player = readyPlayer();
    player.currentTime = 17.125;
    fireEvent.click(screen.getByRole("button", { name: "Mute exported video" }));
    expect(player.muted).toBe(true);
    fireEvent.change(screen.getByRole("slider", { name: "Export volume" }), { target: { value: "35" } });
    expect(player.volume).toBe(0.35);
    expect(player.muted).toBe(false);
    expect(player.currentTime).toBe(17.125);
  });
  it("keeps a rejected play visible and focused while disabling further playback attempts", async () => {
    render(<ExportPlayer src="clipdeck-media://approved/result" />);
    const player = readyPlayer();
    const play = vi.spyOn(player, "play").mockRejectedValue(new Error("decode failed"));
    fireEvent.click(screen.getByRole("button", { name: "Play exported file" }));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(alert.textContent).toContain("Show its file or return to editing");
    expect(screen.getByRole("button", { name: "Play exported file" })).toHaveProperty("disabled", true);
    expect(play).toHaveBeenCalledOnce();
    expect(screen.getByRole("slider", { name: "Exported video position" })).toHaveProperty("disabled", true);
  });
});

// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TranscriptView } from "../../src/renderer/TranscriptView";
import type { Transcript, TimedWord } from "../../src/shared/contracts";

type ReadingTranscript = Pick<Transcript, "words" | "segments">;
const word = (id: string, text: string, startMs: number): TimedWord => ({ id, text, startMs, endMs: startMs + 500 });
const uncertain = (id: string, text: string, startMs: number, endMs = startMs + 800) => ({ id, text, startMs, endMs, wordIds: [] });
function view(transcript: ReadingTranscript, overrides = {}) {
  const onSelect = vi.fn(), onReviewTimingRange = vi.fn();
  const result = render(<TranscriptView transcript={transcript} selection={null} currentMs={0} addedWords={new Set()} timingProvenanceKnown onSelect={onSelect} onReviewTimingRange={onReviewTimingRange} {...overrides} />);
  return { ...result, onSelect, onReviewTimingRange };
}
function search(query: string) { fireEvent.change(screen.getByLabelText("Find in transcript"), { target: { value: query } }); }

beforeEach(() => {
  HTMLElement.prototype.scrollTo = function (options?: ScrollToOptions | number) {
    if (typeof options === "object") { this.scrollTop = options.top ?? 0; this.dispatchEvent(new Event("scroll")); }
  };
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 600, height: 160, top: 0, left: 0, bottom: 160, right: 600, x: 0, y: 0, toJSON: () => ({}) });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); Reflect.deleteProperty(HTMLElement.prototype, "scrollTo"); vi.unstubAllGlobals(); });

describe("display-only transcript reading", () => {
  it("preserves full untimed text in chronological order between real words", () => {
    const text = "Uncertain passage\n" + "review the recording carefully ".repeat(100);
    const transcript = { words: [word("first", "Before", 0), word("last", "After", 3000)], segments: [uncertain("u", text, 1000, 2500)] };
    const original = structuredClone(transcript);
    const { container } = view(transcript);
    const paragraphs = [...container.querySelectorAll(".transcript-paragraph p")];
    expect(paragraphs.map(p => p.textContent?.trim())).toEqual(["Before", text.trim(), "After"]);
    expect(container.querySelectorAll("[data-word]")).toHaveLength(2);
    expect(transcript).toEqual(original);
  });

  it("allows only a provisional manual-range review for an untimed search match", () => {
    const { onSelect, onReviewTimingRange } = view({ words: [], segments: [uncertain("u", "Listen to this uncertain passage", 1200, 2800)] });
    search("uncertain passage");
    expect(screen.getByRole("button", { name: "Select match" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Select all timed text" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Review passage timing" }));
    expect(onReviewTimingRange).toHaveBeenCalledWith(1200, 2800);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("names Select-all as timed-only when display-only text is present", () => {
    const { onSelect } = view({ words: [word("first", "Before", 0), word("last", "After", 3000)], segments: [uncertain("u", "Uncertain passage", 1000)] });
    expect(screen.queryByRole("button", { name: "Select all text" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select all timed text" }));
    expect(onSelect.mock.calls).toEqual([["first", false], ["last", true]]);
  });

  it("does not join timed phrase matches across intervening display-only text", () => {
    view({ words: [word("first", "Before", 0), word("last", "After", 3000)], segments: [uncertain("u", "An uncertain interruption", 1000)] });
    search("before after");
    expect(screen.getByText("0 / 0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select match" }).hasAttribute("disabled")).toBe(true);
  });

  it("retains timed phrase selection and keyboard word traversal", () => {
    const { onSelect } = view({ words: [word("first", "Before", 0), word("last", "After", 700)], segments: [] });
    expect(screen.getByRole("button", { name: "Select all text" })).toBeTruthy();
    search("before after");
    fireEvent.click(screen.getByRole("button", { name: "Select match" }));
    expect(onSelect.mock.calls).toEqual([["first", false], ["last", true]]);
    onSelect.mockClear();
    fireEvent.keyDown(screen.getByRole("button", { name: "Before" }), { key: "ArrowRight", shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith("last", true);
  });

  it("moves between timed and untimed search matches without inventing selection", () => {
    const { onSelect, container } = view({ words: [word("first", "Review", 0), word("last", "Review", 3000)], segments: [uncertain("u", "Review this uncertain passage", 1000)] });
    search("review");
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("2 / 3")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select match" }).hasAttribute("disabled")).toBe(true);
    expect(container.querySelector(".transcript-untimed .search-match")?.textContent).toBe("Review this uncertain passage");
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    fireEvent.click(screen.getByRole("button", { name: "Select match" }));
    expect(onSelect.mock.calls).toEqual([["last", false], ["last", true]]);
  });

  it("virtualizes display-only rows and scrolls a distant search match into view", async () => {
    const segments = Array.from({ length: 300 }, (_, i) => uncertain("u" + i, i === 299 ? "Distant uncertain target" : "Uncertain passage " + i, i * 1000));
    const { container, onSelect } = view({ words: [], segments });
    expect(container.querySelectorAll(".transcript-paragraph").length).toBeLessThan(20);
    expect(screen.queryByText("Distant uncertain target")).toBeNull();
    const viewport = container.querySelector<HTMLDivElement>(".transcript-scroll")!;
    // jsdom has no layout; derive browser scroll extent from the real virtual sizer.
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, get: () => Number.parseFloat((viewport.firstElementChild as HTMLElement).style.height) });
    search("distant uncertain target");
    await waitFor(() => expect(screen.getByText("Distant uncertain target")).toBeTruthy());
    expect(container.querySelector<HTMLDivElement>(".transcript-scroll")!.scrollTop).toBeGreaterThan(10000);
    expect(screen.getByRole("button", { name: "Select match" }).hasAttribute("disabled")).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("disables manual review while a draft is in progress", () => {
    const { onReviewTimingRange, onSelect } = view({ words: [], segments: [uncertain("u", "Unpublished uncertain passage", 1000)] }, { draft: true });
    const button = screen.getByRole("button", { name: "Review passage timing" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.click(button);
    expect(onReviewTimingRange).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

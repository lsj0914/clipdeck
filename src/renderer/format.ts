import type { Cut } from "../shared/contracts";
export function time(ms: number, precise = false): string {
  const value = Math.max(0, Math.round(ms));
  const seconds = Math.floor(value / 1000);
  const head =
    seconds >= 3600
      ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}`
      : String(Math.floor(seconds / 60)).padStart(2, "0");
  return `${head}:${String(seconds % 60).padStart(2, "0")}${precise ? `.${String(value % 1000).padStart(3, "0")}` : ""}`;
}
export function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}
export function parseSeconds(text: string): number {
  const value = text.trim();
  const parts = value.split(":");
  if (
    parts.length > 3 ||
    !parts.every((part, index) =>
      index === parts.length - 1
        ? /^\d+(?:\.\d{1,3})?$/.test(part)
        : /^\d+$/.test(part),
    ) ||
    (parts.length > 1 && Number(parts.at(-1)) >= 60) ||
    (parts.length === 3 && Number(parts[1]) >= 60)
  )
    throw new Error(
      "Enter MM:SS.MMM or seconds with up to three decimal places.",
    );
  const result = Math.round(
    parts.reduce((total, part) => total * 60 + Number(part), 0) * 1000,
  );
  if (!Number.isSafeInteger(result)) throw new Error("Enter a valid time.");
  return result;
}
export class RangeInputError extends Error {
  constructor(readonly field: "start" | "end", message: string) {
    super(message);
  }
}
export function range(start: string, end: string, duration: number) {
  let startMs: number, endMs: number;
  try { startMs = parseSeconds(start); }
  catch (error) { throw new RangeInputError("start", message(error)); }
  try { endMs = parseSeconds(end); }
  catch (error) { throw new RangeInputError("end", message(error)); }
  if (endMs <= startMs)
    throw new RangeInputError("end", "The out point must be after the in point.");
  if (endMs > duration)
    throw new RangeInputError("end",
      `The out point must be within the source (${seconds(duration)} seconds).`,
    );
  return { startMs, endMs };
}
export function assemblyDuration(cuts: Cut[]): number {
  return (
    (cuts.reduce(
      (frames, cut) =>
        frames +
        Math.max(1, Math.ceil(((cut.endMs - cut.startMs) * 30) / 1000)),
      0,
    ) *
      1000) /
    30
  );
}
export function message(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "The operation could not finish. Please try again.";
}

export function assemblyPosition(cuts: Cut[], positionMs: number) {
  const totalFrames = cuts.reduce(
    (sum, cut) =>
      sum + Math.max(1, Math.ceil(((cut.endMs - cut.startMs) * 30) / 1000)),
    0,
  );
  if (!totalFrames) return null;
  const frame = Math.min(
    totalFrames - 1,
    Math.max(0, Math.floor((positionMs * 30) / 1000 + 1e-7)),
  );
  let startFrame = 0;
  for (let index = 0; index < cuts.length; index++) {
    const cut = cuts[index]!;
    const frameCount = Math.max(
      1,
      Math.ceil(((cut.endMs - cut.startMs) * 30) / 1000),
    );
    if (frame < startFrame + frameCount)
      return {
        cut,
        index,
        sourceMs: Math.min(
          cut.endMs,
          cut.startMs + ((frame - startFrame) * 1000) / 30,
        ),
      };
    startFrame += frameCount;
  }
  return null;
}

/** Bound presentation work without changing the stored passage. */
export function excerpt(text: string, limit = 180): string {
  if (text.length <= limit) return text;
  return (
    text
      .slice(0, limit)
      .replace(/[\uD800-\uDBFF]$/, "")
      .trimEnd() + "…"
  );
}

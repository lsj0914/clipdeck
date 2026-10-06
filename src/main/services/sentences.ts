import type { TimedWord, TranscriptSegment } from "../../shared/contracts";
const PAUSE_MS = 800;
const SENTENCE_END = /[.!?。！？…](?:["'”’」』）)\]]*)$/u;
/** Engine batches are transport units; sentence IDs bind to their first real word anchor. */
export function groupSentences(
  words: TimedWord[],
  rawSegments: TranscriptSegment[],
  prefix: string,
): TranscriptSegment[] {
  const groups: TranscriptSegment[] = [];
  let pending: TimedWord[] = [];
  const flush = () => {
    if (!pending.length) return;
    groups.push({
      id: `${prefix}-s-${pending[0]!.id}`,
      text: pending
        .map((word) => word.text)
        .join("")
        .trim(),
      startMs: pending[0]!.startMs,
      endMs: pending.at(-1)!.endMs,
      wordIds: pending.map((word) => word.id),
    });
    pending = [];
  };
  const displays = rawSegments
    .filter((segment) => !segment.wordIds.length && segment.text.trim())
    .sort((a, b) => a.startMs - b.startMs);
  let displayIndex = 0;
  for (const word of words) {
    while (
      displayIndex < displays.length &&
      displays[displayIndex]!.startMs <= word.startMs
    ) {
      flush();
      const display = displays[displayIndex++]!;
      groups.push({ ...display, id: `${prefix}-display-${display.id}` });
    }
    const previous = pending.at(-1);
    if (previous && word.startMs - previous.endMs >= PAUSE_MS) flush();
    pending.push(word);
    if (SENTENCE_END.test(word.text.trimEnd())) flush();
  }
  flush();
  for (const display of displays.slice(displayIndex))
    groups.push({ ...display, id: `${prefix}-display-${display.id}` });
  return groups;
}

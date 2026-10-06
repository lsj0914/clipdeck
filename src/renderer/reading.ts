import type { TimedWord, Transcript, TranscriptSegment } from "../shared/contracts";

import { wordSeparator } from "../domain/transcript-text";
export { wordSeparator } from "../domain/transcript-text";
/** Paragraphs follow existing punctuation and pauses; word anchors never change. */
export function readingGroups(words: TimedWord[]): TimedWord[][] {
  const groups: TimedWord[][] = [];
  let group: TimedWord[] = [];
  let length = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    group.push(word);
    length += word.text.length;
    const next = words[i + 1];
    const pause = next ? next.startMs - word.endMs : 0;
    if (
      (length >= 140 && /[。！？.!?][”’"']?$/u.test(word.text)) ||
      (length >= 80 && pause >= 1200) ||
      group.length >= 120 ||
      length >= 900
    ) {
      groups.push(group);
      group = [];
      length = 0;
    }
  }
  if (group.length) {
    const last = groups.at(-1);
    if (last && group.length < 8 && last.length + group.length <= 128)
      last.push(...group);
    else groups.push(group);
  }
  return groups;
}
export function phraseMatches(words: TimedWord[], query: string) {
  const needle = query.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (!needle) return [];
  let text = "";
  const ends: number[] = [];
  words.forEach((word, i) => {
    if (i) text += wordSeparator(words[i - 1]!.text, word.text);
    text += word.text.toLocaleLowerCase();
    ends.push(text.length);
  });
  const matches: Array<{ start: number; end: number }> = [];
  let offset = 0,
    startWord = 0,
    endWord = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    while (ends[startWord]! <= offset) startWord++;
    endWord = Math.max(startWord, endWord);
    while (ends[endWord]! < offset + needle.length) endWord++;
    matches.push({ start: startWord, end: endWord });
    offset += needle.length;
  }
  return matches;
}

export type ReadingRow =
  | { kind: "timed"; words: TimedWord[] }
  | { kind: "untimed"; segment: TranscriptSegment };

/** Empty wordIds retain real text as a display-only row and break timed runs. */
export function transcriptRows(
  transcript: Pick<Transcript, "words" | "segments">,
): ReadingRow[] {
  const untimed = transcript.segments
    .filter((segment) => !segment.wordIds.length && segment.text.trim())
    .toSorted((a, b) => a.startMs - b.startMs);
  const rows: ReadingRow[] = [];
  let run: TimedWord[] = [];
  let next = 0;
  function flush() {
    rows.push(...readingGroups(run).map(
      (words): ReadingRow => ({ kind: "timed", words }),
    ));
    run = [];
  }
  for (const word of transcript.words) {
    while (next < untimed.length && untimed[next]!.startMs <= word.startMs) {
      flush();
      rows.push({ kind: "untimed", segment: untimed[next++]! });
    }
    run.push(word);
  }
  flush();
  while (next < untimed.length) {
    rows.push({ kind: "untimed", segment: untimed[next++]! });
  }
  return rows;
}

export type ReadingMatch =
  | { kind: "timed"; row: number; start: number; end: number }
  | { kind: "untimed"; row: number };

/** Timed phrase search can span reading paragraphs, but never untimed text. */
export function transcriptMatches(
  rows: ReadingRow[],
  words: TimedWord[],
  query: string,
): ReadingMatch[] {
  const needle = query.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (!needle) return [];
  const positions = new Map(words.map((word, index) => [word.id, index]));
  const rowByWord = new Map<string, number>();
  const matches: ReadingMatch[] = [];
  let run: TimedWord[] = [];
  function flush() {
    for (const match of phraseMatches(run, query)) {
      matches.push({
        kind: "timed",
        row: rowByWord.get(run[match.start]!.id)!,
        start: positions.get(run[match.start]!.id)!,
        end: positions.get(run[match.end]!.id)!,
      });
    }
    run = [];
  }
  rows.forEach((row, index) => {
    if (row.kind === "timed") {
      for (const word of row.words) rowByWord.set(word.id, index);
      run.push(...row.words);
    } else {
      flush();
      const text = row.segment.text.toLocaleLowerCase().replace(/\s+/g, " ");
      let offset = 0;
      while ((offset = text.indexOf(needle, offset)) !== -1) {
        matches.push({ kind: "untimed", row: index });
        offset += needle.length;
      }
    }
  });
  flush();
  return matches;
}

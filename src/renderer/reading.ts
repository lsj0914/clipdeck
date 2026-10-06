import type { TimedWord } from "../shared/contracts";

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

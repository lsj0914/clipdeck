/** Preserve explicit token spacing; infer only missing boundaries in derived prose. */
export function wordSeparator(previous: string, next = ""): string {
  if (!previous || !next || /\s$/.test(previous) || /^\s/.test(next)) return "";
  if (
    /\p{Script=Han}$/u.test(previous) ||
    /^\p{Script=Han}/u.test(next) ||
    /^[，。！？、；：,.!?;:)）\]】》」』]/u.test(next) ||
    /[（(\[【《「『]$/u.test(previous)
  )
    return "";
  return " ";
}

/** Used for generated labels only: user-authored labels are never normalized. */
export function joinTranscriptText(texts: readonly string[]): string {
  return texts
    .map(
      (text, index) =>
        (index ? wordSeparator(texts[index - 1]!, text) : "") + text,
    )
    .join("")
    .trim();
}

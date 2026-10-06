import type { TranscriptionOptions } from "../shared/contracts";
import { record, text } from "./validation";
/** Renderer may provide bounded vocabulary only, never model paths or engine parameters. */
export function parseTranscriptionOptions(
  input: unknown,
): TranscriptionOptions {
  const value = record(input, ["vocabulary"]);
  if (value.vocabulary === undefined) return {};
  const vocabulary = text(value.vocabulary, 2000, true).trim();
  if (
    Array.from(vocabulary).length > 1000 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(vocabulary)
  )
    throw new Error("Vocabulary must contain at most 1000 characters");
  if (vocabulary.split(/[,，;；\n]/u).filter((term) => term.trim()).length > 64)
    throw new Error("Vocabulary must contain at most 64 terms");
  return { vocabulary };
}

import type { TimedWord } from "../../shared/contracts";
import { integer, list, record, text } from "../../domain/validation";
import { offlineWorkerCommand, runProcess } from "./process";

export const PUNCTUATION_MODEL = {
  id: "iic/punc_ct-transformer_zh-cn-common-vocab272727-onnx",
  revision: "8f239ff78c6267c4d859233e7eb3bbdb68c61824",
  sha256: "e6cd8399bf7d0e75f8d9af4a107310e1968ecab1d50135e765b8f0265b27a83d",
};

// Independent check at the native boundary. Whitespace, quotes, decimal points,
// identifier punctuation, and thousands separators must remain byte-for-byte.
function content(value: string): string {
  return [...value].filter((char, index, chars) => {
    if ("，。？、?;；".includes(char)) return false;
    const left = chars[index - 1] ?? "", right = chars[index + 1] ?? "";
    if (char === ".") return /^[a-zA-Z0-9]$/.test(left) && /^[a-zA-Z0-9]$/.test(right);
    if (char === ",") return /^\d$/.test(left) && /^\d$/.test(right);
    return true;
  }).join("");
}

export function applyPunctuation(words: TimedWord[], fragments: string[]): TimedWord[] {
  if (words.length !== fragments.length || content(words.map(w => w.text).join("")) !== content(fragments.join("")))
    throw new Error("Punctuation changed recognized content");
  // Check ownership as well: moving text to another timed anchor is forbidden.
  // Global context protects decimals split across two ASR words; this local check
  // protects every letter, digit, quote, and whitespace in its original word.
  const stable = (value: string) => value.replace(/[，。？、,?.;；]/gu, "");
  return words.map((word, index) => {
    const restored = fragments[index]!;
    if (!restored.length)
      throw new Error("Punctuation returned an empty time anchor");
    if (stable(word.text) !== stable(restored))
      throw new Error("Punctuation moved recognized text between time anchors");
    return { ...word, text: restored };
  });
}

export async function restorePunctuation(options: {
  python: string;
  worker: string;
  directory: string;
  words: TimedWord[];
  language?: "en" | "zh";
  signal: AbortSignal;
}): Promise<TimedWord[]> {
  const language = options.language ?? "zh";
  const command = offlineWorkerCommand(options.python, options.worker);
  const input = JSON.stringify({mode: "punctuate", language, punctuationDirectory: options.directory, fragments: options.words.map(word => word.text)}) + "\n";
  if (Buffer.byteLength(input) > 64 * 1024 * 1024)
    throw new Error("Punctuation input limit exceeded");
  let output = "";
  await runProcess(command.executable, command.argv, {
    env: command.env, signal: options.signal, input, maxBytes: 64 * 1024 * 1024,
    onStdout(chunk) {
      output += chunk;
      if (Buffer.byteLength(output) > 64 * 1024 * 1024)
        throw new Error("Punctuation output limit exceeded");
    },
  }).catch(error => {
    // A failed native process still emits its bounded, path-redacted diagnosis.
    // Cancellation and malformed output retain their original failure.
    if (!options.signal.aborted) {
      for (const line of output.trim().split("\n")) {
        try {
          const event = JSON.parse(line);
          if (event.type === "error" && typeof event.message === "string")
            throw new Error(text(event.message, 2000));
        } catch (diagnostic) {
          if (diagnostic instanceof Error && !(diagnostic instanceof SyntaxError))
            throw diagnostic;
        }
      }
    }
    throw error;
  });
  const fragments: string[] = [];
  let complete = false;
  for (const line of output.trim().split("\n")) {
    if (!line) continue;
    if (complete) throw new Error("Unexpected output after punctuation completion");
    const event = JSON.parse(line);
    if (event.type === "punctuation") {
      const packet = record(event, ["type", "start", "fragments"]);
      if (integer(packet.start) !== fragments.length)
        throw new Error("Out-of-order punctuation result");
      fragments.push(...list(packet.fragments, value => text(value, 20000, true), 8192));
      if (fragments.length > options.words.length)
        throw new Error("Punctuation returned extra time anchors");
    } else if (event.type === "complete") {
      const packet = record(event, ["type", "fragmentCount", "model", "language"]);
      if (packet.language !== language)
        throw new Error("Punctuation language mismatch");
      const model = record(packet.model, ["id", "revision", "sha256"]);
      if (integer(packet.fragmentCount) !== fragments.length || model.id !== PUNCTUATION_MODEL.id || model.revision !== PUNCTUATION_MODEL.revision || model.sha256 !== PUNCTUATION_MODEL.sha256)
        throw new Error("Punctuation model identity mismatch");
      complete = true;
    } else throw new Error("Invalid punctuation worker response");
  }
  if (!complete) throw new Error("Punctuation worker exited without a complete result");
  return applyPunctuation(options.words, fragments);
}

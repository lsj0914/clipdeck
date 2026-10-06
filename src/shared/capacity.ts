export const MAX_TRANSCRIPTION_MS = 6 * 60 * 60 * 1000;
export const PCM_RATE = 16000;
export const PCM_MARGIN_MS = 2000;
export const TRANSCRIPTION_LIMIT_ERROR = "Local transcription supports sources up to six hours. Split this source first; time-based editing remains available.";
export const PCM_LIMIT_ERROR = "Decoded audio exceeds this source's supported length. Split or re-import the source.";
export function transcriptionPcmBytes(durationMs: number): number {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAX_TRANSCRIPTION_MS)
    throw new Error(TRANSCRIPTION_LIMIT_ERROR);
  return Math.ceil((durationMs + PCM_MARGIN_MS) * PCM_RATE / 1000) * 2;
}

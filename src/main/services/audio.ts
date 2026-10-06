import { closeSync, openSync, writeSync } from "node:fs";
import type { JobContext } from "./jobs";
import { runProcess } from "./process";
import { SOURCE_INPUT_OPTIONS } from "./source-input";
import { PCM_LIMIT_ERROR, transcriptionPcmBytes } from "../../shared/capacity";
/** The bundled media runtime has a WAV muxer, not a raw PCM muxer.
 * Strip its bounded RIFF header while streaming samples into the capped file. */
export class PcmWaveDecoder {
  private header = Buffer.alloc(0);
  complete = false;
  constructor(readonly samples: (chunk: Buffer) => void) {}
  push(chunk: Buffer): void {
    if (this.complete) { this.samples(chunk); return; }
    this.header = Buffer.concat([this.header, chunk]);
    if (this.header.length < 12) return;
    if (this.header.toString("ascii", 0, 4) !== "RIFF" || this.header.toString("ascii", 8, 12) !== "WAVE")
      throw new Error("Decoded audio header is invalid");
    let offset = 12, format = false;
    for (;;) {
      if (offset + 8 > 65536) throw new Error("Decoded audio header exceeds its limit");
      if (this.header.length < offset + 8) return;
      const id = this.header.toString("ascii", offset, offset + 4), length = this.header.readUInt32LE(offset + 4);
      if (id === "data") {
        if (!format) throw new Error("Decoded audio format is missing");
        this.complete = true;
        this.samples(this.header.subarray(offset + 8));
        this.header = Buffer.alloc(0);
        return;
      }
      const next = offset + 8 + length + (length % 2);
      if (next > 65536) throw new Error("Decoded audio header exceeds its limit");
      if (this.header.length < next) return;
      if (id === "fmt ") {
        const data = offset + 8;
        if (length < 16 || this.header.readUInt16LE(data) !== 1 ||
          this.header.readUInt16LE(data + 2) !== 1 || this.header.readUInt32LE(data + 4) !== 16000 ||
          this.header.readUInt16LE(data + 12) !== 2 || this.header.readUInt16LE(data + 14) !== 16)
          throw new Error("Decoded audio format is invalid");
        format = true;
      }
      offset = next;
    }
  }
}

/** Decode into a bounded binary stream. FFmpeg's -fs is deliberately avoided:
 * it can exit successfully with a truncated audio file. */
export async function decodeTranscriptionAudio(
  ffmpeg: string, source: string, output: string, durationMs: number, ctx: JobContext,
): Promise<void> {
  const limit = transcriptionPcmBytes(durationMs);
  const handle = openSync(output, "wx", 0o600);
  let bytes = 0;
  const decoded = new PcmWaveDecoder((chunk) => {
    ctx.throwIfCancelled();
    if (bytes + chunk.length > limit) throw new Error(PCM_LIMIT_ERROR);
    let offset = 0;
    while (offset < chunk.length) {
      const written = writeSync(handle, chunk, offset, chunk.length - offset);
      if (!written) throw new Error("Audio temporary storage did not accept data");
      offset += written;
    }
    bytes += chunk.length;
  });
  try {
    await runProcess(ffmpeg, [
      "-v", "error", "-nostdin", ...SOURCE_INPUT_OPTIONS, "-i", source,
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
      // Restore the source timeline's initial silence for delayed audio tracks.
      "-af", "aresample=async=1:first_pts=0",
      "-c:a", "pcm_s16le", "-fflags", "+bitexact", "-map_metadata", "-1", "-f", "wav", "pipe:1",
    ], {
      signal: ctx.signal,
      onStdoutBytes: (chunk) => decoded.push(chunk),
    });
    if (!decoded.complete || !bytes || bytes % 2) throw new Error("Decoded audio is incomplete");
  } finally { closeSync(handle); }
}

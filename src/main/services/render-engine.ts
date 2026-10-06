import { open, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { statSync } from "node:fs";
import type { AssemblyPlan, Asset } from "../../shared/contracts";
import type { JobContext } from "./jobs";
import { runProcess } from "./process";
export interface RenderInput {
  asset: Asset;
  file: string;
  version: number;
  signature: string;
}
export interface RenderReceipt {
  frames: number;
  samples: number;
  width: number;
  height: number;
  durationSeconds: number;
  audioPresentationSamples: number;
}
const seconds = (ms: number) => (ms / 1000).toFixed(6);
/** The source clock is shared by video and audio. Never subtract each stream's STARTPTS. */
export function videoFilter(
  startMs: number,
  endMs: number,
  frames: number,
  width: number,
  height: number,
): string {
  return `trim=start=${seconds(startMs)}:end=${seconds(endMs)},setpts=PTS-${seconds(startMs)}/TB,scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=${(frames / 30 + 1).toFixed(6)},fps=30:start_time=0,trim=end_frame=${frames},settb=1/30,setpts=N,format=yuv420p`;
}
export function audioFilter(
  startMs: number,
  endMs: number,
  samples: number,
): string {
  return `atrim=start=${seconds(startMs)}:end=${seconds(endMs)},asetpts=PTS-${seconds(startMs)}/TB,aresample=48000:async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=stereo,apad=whole_len=${samples},atrim=end_sample=${samples},asettb=1/48000,asetpts=N`;
}
export class RenderEngine {
  constructor(
    readonly ffmpeg: string,
    readonly ffprobe: string,
  ) {}
  async ff(
    args: string[],
    ctx: JobContext,
    onTime?: (ms: number) => void,
  ): Promise<void> {
    let buffered = "";
    await runProcess(
      this.ffmpeg,
      [
        "-hide_banner",
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-progress",
        "pipe:1",
        "-nostats",
        ...args,
      ],
      {
        signal: ctx.signal,
        onStdout: (text) => {
          buffered += text;
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines)
            if (line.startsWith("out_time_us=")) {
              const n = Number(line.slice(12));
              if (Number.isFinite(n)) onTime?.(Math.max(0, n / 1000));
            }
        },
      },
    );
  }
  async assemble(
    plan: AssemblyPlan,
    inputs: Map<string, RenderInput>,
    dir: string,
    ctx: JobContext,
    width: number,
    height: number,
  ): Promise<string> {
    const paths: string[] = [];
    let completedBytes = 0;
    const checkSpace = (file: string) => {
      let bytes = 0;
      try {
        bytes = statSync(file).size;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (completedBytes + bytes > 16 * 1024 ** 3)
        throw new Error(
          "Render staging exceeds the 16 GB local limit; split the assembly",
        );
    };
    for (const [i, segment] of plan.segments.entries()) {
      ctx.update({
        stage: `rendering cut ${i + 1} of ${plan.segments.length}`,
        progress: (segment.startFrame / plan.totalFrames) * 0.7,
      });
      ctx.throwIfCancelled();
      const input = inputs.get(segment.assetId)!;
      const file = path.join(dir, `cut-${i}.mkv`);
      const selected = await runProcess(
        this.ffmpeg,
        [
          "-v",
          "error",
          "-nostdin",
          "-progress",
          "pipe:1",
          "-protocol_whitelist",
          "file,pipe",
          "-ss",
          seconds(segment.startMs),
          "-t",
          seconds(segment.endMs - segment.startMs),
          "-i",
          input.file,
          "-vf",
          `trim=start=0:end=${seconds(segment.endMs - segment.startMs)}`,
          "-an",
          "-f",
          "null",
          "-",
        ],
        { signal: ctx.signal },
      );
      const frameCounts = [...selected.stdout.matchAll(/^frame=(\d+)$/gm)].map(
        (m) => Number(m[1]),
      );
      if (!frameCounts.some((n) => n > 0))
        throw new Error(
          `Cut ${i + 1} contains no usable video frame in the selected range; widen its bounds`,
        );
      const args = [
        "-protocol_whitelist",
        "file,pipe",
        "-ss",
        seconds(segment.startMs),
        "-t",
        seconds(segment.endMs - segment.startMs),
        "-i",
        input.file,
      ];
      if (!input.asset.hasAudio)
        args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
      const a = input.asset.hasAudio ? "0:a:0" : "1:a:0";
      const af = input.asset.hasAudio
        ? audioFilter(0, segment.endMs - segment.startMs, segment.sampleCount)
        : `atrim=end_sample=${segment.sampleCount},asettb=1/48000,asetpts=N`;
      args.push(
        "-filter_complex",
        `[0:v:0]${videoFilter(0, segment.endMs - segment.startMs, segment.frameCount, width, height)}[v];[${a}]${af}[a]`,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-map_metadata",
        "-1",
        "-c:v",
        "ffv1",
        "-level",
        "3",
        "-c:a",
        "pcm_s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        file,
      );
      await this.ff(args, ctx, (ms) => {
        checkSpace(file);
        ctx.update({
          processedMs:
            (segment.startFrame / 30) * 1000 +
            Math.min(ms, (segment.frameCount / 30) * 1000),
          progress: Math.min(
            0.7,
            ((segment.startFrame + (ms / 1000) * 30) / plan.totalFrames) * 0.7,
          ),
        });
      });
      // Empty video can still produce a valid audio container; reject before concat.
      const { stdout } = await runProcess(
        this.ffprobe,
        [
          "-v",
          "error",
          "-count_frames",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=nb_read_frames",
          "-of",
          "json",
          file,
        ],
        { signal: ctx.signal },
      );
      if (
        Number(JSON.parse(stdout).streams?.[0]?.nb_read_frames) !==
        segment.frameCount
      )
        throw new Error(
          `Cut ${i + 1} contains no usable video frame in the selected range; widen its bounds`,
        );
      completedBytes += statSync(file).size;
      paths.push(file);
    }
    const concat = path.join(dir, "assembly.txt");
    // Internally generated basenames only; no source-controlled concat directives.
    await writeFile(
      concat,
      paths
        .map(
          (_, i) =>
            `file 'cut-${i}.mkv'\nduration ${(plan.segments[i]!.frameCount / 30).toFixed(12)}\n`,
        )
        .join(""),
    );
    const output = path.join(dir, "verified.mp4");
    ctx.update({ stage: "encoding assembly", progress: 0.7 });
    await this.ff(
      [
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        concat,
        "-vf",
        "settb=1/30,setpts=N",
        "-af",
        "asettb=1/48000,asetpts=N",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-video_track_timescale",
        "30000",
        "-movflags",
        "+faststart",
        "-map_metadata",
        "-1",
        output,
      ],
      ctx,
      (ms) => {
        checkSpace(output);
        ctx.update({
          progress: 0.7 + Math.min(1, ms / plan.durationMs) * 0.15,
        });
      },
    );
    // Delete lossless intermediates after final encoding, before validation WAV allocation.
    await Promise.all(paths.map((p) => unlink(p)));
    return output;
  }
  async validate(
    file: string,
    expected: {
      frames: number;
      samples: number;
      width: number;
      height: number;
    },
    dir: string,
    ctx: JobContext,
  ): Promise<RenderReceipt> {
    ctx.update({ stage: "validating decode", progress: 0.85 });
    await this.ff(
      [
        "-xerror",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        file,
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-f",
        "null",
        "-",
      ],
      ctx,
    );
    ctx.update({ stage: "validating presentation", progress: 0.9 });
    const { stdout } = await runProcess(
      this.ffprobe,
      [
        "-v",
        "error",
        "-count_frames",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        file,
      ],
      { signal: ctx.signal },
    );
    const probe = JSON.parse(stdout),
      v = probe.streams.find((s: any) => s.codec_type === "video"),
      a = probe.streams.find((s: any) => s.codec_type === "audio");
    const frames = Number(v?.nb_read_frames),
      audioPresentationSamples = Math.round(Number(a?.duration) * 48000),
      durationSeconds = Number(probe.format.duration);
    if (
      frames !== expected.frames ||
      v.width !== expected.width ||
      v.height !== expected.height ||
      v.sample_aspect_ratio !== "1:1" ||
      v.r_frame_rate !== "30/1" ||
      v.codec_name !== "h264" ||
      a?.codec_name !== "aac" ||
      a.sample_rate !== "48000" ||
      a.channels !== 2 ||
      Math.abs(Number(v.start_time)) > 0.0001 ||
      Math.abs(Number(a.start_time)) > 0.0001 ||
      Math.abs(durationSeconds - expected.frames / 30) > 1 / 30 ||
      audioPresentationSamples !== expected.samples
    )
      throw new Error(
        "Rendered presentation does not match the canonical frame/sample plan",
      );
    let presentationFrames = 0,
      lines = "";
    const consume = () => {
      const split = lines.split("\n");
      lines = split.pop() ?? "";
      for (const line of split) {
        const text = line.split(",")[0]?.trim();
        if (!text) continue;
        const pts = Number(text);
        if (
          !Number.isFinite(pts) ||
          Math.abs(pts - presentationFrames / 30) > 1 / 30000 + 0.000001
        )
          throw new Error(
            "Video presentation timestamps do not match the canonical frame clock",
          );
        presentationFrames++;
      }
    };
    await runProcess(
      this.ffprobe,
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_frames",
        "-show_entries",
        "frame=best_effort_timestamp_time",
        "-of",
        "csv=p=0",
        file,
      ],
      {
        signal: ctx.signal,
        onStdout: (text) => {
          lines += text;
          consume();
        },
      },
    );
    if (lines.trim()) {
      lines += "\n";
      consume();
    }
    if (presentationFrames !== expected.frames)
      throw new Error(
        "Decoded video presentation frame count differs from the plan",
      );
    ctx.update({ stage: "validating samples", progress: 0.95 });
    const wav = path.join(dir, "validation.wav");
    await this.ff(
      [
        "-xerror",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-vn",
        "-c:a",
        "pcm_s16le",
        "-rf64",
        "auto",
        wav,
      ],
      ctx,
    );
    const samples = await wavSamples(wav);
    await unlink(wav);
    ctx.throwIfCancelled();
    if (samples !== expected.samples)
      throw new Error(
        "Decoded audio sample count differs from the canonical plan",
      );
    return {
      frames,
      samples,
      width: v.width,
      height: v.height,
      durationSeconds,
      audioPresentationSamples,
    };
  }
}
/** Read WAV chunk headers, not the entire decoded soundtrack; handles RF64 for long media. */
export async function wavSamples(file: string): Promise<number> {
  const f = await open(file, "r");
  try {
    const size = (await f.stat()).size;
    const h = Buffer.alloc(12);
    await f.read(h, 0, 12, 0);
    if (
      !["RIFF", "RF64"].includes(h.toString("ascii", 0, 4)) ||
      h.toString("ascii", 8, 12) !== "WAVE"
    )
      throw new Error("Invalid decoded WAV");
    let offset = 12,
      align = 0,
      largeData: number | undefined;
    while (offset + 8 <= size) {
      const b = Buffer.alloc(8);
      await f.read(b, 0, 8, offset);
      const tag = b.toString("ascii", 0, 4),
        length = b.readUInt32LE(4);
      offset += 8;
      if (tag === "ds64") {
        const x = Buffer.alloc(24);
        await f.read(x, 0, 24, offset);
        largeData = Number(x.readBigUInt64LE(8));
      }
      if (tag === "fmt ") {
        const x = Buffer.alloc(16);
        await f.read(x, 0, 16, offset);
        align = x.readUInt16LE(12);
      }
      if (tag === "data") {
        const bytes = length === 0xffffffff ? largeData : length;
        if (
          !align ||
          bytes === undefined ||
          offset + bytes > size ||
          bytes % align
        )
          throw new Error("Invalid WAV samples");
        return bytes / align;
      }
      offset += length + (length % 2);
    }
    throw new Error("Missing decoded WAV samples");
  } finally {
    await f.close();
  }
}

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { Asset } from "../../shared/contracts";
import { parseAsset } from "../../domain/project";
import { fileSignature } from "./media-protocol";
/** Main-only metadata approval; never serialized into a project or renderer snapshot. */
export interface OriginalPlaybackCandidate {
  file: string;
  signature: string;
  version: number;
  mime: "video/mp4";
  codec: "h264" | "hevc";
}
interface Inspection {
  asset: Asset;
  signature: string;
  directCodec: OriginalPlaybackCandidate["codec"] | null;
}
function approvedCodec(
  raw: Record<string, any>,
  asset: Asset,
): OriginalPlaybackCandidate["codec"] | null {
  const streams = raw.streams as Array<Record<string, any>>;
  const videos = streams.filter((s) => s.codec_type === "video");
  const audios = streams.filter((s) => s.codec_type === "audio");
  const video = videos[0],
    audio = audios[0];
  const zero = (n: unknown) =>
    typeof n === "string" &&
    Number.isFinite(Number(n)) &&
    Math.abs(Number(n)) <= 0.000001;
  const duration = Number(raw.format?.duration);
  const nearDuration = (n: unknown) =>
    Number.isFinite(Number(n)) &&
    Number(n) > 0 &&
    Math.abs(Number(n) - duration) <= 1 / 30 + 0.001;
  if (
    raw.format?.format_name !== "mov,mp4,m4a,3gp,3g2,mj2" ||
    !["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "M4V "].includes(
      raw.format?.tags?.major_brand,
    ) ||
    videos.length !== 1 ||
    audios.length > 1 ||
    streams.some((s) => !["video", "audio"].includes(s.codec_type)) ||
    !video ||
    video.disposition?.attached_pic === 1 ||
    !zero(raw.format?.start_time) ||
    !zero(video.start_time) ||
    !nearDuration(video.duration) ||
    duration > 6 * 60 * 60 ||
    asset.rotation % 360 !== 0 ||
    asset.width > 8192 ||
    asset.height > 8192 ||
    ratio(video.avg_frame_rate, 0) <= 0 ||
    asset.fps > 120 ||
    (video.sample_aspect_ratio !== undefined &&
      video.sample_aspect_ratio !== "1:1") ||
    ![undefined, "unknown", "bt709", "smpte170m", "bt470bg"].includes(
      video.color_transfer,
    ) ||
    ![undefined, "unknown", "bt709", "smpte170m", "bt470bg"].includes(
      video.color_space,
    ) ||
    ![undefined, "unknown", "bt709", "smpte170m", "bt470bg"].includes(
      video.color_primaries,
    )
  )
    return null;
  if (
    audio &&
    (!zero(audio.start_time) ||
      !nearDuration(audio.duration) ||
      audio.codec_name !== "aac" ||
      audio.codec_tag_string !== "mp4a" ||
      audio.profile !== "LC" ||
      ![44100, 48000].includes(Number(audio.sample_rate)) ||
      ![1, 2].includes(audio.channels))
  )
    return null;
  if (
    video.codec_name === "h264" &&
    video.codec_tag_string === "avc1" &&
    video.pix_fmt === "yuv420p" &&
    ["Baseline", "Constrained Baseline", "Main", "High"].includes(video.profile)
  )
    return "h264";
  if (
    video.codec_name === "hevc" &&
    video.codec_tag_string === "hvc1" &&
    ((video.profile === "Main" && video.pix_fmt === "yuv420p") ||
      (video.profile === "Main 10" &&
        video.pix_fmt === "yuv420p10le" &&
        // Some probes omit transfer/primaries; require a positive SDR matrix for 10-bit candidates.
        video.color_space === "bt709"))
  )
    return "hevc";
  return null;
}
const run = promisify(execFile);
/** Main-only path authority. Paths enter through actual native selection/import. */
export class SourceRegistry {
  private paths = new Map<string, string>();
  private versions = new Map<string, number>();
  private sequence = 0;
  version(id: string): number | undefined {
    return this.versions.get(id);
  }
  ids(): string[] {
    return [...this.paths.keys()];
  }
  register(id: string, realPath: string): void {
    this.paths.set(id, realPath);
    this.versions.set(id, ++this.sequence);
  }
  resolve(id: string): string {
    const value = this.paths.get(id);
    if (!value) throw new Error("Source needs native relink authorization");
    return value;
  }
  remove(id: string): void {
    this.paths.delete(id);
    this.versions.delete(id);
  }
  clear(): void {
    this.paths.clear();
    this.versions.clear();
  }
}
/** Hash the entire source, and reject a concurrent replacement/write. */
export async function fingerprintFile(
  file: string,
  signal?: AbortSignal,
): Promise<string> {
  const before = await stat(file);
  if (!before.isFile()) throw new Error("Expected a regular media file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(
    file,
    signal ? { signal } : undefined,
  )) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  const after = await stat(file);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error("Source changed during verification");
  return `sha256:${hash.digest("hex")}`;
}
function ratio(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const [a, b] = value.split(/[/:]/).map(Number);
  const n = (a ?? 0) / (b ?? 1);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
export class MediaService {
  private originalCandidates = new Map<
    string,
    OriginalPlaybackCandidate & { asset: Asset }
  >();
  /** No probing or hashing on snapshot reads; only a still-current native approval can be returned. */
  approvedOriginal(asset: Asset): OriginalPlaybackCandidate | null {
    const approved = this.originalCandidates.get(asset.id);
    if (
      !approved ||
      asset.status !== "ready" ||
      approved.version !== this.sources.version(asset.id)
    )
      return null;
    for (const key of [
      "fingerprint",
      "durationMs",
      "width",
      "height",
      "rotation",
      "fps",
      "sampleAspectRatio",
      "hasAudio",
    ] as const)
      if (asset[key] !== approved.asset[key]) return null;
    try {
      if (
        this.sources.resolve(asset.id) !== approved.file ||
        fileSignature(approved.file) !== approved.signature
      )
        return null;
    } catch {
      return null;
    }
    const { asset: _, ...candidate } = approved;
    return candidate;
  }
  private registerInspection(
    id: string,
    source: string,
    inspected: Inspection,
  ): void {
    this.sources.register(id, source);
    this.originalCandidates.delete(id);
    for (const [oldId, candidate] of this.originalCandidates)
      if (this.sources.version(oldId) !== candidate.version)
        this.originalCandidates.delete(oldId);
    if (inspected.directCodec)
      this.originalCandidates.set(id, {
        asset: structuredClone(inspected.asset),
        file: source,
        version: this.sources.version(id)!,
        signature: inspected.signature,
        mime: "video/mp4",
        codec: inspected.directCodec,
      });
  }
  constructor(
    readonly ffprobe: string,
    readonly sources: SourceRegistry,
  ) {}
  private async inspect(file: string): Promise<Inspection> {
    const filePath = await realpath(file);
    const signature = fileSignature(filePath);
    const identity = await fingerprintFile(filePath);
    const { stdout } = await run(
      this.ffprobe,
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
      { maxBuffer: 4 * 1024 * 1024, timeout: 30000 },
    );
    const raw = JSON.parse(stdout);
    const streams = raw.streams as Array<Record<string, any>>;
    const video = streams.find(
      (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1,
    );
    const audio = streams.find((s) => s.codec_type === "audio");
    if (!video) throw new Error("Unsupported media: no playable video stream");
    const duration = Number(
      raw.format?.duration ?? video?.duration ?? audio?.duration,
    );
    if (!Number.isFinite(duration) || duration <= 0)
      throw new Error("Unsupported media duration");
    const side = video?.side_data_list?.find(
      (s: Record<string, unknown>) => s.rotation !== undefined,
    );
    const rotation = Number(side?.rotation ?? video?.tags?.rotate ?? 0);
    const asset = parseAsset({
      id: randomUUID(),
      name: path.basename(filePath),
      fileRef: path.basename(filePath),
      status: "ready",
      fingerprint: identity,
      durationMs: Math.round(duration * 1000),
      width: video?.width ?? 1,
      height: video?.height ?? 1,
      rotation,
      fps: ratio(video?.avg_frame_rate, 30),
      sampleAspectRatio: ratio(video?.sample_aspect_ratio, 1),
      hasAudio: !!audio,
    });
    if (
      (await fingerprintFile(filePath)) !== identity ||
      fileSignature(filePath) !== signature
    )
      throw new Error("Source changed during probing");
    return { asset, signature, directCodec: approvedCodec(raw, asset) };
  }
  async probeAsset(file: string): Promise<Asset> {
    const source = await realpath(file);
    const inspected = await this.inspect(source);
    this.registerInspection(inspected.asset.id, source, inspected);
    return inspected.asset;
  }
  async verifyAssetIdentity(asset: Asset, signal?: AbortSignal): Promise<void> {
    if (asset.status !== "ready")
      throw new Error(`Source is ${asset.status}; relink/import required`);
    if (
      (await fingerprintFile(this.sources.resolve(asset.id), signal)) !==
      asset.fingerprint
    )
      throw new Error(
        "Source content changed; transcript and cuts require review",
      );
  }
  async relink(asset: Asset, file: string): Promise<Asset> {
    const source = await realpath(file);
    const inspected = await this.inspect(source);
    if (inspected.asset.fingerprint !== asset.fingerprint) {
      this.sources.remove(asset.id);
      return { ...asset, status: "changed" };
    }
    this.registerInspection(asset.id, source, inspected);
    return { ...asset, status: "ready" };
  }
}

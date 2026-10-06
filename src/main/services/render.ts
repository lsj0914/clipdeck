import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  statSync,
  realpathSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
  rmSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import type { AssemblyPlan, Asset, Project } from "../../shared/contracts";
import { buildAssemblyPlan } from "../../domain/assembly";
import type { MediaService } from "./media";
import type { JobContext, JobManager } from "./jobs";
import { MediaProtocol, fileSignature } from "./media-protocol";
import {
  RenderEngine,
  videoFilter,
  audioFilter,
  type RenderInput,
  type RenderReceipt,
} from "./render-engine";
export interface RenderOptions {
  ffmpeg: string;
  ffprobe: string;
  media: MediaService;
  jobs: JobManager;
  cacheRoot: string;
  getProject: () => Project;
}
export interface ExportTarget {
  path: string;
  overwriteConfirmed: boolean;
}
interface Target {
  file: string;
  parent: string;
  parentIdentity: string;
  signature: string | null;
}
interface Result {
  file: string;
  url: string;
  receipt: RenderReceipt;
  cache: boolean;
  key: string;
}
const identity = (file: string) => {
  const s = statSync(file);
  return `${s.dev}:${s.ino}`;
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const RULES = "clipdeck-render-1-common-clock-30fps-48k";
const MAX_CACHE_BYTES = 4 * 1024 ** 3;
export class RenderService {
  readonly protocol = new MediaProtocol();
  readonly engine: RenderEngine;
  private results = new Map<string, Result>();
  private pending = new Map<string, string>();
  // Original files are never cache results: cache eviction must never own/delete them.
  private directSources = new Map<string, { key: string; url: string }>();
  private normalizedSources = new Map<string, string>();
  private directProjectId: string | null = null;
  private syncDirectProject(): void {
    const id = this.options.getProject().id;
    if (id === this.directProjectId) return;
    for (const direct of this.directSources.values())
      this.protocol.revoke(direct.url);
    this.directSources.clear();
    this.normalizedSources.clear();
    this.directProjectId = id;
  }
  private retireDirect(assetId: string, key: string): void {
    this.syncDirectProject();
    this.normalizedSources.set(assetId, key);
    const direct = this.directSources.get(assetId);
    if (direct) {
      this.protocol.revoke(direct.url);
      this.directSources.delete(assetId);
    }
  }
  private originalUrl(asset: Asset, key: string): string | null {
    this.syncDirectProject();
    if (this.normalizedSources.get(asset.id) === key) return null;
    const approved = this.options.media.approvedOriginal(asset);
    const previous = this.directSources.get(asset.id);
    if (previous && (!approved || previous.key !== key)) {
      this.protocol.revoke(previous.url);
      this.directSources.delete(asset.id);
    }
    if (!approved) return null;
    const projectId = this.options.getProject().id;
    if (previous?.key === key && this.protocol.available(previous.url))
      return previous.url;
    const input = this.capture(asset),
      inputs = new Map([[asset.id, input]]);
    const url = this.protocol.register(approved.file, async (signal) => {
      signal.throwIfAborted();
      const project = this.options.getProject(),
        current = project.assets.find((a) => a.id === asset.id);
      if (
        project.id !== projectId ||
        !current ||
        current.status !== "ready" ||
        this.normalizedSources.get(asset.id) === key ||
        this.directSources.get(asset.id)?.url !== url
      )
        return false;
      const candidate = this.options.media.approvedOriginal(current);
      if (
        !candidate ||
        candidate.version !== approved.version ||
        candidate.signature !== approved.signature
      )
        return false;
      this.checkSourcesSync(inputs);
      return true;
    });
    this.directSources.set(asset.id, { key, url });
    return url;
  }
  private sourceJobs = new Map<
    string,
    { projectId: string; input: RenderInput }
  >();
  sourceJobCurrent(id: string): boolean {
    const value = this.sourceJobs.get(id);
    if (!value) return false;
    try {
      if (fileSignature(value.input.file) !== value.input.signature)
        return false;
    } catch {
      return false;
    }
    const p = this.options.getProject();
    return (
      p.id === value.projectId &&
      p.assets.some(
        (a) =>
          a.id === value.input.asset.id &&
          a.fingerprint === value.input.asset.fingerprint &&
          a.status === "ready",
      ) &&
      this.options.media.sources.version(value.input.asset.id) ===
        value.input.version
    );
  }
  constructor(readonly options: RenderOptions) {
    this.engine = new RenderEngine(options.ffmpeg, options.ffprobe);
  }
  receipt(id: string): RenderReceipt | undefined {
    return this.results.get(id)?.receipt;
  }
  outputPath(id: string): string | undefined {
    return this.results.get(id)?.file;
  }
  private snapshot(plan: AssemblyPlan): {
    plan: AssemblyPlan;
    inputs: Map<string, RenderInput>;
  } {
    const project = this.options.getProject();
    if (JSON.stringify(plan) !== JSON.stringify(buildAssemblyPlan(project)))
      throw new Error("Assembly plan no longer matches the current project");
    const frozen = structuredClone(plan);
    if (frozen.durationMs > 6 * 60 * 60 * 1000)
      throw new Error(
        "Assembly exceeds the six-hour local render limit; split this project",
      );
    const inputs = new Map<string, RenderInput>();
    for (const segment of frozen.segments) {
      if (inputs.has(segment.assetId)) continue;
      const asset = project.assets.find((a) => a.id === segment.assetId)!;
      inputs.set(asset.id, this.capture(asset));
    }
    return { plan: frozen, inputs };
  }
  private capture(asset: Asset): RenderInput {
    if (asset.status !== "ready")
      throw new Error("Source requires relinking before rendering");
    const file = this.options.media.sources.resolve(asset.id),
      version = this.options.media.sources.version(asset.id)!;
    return {
      asset: structuredClone(asset),
      file,
      version,
      signature: fileSignature(file),
    };
  }
  private checkSourcesSync(inputs: Map<string, RenderInput>): void {
    for (const input of inputs.values())
      if (
        this.options.media.sources.version(input.asset.id) !== input.version ||
        this.options.media.sources.resolve(input.asset.id) !== input.file ||
        fileSignature(input.file) !== input.signature
      )
        throw new Error(
          "Source changed during media processing; relink and review its cuts",
        );
  }
  private async verifySources(
    inputs: Map<string, RenderInput>,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    this.checkSourcesSync(inputs);
    for (const input of inputs.values()) {
      await this.options.media.verifyAssetIdentity(input.asset, signal);
      signal.throwIfAborted();
    }
    this.checkSourcesSync(inputs);
  }
  private async target(request: ExportTarget): Promise<Target> {
    const parent = await realpath(path.dirname(request.path)),
      file = path.join(parent, path.basename(request.path));
    this.checkTargetSources(file);
    let signature: string | null = null;
    try {
      const s = lstatSync(file);
      if (s.isSymbolicLink())
        throw new Error("Symbolic-link output targets are not allowed");
      if (!s.isFile()) throw new Error("Output must be a regular file");
      if (!request.overwriteConfirmed)
        throw new Error("Overwrite requires native save-dialog confirmation");
      signature = fileSignature(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return { file, parent, parentIdentity: identity(parent), signature };
  }
  private checkTargetSources(file: string): void {
    let outputIdentity: string | undefined;
    try {
      outputIdentity = identity(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    for (const id of this.options.media.sources.ids()) {
      const source = this.options.media.sources.resolve(id);
      if (
        file === source ||
        (outputIdentity && outputIdentity === identity(source))
      )
        throw new Error(
          "Output aliases an original source; choose a different destination",
        );
    }
  }
  private checkTarget(target: Target): void {
    if (
      realpathSync(target.parent) !== target.parent ||
      identity(target.parent) !== target.parentIdentity
    )
      throw new Error("Output directory changed during processing");
    this.checkTargetSources(target.file);
    let signature: string | null = null;
    try {
      if (lstatSync(target.file).isSymbolicLink())
        throw new Error("Output became a symbolic link");
      signature = fileSignature(target.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (signature !== target.signature)
      throw new Error(
        "Output changed after native save confirmation; choose the destination again",
      );
  }
  private sourceKey(asset: Asset): string {
    return digest([
      RULES,
      "source",
      asset.id,
      asset.fingerprint,
      this.options.media.sources.version(asset.id),
      fileSignature(this.options.media.sources.resolve(asset.id)),
    ]);
  }
  sourceUrl(asset: Asset): string | null {
    this.syncDirectProject();
    const current = this.options
      .getProject()
      .assets.find((a) => a.id === asset.id);
    if (
      !current ||
      current.status !== "ready" ||
      current.fingerprint !== asset.fingerprint
    )
      return null;
    if (
      asset.status !== "ready" ||
      !this.options.media.sources.version(asset.id)
    )
      return null;
    try {
      const key = this.sourceKey(asset),
        id = this.pending.get(key),
        result = id ? this.results.get(id) : undefined;
      return result && this.protocol.available(result.url)
        ? result.url
        : this.originalUrl(asset, key);
    } catch {
      // Sources may disappear between approval and capability registration.
      return null;
    }
  }
  async initialize(): Promise<void> {
    await rm(this.options.cacheRoot, { recursive: true, force: true });
    await mkdir(this.options.cacheRoot, { recursive: true });
  }
  async prepareSourcePreview(assetId: string): Promise<string> {
    const asset = this.options
      .getProject()
      .assets.find((a) => a.id === assetId);
    if (!asset) throw new Error("Unknown source");
    const input = this.capture(asset),
      inputs = new Map([[assetId, input]]),
      key = this.sourceKey(asset);
    this.retireDirect(assetId, key);
    if (asset.durationMs > 6 * 60 * 60 * 1000)
      throw new Error(
        "Source preview exceeds the six-hour local limit; split the original first",
      );
    const existing = this.cachedJob(key);
    if (existing) return existing;
    await mkdir(this.options.cacheRoot, { recursive: true });
    const target = await this.target({
      path: path.join(this.options.cacheRoot, `${randomUUID()}.mp4`),
      overwriteConfirmed: false,
    });
    const raced = this.cachedJob(key);
    if (raced) return raced;
    const frames = Math.ceil((asset.durationMs * 30) / 1000),
      samples = frames * 1600;
    let displayWidth = asset.width * (asset.sampleAspectRatio ?? 1),
      displayHeight = asset.height;
    if (Math.abs(asset.rotation) % 180 === 90)
      [displayWidth, displayHeight] = [displayHeight, displayWidth];
    const scale = Math.min(1, 1280 / Math.max(displayWidth, displayHeight));
    const width = Math.max(2, Math.round((displayWidth * scale) / 2) * 2),
      height = Math.max(2, Math.round((displayHeight * scale) / 2) * 2);
    const id = this.options.jobs.start(
      "sourcePreview",
      { assetId, totalMs: asset.durationMs },
      async (ctx) => {
        let dir: string | undefined;
        try {
          ctx.update({ stage: "checking source identity", progress: null });
          await this.verifySources(inputs, ctx.signal);
          await this.reserve(target.parent, samples);
          dir = await mkdtemp(path.join(target.parent, ".clipdeck-source-"));
          const file = path.join(dir, "verified.mp4");
          const args = ["-protocol_whitelist", "file,pipe", "-i", input.file];
          if (!asset.hasAudio)
            args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
          const af = asset.hasAudio
            ? audioFilter(0, asset.durationMs, samples)
            : `atrim=end_sample=${samples},asettb=1/48000,asetpts=N`;
          args.push(
            "-filter_complex",
            `[0:v:0]${videoFilter(0, asset.durationMs, frames, width, height)}[v];[${asset.hasAudio ? "0:a:0" : "1:a:0"}]${af}[a]`,
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "22",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-map_metadata",
            "-1",
            "-video_track_timescale",
            "30000",
            "-movflags",
            "+faststart",
            file,
          );
          ctx.update({ stage: "preparing source video", progress: 0 });
          await this.engine.ff(args, ctx, (ms) => {
            try {
              if (statSync(file).size > MAX_CACHE_BYTES)
                throw new Error("Source preview exceeds the local cache limit");
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            }
            ctx.update({
              processedMs: Math.min(ms, asset.durationMs),
              progress: Math.min(0.85, (ms / asset.durationMs) * 0.85),
            });
          });
          const receipt = await this.engine.validate(
            file,
            { frames, samples, width, height },
            dir,
            ctx,
          );
          if (
            Math.abs(receipt.durationSeconds - asset.durationMs / 1000) >
            1 / 30 + 0.001
          )
            throw new Error(
              "Source preview duration differs from the original time axis",
            );
          ctx.update({ stage: "checking sources", progress: 0.98 });
          await this.verifySources(inputs, ctx.signal);
          this.makeCacheRoom(statSync(file).size);
          ctx.update({ stage: "committing", progress: 0.99 });
          ctx.throwIfCancelled();
          const fd = openSync(file, "r");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          ctx.commit(() => {
            this.checkSourcesSync(inputs);
            this.checkTarget(target);
            renameSync(file, target.file);
          });
          const url = this.protocol.register(target.file, async (signal) => {
            signal.throwIfAborted();
            this.checkSourcesSync(inputs);
            return true;
          });
          this.results.set(id, {
            file: target.file,
            url,
            receipt,
            cache: true,
            key,
          });
          ctx.update({ outputUrl: url });
          await this.prune();
        } finally {
          if (dir)
            await rm(dir, { recursive: true, force: true }).catch(() => {});
          if (!this.results.has(id)) this.releaseLookup(key, id);
        }
      },
    );
    this.sourceJobs.set(id, { projectId: this.options.getProject().id, input });
    this.pending.set(key, id);
    return id;
  }
  async preview(plan: AssemblyPlan): Promise<string> {
    const snapshot = this.snapshot(plan);
    await mkdir(this.options.cacheRoot, { recursive: true });
    const key = digest([
      RULES,
      "assembly",
      snapshot.plan,
      [...snapshot.inputs.values()].map((i) => [
        i.asset.fingerprint,
        i.version,
        i.signature,
      ]),
    ]);
    const existing = this.cachedJob(key);
    if (existing) return existing;
    const target = await this.target({
      path: path.join(this.options.cacheRoot, `${randomUUID()}.mp4`),
      overwriteConfirmed: false,
    });
    const raced = this.cachedJob(key);
    if (raced) return raced;
    return this.start("preview", snapshot, target, key);
  }
  async export(plan: AssemblyPlan, request: ExportTarget): Promise<string> {
    const snapshot = this.snapshot(plan);
    const target = await this.target(request);
    return this.start("export", snapshot, target, randomUUID());
  }
  /** A retired result must not erase a newer attempt using the same key. */
  private releaseLookup(key: string, ownerId: string): void {
    if (this.pending.get(key) === ownerId) this.pending.delete(key);
  }
  private cachedJob(key: string): string | undefined {
    const id = this.pending.get(key);
    if (!id) return;
    const job = this.options.jobs.list().find((j) => j.id === id);
    if (job && ["queued", "running"].includes(job.status)) return id;
    const result = this.results.get(id);
    if (
      job?.status === "completed" &&
      result &&
      this.protocol.available(result.url)
    )
      return id;
    this.releaseLookup(key, id);
    return;
  }
  private async reserve(parent: string, samples: number): Promise<void> {
    const free = await statfs(parent);
    if (free.bavail * free.bsize < samples * 4 + 256 * 1024 ** 2)
      throw new Error(
        "Not enough free space for media processing and audio verification",
      );
  }
  private start(
    kind: "preview" | "export",
    snapshot: ReturnType<RenderService["snapshot"]>,
    target: Target,
    key: string,
  ): string {
    const { plan, inputs } = snapshot,
      width = kind === "preview" ? plan.output.width / 2 : plan.output.width,
      height = kind === "preview" ? plan.output.height / 2 : plan.output.height;
    const id = this.options.jobs.start(
      kind,
      {
        projectId: plan.projectId,
        projectRevision: plan.revision,
        totalMs: plan.durationMs,
      },
      async (ctx) => {
        let dir: string | undefined;
        try {
          await this.verifySources(inputs, ctx.signal);
          this.checkTarget(target);
          await this.reserve(target.parent, plan.totalSamples);
          dir = await mkdtemp(path.join(target.parent, ".clipdeck-render-"));
          const file = await this.engine.assemble(
            plan,
            inputs,
            dir,
            ctx,
            width,
            height,
          );
          const receipt = await this.engine.validate(
            file,
            {
              frames: plan.totalFrames,
              samples: plan.totalSamples,
              width,
              height,
            },
            dir,
            ctx,
          );
          ctx.update({ stage: "checking sources", progress: 0.98 });
          await this.verifySources(inputs, ctx.signal);
          if (kind === "preview") this.makeCacheRoom(statSync(file).size);
          ctx.update({ stage: "committing", progress: 0.99 });
          ctx.throwIfCancelled();
          const fd = openSync(file, "r");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          ctx.commit(() => {
            this.checkSourcesSync(inputs);
            this.checkTarget(target);
            renameSync(file, target.file);
          });
          const url = this.protocol.register(
            target.file,
            kind === "export"
              ? async () => true
              : async (signal) => {
                  const p = this.options.getProject();
                  if (p.id !== plan.projectId || p.revision !== plan.revision)
                    return false;
                  signal.throwIfAborted();
                  this.checkSourcesSync(inputs);
                  return true;
                },
          );
          this.results.set(id, {
            file: target.file,
            url,
            receipt,
            cache: kind === "preview",
            key,
          });
          ctx.update({ outputUrl: url });
          await this.prune();
        } finally {
          if (dir)
            await rm(dir, { recursive: true, force: true }).catch(() => {});
          if (!this.results.has(id)) this.releaseLookup(key, id);
        }
      },
    );
    this.pending.set(key, id);
    return id;
  }
  private makeCacheRoom(incomingBytes: number): void {
    const cached = [...this.results.entries()].filter(([, r]) => r.cache);
    const size = (r: Result) => {
      try {
        return statSync(r.file).size;
      } catch {
        return 0;
      }
    };
    let bytes = cached.reduce((total, [, r]) => total + size(r), 0),
      count = cached.length;
    const candidates = cached.filter(
      ([, r]) => r.url !== this.protocol.lastServedUrl,
    );
    while (count >= 8 || bytes + incomingBytes > MAX_CACHE_BYTES) {
      const next = candidates.shift();
      if (!next)
        throw new Error(
          "The current video and new preview exceed the 4 GB cache limit; use a shorter source or assembly",
        );
      const [id, result] = next;
      bytes -= size(result);
      count--;
      this.protocol.revoke(result.url);
      this.results.delete(id);
      this.releaseLookup(result.key, id);
      rmSync(result.file, { force: true });
    }
  }
  private async prune(): Promise<void> {
    const ids = new Set(this.options.jobs.list().map((j) => j.id));
    for (const [id, result] of this.results)
      if (!result.cache && !ids.has(id)) {
        this.protocol.revoke(result.url);
        this.results.delete(id);
        this.releaseLookup(result.key, id);
      }
    for (const id of this.sourceJobs.keys())
      if (!ids.has(id)) this.sourceJobs.delete(id);
  }
}

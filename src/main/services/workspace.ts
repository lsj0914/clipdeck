import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type {
  Asset,
  EditCommand,
  Language,
  ModelChoice,
  TranscriptionOptions as TranscriptionRequestOptions,
  Project,
  TranscriptionDraft,
  Transcript,
  WorkspaceSnapshot,
} from "../../shared/contracts";
import {
  createProject,
  applyProjectEdit,
  reconcileCut,
  validateProject,
  serializeProject,
} from "../../domain/project";
import { safeSnapshot, type IpcServices } from "../ipc";
import { MediaService, SourceRegistry } from "./media";
import { ModelRegistry } from "./models";
import { ProjectStore } from "./storage";
import { JobManager } from "./jobs";
import { TranscriptionService, checkWorker } from "./transcription";
import type { RuntimePaths } from "./runtime";
import { RenderService } from "./render";
import { buildAssemblyPlan } from "../../domain/assembly";
import { cleanupLocalTransient } from "./transient";
export interface NativeDialogs {
  media(): Promise<string[]>;
  open(): Promise<string | null>;
  save(current: string | null): Promise<string | null>;
  relink(asset: Asset): Promise<string | null>;
  model(): Promise<string | null>;
  export?(): Promise<string | null>;
  reveal?(file: string): void;
}
export interface WorkspaceOptions {
  runtime: RuntimePaths;
  dataRoot: string;
  notify: (snapshot: WorkspaceSnapshot) => void;
  dialogs: NativeDialogs;
}
export class WorkspaceService {
  project: Project = createProject();
  readonly sources = new SourceRegistry();
  readonly media: MediaService;
  readonly jobs: JobManager;
  readonly models: ModelRegistry;
  readonly store: ProjectStore;
  readonly transcription: TranscriptionService;
  readonly rendering: RenderService;
  private mediaReady = false;
  private workerReady = false;
  private recovered = false;
  private recoveryError: string | null = null;
  private drafts: Record<string, TranscriptionDraft> = {};
  private transcriptVersions = new WeakMap<Transcript, string>();
  private sourceUrl: ((asset: Asset) => string | null) | undefined;
  private sourceAccessPending = false;
  private projectEpoch = 0;
  private importFailures: Array<{ name: string; message: string }> = [];
  private closing = false;
  private cleanupWarnings: string[] = [];
  private admittedStarts = new Set<{ cancelled: boolean; done: Promise<void>; finish: () => void }>();
  beginClose(): void { this.closing = true; }
  resumeAfterClose(): void { this.closing = false; }
  hasRunningWork(): boolean {
    return this.admittedStarts.size > 0 || this.transcription.hasPendingStarts || this.jobs.list().some((job) => ["queued", "running", "cancelling"].includes(job.status));
  }
  private assertWorkAllowed(): void {
    if (this.closing) throw new Error("The workspace is closing; keep editing before starting another task");
  }
  async cancelWork(): Promise<void> {
    const admitted = [...this.admittedStarts];
    for (const start of admitted) start.cancelled = true;
    await this.transcription.cancelPendingStarts();
    await Promise.all(admitted.map((start) => start.done));
    await this.jobs.cancelAll();
  }
  private async admitWork(start: () => Promise<string>): Promise<string> {
    this.assertWorkAllowed();
    let finish!: () => void;
    const ticket = { cancelled: false, done: new Promise<void>((resolve) => { finish = resolve; }), finish: () => finish() };
    this.admittedStarts.add(ticket);
    try {
      const id = await start();
      if (ticket.cancelled) {
        // JobManager pumps on setImmediate. Settle a late registration in this
        // promise turn before it can launch a native process.
        await this.jobs.cancel(id);
        throw new Error("Task was cancelled before starting");
      }
      return id;
    } finally { this.admittedStarts.delete(ticket); ticket.finish(); }
  }
  constructor(readonly options: WorkspaceOptions) {
    const notify = () => this.emit();
    this.media = new MediaService(options.runtime.ffprobe, this.sources);
    this.jobs = new JobManager(notify);
    this.rendering = new RenderService({
      ...options.runtime,
      media: this.media,
      jobs: this.jobs,
      cacheRoot: path.join(options.dataRoot, "media-cache"),
      getProject: () => this.project,
    });
    this.sourceUrl = (asset) => this.rendering.sourceUrl(asset);
    this.models = new ModelRegistry(
      path.join(options.dataRoot, "model-settings.json"),
      path.join(options.dataRoot, "models/faster-whisper-small-536b066"),
      notify,
    );
    this.store = new ProjectStore(
      path.join(options.dataRoot, "recovery.json"),
      this.sources,
      this.media,
    );
    this.transcription = new TranscriptionService({
      ...options.runtime,
      tempRoot: path.join(options.dataRoot, "jobs"),
      media: this.media,
      models: this.models,
      jobs: this.jobs,
      getProject: () => this.project,
      onDraft: (assetId, draft) => {
        if (draft) this.drafts[assetId] = draft;
        else delete this.drafts[assetId];
        this.emit();
      },
      onTranscript: (t) => this.commitTranscript(t),
    });
  }
  async initialize(): Promise<void> {
    await mkdir(this.options.dataRoot, { recursive: true });
    this.cleanupWarnings = await cleanupLocalTransient(this.options.dataRoot);
    await this.rendering.initialize();
    try {
      await Promise.all([
        access(this.options.runtime.ffmpeg, constants.X_OK),
        access(this.options.runtime.ffprobe, constants.X_OK),
      ]);
      this.mediaReady = true;
    } catch {}
    try {
      await checkWorker(
        this.options.runtime.python,
        this.options.runtime.worker,
      );
      this.workerReady = true;
    } catch {}
    await this.models.initialize();
    try {
      const recovered = await this.store.recover();
      if (recovered) {
        this.project = recovered;
        this.recovered = true;
      }
    } catch {
      this.recoveryError =
        "Could not recover the local draft; open a saved project or start a new one";
    }
    this.emit();
  }
  attachMediaUrls(provider: (asset: Asset) => string | null): void {
    this.sourceUrl = provider;
    this.emit();
  }
  snapshot(): WorkspaceSnapshot {
    const result = safeSnapshot(this.project);
    result.transcriptVersions = Object.fromEntries(
      this.project.transcripts.map((transcript) => {
        let version = this.transcriptVersions.get(transcript);
        if (!version) {
          version = globalThis.crypto.randomUUID();
          this.transcriptVersions.set(transcript, version);
        }
        return [transcript.assetId, version];
      }),
    );
    result.cleanupWarnings = [...new Set([...this.cleanupWarnings, ...this.rendering.cleanupWarnings])];
    result.model = { ...this.models.status };
    result.jobs = this.jobs
      .list()
      .filter(
        (job) =>
          job.kind !== "sourcePreview" ||
          this.rendering.sourceJobCurrent(job.id),
      )
      .map((job) =>
        job.outputUrl && !this.rendering.protocol.available(job.outputUrl)
          ? { ...job, outputUrl: null }
          : job,
      );
    result.importFailures = this.importFailures.map((failure) => ({
      ...failure,
    }));
    result.transcriptionDrafts = { ...this.drafts };
    result.save = {
      dirty: this.store.savedRevision !== this.project.revision,
      displayName: this.store.currentPath
        ? path.basename(this.store.currentPath)
        : null,
      recovered: this.recovered,
      error: this.recoveryError,
    };
    result.capabilities = {
      media: this.mediaReady,
      transcription: this.workerReady && this.models.status.status === "ready",
      rendering: this.mediaReady,
      persistence: true,
    };
    result.project.assets = result.project.assets.map((asset) => ({
      ...asset,
      mediaUrl:
        asset.status === "ready"
          ? (this.sourceUrl?.(
              this.project.assets.find((a) => a.id === asset.id)!,
            ) ?? null)
          : null,
    }));
    return result;
  }
  private emit(): void {
    this.options.notify(this.snapshot());
  }
  private async persistRecovery(): Promise<void> {
    try {
      await this.store.autosave(this.project);
      this.recoveryError = null;
    } catch {
      this.recoveryError = "Could not save the local recovery draft";
      this.emit();
      throw new Error(this.recoveryError);
    }
  }
  private externalUpdate(assets: Asset[], approve?: () => void): void {
    const transcripts = this.project.transcripts.filter((t) =>
      assets.some(
        (a) =>
          a.id === t.assetId &&
          a.status !== "changed" &&
          a.fingerprint === t.fingerprint,
      ),
    );
    const cache = new Map<Transcript, Set<string>>();
    const next = {
      ...this.project,
      assets,
      transcripts,
      cuts: this.project.cuts.map((c) =>
        reconcileCut(c, assets, transcripts, cache),
      ),
      revision: this.project.revision + 1,
    };
    validateProject(serializeProject(next));
    approve?.();
    this.project = next;
    this.emit();
  }
  private commitTranscript(transcript: Transcript): void {
    const transcripts = [
      ...this.project.transcripts.filter(
        (t) => t.assetId !== transcript.assetId,
      ),
      transcript,
    ];
    const cache = new Map<Transcript, Set<string>>();
    this.project = {
      ...this.project,
      transcripts,
      cuts: this.project.cuts.map((c) =>
        reconcileCut(c, this.project.assets, transcripts, cache),
      ),
      revision: this.project.revision + 1,
    };
    this.emit();
    void this.persistRecovery().catch(() => {});
  }
  async getSnapshot(): Promise<WorkspaceSnapshot> {
    await this.refreshSources();
    return this.snapshot();
  }
  async refreshSources(): Promise<void> {
    if (this.sourceAccessPending) return;
    const initial = this.project;
    const epoch = this.projectEpoch;
    const changes = new Map<
      string,
      { expected: Asset; replacement: Asset; sourceVersion: number | undefined }
    >();
    for (const asset of initial.assets) {
      if (asset.status !== "ready") continue;
      const sourceVersion = this.sources.version(asset.id);
      try {
        await this.media.verifyAssetIdentity(asset);
      } catch (error) {
        const missing =
          (error as NodeJS.ErrnoException).code === "ENOENT" ||
          !this.sources.ids().includes(asset.id);
        changes.set(asset.id, {
          expected: asset,
          sourceVersion,
          replacement: { ...asset, status: missing ? "missing" : "changed" },
        });
      }
    }
    if (epoch !== this.projectEpoch || initial.id !== this.project.id) return;
    let changed = false;
    const assets = this.project.assets.map((asset) => {
      const result = changes.get(asset.id);
      if (
        !result ||
        result.expected !== asset ||
        result.sourceVersion !== this.sources.version(asset.id)
      )
        return asset;
      this.sources.remove(asset.id);
      changed = true;
      return result.replacement;
    });
    if (changed) {
      this.externalUpdate(assets);
      await this.persistRecovery();
    }
  }
  async importPaths(paths: string[]): Promise<WorkspaceSnapshot> {
    if (!this.mediaReady)
      throw new Error("Native media runtime has not been prepared");
    if (paths.length > 1000) throw new Error("Import count limit exceeded");
    const projectId = this.project.id;
    const epoch = this.projectEpoch;
    const imported: Asset[] = [];
    const failures: Array<{ name: string; message: string }> = [];
    this.importFailures = [];
    for (const file of paths) {
      try {
        const asset = await this.media.probeAsset(file);
        if (epoch !== this.projectEpoch || projectId !== this.project.id) {
          this.sources.remove(asset.id);
          for (const prior of imported) this.sources.remove(prior.id);
          throw new Error("Project changed during import");
        }
        if (this.project.assets.length + imported.length >= 10000) {
          this.sources.remove(asset.id);
          throw new Error("Project source limit reached");
        }
        imported.push(asset);
      } catch (error) {
        if (epoch !== this.projectEpoch || projectId !== this.project.id)
          throw error;
        failures.push({
          name: path.basename(file).slice(0, 2000),
          message:
            "Could not import this video; choose a readable supported file",
        });
      }
    }
    this.importFailures = failures;
    if (imported.length) {
      const available = 10000 - this.project.assets.length;
      const accepted = imported.slice(0, available);
      for (const extra of imported.slice(available)) {
        this.sources.remove(extra.id);
        this.importFailures.push({
          name: extra.name,
          message: "Project source limit reached",
        });
      }
      if (accepted.length) {
        this.externalUpdate([...this.project.assets, ...accepted]);
        await this.persistRecovery();
      }
    } else this.emit();
    return this.snapshot();
  }
  async importMedia(): Promise<WorkspaceSnapshot> {
    return this.importPaths(await this.options.dialogs.media());
  }
  async importDroppedFiles(paths: string[]): Promise<WorkspaceSnapshot> {
    return this.importPaths(paths);
  }
  async applyEdit(command: EditCommand): Promise<WorkspaceSnapshot> {
    this.project = applyProjectEdit(this.project, command);
    this.emit();
    await this.persistRecovery();
    return this.snapshot();
  }
  async transcribe(
    assetId: string,
    language: Language,
    options?: TranscriptionRequestOptions,
  ): Promise<string> {
    return this.admitWork(async () => {
      if (!this.workerReady) throw new Error("Pinned offline worker runtime has not been prepared");
      try { return await this.transcription.start(assetId, language, options); }
      catch (error) { if (!this.closing) await this.refreshSources(); throw error; }
    });
  }
  async prepareSourcePreview(assetId: string): Promise<string> {
    return this.admitWork(async () => {
      if (!this.mediaReady) throw new Error("Native media runtime has not been prepared");
      return this.rendering.prepareSourcePreview(assetId);
    });
  }
  async preparePreview(): Promise<string> {
    return this.admitWork(async () => {
      if (!this.mediaReady) throw new Error("Native media runtime has not been prepared");
      return this.rendering.preview(buildAssemblyPlan(this.project));
    });
  }
  async exportVideo(): Promise<string> {
    return this.admitWork(async () => {
    if (!this.mediaReady || !this.options.dialogs.export)
      throw new Error("Native export is unavailable");
    const plan = buildAssemblyPlan(this.project),
      epoch = this.projectEpoch;
    const target = await this.options.dialogs.export();
    if (!target) throw new Error("Export destination was not selected");
    if (
      epoch !== this.projectEpoch ||
      plan.projectId !== this.project.id ||
      plan.revision !== this.project.revision
    )
      throw new Error(
        "Project changed while choosing the export destination; try again",
      );
    // Only the native save dialog can produce this confirmed target.
    return this.rendering.export(plan, {
      path: target,
      overwriteConfirmed: true,
    });
    });
  }
  async revealExport(id: string): Promise<void> {
    const job = this.jobs.list().find((j) => j.id === id),
      file = this.rendering.outputPath(id);
    if (job?.kind !== "export" || job.status !== "completed" || !file)
      throw new Error("No completed export is available");
    await access(file);
    this.options.dialogs.reveal?.(file);
  }
  async cancelJob(id: string): Promise<void> {
    await this.jobs.cancel(id);
  }
  async openProject(): Promise<WorkspaceSnapshot> {
    const file = await this.options.dialogs.open();
    if (!file) return this.snapshot();
    ++this.projectEpoch;
    await this.jobs.cancelAll();
    this.sourceAccessPending = true;
    try {
      const project = await this.store.open(file);
      this.project = project;
      this.drafts = {};
      this.recovered = false;
      this.emit();
      return this.snapshot();
    } finally {
      this.sourceAccessPending = false;
    }
  }
  async saveProject(asNew = false): Promise<WorkspaceSnapshot> {
    const initial = this.project;
    const epoch = this.projectEpoch;
    const target =
      asNew || !this.store.currentPath
        ? await this.options.dialogs.save(this.store.currentPath)
        : this.store.currentPath;
    if (!target) return this.snapshot();
    if (epoch !== this.projectEpoch || initial.id !== this.project.id)
      throw new Error("Project changed while choosing save location");
    const saving = this.project;
    const saved = await this.store.save(saving, target);
    if (epoch === this.projectEpoch && this.project.id === saving.id) {
      this.project = { ...this.project, savedAt: saved.savedAt };
      this.recovered = false;
    }
    this.emit();
    await this.persistRecovery();
    return this.snapshot();
  }
  async relinkMedia(assetId: string): Promise<WorkspaceSnapshot> {
    const initial = this.project;
    const epoch = this.projectEpoch;
    const asset = initial.assets.find((a) => a.id === assetId);
    if (!asset) throw new Error("Unknown source");
    const file = await this.options.dialogs.relink(asset);
    if (!file) return this.snapshot();
    if (epoch !== this.projectEpoch || initial.id !== this.project.id)
      throw new Error("Project changed while choosing source");
    for (const job of this.jobs.list())
      if (
        job.assetId === assetId &&
        ["queued", "running", "cancelling"].includes(job.status)
      )
        await this.jobs.cancel(job.id);
    const linked = await this.media.prepareRelink(asset, file);
    if (epoch !== this.projectEpoch || initial.id !== this.project.id ||
        !this.project.assets.some((current) => current.id === assetId && current.fingerprint === asset.fingerprint)) {
      throw new Error("Project changed during relink");
    }
    this.externalUpdate(
      this.project.assets.map((a) => (a.id === assetId ? linked.asset : a)),
      linked.approve,
    );
    await this.persistRecovery();
    return this.snapshot();
  }
  async chooseModel(): Promise<WorkspaceSnapshot> {
    const directory = await this.options.dialogs.model();
    if (!directory) return this.snapshot();
    await checkWorker(this.options.runtime.python, this.options.runtime.worker);
    this.workerReady = true;
    for (const job of this.jobs.list())
      if (
        job.kind === "modelDownload" &&
        ["queued", "running", "cancelling"].includes(job.status)
      )
        await this.jobs.cancel(job.id);
    await this.models.choose(directory);
    return this.snapshot();
  }
  async downloadModel(choice: ModelChoice = "small"): Promise<string> {
    return this.admitWork(async () => {
    if (!this.workerReady)
      throw new Error("Prepare the pinned offline worker runtime first");
    if (
      this.models.status.status === "downloading" ||
      this.jobs
        .list()
        .some(
          (job) =>
            job.kind === "modelDownload" &&
            ["queued", "running", "cancelling"].includes(job.status),
        )
    )
      throw new Error("Model download already running");
    return this.jobs.start("modelDownload", {}, async (ctx) => {
      ctx.update({ stage: "downloading model", progress: 0 });
      await this.models.download(ctx.signal, ctx.commit, choice);
      ctx.throwIfCancelled();
    });
    });
  }
  services(): IpcServices {
    return {
      getSnapshot: () => this.getSnapshot(),
      importMedia: () => this.importMedia(),
      importDroppedFiles: (p) => this.importDroppedFiles(p),
      applyEdit: (c) => this.applyEdit(c),
      transcribe: (a, l, options) => this.transcribe(a, l, options),
      prepareSourcePreview: (id) => this.prepareSourcePreview(id),
      preparePreview: () => this.preparePreview(),
      exportVideo: () => this.exportVideo(),
      revealExport: (id) => this.revealExport(id),
      cancelJob: (id) => this.cancelJob(id),
      openProject: () => this.openProject(),
      saveProject: (asNew) => this.saveProject(asNew),
      relinkMedia: (id) => this.relinkMedia(id),
      chooseModel: () => this.chooseModel(),
      downloadModel: (choice) => this.downloadModel(choice),
    };
  }
  async close(): Promise<void> {
    this.beginClose();
    try {
      await this.cancelWork();
      await this.persistRecovery();
    } catch (error) {
      this.resumeAfterClose();
      throw error;
    }
  }
}

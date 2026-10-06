import { publicErrorMessage } from "../errors";
import { randomUUID } from "node:crypto";
import type { Job, JobKind } from "../../shared/contracts";
export interface JobContext {
  signal: AbortSignal;
  update(
    changes: Partial<
      Pick<Job, "stage" | "processedMs" | "totalMs" | "progress" | "outputUrl">
    >,
  ): void;
  throwIfCancelled(): void;
  /** Check cancellation and synchronously publish a verified result in one event-loop turn. Never pass an async callback. */
  commit(publish: () => void): void;
}
interface Entry {
  job: Job;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
  task: (ctx: JobContext) => Promise<void>;
  diagnostic?: unknown;
  committed: boolean;
  started: boolean;
}
export class JobManager {
  private entries = new Map<string, Entry>();
  private heavyRunning = 0;
  private downloadRunning = 0;
  private pumpPending = false;
  constructor(readonly notify: () => void) {}
  list(): Job[] {
    return [...this.entries.values()].map((e) => ({ ...e.job }));
  }
  start(
    kind: JobKind,
    options: Partial<
      Pick<Job, "assetId" | "totalMs" | "projectId" | "projectRevision">
    >,
    task: (ctx: JobContext) => Promise<void>,
  ): string {
    const id = randomUUID();
    const controller = new AbortController();
    const job: Job = {
      id,
      kind,
      status: "queued",
      stage: "queued",
      processedMs: 0,
      totalMs: null,
      progress: null,
      error: null,
      cancelRequested: false,
      assetId: null,
      outputUrl: null,
      ...options,
    };
    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));
    this.entries.set(id, {
      job,
      controller,
      done,
      finish,
      task,
      committed: false,
      started: false,
    });
    this.notify();
    this.schedule();
    if (this.entries.size > 200)
      for (const [key, e] of this.entries) {
        if (this.entries.size <= 200) break;
        if (
          ["completed", "cancelled", "failed"].includes(e.job.status) &&
          !e.started
        )
          this.entries.delete(key);
      }
    return id;
  }
  private schedule(): void {
    if (this.pumpPending) return;
    this.pumpPending = true;
    setImmediate(() => {
      this.pumpPending = false;
      this.pump();
    });
  }
  private pump(): void {
    for (const entry of this.entries.values()) {
      if (entry.job.status !== "queued") continue;
      const download = entry.job.kind === "modelDownload";
      if (download ? this.downloadRunning >= 1 : this.heavyRunning >= 2)
        continue;
      if (download) this.downloadRunning++;
      else this.heavyRunning++;
      entry.started = true;
      void this.execute(entry, download);
    }
  }
  private async execute(entry: Entry, download: boolean): Promise<void> {
    const { job, controller } = entry;
    const complete = () => {
      job.status = "completed";
      job.stage = "complete";
      job.progress = 1;
      if (job.totalMs !== null) job.processedMs = job.totalMs;
    };
    try {
      controller.signal.throwIfAborted();
      job.status = "running";
      job.stage = "starting";
      this.notify();
      await entry.task({
        signal: controller.signal,
        update: (changes) => {
          if (!entry.committed) controller.signal.throwIfAborted();
          Object.assign(job, changes);
          this.notify();
        },
        throwIfCancelled: () => {
          if (!entry.committed) controller.signal.throwIfAborted();
        },
        commit: (publish) => {
          controller.signal.throwIfAborted();
          const result = publish() as unknown;
          if (
            result &&
            typeof (result as { then?: unknown }).then === "function"
          )
            throw new Error("Job commit callback must be synchronous");
          entry.committed = true;
          complete();
          this.notify();
        },
      });
      if (!entry.committed) controller.signal.throwIfAborted();
      complete();
    } catch (error) {
      entry.diagnostic = error;
      if (entry.committed) {
        complete();
      } else {
        job.status = controller.signal.aborted ? "cancelled" : "failed";
        job.stage = job.status;
        job.progress = null;
        job.outputUrl = null;
        job.error = controller.signal.aborted
          ? null
          : publicErrorMessage(error);
      }
    } finally {
      entry.started = false;
      if (download) this.downloadRunning--;
      else this.heavyRunning--;
      entry.finish();
      this.notify();
      this.schedule();
    }
  }
  async wait(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Unknown job");
    await entry.done;
  }
  async cancel(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Unknown job");
    if (
      entry.committed ||
      ["completed", "cancelled", "failed"].includes(entry.job.status)
    )
      return;
    entry.job.cancelRequested = true;
    entry.controller.abort();
    if (!entry.started) {
      entry.job.status = "cancelled";
      entry.job.stage = "cancelled";
      entry.job.progress = null;
      entry.finish();
    } else entry.job.status = "cancelling";
    this.notify();
    await entry.done;
  }
  async cancelAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.cancel(id)));
  }
}

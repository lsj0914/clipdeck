import { it, expect } from "vitest";
import { JobManager } from "../../src/main/services/jobs";
it("queued job starts indeterminate and actual progress then completion are persisted", async () => {
  const jobs = new JobManager(() => {});
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const id = jobs.start(
    "transcription",
    { assetId: "source", totalMs: 1000 },
    async (ctx) => {
      ctx.update({ stage: "transcribing", processedMs: 300, progress: 0.3 });
      await gate;
      ctx.throwIfCancelled();
    },
  );
  expect(jobs.list()[0]).toMatchObject({
    status: "queued",
    progress: null,
    processedMs: 0,
  });
  await new Promise((r) => setImmediate(r));
  expect(jobs.list()[0]).toMatchObject({ status: "running", progress: 0.3 });
  release();
  await jobs.wait(id);
  expect(jobs.list()[0]).toMatchObject({ status: "completed", progress: 1 });
});
it("cancellation is awaited and cannot become completion even after task resolves", async () => {
  const jobs = new JobManager(() => {});
  const id = jobs.start("transcription", { assetId: "source" }, async (ctx) => {
    await new Promise<void>((r) =>
      ctx.signal.addEventListener("abort", () => r(), { once: true }),
    );
  });
  await new Promise((r) => setImmediate(r));
  await jobs.cancel(id);
  expect(jobs.list()[0]).toMatchObject({
    status: "cancelled",
    cancelRequested: true,
    progress: null,
  });
});
it("explicit task failure remains failed with no output", async () => {
  const jobs = new JobManager(() => {});
  const id = jobs.start("transcription", {}, async () => {
    throw new Error("Missing tokenizer.json");
  });
  await jobs.wait(id);
  expect(jobs.list()[0]).toMatchObject({
    status: "failed",
    error: "Missing tokenizer.json",
    outputUrl: null,
  });
});
it("only two heavy jobs run; cancelling third queued job prevents all task side effects", async () => {
  const jobs = new JobManager(() => {});
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let starts = 0;
  const first = jobs.start("transcription", {}, async () => {
    starts++;
    await gate;
  });
  const second = jobs.start("export", {}, async () => {
    starts++;
    await gate;
  });
  const third = jobs.start("preview", {}, async () => {
    starts++;
  });
  await new Promise((r) => setImmediate(r));
  expect(starts).toBe(2);
  expect(jobs.list().find((j) => j.id === third)?.status).toBe("queued");
  await jobs.cancel(third);
  release();
  await Promise.all([jobs.wait(first), jobs.wait(second)]);
  expect(starts).toBe(2);
  expect(jobs.list().find((j) => j.id === third)?.status).toBe("cancelled");
});
it("an atomic commit boundary makes late cancellation completed rather than cancelled", async () => {
  const jobs = new JobManager(() => {});
  let committed = false;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const id = jobs.start("export", {}, async (ctx) => {
    ctx.commit(() => {
      committed = true;
    });
    await gate;
  });
  await new Promise((r) => setImmediate(r));
  await jobs.cancel(id);
  release();
  await jobs.wait(id);
  expect(committed).toBe(true);
  expect(jobs.list()[0]?.status).toBe("completed");
});
it("asynchronous filesystem failures use the same public path-safe error as IPC", async () => {
  const { stat } = await import("node:fs/promises");
  const nativePath =
    "/private/tmp/clipdeck-private-job-source-missing-2026-10-06";
  const jobs = new JobManager(() => {});
  const id = jobs.start("transcription", {}, async () => {
    await stat(nativePath);
  });
  await jobs.wait(id);
  expect(jobs.list()[0]?.status).toBe("failed");
  expect(jobs.list()[0]?.error).toMatch(/local|resource|file/i);
  expect(JSON.stringify(jobs.list())).not.toContain(nativePath);
});

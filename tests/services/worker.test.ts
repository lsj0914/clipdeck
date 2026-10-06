import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
const python = path.resolve(".runtime/worker/bin/python3.12");
const script = path.resolve("worker/transcribe.py");
const model = path.join(
  process.env.HOME!,
  ".cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120",
);
async function worker(request: unknown) {
  return new Promise<{ code: number | null; events: any[]; stderr: string }>(
    (resolve) => {
      const p = spawn(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          "(version 1)(allow default)(deny network-outbound)",
          python,
          script,
        ],
        {
          env: {
            ...process.env,
            HF_HUB_OFFLINE: "1",
            TRANSFORMERS_OFFLINE: "1",
          },
        },
      );
      let out = "",
        err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) =>
        resolve({
          code,
          events: out
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((s) => JSON.parse(s)),
          stderr: err,
        }),
      );
      p.stdin.end(
        JSON.stringify({
          ...(request as Record<string, unknown>),
        }) + "\n",
      );
    },
  );
}
it("checks actual pinned local runtime and VAD under network denial", async () => {
  const result = await worker({ mode: "check" });
  expect(result.code).toBe(0);
  expect(result.events[0]).toMatchObject({
    type: "ready",
    engine: { name: "faster-whisper", version: "1.2.1" },
    versions: { numpy: "2.5.3", av: "16.0.1+clipdeck.ffmpeg8.1.2" },
  });
}, 30000);
it("missing VAD resources fail explicitly before any transcription", async () => {
  const result = await worker({ mode: "check", vadResource: "absent" });
  expect(result.code).toBe(1);
  expect(result.events[0]).toMatchObject({ type: "error" });
  expect(result.events[0].message).toMatch(/VAD/i);
});
it("missing tokenizer does not trigger online fallback", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "clipdeck-invalid-model-"));
  try {
    const pcm = path.join(directory, "neutral.pcm");
    await writeFile(pcm, Buffer.alloc(32));
    const result = await worker({
      mode: "transcribe", modelDirectory: path.resolve("worker"),
      audioPath: pcm, audioFormat: "s16le", durationMs: 1000, language: "en",
    });
    expect(result.code).toBe(1);
    expect(result.events[0]?.message).toMatch(/model.bin|tokenizer/i);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("production preflight never silently accepts superseded development Python", async () => {
  const result = await worker({ mode: "check" });
  expect(result.code).toBe(0);
  expect(result.events[0].pythonVersion).toBe("3.12.15");
}, 30000);

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
it("preflight disables telemetry before library initialization and leaves a fresh HOME empty", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "clipdeck-private-worker-"));
  try {
    const result = await new Promise<{
      code: number | null;
      out: string;
      err: string;
    }>((resolve) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        PATH: "/usr/bin:/bin",
      };
      delete env.ORT_DISABLE_TELEMETRY;
      const p = spawn(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          "(version 1)(allow default)(deny network-outbound)",
          python,
          script,
        ],
        { env },
      );
      let out = "",
        err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => resolve({ code, out, err }));
      p.stdin.end(JSON.stringify({ mode: "check" }) + "\n");
    });
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(JSON.parse(result.out)).toMatchObject({
      type: "ready",
      telemetryDisabled: true,
    });
    expect(await readdir(home)).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30000);

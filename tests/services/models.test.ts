import { it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, symlink, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import {
  verifyModelDirectory,
  MODEL_MANIFEST,
  downloadManifest,
} from "../../src/main/services/models";
const official = path.join(
  process.env.HOME!,
  ".cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120",
);
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clipdeck-model-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it("accepts complete official local model and verifies each file hash", async () => {
  const checked = await verifyModelDirectory(official);
  expect(checked.id).toBe("Systran/faster-whisper-small");
  expect(checked.digest).toMatch(/^[a-f0-9]{64}$/);
});
it("missing tokenizer is explicitly rejected before any model fallback", async () => {
  for (const f of MODEL_MANIFEST.files.filter(
    (f) => f.name !== "tokenizer.json",
  ))
    await symlink(path.join(official, f.name), path.join(dir, f.name));
  await expect(verifyModelDirectory(dir)).rejects.toThrow(/tokenizer.json/i);
});
it("tampered local model is never ready", async () => {
  for (const f of MODEL_MANIFEST.files)
    await symlink(
      path.join(official, f.name),
      path.join(dir, f.name === "config.json" ? "original-config" : f.name),
    );
  await writeFile(path.join(dir, "config.json"), "{}");
  await expect(verifyModelDirectory(dir)).rejects.toThrow(/config.json/i);
});
it("cancelled actual streamed transfer cleans staging and never publishes a ready directory", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-length": "1000000" });
    const timer = setInterval(() => res.write(Buffer.alloc(1000)), 5);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  try {
    await expect(
      downloadManifest(
        {
          id: "test",
          revision: "fixed",
          files: [
            {
              name: "model.bin",
              bytes: 1000000,
              sha256: "0".repeat(64),
              url: `http://127.0.0.1:${address.port}/model`,
            },
          ],
        },
        path.join(dir, "target"),
        controller.signal,
        () => {},
      ),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(dir, "target", "model.bin")),
    ).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it("actual transfer only atomically publishes after digest verification", async () => {
  const server = createServer((_req, res) => res.end("hello"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  const manifest = {
    id: "fixture",
    revision: "1",
    files: [
      {
        name: "model.bin",
        bytes: 5,
        sha256:
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        url: `http://127.0.0.1:${address.port}/model`,
      },
    ],
  };
  try {
    await downloadManifest(
      manifest,
      path.join(dir, "target"),
      new AbortController().signal,
      () => {},
    );
    expect(await readFile(path.join(dir, "target", "model.bin"), "utf8")).toBe(
      "hello",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it("repairs a corrupt nonempty managed cache with verified bytes", async () => {
  const target = path.join(dir, "cache");
  await (await import("node:fs/promises")).mkdir(target);
  await writeFile(path.join(target, "model.bin"), "broken");
  const server = createServer((_req, res) => res.end("hello"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  try {
    await downloadManifest(
      {
        id: "fixture",
        revision: "1",
        files: [
          {
            name: "model.bin",
            bytes: 5,
            sha256:
              "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            url: `http://127.0.0.1:${address.port}/model`,
          },
        ],
      },
      target,
      new AbortController().signal,
      () => {},
    );
    expect(await readFile(path.join(target, "model.bin"), "utf8")).toBe(
      "hello",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it("an already cancelled cached acquisition cannot publish model settings or ready state", async () => {
  const { ModelRegistry } = await import("../../src/main/services/models");
  const state = path.join(dir, "settings.json");
  await writeFile(state, '{"previous":true}');
  const registry = new ModelRegistry(state, official, () => {});
  const controller = new AbortController();
  controller.abort();
  await expect(registry.download(controller.signal)).rejects.toThrow();
  expect(await readFile(state, "utf8")).toBe('{"previous":true}');
  expect(registry.status.status).not.toBe("ready");
});

import { acquireManifest } from "../../src/main/services/models";
import { JobManager } from "../../src/main/services/jobs";
import { mkdir } from "node:fs/promises";
const smallManifest = (url: string) => ({
  id: "fixture",
  revision: "1",
  files: [
    {
      name: "model.bin",
      bytes: 5,
      sha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      url,
    },
  ],
});
for (const cached of [false, true]) {
  it(`cancel before ${cached ? "cached" : "new"} model publication retains directory/settings`, async () => {
    const target = path.join(dir, "cache"),
      state = path.join(dir, "settings.json");
    await mkdir(target);
    await writeFile(
      path.join(target, "model.bin"),
      cached ? "hello" : "broken",
    );
    await writeFile(state, '{"previous":true}');
    const server = createServer((_req, res) => res.end("hello"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const controller = new AbortController();
    try {
      await expect(
        acquireManifest(
          smallManifest(`http://127.0.0.1:${port}`),
          target,
          state,
          controller.signal,
          () => {},
          (publish: () => void) => {
            controller.abort();
            controller.signal.throwIfAborted();
            publish();
          },
        ),
      ).rejects.toThrow();
      expect(await readFile(state, "utf8")).toBe('{"previous":true}');
      expect(await readFile(path.join(target, "model.bin"), "utf8")).toBe(
        cached ? "hello" : "broken",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it(`late cancellation after ${cached ? "cached" : "new"} model publication preserves completed job`, async () => {
    const target = path.join(dir, "cache"),
      state = path.join(dir, "settings.json");
    if (cached) {
      await mkdir(target);
      await writeFile(path.join(target, "model.bin"), "hello");
    }
    const server = createServer((_req, res) => res.end("hello"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const jobs = new JobManager(() => {});
    let id = "";
    try {
      id = jobs.start("modelDownload", {}, async (ctx) => {
        await acquireManifest(
          smallManifest(`http://127.0.0.1:${port}`),
          target,
          state,
          ctx.signal,
          () => {},
          (publish: () => void) => {
            ctx.commit(publish);
            void jobs.cancel(id);
          },
        );
      });
      await jobs.wait(id);
      expect(jobs.list()[0]?.status).toBe("completed");
      expect(JSON.parse(await readFile(state, "utf8")).directory).toBe(target);
      expect(await readFile(path.join(target, "model.bin"), "utf8")).toBe(
        "hello",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
}
it("settings publication failure rolls back a repaired managed cache", async () => {
  const target = path.join(dir, "cache"),
    state = path.join(dir, "settings.json");
  await mkdir(target);
  await writeFile(path.join(target, "model.bin"), "broken");
  await mkdir(state);
  await writeFile(path.join(state, "protected"), "old");
  const server = createServer((_req, res) => res.end("hello"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    await expect(
      acquireManifest(
        smallManifest(`http://127.0.0.1:${port}`),
        target,
        state,
        new AbortController().signal,
        () => {},
        (publish: () => void) => publish(),
      ),
    ).rejects.toThrow();
    expect(await readFile(path.join(target, "model.bin"), "utf8")).toBe(
      "broken",
    );
    expect(await readFile(path.join(state, "protected"), "utf8")).toBe("old");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

for (const late of [false, true]) {
  it(`actual cached registry ${late ? "commits ready state before late cancellation" : "retains prior settings when cancelled at publication"}`, async () => {
    const { ModelRegistry } = await import("../../src/main/services/models");
    const state = path.join(dir, "settings.json");
    await writeFile(state, '{"previous":true}');
    const registry = new ModelRegistry(state, official, () => {}),
      jobs = new JobManager(() => {});
    let id = "";
    id = jobs.start("modelDownload", {}, async (ctx) => {
      await registry.download(ctx.signal, (publish) => {
        if (!late) void jobs.cancel(id);
        ctx.commit(publish);
        if (late) void jobs.cancel(id);
      });
    });
    await jobs.wait(id);
    expect(jobs.list()[0]?.status).toBe(late ? "completed" : "cancelled");
    expect(registry.status.status).toBe(late ? "ready" : "notReady");
    if (late)
      expect(JSON.parse(await readFile(state, "utf8")).directory).toBe(
        official,
      );
    else expect(await readFile(state, "utf8")).toBe('{"previous":true}');
  });
}

const turbo = process.env.CLIPDECK_TURBO_MODEL;
it("rejects inherited and unknown model choices before changing acquisition state", async () => {
  const { ModelRegistry } = await import("../../src/main/services/models");
  const registry = new ModelRegistry(
    path.join(dir, "settings.json"),
    path.join(dir, "small"),
    () => {},
  );
  const previous = registry.status;
  for (const choice of ["constructor", "__proto__", "unknown"]) {
    await expect(
      registry.download(
        new AbortController().signal,
        undefined,
        choice as "small",
      ),
    ).rejects.toThrow("Unsupported local model choice");
    expect(registry.status).toBe(previous);
    await expect(
      verifyModelDirectory(official, choice as "small"),
    ).rejects.toThrow("Unsupported local model choice");
  }
});
it.runIf(!!turbo)(
  "recognizes the exact stronger local manifest and persists active identity without host-path snapshots",
  async () => {
    const { ModelRegistry } = await import("../../src/main/services/models");
    const registry = new ModelRegistry(
      path.join(dir, "quality-settings.json"),
      path.join(dir, "small"),
      () => {},
    );
    await registry.choose(turbo!);
    expect(registry.status).toMatchObject({
      status: "ready",
      choice: "turbo",
      id: "dropbox-dash/faster-whisper-large-v3-turbo",
    });
    expect(registry.status.available?.map((choice) => choice.choice)).toEqual([
      "small",
      "turbo",
    ]);
    expect(JSON.stringify(registry.status)).not.toContain(turbo!);
    const checked = await registry.verify();
    expect(checked).toMatchObject({ choice: "turbo", id: registry.status.id });
    const restarted = new ModelRegistry(
      registry.statePath,
      registry.downloadPath,
      () => {},
    );
    await restarted.initialize();
    expect(restarted.status.choice).toBe("turbo");
  },
);
it.runIf(!!turbo)(
  "cancelled stronger cached acquisition retains the previously verified small model and settings",
  async () => {
    const { ModelRegistry } = await import("../../src/main/services/models");
    const smallTarget = path.join(dir, "small");
    await symlink(official, smallTarget);
    const turboTarget = path.join(dir, "faster-whisper-large-v3-turbo-0a363e9");
    await symlink(turbo!, turboTarget);
    const registry = new ModelRegistry(
      path.join(dir, "quality-settings.json"),
      smallTarget,
      () => {},
    );
    await registry.choose(official);
    const previous = await readFile(registry.statePath, "utf8");
    const controller = new AbortController();
    await expect(
      registry.download(
        controller.signal,
        (publish) => {
          controller.abort();
          controller.signal.throwIfAborted();
          publish();
        },
        "turbo",
      ),
    ).rejects.toThrow();
    expect(registry.status).toMatchObject({ status: "ready", choice: "small" });
    expect(registry.directory).toBe(official);
    expect(await readFile(registry.statePath, "utf8")).toBe(previous);
  },
);

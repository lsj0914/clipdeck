import { it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  ProjectStore,
  readProjectFile,
  resolveProjectReference,
} from "../../src/main/services/storage";
import { createProject, applyProjectEdit } from "../../src/domain/project";
import { SourceRegistry } from "../../src/main/services/media";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clipdeck-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it("save-as switches current target and later normal saves update only that file", async () => {
  const store = new ProjectStore(
    path.join(dir, "recovery.json"),
    new SourceRegistry(),
  );
  let p = createProject();
  const a = path.join(dir, "a.clipdeck"),
    b = path.join(dir, "b.clipdeck");
  await store.save(p, a);
  p = applyProjectEdit(p, { type: "renameProject", name: "B" });
  await store.save(p, b);
  p = applyProjectEdit(p, { type: "renameProject", name: "C" });
  await store.save(p);
  expect(JSON.parse(await readFile(a, "utf8")).name).toBe("Untitled project");
  expect(JSON.parse(await readFile(b, "utf8")).name).toBe("C");
  expect(store.currentPath).toBe(await realpath(b));
});
it("recovery keeps latest revision despite out-of-order asynchronous writes", async () => {
  const store = new ProjectStore(
    path.join(dir, "recovery.json"),
    new SourceRegistry(),
  );
  const p = createProject();
  const latest = applyProjectEdit(
    applyProjectEdit(p, { type: "renameProject", name: "old" }),
    { type: "renameProject", name: "latest" },
  );
  await Promise.all([store.autosave(latest), store.autosave(p)]);
  const recovered = await store.recover();
  expect(recovered?.name).toBe("latest");
  expect(recovered?.revision).toBe(2);
});
it("rejects oversized project bytes before parsing", async () => {
  const file = path.join(dir, "huge.clipdeck");
  await writeFile(file, " ".repeat(1025));
  await expect(readProjectFile(file, 1024)).rejects.toThrow(/limit/i);
});
it("project refs cannot authorize outside real project root, including symlinks", async () => {
  await mkdir(path.join(dir, "project"));
  const source = path.join(dir, "secret.mp4");
  await writeFile(source, "secret");
  await expect(
    resolveProjectReference(
      path.join(dir, "project", "p.clipdeck"),
      "../secret.mp4",
    ),
  ).rejects.toThrow(/authorization/i);
});
it("atomic save leaves a valid reopenable project with no session history", async () => {
  const store = new ProjectStore(
    path.join(dir, "recovery.json"),
    new SourceRegistry(),
  );
  const file = path.join(dir, "p.clipdeck");
  const p = applyProjectEdit(createProject(), {
    type: "renameProject",
    name: "中文 project",
  });
  await store.save(p, file);
  expect(await store.open(file)).toMatchObject({
    name: "中文 project",
    revision: 1,
    history: { past: [], future: [] },
  });
  expect(JSON.parse(await readFile(file, "utf8")).history).toBeUndefined();
});
it("a late save cannot steal an opened project target or its clean revision", async () => {
  const sources = new SourceRegistry();
  const store = new ProjectStore(path.join(dir, "recovery.json"), sources);
  const a = applyProjectEdit(createProject(), {
    type: "renameProject",
    name: "A",
  });
  const b = applyProjectEdit(createProject(), {
    type: "renameProject",
    name: "B",
  });
  const targetA = path.join(dir, "A.clipdeck"),
    targetB = path.join(dir, "B.clipdeck");
  await store.save(b, targetB);
  const original = (store as any).data.bind(store);
  let resume!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => (resume = r));
  const waiting = new Promise<void>((r) => (entered = r));
  (store as any).data = async (p: any, target: string) => {
    const data = await original(p, target);
    if (p.id === a.id) {
      entered();
      await gate;
    }
    return data;
  };
  const saving = store.save(a, targetA);
  await waiting;
  await store.open(targetB);
  resume();
  await saving;
  expect(store.currentPath).toBe(await realpath(targetB));
  expect(store.savedRevision).toBe(b.revision);
  await store.save(b);
  expect(JSON.parse(await readFile(targetA, "utf8")).name).toBe("A");
  expect(JSON.parse(await readFile(targetB, "utf8")).name).toBe("B");
});
it("an older delayed same-target save cannot overwrite a newer published revision", async () => {
  const store = new ProjectStore(
    path.join(dir, "recovery.json"),
    new SourceRegistry(),
  );
  const old = applyProjectEdit(createProject(), {
    type: "renameProject",
    name: "old",
  });
  const latest = applyProjectEdit(old, {
    type: "renameProject",
    name: "latest",
  });
  const target = path.join(dir, "shared.clipdeck");
  const original = (store as any).data.bind(store);
  let resume!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => (resume = r));
  const waiting = new Promise<void>((r) => (entered = r));
  (store as any).data = async (p: any, file: string) => {
    const data = await original(p, file);
    if (p.revision === old.revision) {
      entered();
      await gate;
    }
    return data;
  };
  const saving = store.save(old, target);
  await waiting;
  await store.save(latest, target);
  resume();
  await expect(saving).rejects.toThrow(/superseded/i);
  expect(JSON.parse(await readFile(target, "utf8"))).toMatchObject({
    name: "latest",
    revision: 2,
  });
  expect(store.savedRevision).toBe(2);
});

for (const transition of ["open", "recover"] as const) {
  it(`intentional Save As of an older ${transition === "open" ? "reopened" : "recovered"} copy replaces its requested target`, async () => {
    const store = new ProjectStore(
      path.join(dir, "recovery.json"),
      new SourceRegistry(),
    );
    const backup = path.join(dir, "backup.clipdeck"),
      original = path.join(dir, "original.clipdeck");
    const older = applyProjectEdit(createProject(), {
      type: "renameProject",
      name: "old copy",
    });
    const newer = applyProjectEdit(older, {
      type: "renameProject",
      name: "newer saved copy",
    });
    await store.save(older, backup);
    await store.save(newer, original);
    let requested;
    if (transition === "open") requested = await store.open(backup);
    else {
      const recoveryStore = new ProjectStore(
        store.recoveryPath,
        new SourceRegistry(),
      );
      await recoveryStore.autosave(older);
      requested = (await store.recover())!;
    }
    const result = await store.save(requested, original);
    expect(result.savedAt).not.toBeNull();
    expect(await readProjectFile(original)).toMatchObject({
      id: older.id,
      name: "old copy",
      revision: 1,
    });
    expect(store.currentPath).toBe(await realpath(original));
    expect(store.savedRevision).toBe(1);
    const later = applyProjectEdit(requested, {
      type: "renameProject",
      name: "later normal save",
    });
    await store.save(later);
    expect((await readProjectFile(original)).name).toBe("later normal save");
    expect((await readProjectFile(backup)).name).toBe("old copy");
  });
}
it("an obsolete save request rejects rather than reporting a successful skipped Save As", async () => {
  const store = new ProjectStore(
      path.join(dir, "recovery.json"),
      new SourceRegistry(),
    ),
    target = path.join(dir, "original.clipdeck");
  const older = applyProjectEdit(createProject(), {
      type: "renameProject",
      name: "older",
    }),
    latest = applyProjectEdit(older, { type: "renameProject", name: "latest" });
  await store.save(latest, target);
  await expect(store.save(older, target)).rejects.toThrow(/superseded/i);
  expect((await readProjectFile(target)).name).toBe("latest");
  expect(store.currentPath).toBe(await realpath(target));
  expect(store.savedRevision).toBe(2);
});

it("a pending prior-generation save cannot replace an intentional lower-revision Save As", async () => {
  const store = new ProjectStore(
      path.join(dir, "recovery.json"),
      new SourceRegistry(),
    ),
    backup = path.join(dir, "backup.clipdeck"),
    target = path.join(dir, "original.clipdeck");
  const older = applyProjectEdit(createProject(), {
      type: "renameProject",
      name: "backup copy",
    }),
    latest = applyProjectEdit(older, {
      type: "renameProject",
      name: "pending newer copy",
    });
  await store.save(older, backup);
  const original = (store as any).data.bind(store);
  let resume!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (resume = r)),
    waiting = new Promise<void>((r) => (entered = r));
  (store as any).data = async (p: any, file: string) => {
    const data = await original(p, file);
    if (p.revision === latest.revision) {
      entered();
      await gate;
    }
    return data;
  };
  const pending = store.save(latest, target);
  const outcome = pending.then(
    () => ({ success: true, error: null }),
    (error) => ({ success: false, error }),
  );
  await waiting;
  const reopened = await store.open(backup);
  await store.save(reopened, target);
  resume();
  const result = await outcome;
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/superseded/i);
  expect(await readProjectFile(target)).toMatchObject({
    name: "backup copy",
    revision: 1,
  });
  expect(store.currentPath).toBe(await realpath(target));
  expect(store.savedRevision).toBe(1);
});

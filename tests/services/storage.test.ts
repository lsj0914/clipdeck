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
import { createProject, applyProjectEdit, serializeProject } from "../../src/domain/project";
import { SourceRegistry, type MediaService } from "../../src/main/services/media";
import { asset } from "../domain/fixtures";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "clipdeck-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it("a superseded recovery cannot replace the newly opened project's source authority", async () => {
  const sources = new SourceRegistry();
  const recoveredAsset = { ...asset, id: "recovered-source", fileRef: "old.mp4" };
  const openedAsset = { ...asset, id: "opened-source", fileRef: "new.mp4" };
  await writeFile(path.join(dir, "old.mp4"), "old recording");
  await writeFile(path.join(dir, "new.mp4"), "new recording");
  const media = { prepareRelink: async (a: typeof asset, file: string) => ({
    asset: { ...a, status: "ready" as const },
    approve: () => sources.register(a.id, file),
  }) } as unknown as MediaService;
  const store = new ProjectStore(path.join(dir, "recovery.json"), sources, media);
  const old = { ...createProject(), assets: [recoveredAsset] };
  const next = { ...createProject(), assets: [openedAsset] };
  const target = path.join(dir, "new.clipdeck");
  await writeFile(target, JSON.stringify(serializeProject(next)));
  sources.register(recoveredAsset.id, await realpath(path.join(dir, "old.mp4")));
  // Delay an in-flight autosave at the serialization boundary. recover() waits
  // for it while a later native Open is free to select a different project.
  const original = (store as any).data.bind(store);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const waiting = new Promise<void>((r) => (entered = r));
  (store as any).data = async (p: any, file: string) => {
    const value = await original(p, file);
    entered();
    await gate;
    return value;
  };
  const saving = store.autosave(old);
  await waiting;
  const recovering = store.recover();
  const rejection = expect(recovering).rejects.toThrow(/superseded/i);
  await store.open(target);
  release();
  await saving;
  await rejection;
  expect(store.currentPath).toBe(await realpath(target));
  expect(sources.ids()).toEqual([openedAsset.id]);
  expect(sources.resolve(openedAsset.id)).toBe(await realpath(path.join(dir, "new.mp4")));
});
it("reopens a natively selected external source after restart without trusting arbitrary project paths", async () => {
  const projectDir = path.join(dir, "projects"), dataDir = path.join(dir, "private-state");
  await mkdir(projectDir);
  const source = path.join(dir, "recording.mp4");
  await writeFile(source, "authorized recording");
  const canonical = await realpath(source), sources = new SourceRegistry();
  sources.register(asset.id, canonical);
  const p = { ...createProject(), assets: [{ ...asset }] };
  const target = path.join(projectDir, "p.clipdeck"), recovery = path.join(dataDir, "recovery.json");
  await new ProjectStore(recovery, sources).save(p, target);
  const reopenedSources = new SourceRegistry();
  const media = { prepareRelink: async (a: typeof asset, file: string) => {
    expect(file).toBe(canonical);
    return { asset: { ...a, status: "ready" as const }, approve: () => reopenedSources.register(a.id, file) };
  }} as unknown as MediaService;
  const reopened = await new ProjectStore(recovery, reopenedSources, media).open(target);
  expect(reopened.assets[0]!.status).toBe("ready");
  expect(reopenedSources.resolve(asset.id)).toBe(canonical);
  // Changing the project identity cannot borrow another project's source grant.
  const serialized = JSON.parse(await readFile(target, "utf8"));
  serialized.id = "foreign-project";
  await writeFile(target, JSON.stringify(serialized));
  expect((await new ProjectStore(recovery, new SourceRegistry(), media).open(target)).assets[0]!.status).toBe("missing");
  // A fresh profile has no authority, even for an unchanged external reference.
  serialized.id = p.id;
  await writeFile(target, JSON.stringify(serialized));
  expect((await new ProjectStore(path.join(dir, "new-profile/recovery.json"), new SourceRegistry(), media).open(target)).assets[0]!.status).toBe("missing");
  expect(serialized).not.toHaveProperty("sourceGrants");
});

it("an authorized project cannot substitute a different external file reference", async () => {
  const projectDir = path.join(dir, "projects");
  await mkdir(projectDir);
  const source = path.join(dir, "authorized.mp4"), other = path.join(dir, "other.mp4");
  await writeFile(source, "authorized"); await writeFile(other, "private");
  const sources = new SourceRegistry(); sources.register(asset.id, await realpath(source));
  const p = { ...createProject(), assets: [{ ...asset }] }, target = path.join(projectDir, "p.clipdeck");
  const recovery = path.join(dir, "state/recovery.json");
  await new ProjectStore(recovery, sources).save(p, target);
  const serialized = JSON.parse(await readFile(target, "utf8"));
  serialized.assets[0].fileRef = "../other.mp4";
  await writeFile(target, JSON.stringify(serialized));
  const media = { prepareRelink: async () => { throw new Error("must not read substituted source"); }} as unknown as MediaService;
  const reopened = await new ProjectStore(recovery, new SourceRegistry(), media).open(target);
  expect(reopened.assets[0]!.status).toBe("missing");
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

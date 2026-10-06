import { open, mkdir, rename, rm, realpath, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Project } from "../../shared/contracts";
import { serializeProject, validateProject } from "../../domain/project";
import { SourceRegistry, MediaService } from "./media";
export const PROJECT_BYTE_LIMIT = 64 * 1024 * 1024;
async function readBounded(file: string, limit: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.size > limit)
      throw new Error("Project byte limit exceeded");
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.alloc(Math.min(65536, limit + 1));
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw new Error("Project byte limit exceeded");
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}
export async function readProjectFile(
  file: string,
  limit = PROJECT_BYTE_LIMIT,
): Promise<Project> {
  return validateProject(JSON.parse(await readBounded(file, limit)));
}
export async function resolveProjectReference(
  file: string,
  ref: string,
): Promise<string> {
  const root = await realpath(path.dirname(file));
  const candidate = await realpath(path.resolve(root, ref));
  const relative = path.relative(root, candidate);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new Error("External source requires native relink authorization");
  return candidate;
}
export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    const directory = await open(path.dirname(file), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}
export class ProjectStore {
  currentPath: string | null = null;
  savedRevision: number | null = null;
  private generation = 0;
  private saveSequence = 0;
  private publicationQueue: Promise<void> = Promise.resolve();
  private latestSaves = new Map<
    string,
    {
      generation: number;
      projectId: string;
      revision: number;
      sequence: number;
    }
  >();
  private recoveryRevision = -1;
  private recoveryProjectId: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    readonly recoveryPath: string,
    readonly sources: SourceRegistry,
    readonly media?: MediaService,
  ) {}
  private async data(p: Project, target: string) {
    const approved = new Map(
      this.sources.ids().map((id) => [id, this.sources.resolve(id)]),
    );
    await mkdir(path.dirname(target), { recursive: true });
    const root = await realpath(path.dirname(target));
    const result = serializeProject(p);
    result.assets = result.assets.map((a) => {
      try {
        const source = approved.get(a.id);
        if (!source) throw new Error("Unresolved");
        const relative = path.relative(root, source);
        return { ...a, fileRef: relative || path.basename(source) };
      } catch {
        return a;
      }
    });
    return result;
  }
  async save(p: Project, file?: string): Promise<Project> {
    const generation = this.generation;
    const sequence = ++this.saveSequence;
    let target = file ? path.resolve(file) : this.currentPath;
    if (!target) throw new Error("Choose a project save location");
    await mkdir(path.dirname(target), { recursive: true });
    target = path.join(
      await realpath(path.dirname(target)),
      path.basename(target),
    );
    for (const id of this.sources.ids()) {
      const source = this.sources.resolve(id);
      let realTarget = target;
      try {
        realTarget = await realpath(target);
      } catch {}
      if (source === realTarget)
        throw new Error(
          "Project save cannot overwrite an original media source",
        );
    }
    const previous = this.latestSaves.get(target);
    if (
      previous &&
      (previous.generation > generation ||
        (previous.generation === generation &&
          (previous.sequence > sequence ||
            (previous.projectId === p.id && previous.revision > p.revision))))
    )
      throw new Error("Save was superseded by a newer save request");
    this.latestSaves.set(target, {
      generation,
      projectId: p.id,
      revision: p.revision,
      sequence,
    });
    const saved = { ...p, savedAt: new Date().toISOString() };
    const data = await this.data(saved, target);
    const destination = target;
    const publication = this.publicationQueue
      .catch(() => {})
      .then(async () => {
        if (this.latestSaves.get(destination)?.sequence !== sequence)
          throw new Error("Save was superseded by a newer save request");
        await atomicJson(destination, data);
        if (
          this.generation === generation &&
          this.latestSaves.get(destination)?.sequence === sequence
        ) {
          this.currentPath = destination;
          this.savedRevision = p.revision;
        }
      });
    this.publicationQueue = publication;
    await publication;
    return saved;
  }
  private async approve(p: Project, file: string): Promise<Project> {
    this.sources.clear();
    const assets = [];
    for (const asset of p.assets) {
      try {
        const source = await resolveProjectReference(file, asset.fileRef);
        if (!this.media) throw new Error("Media service unavailable");
        assets.push(await this.media.relink(asset, source));
      } catch {
        assets.push({ ...asset, status: "missing" as const });
      }
    }
    return validateProject({ ...serializeProject(p), assets });
  }
  async open(file: string): Promise<Project> {
    const generation = ++this.generation;
    const target = await realpath(file);
    const parsed = await readProjectFile(target);
    const p = await this.approve(parsed, target);
    if (this.generation !== generation)
      throw new Error("Project opening was superseded");
    this.currentPath = target;
    this.savedRevision = p.revision;
    this.recoveryProjectId = p.id;
    this.recoveryRevision = p.revision;
    return p;
  }
  autosave(p: Project): Promise<void> {
    if (this.recoveryProjectId !== p.id) {
      this.recoveryProjectId = p.id;
      this.recoveryRevision = -1;
    }
    const projectId = p.id;
    if (p.revision < this.recoveryRevision) return this.queue;
    this.recoveryRevision = p.revision;
    const referencePath = this.currentPath ?? this.recoveryPath;
    const data = this.data(p, referencePath);
    const currentPath = this.currentPath;
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        if (
          this.recoveryProjectId !== projectId ||
          p.revision < this.recoveryRevision
        )
          return;
        await atomicJson(this.recoveryPath, {
          recoveryVersion: 1,
          currentPath,
          project: await data,
        });
      });
    this.queue = operation;
    return operation;
  }
  async recover(): Promise<Project | null> {
    const generation = ++this.generation;
    await this.queue;
    let raw;
    try {
      raw = JSON.parse(
        await readBounded(this.recoveryPath, PROJECT_BYTE_LIMIT),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (
      raw.recoveryVersion !== 1 ||
      (raw.currentPath !== null && typeof raw.currentPath !== "string")
    )
      throw new Error("Invalid recovery record");
    let p = validateProject(raw.project);
    if (raw.currentPath) {
      try {
        const saved = await readProjectFile(raw.currentPath);
        if (saved.id === p.id && saved.revision >= p.revision) return null;
      } catch {}
    }
    p = await this.approve(p, raw.currentPath ?? this.recoveryPath);
    if (this.generation !== generation)
      throw new Error("Recovery was superseded");
    this.currentPath = raw.currentPath;
    this.savedRevision = null;
    this.recoveryProjectId = p.id;
    this.recoveryRevision = p.revision;
    return p;
  }
}

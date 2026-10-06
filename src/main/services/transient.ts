import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicJson } from "./storage";
import { integer, list, record, text } from "../../domain/validation";

export const CLEANUP_WARNING = "Some temporary files could not be cleared. Check that your export folder is available and your disk has free space, then restart ClipDeck.";
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const JOB = /^transcription-[A-Za-z0-9]{6}$/;
const PARTIAL = new RegExp(`^faster-whisper-(?:small-536b066|large-v3-turbo-0a363e9)\\.partial-${UUID}$`);
const PREPARED = new RegExp(`^(?:model-settings\\.json\\.prepared-${UUID}|\\.model-settings\\.json\\.prepared-${UUID}\\.${UUID}\\.tmp)$`);
const identity = (s: { dev: number; ino: number }) => `${s.dev}:${s.ino}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

/** Single-instance startup only. Never traverse a symlinked storage root. */
export async function cleanupLocalTransient(dataRoot: string): Promise<string[]> {
  let warned = false;
  const sweep = async (root: string, pattern: RegExp, directory: boolean) => {
    try {
      const parent = await lstat(root);
      if (!parent.isDirectory() || parent.isSymbolicLink()) { warned = true; return; }
      const canonical = await realpath(root), dataCanonical = await realpath(dataRoot);
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!pattern.test(entry.name)) continue;
        // Unlinking a leaf link is safe; its referenced data is never visited.
        if (entry.isSymbolicLink() || (directory ? entry.isDirectory() : entry.isFile())) {
          const current = await lstat(root);
          const latestRoot = await lstat(dataRoot);
          if (!current.isDirectory() || current.isSymbolicLink() || identity(current) !== identity(parent) ||
            latestRoot.isSymbolicLink() || identity(latestRoot) !== identity(rootStat) ||
            await realpath(root) !== canonical || await realpath(dataRoot) !== dataCanonical) throw new Error("Temporary storage changed");
          await rm(path.join(root, entry.name), { recursive: directory && !entry.isSymbolicLink(), force: true });
        }
      }
    } catch (error) { if (!missing(error)) warned = true; }
  };
  const rootStat = await lstat(dataRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [CLEANUP_WARNING];
  await sweep(path.join(dataRoot, "jobs"), JOB, true);
  await sweep(path.join(dataRoot, "models"), PARTIAL, true);
  await sweep(dataRoot, PREPARED, false);
  return warned ? [CLEANUP_WARNING] : [];
}

interface StagingEntry { directory: string; parent: string; parentIdentity: string; identity: string; token: string; }
interface JournalRoot { directory: string; identity: string; }
const MARKER = ".clipdeck-owned.json";
async function smallJson(file: string, limit: number): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = await handle.stat();
    if (!size.isFile() || size.size > limit) throw new Error("Temporary ownership record is invalid");
    // A single extra byte also rejects growth after the initial stat.
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error("Temporary ownership record exceeds its limit");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally { await handle.close(); }
}

/** External export staging is cleaned only through a private durable journal. */
export class OwnedStagingRegistry {
  private entries: StagingEntry[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private broken = false;
  private root?: JournalRoot;
  readonly warnings = new Set<string>();
  constructor(readonly journalPath: string) {}
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(operation);
    this.queue = next;
    return next;
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parent = path.dirname(this.journalPath);
      await mkdir(parent, { recursive: true });
      const parentStat = await lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Temporary journal storage changed");
      this.root = { directory: await realpath(parent), identity: identity(parentStat) };
      const raw = record(await smallJson(this.journalPath, 1024 * 1024), ["version", "root", "entries"]);
      if (integer(raw.version, 1, 1) !== 1) throw new Error("Invalid staging journal version");
      const root = record(raw.root, ["directory", "identity"]);
      if (text(root.directory, 4096) !== this.root.directory || text(root.identity, 100) !== this.root.identity)
        throw new Error("Temporary journal storage changed");
      this.entries = list(raw.entries, (value) => {
        const item = record(value, ["directory", "parent", "parentIdentity", "identity", "token"]);
        const entry = { directory: text(item.directory, 4096), parent: text(item.parent, 4096), parentIdentity: text(item.parentIdentity, 100), identity: text(item.identity, 100), token: text(item.token, 36) };
        if (!path.isAbsolute(entry.directory) || !path.isAbsolute(entry.parent) ||
          path.normalize(entry.parent) !== entry.parent || path.normalize(entry.directory) !== entry.directory ||
          path.dirname(entry.directory) !== entry.parent || !/^\.clipdeck-render-[A-Za-z0-9]{6}$/.test(path.basename(entry.directory)) || !new RegExp(`^${UUID}$`).test(entry.token))
          throw new Error("Invalid staging ownership");
        return entry;
      }, 1024);
      await this.verifyRoot();
    } catch (error) {
      if (!missing(error)) { this.broken = true; this.warnings.add(CLEANUP_WARNING); }
    }
  }
  private async verifyRoot(): Promise<void> {
    const parent = path.dirname(this.journalPath), current = await lstat(parent);
    if (!this.root || !current.isDirectory() || current.isSymbolicLink() ||
      identity(current) !== this.root.identity || await realpath(parent) !== this.root.directory)
      throw new Error("Temporary journal storage changed");
  }
  private async persist(): Promise<void> {
    try {
      await this.verifyRoot();
      const value = { version: 1, root: this.root, entries: this.entries };
      if (Buffer.byteLength(JSON.stringify(value, null, 2)) > 1024 * 1024)
        throw new Error("Export temporary ownership record is full; restart ClipDeck and check local storage");
      await atomicJson(this.journalPath, value);
      await this.verifyRoot();
      if (!this.entries.length && !this.broken) this.warnings.delete(CLEANUP_WARNING);
    } catch (error) { this.warnings.add(CLEANUP_WARNING); throw error; }
  }
  private async erase(entry: StagingEntry): Promise<boolean> {
    let parentVerified = false;
    try {
      await this.verifyRoot();
      const parent = await lstat(entry.parent);
      if (!parent.isDirectory() || parent.isSymbolicLink() || identity(parent) !== entry.parentIdentity ||
        await realpath(entry.parent) !== entry.parent) return false;
      parentVerified = true;
      const directory = await lstat(entry.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink() || identity(directory) !== entry.identity ||
        await realpath(entry.directory) !== entry.directory) return false;
      const marker = record(await smallJson(path.join(entry.directory, MARKER), 256), ["version", "token"]);
      if (marker.version !== 1 || marker.token !== entry.token) return false;
      const latestParent = await lstat(entry.parent), latestDirectory = await lstat(entry.directory);
      await this.verifyRoot();
      if (latestParent.isSymbolicLink() || latestDirectory.isSymbolicLink() || identity(latestParent) !== entry.parentIdentity || identity(latestDirectory) !== entry.identity ||
        await realpath(entry.parent) !== entry.parent || await realpath(entry.directory) !== entry.directory) return false;
      await rm(entry.directory, { recursive: true, force: true });
      return true;
    } catch (error) {
      // Only an absent staging directory retires ownership; a missing marker or
      // changed parent must never authorize deletion of a replacement folder.
      if (parentVerified) {
        try { await lstat(entry.directory); } catch (check) {
          if (missing(check)) {
            try {
              await this.verifyRoot();
              const parent = await lstat(entry.parent);
              return !parent.isSymbolicLink() && identity(parent) === entry.parentIdentity && await realpath(entry.parent) === entry.parent;
            }
            catch { return false; }
          }
        }
      }
      return false;
    }
  }
  initialize(): Promise<void> {
    return this.serialize(async () => {
      await this.load();
      if (this.broken) return;
      const retained: StagingEntry[] = [];
      for (const entry of this.entries) if (!await this.erase(entry)) retained.push(entry);
      if (retained.length) this.warnings.add(CLEANUP_WARNING);
      this.entries = retained;
      await this.persist().catch(() => {});
    });
  }
  create(parent: string): Promise<string> {
    return this.serialize(async () => {
      await this.load();
      if (this.broken || this.entries.length >= 1024) throw new Error("Export temporary storage needs attention; restart ClipDeck and check local storage");
      await this.verifyRoot();
      const canonical = await realpath(parent), parentStat = await lstat(canonical);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Export directory is unavailable");
      const directory = await mkdtemp(path.join(canonical, ".clipdeck-render-")), token = randomUUID();
      let entry: StagingEntry | undefined;
      try {
        entry = { directory, parent: canonical, parentIdentity: identity(parentStat), identity: identity(await lstat(directory)), token };
        const marker = await open(path.join(directory, MARKER), "wx", 0o600);
        try { await marker.writeFile(JSON.stringify({ version: 1, token })); await marker.sync(); }
        finally { await marker.close(); }
        const folder = await open(directory, "r");
        try { await folder.sync(); } finally { await folder.close(); }
        if (await realpath(canonical) !== canonical || await realpath(directory) !== directory)
          throw new Error("Export directory changed");
        this.entries.push(entry);
        try { await this.persist(); }
        catch (error) { this.entries = this.entries.filter((e) => e !== entry); throw error; }
        // No decoded media may be written until the ownership record is durable.
        return directory;
      } catch (error) {
        if (!entry || !await this.erase(entry)) this.warnings.add(CLEANUP_WARNING);
        throw error;
      }
    });
  }
  remove(directory: string): Promise<void> {
    return this.serialize(async () => {
      await this.load();
      const entry = this.entries.find((e) => e.directory === directory);
      if (!entry) return;
      if (!await this.erase(entry)) { this.warnings.add(CLEANUP_WARNING); return; }
      this.entries = this.entries.filter((e) => e !== entry);
      await this.persist();
    });
  }
}

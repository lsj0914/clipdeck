import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export function requireBenchmarkNodeVersion(version) {
  if (!/^24\.\d+\.\d+$/.test(version)) throw new Error(`Benchmark requires Node 24; observed ${version}`);
}

export async function loadBenchmarkInputs(directory) {
  const manifestFile = path.join(directory, "manifest.json");
  const raw = await readFile(manifestFile);
  const manifest = JSON.parse(raw.toString("utf8"));
  const sources = [];
  for (const source of manifest.sources) {
    const file = path.join(directory, path.basename(source.path));
    const actual = createHash("sha256").update(await readFile(file)).digest("hex");
    if (actual !== source.sha256) throw new Error(`Source hash mismatch: ${source.id}`);
    sources.push({ ...source, file });
  }
  const passages = manifest.selectable_passages.map((passage) => {
    const startMs = Math.round(passage.start_seconds * 1000);
    const endMs = Math.round(passage.end_seconds * 1000);
    if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs || !sources.some(s => s.id === passage.source_id)) {
      throw new Error(`Invalid integer passage range: ${passage.id}`);
    }
    return { ...passage, startMs, endMs };
  });
  return { sources, passages, manifest, manifestSha256: createHash("sha256").update(raw).digest("hex") };
}

export function parsePcmWav(bytes) {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") throw new Error("Invalid WAV");
  let format, data;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > bytes.length) throw new Error("Invalid WAV chunk size");
    if (type === "fmt " && size >= 16) {
      if (bytes.readUInt16LE(start) !== 1) throw new Error("Expected PCM WAV");
      format = { channels: bytes.readUInt16LE(start + 2), sampleRate: bytes.readUInt32LE(start + 4), bytesPerSample: bytes.readUInt16LE(start + 14) / 8 };
    }
    if (type === "data") data = bytes.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || !data || !format.channels || !format.sampleRate || !Number.isInteger(format.bytesPerSample) || !format.bytesPerSample) throw new Error("Invalid WAV PCM data");
  const samples = data.length / (format.channels * format.bytesPerSample);
  if (!Number.isSafeInteger(samples)) throw new Error("Invalid WAV sample alignment");
  return { ...format, samples, durationSeconds: samples / format.sampleRate, data };
}

export function processTreeSample(stdout, rootPid) {
  const rows = stdout.trim().split("\n").filter(Boolean).map(line => {
    const [pid, ppid, rss, ...command] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), rssKiB: Number(rss), command: command.join(" ") };
  }).filter(r => Number.isFinite(r.pid) && Number.isFinite(r.ppid) && Number.isFinite(r.rssKiB) && path.basename(r.command) !== "ps");
  const descendants = new Set([rootPid]);
  let added = true;
  while (added) {
    added = false;
    for (const row of rows) if (descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); added = true; }
  }
  const processes = rows.filter(r => descendants.has(r.pid));
  return {
    treeRssKiB: processes.reduce((total, r) => total + r.rssKiB, 0),
    nativeRssKiB: processes.filter(r => r.pid !== rootPid).reduce((total, r) => total + r.rssKiB, 0),
    processes,
  };
}

export function publicReceipt(value, roots = {}) {
  if (Array.isArray(value)) return value.map(item => publicReceipt(item, roots));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicReceipt(item, roots)]));
  if (typeof value !== "string") return value;
  let safe = value;
  for (const [root, replacement] of Object.entries(roots).sort((a, b) => b[0].length - a[0].length)) safe = safe.split(root).join(replacement);
  return safe.replace(/\/(?:Users|private|tmp|var|Volumes|home)\/[^\s\"'<>]+/g, "[local path]");
}

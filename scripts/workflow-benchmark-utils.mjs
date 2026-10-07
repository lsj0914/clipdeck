import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

export function summarizeRendererEvidence(report, actions, actionsSha256) {
  const names = ["select-word", "cross-unmounted-selection", "add-selection", "undo-add", "edit-cut", "reorder-cut", "undo-reorder", "find-transcript", "find-next-scroll"];
  const conditions = ["first-operation-after-open", "filesystem-warm-1", "filesystem-warm-2", "filesystem-warm-3"];
  assert.match(report.sourceHead, /^[a-f0-9]{40}$/);
  assert.equal(report.actionsSha256, actionsSha256, "Renderer report/actions hash mismatch");
  assert.equal(report.freshProcesses, 3);
  assert.equal(report.timedSamples, 108);
  assert.deepEqual(report.operations, names);
  assert.deepEqual(report.conditions, conditions);
  assert.equal(report.allTrusted, true);
  assert.equal(report.allNoError, true);
  assert.ok(Array.isArray(actions));
  const setup = actions.filter(row => row.name === "project-open" && row.condition === "setup-unmeasured");
  const rows = actions.filter(row => !(row.name === "project-open" && row.condition === "setup-unmeasured"));
  assert.equal(rows.length, 108, "Expected all 108 timed renderer observations");
  const slots = new Set();
  for (const row of rows) {
    assert.ok([1, 2, 3].includes(row.run) && names.includes(row.name) && conditions.includes(row.condition)
      && row.event?.isTrusted === true && row.error === null && Number.isFinite(row.ms) && row.ms >= 0
      && row.predicateId === `r17.task7.${row.name}.v2`, "Invalid renderer observation");
    const slot = `${row.run}/${row.condition}/${row.name}`;
    assert.ok(!slots.has(slot), `Duplicate renderer observation: ${slot}`);
    slots.add(slot);
  }
  const percentile = values => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * 0.95) - 1];
  };
  const perOperation = Object.fromEntries(names.map(name => {
    const selected = rows.filter(row => row.name === name);
    assert.equal(selected.length, 12);
    return [name, {
      n: selected.length, p95NearestRankMs: percentile(selected.map(row => row.ms)),
      maximumMs: Math.max(...selected.map(row => row.ms)),
      firstP95Ms: percentile(selected.filter(row => row.condition === conditions[0]).map(row => row.ms)),
      warmP95Ms: percentile(selected.filter(row => row.condition !== conditions[0]).map(row => row.ms)),
    }];
  }));
  if (report.perOperation) for (const name of names) {
    assert.equal(report.perOperation[name].n, perOperation[name].n);
    assert.equal(report.perOperation[name].p95NearestRankMs, perOperation[name].p95NearestRankMs);
  }
  return {
    sourceCommit: report.sourceHead, actionsSha256, freshProcesses: 3,
    firstCohorts: 3, warmCohorts: 9, operationSamples: 12, totalInteractionSamples: rows.length,
    unmeasuredSetupRows: setup.length, thresholdMs: 200,
    maximumMs: Math.max(...rows.map(row => row.ms)), pooledInteractionP95Ms: percentile(rows.map(row => row.ms)),
    withinInteractionThreshold: Object.values(perOperation).every(op => op.p95NearestRankMs <= 200),
    operationP95Ms: Object.fromEntries(names.map(name => [name, perOperation[name].p95NearestRankMs])), perOperation,
    measuredSamples: rows.map(row => ({ run: row.run, name: row.name, condition: row.condition, ms: row.ms,
      isTrusted: row.event.isTrusted, predicateId: row.predicateId,
      ...(row.after ? { afterWordCount: row.after.wordCount, afterCutCount: row.after.cutCount, afterRevision: row.afterRevision } : {}) })),
    timingScope: "Trusted input capture through the matching v2 state predicate and two animation frames; explicitly unmeasured project opens excluded",
    boundaries: report.boundaries ?? [],
  };
}

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

import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { requireBenchmarkNodeVersion } from "./workflow-benchmark-utils.mjs";

requireBenchmarkNodeVersion(process.versions.node);

const values = Object.fromEntries(process.argv.slice(2).map(value => {
  if (!value.startsWith("--") || !value.includes("=")) throw new Error("Use --name=value arguments");
  const split = value.indexOf("=");
  return [value.slice(2, split), value.slice(split + 1)];
}));
const mode = values.mode ?? "prepare";
if (!["prepare", "smoke", "measure"].includes(mode)) throw new Error("mode must be prepare, smoke or measure");
if (!values["output-dir"] || !values["inputs-dir"]) throw new Error("Provide --inputs-dir and external --output-dir");
if (mode === "measure" && !values["model-dir"]) throw new Error("Provide an explicit verified local --model-dir; downloads are forbidden");
const output = path.resolve(values["output-dir"]);
const repo = process.cwd();
if (output === repo || output.startsWith(repo + path.sep)) throw new Error("Raw media/evidence must stay outside the repository");
const run = path.join(output, `${new Date().toISOString().replace(/[:.]/g, "-")}-${mode}`);
await mkdir(run, { recursive: true });
const entry = path.join(run, "workflow-entry.mjs");
await build({ entryPoints: ["scripts/workflow-benchmark.ts"], outfile: entry, bundle: true, platform: "node", format: "esm", target: "node24" });
const common = [entry, `--repo=${repo}`, `--inputs-dir=${path.resolve(values["inputs-dir"])}`, `--output-dir=${run}`, `--mode=${mode}`];
if (values["model-dir"]) common.push(`--model-dir=${path.resolve(values["model-dir"])}`);
await writeFile(path.join(run, "invocation.json"), JSON.stringify({ executable: process.execPath, argv: process.argv.slice(1), cohorts: mode === "measure" ? 3 : 1 }, null, 2) + "\n");
for (let cohort = 0; cohort < (mode === "measure" ? 3 : 1); cohort++) {
  const child = spawn(process.execPath, [...common, `--cohort=${cohort}`], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", ORT_DISABLE_TELEMETRY: "1", PYTHONDONTWRITEBYTECODE: "1" } });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; process.stdout.write(data); });
  child.stderr.on("data", data => { stderr += data; process.stderr.write(data); });
  const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  await writeFile(path.join(run, `cohort-${cohort}.stdout.log`), stdout);
  await writeFile(path.join(run, `cohort-${cohort}.stderr.log`), stderr);
  if (exitCode !== 0) throw new Error(`Cohort ${cohort} failed with exit ${exitCode}; all output retained in ${run}`);
}
console.log(JSON.stringify({ evidenceDirectory: run, mode, status: "finished; inspect receipts before making acceptance claims" }));

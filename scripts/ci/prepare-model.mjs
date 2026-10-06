import { build } from 'esbuild';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('CI preparation requires Node 24');
if (process.argv.length !== 2) throw new Error('No custom model, URL or destination is accepted');
const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'clipdeck-ci-model-'));
let lock;
let ownsLock = false;
try {
  const bundle = path.join(temporary, 'models.mjs');
  await build({ entryPoints: [path.join(root, 'src/main/services/models.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node24' });
  const { MODEL_MANIFEST, downloadManifest, verifyModelDirectory } = await import(pathToFileURL(bundle).href);
  const home = await homedir();
  const pieces = ['.cache', 'huggingface', 'hub', 'models--Systran--faster-whisper-small', 'snapshots'];
  let parent = home;
  for (const piece of pieces) {
    parent = path.join(parent, piece);
    await mkdir(parent, { recursive: true });
    const stat = await lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('CI model cache must use owned directories, without symlink ancestors');
  }
  const target = path.join(parent, MODEL_MANIFEST.revision);
  lock = `${target}.clipdeck-ci-lock`;
  await mkdir(lock);
  ownsLock = true;
  let present = false;
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Existing CI model target is not an owned directory');
    present = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!present) {
    await downloadManifest(MODEL_MANIFEST, target, AbortSignal.timeout(10 * 60 * 1000), () => {});
  }
  // A corrupt cache is rejected rather than overwritten; this tool does not repair arbitrary existing files.
  const checked = await verifyModelDirectory(target, 'small');
  process.stdout.write(`${JSON.stringify({ schema: 1, node: process.versions.node, model: checked.id, revision: MODEL_MANIFEST.revision, digest: checked.digest, verified: true, downloaded: !present, bytes: MODEL_MANIFEST.files.reduce((sum, file) => sum + file.bytes, 0) })}\n`);
} finally {
  if (ownsLock) await rm(lock, { recursive: true, force: true });
  await rm(temporary, { recursive: true, force: true });
}

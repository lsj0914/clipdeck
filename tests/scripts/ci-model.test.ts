import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
const exec = promisify(execFile);
const revision = '536b0662742c02347bc0e980a01041f333bce120';
const helper = path.resolve('scripts/ci/prepare-model.mjs');
async function failure(home: string, args: string[] = []) {
  try {
    await exec(process.execPath, [helper, ...args], { env: { ...process.env, HOME: home }, timeout: 30000 });
    throw new Error('Expected preparation to reject');
  } catch (error) {
    return error as Error & { stderr: string; code: number };
  }
}
it('rejects a corrupt existing model without deleting or replacing its contents', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'clipdeck-ci-home-'));
  try {
    const target = path.join(home, '.cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots', revision);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'keep.txt'), 'owned existing data');
    const error = await failure(home);
    expect(error.code).not.toBe(0);
    expect(error.stderr).toContain('Missing local model resource');
    expect(await readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('owned existing data');
    expect(await readdir(path.dirname(target))).toEqual([revision]);
  } finally { await rm(home, { recursive: true, force: true }); }
});
it('does not remove another process acquisition lock when exclusive acquisition fails', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'clipdeck-ci-home-'));
  try {
    const lock = path.join(home, '.cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots', `${revision}.clipdeck-ci-lock`);
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, 'owner'), 'other process');
    const error = await failure(home);
    expect(error.stderr).toContain('EEXIST');
    expect(await readFile(path.join(lock, 'owner'), 'utf8')).toBe('other process');
  } finally { await rm(home, { recursive: true, force: true }); }
});
it('rejects a symlink cache ancestor without creating a model in its external destination', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'clipdeck-ci-home-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'clipdeck-ci-outside-'));
  try {
    await symlink(outside, path.join(home, '.cache'), 'dir');
    const error = await failure(home);
    expect(error.stderr).toContain('without symlink ancestors');
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
it('rejects arbitrary destinations and model URLs before touching the cache', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'clipdeck-ci-home-'));
  try {
    const error = await failure(home, ['--target', '/unowned/location']);
    expect(error.stderr).toContain('No custom model, URL or destination');
    expect(await readdir(home)).toEqual([]);
  } finally { await rm(home, { recursive: true, force: true }); }
});

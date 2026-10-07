import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const run = promisify(execFile);
const probe = fileURLToPath(new URL('../../scripts/packaging/offline_validation.mjs', import.meta.url));

for (const scenario of ['bundle child', 'bundle ancestor', 'linked output parent', 'linked application']) {
  test(`offline probe rejects ${scenario} before altering its application`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clipdeck-offline-output-'));
    try {
      const bundle = path.join(root, 'ClipDeck.app');
      const resources = path.join(bundle, 'Contents/Resources');
      await mkdir(resources, { recursive: true });
      const marker = path.join(resources, 'preserved.txt');
      await writeFile(marker, 'original application fixture');
      let app = bundle, output = path.join(resources, 'new-observations');
      if (scenario === 'bundle ancestor') output = root;
      if (scenario === 'linked output parent') {
        const link = path.join(root, 'linked-resources');
        await symlink(resources, link, 'dir');
        output = path.join(link, 'new-observations');
      }
      if (scenario === 'linked application') {
        app = path.join(root, 'App Alias'); await symlink(bundle, app, 'dir');
      }
      await assert.rejects(run(process.execPath, [probe, '--app', app, '--output', output]), error => {
        assert.match(error.stderr, /Observation output must be outside the app bundle/);
        return true;
      });
      assert.equal(await readFile(marker, 'utf8'), 'original application fixture');
      assert.deepEqual(await readdir(resources), ['preserved.txt']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('an outside sibling with the app name prefix reaches the normal signature check', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clipdeck-offline-sibling-'));
  try {
    const app = path.join(root, 'ClipDeck.app'); await mkdir(app);
    await assert.rejects(run(process.execPath, [probe, '--app', app, '--output', path.join(root, 'ClipDeck.app-evidence')]), error => {
      assert.doesNotMatch(error.stderr, /Observation output must be outside the app bundle/);
      assert.match(error.stderr, /codesign/); // Neutral unsigned fixture; no app is launched.
      return true;
    });
    assert.deepEqual(await readdir(app), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

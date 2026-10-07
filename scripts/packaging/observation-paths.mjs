import assert from 'node:assert/strict';
import path from 'node:path';
import { realpath } from 'node:fs/promises';

// Resolve existing ancestors before any write. The output parent must already
// exist; an observation directory must never be created inside its subject app.
export async function observationPaths(appInput, outputInput) {
  const app = await realpath(path.resolve(appInput));
  const requested = path.resolve(outputInput);
  const parent = await realpath(path.dirname(requested));
  const out = path.join(parent, path.basename(requested));
  const inside = (candidate, root) => candidate === root || candidate.startsWith(root + path.sep);
  assert.ok(!inside(out, app) && !inside(app, out), 'Observation output must be outside the app bundle');
  return { app, out };
}

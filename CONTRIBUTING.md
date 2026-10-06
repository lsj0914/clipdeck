# Contributing

ClipDeck is undergoing pre-release desktop acceptance. Issues that describe a real input, expected result and reproducible failure are particularly useful. Do not attach private recordings, credentials or full local paths; share a licensed minimal fixture or sanitized metadata instead.

Use Node 24 and `npm ci`. Keep main-process authority, the restricted preload bridge and the sandboxed renderer intact. New processing must preserve source identity, cancellation, atomic publication and preview/export timing. A source URL is a capability, not a renderer-authorized filesystem path.

## Resource-free checks

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run typecheck
npm test -- tests/domain tests/renderer tests/services/ipc.test.ts tests/services/ipc-native.test.ts tests/services/jobs.test.ts tests/services/process.test.ts tests/services/storage.test.ts tests/services/sentences.test.ts tests/services/media-protocol.test.ts tests/services/preparation.test.ts tests/scripts --maxWorkers=2
python3 -m unittest discover -s tests/packaging -p 'test_*.py'
npm run build
```

These checks do not launch a native editor or prove real ASR. For native work on Apple Silicon macOS, prepare the pinned archives and explicit model using [README](README.md#develop-and-verify), then run the full suite and `npm run smoke:desktop`. Actual recordings for fixture-gated inference must be provisioned separately; preserve reported skips. The maintained decoder is a project-specific pinned build, so an arbitrary PyPI installation is not equivalent.

Vitest runs the TypeScript behavior checks. The offline instrumentation uses Node's own runner: `node --test tests/packaging/offline_guard.test.mjs`, after native resource preparation. CI runs both explicitly; Python packaging checks use the separate standard-library unittest runner.

## Changes and evidence

Keep changes focused. Add regression tests for behavior that could lose edits, leak file authority, use stale source bytes or change timing. For UI changes, exercise actual imported media, empty/error/loading states, keyboard interaction and the minimum 800×600 window. Check local scrollports and overlapping controls; a page without horizontal overflow can still be unusable.

Explain the concrete before/after behavior, validation and remaining limits in a pull request. Do not infer recognition accuracy from synthetic speech or vocabulary-hint matches. Performance comparisons retain the same fixture, thresholds and all tails, and distinguish fresh process from filesystem-warm runs.

## Release work

[Packaging guide](docs/packaging.md) documents immutable resources, source matching, signatures, licenses and the separate full-workflow gates. Unit and native Actions run for pushes and pull requests, including forks. Native preparation downloads anonymously from the fixed [public resource release](https://github.com/lsj0914/clipdeck/releases/tag/resources-bootstrap-0.1.0) and verifies locked sizes/hashes. Repository contents permission is read-only, checkout credentials are not retained, and there is no privileged draft-resource job.

Contributions are distributed under GPL-3.0-or-later. Retain third-party notices and only use demo media whose redistribution rights are recorded.

# ClipDeck

Build a rough cut by choosing the words you want to keep from your own videos.

[简体中文](README.zh-CN.md) · [Contributing](CONTRIBUTING.md) · [Verification](docs/verification/benchmarks.md)

ClipDeck is a local desktop editor for interviews, lessons and spoken recordings. Import several videos, read their transcripts, select passages, arrange them into one story, check the assembled preview, and export an MP4. Files and transcription stay on your computer after explicit model setup.

**Status:** pre-release development. The current branch is undergoing real desktop and packaging acceptance; a verified public app download is not available yet. The initial target is Apple Silicon macOS. This README will link the exact accepted artifact and demo when they exist.

## The workflow

1. **Import your videos.** Use the native file picker. Projects keep references to the originals, so retain the source files.
2. **Create a transcript, or use a time range.** English and Chinese recognition run locally. Prepare the selected model explicitly; silent footage can be cut without transcription.
3. **Keep a passage.** Select its words, audition it against the original, and add it to the assembly. Repeat across sources.
4. **Shape the story.** Reorder passages, adjust in/out points, and use undo/redo. Check the continuous assembly preview before exporting.
5. **Export and save.** Export a playable MP4 and save a `.clipdeck` project to continue later. Moving originals requires relinking; changed source bytes invalidate old anchors.

The core is multi-source speech editing rather than a traditional effects timeline. Source playback and assembled playback are separate. The assembly preview and final export use the same frame/sample edit plan, including clips with different sizes and frame rates.

## Scope and constraints

- Local word timestamps, cancellable jobs, manual ranges, project recovery and explicit relinking.
- Landscape 16:9, portrait 9:16 and square output. The whole source image fits inside the selected frame; padding preserves its edges. Output is H.264/AAC, 30 fps, 48 kHz stereo.
- Compatible originals can be tried immediately; media that the browser cannot decode uses a normalized preview. Export always processes the original source.
- Choose Small (486 MB) or the optional Large v3 turbo (1.62 GB) model explicitly. Vocabulary hints and anchored text corrections help check recognition while retaining source timing. Names, accents and specialist vocabulary still need review; there is no claimed word-error benchmark. See [models and correction evidence](docs/asr-models.md).
- Full-source preview and the assembled output are limited to six hours. Longer sources can still be imported and edited, with shorter selections exported; split the source if you need full-source playback. Preview cache: eight owned artifacts and 4 GiB; assembly staging: 16 GiB. Text editing remains available when preview is unavailable.
- No cloud account, automatic highlight scoring, subtitles, effects, collaboration or professional project-format export in this first release.

The intended binary floor is macOS 14 on ARM64. Actual local checks have run on macOS 27.0.1; earlier OS execution and Intel/Windows/Linux are unverified. Preview packaging is ad-hoc signed, without Developer ID signing or notarization. See [packaging and distribution status](docs/packaging.md).

## Develop and verify

Use Node 24 and the locked dependencies. The Python/media resources are exact pinned archives, not replacements from the developer's PATH.

```sh
npm ci
npm run prepare:electron
python3 scripts/packaging/prepare_resources.py --assets-dir ../clipdeck-downloads --output .runtime --layout developer
node scripts/ci/prepare-model.mjs
npm run typecheck
npm test -- --maxWorkers=2
npm run build
npm start
```

The preparation step requires the four locked archives from the resource release; they are currently being prepared for publication. [Packaging guide](docs/packaging.md) documents their identities, corresponding sources and complete preparation route. The CI model helper explicitly downloads the pinned Small model to its canonical test cache; it verifies cache hits and rejects corrupt existing content.

The repository also separates resource-free unit checks from native checks. [Contributing](CONTRIBUTING.md) has the exact commands. A successful bundle build or desktop smoke is not evidence of the complete import-to-export workflow. Fixture-gated ASR checks are explicitly skipped when their recordings are absent. [Benchmark notes](docs/verification/benchmarks.md) distinguish generated fixtures, recorded speech, fresh processes, filesystem-warm runs and measured limits.

## Related projects

Text-based editing has an existing ecosystem. [OpenScript](https://github.com/preston176/openscript) and [Toaster](https://github.com/alexmpowers/toaster) are related projects; [LosslessCut](https://github.com/mifi/lossless-cut) and [Auto-Editor](https://auto-editor.com/) solve useful adjacent editing tasks. ClipDeck's implementation focuses on a recoverable local multi-source workflow and matching preview/export with explicit correctness evidence.

## License

[GPL-3.0-or-later](LICENSE). Bundled runtimes, fonts, models and media libraries have their own licenses. [Third-party notices](THIRD_PARTY_NOTICES.md) and the packaging source archives retain them. User recordings are never part of the repository or public demo.

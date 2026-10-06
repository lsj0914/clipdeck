# Reproducible native and renderer benchmarks

These historical measurements cover specific development workloads on one Mac. Their exact source commits and resource identities are retained below; they are not measurements of the later continuous transcript UI, independent-window ASR policy or neutral resource rebuild. Current renderer remeasurement and whole-recording desktop acceptance remain pending. They do not establish a universal speed claim, packaged installation acceptance, native file-picker use or human listening/viewing.

## Public-source native CI

[GitHub Actions run 37460832685](https://github.com/lsj0914/clipdeck/actions/runs/37460832685), attempt 2, verified public source `67cb80e669eeae454a399e37220e2c234a1c07e7` on macOS **15.7.9 ARM64**, Node **24.20.0** and Electron **44.5.1**. All 22 TypeScript test files passed: **238 cases passed, 12 fixture-gated cases skipped**. The skipped cases require separately provisioned recorded speech, Turbo, codec or workspace inference fixtures; this is not 250 executed cases or a speech accuracy test. Locked runtime preparation, explicit pinned Small-model acquisition, Node offline instrumentation, typecheck/build and sandboxed startup/close also passed. The fresh app profile had no selected model, so startup correctly reported transcription unavailable. Three retained Apple backupd XPC diagnostics did not prevent startup or close.

The initial attempt started before the resource draft existed, so its resource fetch failed and native job was skipped; the failed attempt remains visible. After all four exact assets were uploaded, only the failed/dependent jobs were rerun. This source-era bootstrap result is separate from later anonymous-download CI and final packaged workflow acceptance.

## Renderer: 50,000 words and 500 cuts

The retained historical measurement uses source commit `e35b0975f721d17284f03489bd742a7f1129010c`: three fresh Electron processes, each with a first cohort and three warm cohorts. Nine actual editing operations have 12 samples each, **108 interaction samples** in total. Every operation's p95 is at most 200 ms; adding all 50,000 selected words has p95 **173.2 ms**. The prior **434.9 ms** failure is retained and is not dropped from the record. Pooled interaction p95 is 164.4 ms; project-open p95 254.2 ms is separate from editing.

| Operation | First-cohort p95 ms | Warm p95 ms | All 12 p95 ms |
| --- | ---: | ---: | ---: |
| Select word | 24.9 | 25.8 | 25.8 |
| Select across unmounted groups | 22.7 | 25.2 | 25.2 |
| Add all 50,000 words | 173.2 | 167.1 | 173.2 |
| Undo add | 140.3 | 140.5 | 140.5 |
| Edit cut | 132.4 | 140.3 | 140.3 |
| Reorder cut | 131.6 | 148.3 | 148.3 |
| Undo reorder | 132.4 | 154.8 | 154.8 |
| Find transcript | 24.3 | 23.9 | 24.3 |
| Find next and scroll | 21.5 | 21.5 | 21.5 |

Timing starts with native input-event capture and ends after matching actual React/native state plus two animation frames. The selected range crosses unmounted transcript groups and retains all 50,000 native word IDs, original fingerprint, revision 1 and integer 0–25,000,000 ms bounds. The synthetic fixture is 25,000 seconds long; its source preview is genuinely rejected by the six-hour limit. Editing remains usable after the real rejection. This workload proves transcript editing under that condition, not seven-hour playback or long-form ASR.

Hardware: Apple M5 Pro MacBook Pro (`Mac17,8`), 18 cores, 48 GB RAM, arm64/macOS. Electron 44.5.1 / Chromium 152.0.7977.130 / Electron Node 24.21.0. First-operation conditions do not include OS page-cache eviction. Individual process peak working sets in runs 1/2/3 are renderer **586.5/588.4/590.7 MiB** and main **338.3/338.1/337.4 MiB**. These separate high-water marks must not be added and called simultaneous whole-app memory. The original finite cohort, thresholds and input hashes were unchanged.

The external frozen report is identified by `REPORT-e35b097.md`, source/build provenance and all retained timings; compact public evidence is in [workflow-performance.json](workflow-performance.json). The fixture source SHA-256 is `7f23f3769896d7c614888b5377ec15cd90d1331283b1d505f5880311cc84f795`. Full external reports/logs contain local scratch paths and remain separate from public source.

## Native workflow method

The new native harness is [benchmark-workflow.mjs](../../scripts/benchmark-workflow.mjs). It requires **Node 24** before reading inputs or creating output, bundles the current actual service code into an external scratch entry and launches exactly three fresh Node cohorts sequentially using the launcher's exact executable. It does not rebuild shared `dist`, drive the renderer or substitute an API/model. Prepared runtime paths are repository-local `.runtime/bin/ffmpeg`, `.runtime/bin/ffprobe`, `.runtime/worker/bin/python3.12` and `worker/transcribe.py`; no host Python or implicit model download is used.

Use the already prepared input directory containing `manifest.json` and its nine original MP4s. All source SHA-256 values are checked before and after. `--model-dir` must identify the complete local `Systran/faster-whisper-small` snapshot at revision `536b0662742c02347bc0e980a01041f333bce120`; native registration verifies each fixed size/hash. Raw generated media and logs require an output directory outside this checkout.

```sh
node scripts/benchmark-workflow.mjs --mode=prepare --inputs-dir="$INPUTS" --output-dir="$OUTPUT"
node scripts/benchmark-workflow.mjs --mode=smoke --inputs-dir="$INPUTS" --output-dir="$OUTPUT"
node scripts/benchmark-workflow.mjs --mode=measure --inputs-dir="$INPUTS" --output-dir="$OUTPUT" --model-dir="$MODEL"
node scripts/summarize-workflow-benchmark.mjs --receipt-dir="$RUN" --renderer-report="$RENDERER_REPORT" --output-file=docs/verification/workflow-performance.json
```

Run `measure` during a quiet window with other transcription/render/build/test jobs stopped. There are no discarded tails or extra runs seeking a passing result. Each cohort records hardware, load, source/runtime hashes, commands, stages, status/reasons and every 100 ms process-tree RSS sample. The retained full `receipt.json` has all operations; `operations.jsonl` records each completion before derived metrics/output receipts are added. Native failures stop that cohort and remain in its logs.

For the published runtime-repair receipt, the summary command additionally uses `--superseded-dir="$SUPERSEDED_RUN"` and `--condition-events="$CONDITION_EVENTS"` to retain the original cohort and observed desktop change. The summarizer rejects unsupported-Node receipts as an authoritative cohort.

- **First:** first measured operation of its kind in a fresh Node cohort. Prior input probing and model registration/hash verification warm filesystem data; no reboot, cache purge or universal “cold” claim.
- **FS-warm recompute:** one subsequent operation in the same cohort, with a new render service/cache for proxy/render work. ASR creates a new Python worker and reloads the model for every job. This is not a persistent-model warm result.
- **Cache hit:** the same live render service reuses a committed verified source/assembly preview; it does no new encoding. Cache-hit latency is reported separately.

ASR end-to-end time is measured through the **uninstrumented native TranscriptionService**, including actual source/model checks, extraction, worker loading/inference and final validation/commit. RTF divides wall seconds by independently decoded audio duration. Model-free worker preflight is separate. One extra diagnostic per language observes the unchanged worker with `sys.setprofile`; no function/model/parameter/response is replaced. It separates model-file verification, preflight/import checks, PCM loading/input validation, real model constructor and ready-to-complete inference plus normal event delivery. Profile overhead is included and the diagnostic is excluded from throughput repeats.

Memory is sampled simultaneous RSS of the Node cohort and its native descendants, excluding the `ps` sampler. It is a sampled peak, not a kernel high-water mark, and covers this service process tree rather than an Electron app. Short cache hits may only have the initial sample.

## Story and media truth

The canonical story uses **three logical source files of the same recorded reader**, not three people: OpenSLR31 corpus reader `2412`, Samuel Butler's *Erewhon*. All imagery is generated visual markers. Proxy/render timings here describe these small generated-image video fixtures; they do not characterize camera footage, 4K60 processing or long-source preview latency. The receipt retains actual probed story-source geometry/frame rates. Twelve complete corpus passages select 96.715063 seconds of original speech. Bounds round independently to integer milliseconds; each cut rounds up to whole 30 fps output frames. The exact native plan therefore has **2,909 frames, 4,654,400 samples at 48 kHz and 96.966667 seconds**. Frame/sample padding does not read beyond each selected end.

Landscape preview/export has three fresh first cohorts and one FS-warm recompute per cohort. Portrait and square receive one preview/export correctness check each in cohort 1; those single runs are clearly excluded from the repeated performance cohort. Each output must pass the actual native full-decode validator with exact frame/decoded sample counts and presentation duration within one frame before atomic commit. This automation supplements the root-owned desktop story demonstration; it does not prove word selection, a human picker or human playback/listening.

Recorded English audio derives from [OpenSLR31 Mini LibriSpeech](https://openslr.org/31/), archive `dev-clean-2.tar.gz`, MD5 `6d7ab67ac6a1d2c993d050e16d61080d`, SHA-256 `176ec501490eced2d6c1f89f4f0ddc7dfe799e649e5322f8ba49fe3ff50c8012`, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Credit Vassil Panayotov, Guoguo Chen, Daniel Povey, Sanjeev Khudanpur, LibriVox volunteer readers and the OpenSLR subset. Transformations decode/concatenate corpus utterances, pair generated markers and encode H.264/AAC; local input intervals and original FLAC hashes remain in the input manifest. Whole-book timestamps are unknown. Synthetic macOS Mandarin voice is local acceptance only; its redistribution rights are not established. No such audio is included in public evidence files.

The already verified distinct 60-marker/three-run benchmark remains in [render-acceptance.json](render-acceptance.json), reproduced by [benchmark-render.mjs](../../scripts/benchmark-render.mjs). It covers reverse order, 180 checked visual boundary frames, 60 tone/silence checks per run and exact 780 frames / 1,248,000 decoded samples. This task does not rerun it or replace it with repeated use of one source. Its filesystem-warm first-render and sampled-memory limits remain explicit.

## Native measured results

All three finite Node 24.19.0 cohorts ran on **`990b84b30ca9c78e4fc640fa17ca3845e00883b8`**, with identical native source/runtime hashes. The bundled entry SHA-256 is `ddbce0022588030758a97d45b8aaa91e37500719f75f8e10dedd52a09fa99355`. The public receipt retains each raw receipt's digest, all **80 operation results**, per-run memory peaks and all original source hashes. There were **zero failed or skipped benchmark operations**. This candidate's broader review and UI acceptance remain separate gates.

Self-review found that an earlier invocation used shell Node **23.11.0**, although the plan specifies Node 24. All 80 original operation results and three raw receipt hashes are retained as a **superseded runtime cohort** in the public receipt. The repair added a fail-closed version guard and explicitly launched the bundled Node 24.19.0 binary. Only the identical three-cohort workload was repeated; inputs, thresholds, native service code, media runtime, model and worker were unchanged. The Node 23 results are excluded from the authoritative comparison rather than erased.

Hardware is Apple M5 Pro / `Mac17,8`, 18 cores, 48 GiB RAM, macOS ARM64 / Darwin 27.0.0; harness Node 24.19.0. Initial cohort load averages were 3.28/3.10/2.89, 10.75/5.92/4.04 and 10.57/6.63/4.46. The later values include the preceding cohort's recent load; no cache flush or cooling pause was added. The root held other heavy development work during this finite window. The user manually unlocked the Mac during cohort 1; the separate condition-event receipt retains the report time and scope. Normal desktop processes remained active, so this is not an uninterrupted laboratory/locked-screen test. No extra repeat was added for that condition change. Prepared resources were FFmpeg 9.0.2 and Python 3.12.15, with actual worker preflight confirming faster-whisper 1.2.1, CTranslate2 4.8.2, NumPy 2.5.3, maintained PyAV 16.0.1+clipdeck.ffmpeg8.1.2, ONNX Runtime 1.30.0 and tokenizers 0.23.2. ASR uses CPU/int8, four threads, VAD, word timestamps and beam size 5 under the production OS outbound-network denial and early offline/telemetry settings.

Each cell below lists runs 1/2/3 in order, in **seconds**. First and FS-warm samples are separate; their tails are retained.

| Native operation | First seconds | FS-warm recompute seconds |
| --- | --- | --- |
| Recorded English ASR, 57.085 s decoded audio | 7.956 / 8.338 / 8.282 | 7.967 / 8.646 / 8.189 |
| Synthetic Mandarin ASR, 11.365688 s decoded audio | 2.760 / 2.803 / 2.652 | 2.550 / 2.755 / 2.648 |
| Source proxy, story file 1 (57.085 s) | 0.917 / 0.954 / 0.930 | 0.893 / 1.115 / 0.894 |
| Source proxy, story file 2 (40.935 s) | 0.734 / 0.696 / 0.694 | 0.672 / 0.696 / 0.672 |
| Source proxy, story file 3 (40.542 s) | 0.645 / 0.690 / 0.673 | 0.631 / 0.659 / 0.632 |
| Landscape assembly preview (960×540) | 7.385 / 7.369 / 7.472 | 7.044 / 7.218 / 7.644 |
| Landscape export (1920×1080) | 20.765 / 20.702 / 20.368 | 19.825 / 20.926 / **25.343** |

English end-to-end RTF is **0.1394/0.1461/0.1451** first and **0.1396/0.1515/0.1435** FS-warm. Mandarin end-to-end RTF is **0.2428/0.2466/0.2333** first and **0.2243/0.2424/0.2330** FS-warm. Every sample starts a new model-loading worker. Native source-preview cache hits span 0.429–0.750 ms; assembly-preview cache hits span 0.644–1.018 ms. Those are native method/job-resolution times and do not include loading or playing video in the UI. The final 25.343-second export tail was retained with no diagnostic rerun or invented explanation.

Sampled simultaneous Node/native **tree** peak RSS is shown in MiB; the public receipt also keeps native-descendant-only peaks per operation. It is not whole-app memory.

| Operation | First tree MiB, runs 1/2/3 | FS-warm tree MiB, runs 1/2/3 |
| --- | --- | --- |
| Recorded English ASR | 1289.6 / 1356.6 / 1359.1 | 1373.4 / 1404.8 / 1317.9 |
| Synthetic Mandarin ASR | 1225.4 / 1213.0 / 1198.8 | 1235.5 / 1220.6 / 1206.2 |
| Landscape preview | 522.0 / 479.3 / 475.3 | 684.1 / 577.8 / 570.8 |
| Landscape export | 1212.3 / 1202.1 / 1196.0 | 1372.0 / 1268.5 / 1283.7 |

Native descendant-only peaks for these cohorts span 1116.5–1198.3 MiB for English ASR, 969.2–978.2 MiB for Mandarin, 208.6–209.3 MiB for landscape preview and 861.0–862.3 MiB for landscape export. Source-proxy native peaks span 108.5–109.2 MiB. Tree and child-only peak values can occur at different sample times and must not be added together.

Uninstrumented service stage events show extraction plus the following source-identity check at **14.93–20.30 ms** for English and **7.98–9.12 ms** for Mandarin. Worker startup/model checking/preflight/PCM/model initialization occupies **532.92–585.99 ms**. The remaining native transcribing stage includes inference, final transcript validation and commit. Standalone model-free preflight times were **118.80/149.05/153.48 ms**; official local model registration checks took **206.85/205.40/217.00 ms** outside throughput timing.

The separate observed diagnostic reports the following real worker phases. These are **one diagnostic per language**, include profiling overhead and are excluded from the three-repeat throughput comparison.

| Profile-observed worker phase | English ms | Mandarin ms |
| --- | ---: | ---: |
| Model resource size/hash check | 167.05 | 165.92 |
| Preflight/import/version/VAD checks | 177.21 | 167.07 |
| PCM loading and input validation | 1.07 | 0.22 |
| Actual WhisperModel constructor | 267.69 | 272.79 |
| Ready → complete: inference plus event delivery | 7306.59 | 1748.30 |

Observed inference/event-delivery RTF is 0.1280 for recorded English and 0.1538 for synthetic Mandarin; these do not replace the authoritative end-to-end RTF. Both diagnostics confirmed Python 3.12.15, the exact versions above, the local VAD digest and telemetry disablement, with empty stderr.

One-off portrait preview/export took **5.589/14.372 seconds** at 540×960/1080×1920; square preview/export took **4.405/10.287 seconds** at 540×540/1080×1080. These are correctness checks and are not three-repeat aspect performance claims. All **16 assembly artifacts** and **18 source proxies** completed the native full-decode/frame/sample/duration checks before commit; all nine originals were preserved. A separate short Node24 harness smoke checked 0.130–0.531 seconds from a real source and committed exactly 13 frames / 20,800 samples.

Renderer and native results here provide bounded R17 evidence. Human desktop interaction/listening, full acceptance review, final packaged installation and public delivery are separate.

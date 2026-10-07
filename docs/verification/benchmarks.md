# Reproducible native and renderer benchmarks

Measurements completed on 2026-10-07 cover defined workloads on one Apple M5 Pro Mac with 48 GB RAM. Native services were measured at public source `ab2e534bd80c446b70c4e75054a7abd825d1ae90`, Node 24.19.0 and FFmpeg 9.0.2. Renderer interactions were measured at root source `5b0a626f1e78b5b4e9e39e0f4b68bba3b5dc789a`; its `App.tsx` is byte-identical to the native campaign's public source. The different source identities remain explicit. These results do not establish complete packaged desktop acceptance or a verified public application download.

The public records are [workflow-performance.json](workflow-performance.json) and [native-marker-performance.json](native-marker-performance.json). Source/runtime/model/input identities, all measured timings and the defined limitations are retained. Raw desktop traces and machine paths stay outside the public repository. [Historical notes](https://github.com/lsj0914/clipdeck/blob/ab2e534bd80c446b70c4e75054a7abd825d1ae90/docs/verification/benchmarks.md) retain the previous renderer/native cohorts, including slower results and the superseded Node 23 run; they have not been relabeled as current measurements.

## Renderer: 50,000 words and 500 cuts

Three fresh Electron processes each completed nine operations in four conditions: the first operation after opening, then three filesystem-warm repeats. That yields 12 samples per operation and 108 trusted interaction timings. Timing runs from actual input capture to the matching version-2 state predicate and two animation frames. The three explicitly unmeasured project-open rows remain separate; they are not included in editing percentiles.

| Operation | First p95, n=3 (ms) | Warm p95, n=9 (ms) | All p95, n=12 (ms) |
| --- | ---: | ---: | ---: |
| Select word | 28.0 | 25.7 | 28.0 |
| Select across unmounted groups | 51.2 | 41.7 | 51.2 |
| Add all 50,000 words | 168.1 | 175.8 | 175.8 |
| Undo add | 146.6 | 156.9 | 156.9 |
| Edit cut | 129.7 | 162.4 | 162.4 |
| Reorder cut | 141.5 | 155.4 | 155.4 |
| Undo reorder | 136.6 | 139.2 | 139.2 |
| Find transcript | 32.0 | 131.5 | 131.5 |
| Find next and scroll | 44.8 | 38.4 | 44.8 |

All operation p95 values are below the specified 200 ms threshold. At n=12, nearest-rank p95 is the maximum; this finite workload does not characterize population tails. All timings, including the 175.8 ms maximum and 131.5 ms search tail, are present in the JSON. No timing was discarded to meet the threshold.

The synthetic source is 25,000 seconds long. Its actual full-source preview is rejected by the six-hour limit; this test proves editing after that rejection rather than seven-hour playback or ASR. Selection retains all 50,000 native word IDs and original bounds. Save/readback checks preserve the complete transcript and chosen 500-cut order. Script virtualization presents 500 logical passages with a small mounted subset; it does not mount 500 simultaneous rows.

The first process retains limitations in unmeasured controller/physical scroll evidence. The third process retains a lock-screen interruption and brief preparation work during an unarmed interval; it resumed the same process. There was no OS page-cache eviction. Renderer memory was observed at selected setup/pass/save points, rather than continuously per operation; no current whole-app memory maximum is claimed here.

## Native workflow: three fresh cohorts

Each fresh Node process performs one first and one filesystem-warm recompute using the actual service/worker implementations. These are not GUI or installation timings. Source probing, hashing and model registration may already warm the filesystem. Every ASR job creates a new Python worker and reloads the model; filesystem-warm does not mean a persistent loaded model.

The story consists of three logical files of one recorded OpenSLR31 reader, paired with generated visual markers. Twelve manually specified complete corpus passages select 96,715 integer milliseconds of speech. Frame-grid planning yields exactly 2,909 frames, 4,654,400 samples at 48 kHz and 96.966667 seconds. These manual ranges do not establish ASR word-selection correctness. The Chinese ASR input is synthesized speech, separate from the recorded English input.

The ASR model is the pinned Small snapshot, not Turbo. End-to-end ASR includes source/model checks, extraction, per-job worker startup, recognition, the pinned local punctuation pass and transcript validation/commit. Actual saved transcript hashes and punctuation identities are included in the JSON. Recognition anchors and positive timestamps do not constitute a word-error-rate or universal punctuation-quality benchmark.

Each cell below preserves all three elapsed times in seconds, in cohort order. At n=3 a nearest-rank p95 would be the maximum; no broad percentile claim is made.

| Operation | First (s): cohorts 0 / 1 / 2 | FS-warm (s): cohorts 0 / 1 / 2 |
| --- | ---: | ---: |
| Recorded English ASR, 57.085 s | 7.351 / 7.474 / 7.555 | 7.258 / 7.478 / 7.552 |
| Synthetic Chinese ASR, 11.366 s | 3.035 / 3.131 / 3.155 | 3.040 / 3.106 / 3.162 |
| Source proxy, part 1 | 0.883 / 0.888 / 0.898 | 0.889 / 0.898 / 0.899 |
| Source proxy, part 2 | 0.669 / 0.673 / 0.673 | 0.662 / 0.674 / 0.684 |
| Source proxy, part 3 | 0.632 / 0.623 / 0.639 | 0.625 / 0.645 / 0.638 |
| Landscape assembly preview | 6.891 / 6.957 / 7.007 | 6.972 / 7.022 / 6.998 |
| Landscape assembly export | 19.068 / 19.297 / 19.259 | 19.174 / 19.261 / 19.287 |

Cache hits are separate operations: the same live RenderService reuses a committed verified preview/job without re-encoding. Sub-millisecond service cache-hit timings do not mean a frame became visible that quickly. The recorded English end-to-end RTF spans 0.1271–0.1324; synthetic Chinese spans 0.2670–0.2782. These ratios apply only to these inputs and hardware.

Model-free worker preflight was 3.627 / 0.351 / 0.353 seconds. The larger first result remains included. Model registration is separately recorded outside ASR throughput. Two extra profile-observed worker diagnostics in cohort 0 are excluded from authoritative throughput; they do not include the service's later punctuation/commit stage.

Portrait and square each received one preview/export correctness pair in cohort 0, at 540×960 / 1080×1920 and 540×540 / 1080×1080. They are not three-repeat aspect performance cohorts. All 16 assembly artifacts completed the production native full-decode/frame/sample/duration checks and their complete output byte hashes were reread. The 18 source-proxy receipts contain native decode counts but lack recorded output byte hashes; they are not included in the 16 hash-linked assembly outputs. All nine original inputs match their hashes before and after the campaign.

The 80 operations retain 2,809 simultaneous Node-and-descendant RSS samples with zero recorded sample errors. Each recorded peak matches the retained samples. Sampling runs every 100 ms and excludes the sampler; it is not a kernel high-water mark or whole Electron-app measurement. Short cache hits may complete before the first asynchronous sample returns. Selected tree peaks in MiB follow; each cell retains all three cohorts.

| Operation | First tree peaks (MiB) | FS-warm tree peaks (MiB) |
| --- | ---: | ---: |
| Recorded English ASR, 57.085 s | 1312.1 / 1310.8 / 1304.8 | 1366.9 / 1332.8 / 1330.7 |
| Synthetic Chinese ASR, 11.366 s | 1243.4 / 1225.5 / 1220.5 | 1259.5 / 1227.0 / 1225.4 |
| Landscape assembly preview | 528.2 / 478.7 / 467.5 | 689.4 / 567.0 / 553.4 |
| Landscape assembly export | 1217.4 / 1192.0 / 1178.6 | 1380.0 / 1266.2 / 1262.6 |

An additional whole-Node OS-sandbox attempt failed spawning the process inventory tool before timed operations. The allow-default-only control also returned EPERM. That failed attempt is retained outside the repository, and contains no discarded timed samples. The successful campaign uses the unchanged documented Node harness; production Python workers retain their OS outbound-network denial. The entire Node/FFmpeg harness is not described as OS-network-denied.

## Sixty distinct markers and non-frame cut boundaries

The separate current marker matrix exports 60 different original generated color/number markers with tones, in reverse order. Inputs mix 24/25/30 fps, geometry, rotation, sample aspect ratio and one silent source. Each 0.130–0.531 second range owns 13 output frames and 20,800 audio samples. All three outputs contain exactly 780 frames, 1,248,000 presented/decoded audio samples, 1920×1080 and 26 seconds.

Actual export times are 4.975 / 4.967 / 5.027 seconds. These runs share one Node process and use three new services/caches; fixture generation warmed the filesystem. Root and independent review separately reread 540 first/middle/last-of-cut PNG sample points and 180 tone/silence windows, with all 60 source hashes intact. This is a synthetic boundary/order test, not natural-scene quality, lip sync or human listening.

The original marker receipt contains aggregate memory peaks without raw samples/error rows, so those peaks are omitted from the compact public record. Its source attribution relies on the actual exact-source launch and retained source snapshot; the original harness removed its transient compiled entry. Output byte hashes in the public JSON were computed afterward from retained outputs and are explicitly labeled as such.

## Reproduce and summarize

Use Node 24, the locked local runtime and an explicitly verified local Small model. Prepared benchmark inputs contain their manifest and nine original MP4s. Raw media/evidence must remain outside the checkout.

```sh
node scripts/benchmark-workflow.mjs --mode=prepare --inputs-dir="$INPUTS" --output-dir="$OUTPUT"
node scripts/benchmark-workflow.mjs --mode=smoke --inputs-dir="$INPUTS" --output-dir="$OUTPUT"
node scripts/benchmark-workflow.mjs --mode=measure --inputs-dir="$INPUTS" --output-dir="$OUTPUT" --model-dir="$MODEL"
node scripts/benchmark-render.mjs --output-dir="$MARKER_OUTPUT" --runs=3
node scripts/summarize-workflow-benchmark.mjs --receipt-dir="$RUN" --renderer-report="$RENDERER_REPORT" --renderer-actions="$RENDERER_ACTIONS" --output-file=docs/verification/workflow-performance.json
```

Run during a quiet window with other ASR/render/build jobs stopped. The renderer summary requires a structured JSON report and its hash-linked raw actions JSONL. It validates all 108 unique operation/condition/run slots and recomputes the metrics; it does not repeat historical hardcoded numbers. Non-trusted, erroneous, non-finite, missing or duplicate observations fail summary validation. Slow valid observations are retained and reported as exceeding the threshold.

The native harness snapshots source/runtime/model/input identities and fails if originals change. The frozen bundled entry, full receipts, raw completions and stage/memory records are separate from derived public summaries. [The historical source-native CI notes](https://github.com/lsj0914/clipdeck/blob/ab2e534bd80c446b70c4e75054a7abd825d1ae90/docs/verification/benchmarks.md#public-source-native-ci) remain available; CI startup/close does not establish the import-to-export desktop workflow. The benchmark campaign's historical exact-source CI is [run 37578111410](https://github.com/lsj0914/clipdeck/actions/runs/37578111410), with fixture-gated limits recorded in its log.

The subsequent [experimental Preview 2 record](preview-2.md) documents performed native picker, navigation, save/reopen/relink, real camera-footage demo and export checks against its exact binary. Human listening/lip sync, complete current renderer performance and full-workflow acceptance remain separate requirements. These historical benchmark passes do not establish complete release readiness.

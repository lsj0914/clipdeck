# Prepared offline worker runtime

ClipDeck requires Python **3.12.15** and the exact distributions in `worker/requirements.txt`. Development and packaging both resolve `worker/bin/python3.12` inside their own runtime directory. There is no host Python, PATH, research environment, or older Python fallback.

Prepare the project-local copy from the verified portable payload and its receipt:

```sh
npm run prepare:worker -- --runtime-dir /path/to/worker --runtime-manifest /path/to/payload-manifest.json
```

Preparation pins receipt SHA256 `298b8f006e05917c887a055d3d021899135669b2a0771b95d257e2492208df07`, checks every regular file and internal symlink, rejects extra files, copies to staging, verifies the copy, and runs the actual product preflight under macOS network denial before replacing `.runtime/worker`. The source payload remains unchanged. The independently prepared runtime archive has SHA256 `16934b19b56ff3e7758b42cfa14c944146feba18433169a2076513633d8556e8`; its build, source and license receipts belong to the packaging work.

The maintained PyAV decoder is `16.0.1+clipdeck.ffmpeg8.1.2`, with wheel SHA256 `b58b8d62b42d44f7b8bb2fcfdc543be51a5df8d73bf4c7951d138624e0b852a9`. It supplies PCM/WAV decoding. Source video audio is always decoded by the project-local FFmpeg 9.0.2 into mono 16k signed-16 PCM, then read as a NumPy array by the worker.

The worker sets `ORT_DISABLE_TELEMETRY=1` before importing ONNX Runtime or faster-whisper, then calls `disable_telemetry_events()` before model/VAD sessions. Model/tokenizer/VAD files are fully hash verified; worker execution also denies outbound network access. The fresh-HOME preflight test checks that no telemetry state is created.

The prepared development copy and real inference checks are verified. A signed, packaged application and fresh-machine resource/license closure remain separate acceptance work.

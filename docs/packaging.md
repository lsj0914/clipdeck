# Packaging ClipDeck for macOS ARM64

ClipDeck application source is **GPL-3.0-or-later**. The preview bundle uses ad-hoc signing. It is **not Developer ID signed or notarized**. Gatekeeper may reject a downloaded preview; this project does not ask users to disable security protections. A reviewed source build is the supported alternative until a signed distribution exists.

The intended binary deployment floor is macOS 14 on Apple Silicon. Execution has been checked on macOS 27.0.1 ARM64; macOS 14 execution, Intel Macs, Windows and Linux are unverified. A Mach-O minimum-version field is build metadata, not evidence of execution on an older system.

## Inputs and release assets

`packaging/resources.lock.json` pins complete archive names, SHA-256 values and byte lengths. Never use a floating `latest` URL, a copied virtual environment, a system FFmpeg, or an implicit Hugging Face cache. The four resource assets are:

- `portable-worker-runtime-3.12.15-macos-arm64.tar.gz`: standalone CPython 3.12.15, 23 pinned worker dependencies, retained licenses and the required VAD resource. No Whisper model.
- `clipdeck-media-runtime-9.0.2-macos-arm64.tar.gz`: the reviewed FFmpeg 9.0.2 and ffprobe CLIs with x264, GPL version 3 configuration, file/pipe protocols and networking disabled.
- `clipdeck-media-corresponding-source.tar.gz`: exact FFmpeg/x264/pkgconf source inputs, configuration and build recipe for those CLIs.
- `clipdeck-maintained-decoder-corresponding-source.tar.gz`: the maintained PyAV BSD decoder and minimal FFmpeg 8.1.2 LGPL source, modifications, build/relinking recipe and configuration. This is not the former GPL vendor wheel.

The official Electron 44.5.1 Darwin ARM64 ZIP is separately pinned in the same lock. Its baseline contains 13 ARM64 Mach-O objects with a maximum minimum-OS field of 13.0. The combined preview has 108 ARM64 Mach-O objects; its maximum field and outer bundle minimum are 14.0. The complete worker file inventory and upstream notice provenance are tracked under `packaging/`.

The current resource set uses the neutral compiled 003 rebuild with a corrected media source recipe that creates its own log directory. The media CLIs and maintained FFmpeg decoder were compiled with `/opt/clipdeck-runtime`, relative include/library paths, and compiler source/debug mapping to `/clipdeck-build`; the PyAV wheel and standalone Python payload were prepared afresh with the same 23 dependency versions. No compiled string replacement was used. `packaging/resource-rebuild.json` binds those current assets, unchanged upstream sources and recipe inventories; `worker-wheel-inputs.json` records the exact wheel inputs. Every regular member and tar metadata were independently scanned for the identified private maintainer home/research needles, including all 95 native resource files. This named-needle scan is not a universal secret scan or a final application-source/privacy acceptance claim. Earlier 002 source-diagnostic normalization and prototypes remain historical evidence.

A maintainer must publish the locked resource assets and corresponding-source archives together with the preview and its exact application-source archive. Availability on a draft release is not a public download claim. Supply the release URL explicitly after it exists. For a private draft, use an authenticated GitHub download outside this script, then use the local archive route. No credentials are accepted by these tools.

## Prepare resources

These tools use the Python standard library. On a Mac, Apple's command-line tools supply the inspection/signing utilities. Work from a checkout of the reviewed release commit and use a new output directory outside the checkout:

```sh
python3 scripts/packaging/prepare_resources.py \
  --assets-dir ../clipdeck-downloads \
  --output ../clipdeck-resources
```

Put the four exact local assets in `../clipdeck-downloads` first. Alternatively add `--release-base-url https://github.com/OWNER/REPO/releases/download/REVIEWED_TAG`; replace the placeholder with the actual reviewed release directory. Downloads are HTTPS, pinned, fail closed on changed bytes and do not use `latest`. Existing outputs are preserved. Filesystem traversal, escaping links, unexpected archive scopes and privileged modes are rejected. Executable modes and relative symlinks are retained. The prepared output contains:

```text
runtime/bin/ffmpeg
runtime/bin/ffprobe
runtime/worker/bin/python3.12
worker/                       # added from the reviewed app source during assembly
notices/
corresponding-source/
resource-manifest.json        # preparation receipt, kept outside the final app
```

For development, use `--layout developer --output .runtime` in a checkout where `.runtime` does not exist. That layout produces `.runtime/bin` and `.runtime/worker`, matching the actual development resolver. If `.runtime` already exists, prepare to a fresh directory, preserve the old directory and deliberately move the verified tree into place. Do not run the older directory-only `prepare-worker` route with the new public manifest: that compatibility tool pins a different historical manifest. No package installation, global Python change or developer PATH lookup occurs in this preparation route.

One optional real worker preflight, without a model or inference:

```sh
python3 scripts/packaging/check_runtime.py \
  --runtime-dir .runtime --worker-script worker/transcribe.py \
  --output ../worker-preflight.json
```

This invokes the bundled interpreter with isolated Python imports, an empty HF directory, `/usr/bin:/bin`, disabled telemetry and a worker-specific macOS outbound denial. It preserves stdout/stderr. It proves the worker preflight only; it does not prove a whole-app offline workflow.

## Freeze the reviewed build and application source

Finish the coherent app build, source review, tests and real workflow checks before packaging. The scripts never rebuild shared `dist`. Commit the reviewed application, packaging metadata and documentation. Produce the matching application source with committed files, modes and symlinks:

```sh
git archive --format=tar HEAD | gzip -n > ../clipdeck-application-source.tar.gz
python3 scripts/packaging/snapshot_build.py \
  --application-source ../clipdeck-application-source.tar.gz \
  --output ../clipdeck-reviewed-build.json
```

The snapshot checks every archive member against the committed git blobs and the actual checkout, rejecting missing files and uncommitted input changes. It hashes all built files and records the commit, package/worker hashes and dirty context. This binds source and inputs; the person coordinating the release must still establish that `dist` came from the reviewed coherent build.

## Assemble and inspect the preview

Obtain the exact official ZIP named and pinned in the lock from Electron's release. Keep it unchanged; supply it explicitly:

```sh
python3 scripts/packaging/build_app.py \
  --resources ../clipdeck-resources \
  --electron-zip ../clipdeck-downloads/electron-v44.5.1-darwin-arm64.zip \
  --snapshot ../clipdeck-reviewed-build.json \
  --application-source ../clipdeck-application-source.tar.gz \
  --output ../clipdeck-preview
```

The recipe follows [Electron's documented manual packaging and rebranding](https://www.electronjs.org/docs/latest/tutorial/application-distribution). It copies the app under `Contents/Resources/app`, uses the original ClipDeck icon, renames the outer executable and every helper, and retains the framework identity. The worker script remains outside ASAR at `Contents/Resources/worker/transcribe.py`; native resources remain at exactly `Contents/Resources/runtime/{bin,worker}`. No model is bundled. Full Electron/Chromium, Mantle/ReactiveObjC, media, worker and current frontend/font licenses are retained. Matching application, media and maintained decoder source archives travel inside `corresponding-source`.

The official ZIP omits the base helper's empty `Contents/Resources`. The recipe creates that real readable 0755 directory before signing, independently of developer Electron preparation. A prior moved prototype still logged `sandbox_extension_issue_file ... Helper.app/Contents/Resources: EPERM` although the directory existed and normal startup/preflight/close succeeded. Focused API probes established an extension-issuance denial, not a missing directory. The upper private Apple caller remains unproven. Preserve any warning; do not hide stderr, add `--no-sandbox`, change Electron's renderer sandbox, or claim the warning is harmless on all systems.

Signing is inside out: native leaves, deepest nested helpers/frameworks, then the outer app. `--deep` is used for verification only, following [Apple's code-signing guidance](https://developer.apple.com/library/archive/technotes/tn2206/_index.html). The native audit inspects every object for ARM64, minimum-OS metadata, normalized bundled/system loader closure, symlinks and strict signatures, then verifies the outer bundle strictly and deeply. Absolute developer loader paths or unresolved non-system libraries fail the build.

Outputs include `signing.json`, `native-audit.json`, the complete `sha256-manifest.json`, and `preparation.json`. Failures retain a `failure.json` and partially prepared output for diagnosis; choose a new output for retry. Inputs are preserved. The resource/notice and native audits are mechanical checks, not R15 workflow acceptance or R18 release acceptance.

Read-only reinspection:

```sh
python3 scripts/packaging/audit_app.py \
  --app ../clipdeck-preview/ClipDeck.app --output ../native-audit-recheck.json
python3 scripts/packaging/audit_notices.py \
  --app ../clipdeck-preview/ClipDeck.app --output ../notice-audit.json
```

After acceptance, the publication owner can create a ZIP with `/usr/bin/ditto -c -k --sequesterRsrc --keepParent ../clipdeck-preview/ClipDeck.app ../ClipDeck-preview-macos-arm64.zip`. Preserve the app's modes, links and empty helper directory. Extract to a **new path containing spaces**, compare the complete payload manifest and run the strict signature/native/notice audits again before publication. Record the ZIP hash. These are repeatable input-checked recipes; bit-for-bit identity across different Apple signing/ZIP tool versions is not promised.

## Required acceptance separate from preparation

Use fresh app data and an empty HF cache for the first packaged run. Record the actual moved app's packaged resource resolver, secure BrowserWindow preferences, bridge capabilities, preflight and graceful close. Then perform a real media import, source preview, transcript/edit/export/reload, model download cancellation/recovery/reacquisition, and the whole workflow after model preparation with networking denied by the validated method. Keep the human-visible demo and artifact receipts tied to the final app/ZIP hashes.

The validated offline method combines fail-closed Node API guards, an owned rejecting Chromium proxy with DNS/loopback handling, before/after TCP/UDP/HTTP/HTTPS/WS/DNS canaries, worker-specific macOS outbound denial, and file/pipe-only media processes. It is **API-layer app network denial plus worker OS denial**, not a kernel denial of every syscall across the Electron tree. An outer Seatbelt denial broke normal Chromium nested sandbox initialization; `session.enableNetworkEmulation` alone allowed a negative-control request. Neither is an acceptable substitute. No global network or security settings are changed. Repeat the method on the actual final app and full workflow; startup-only prerequisite receipts do not satisfy it.

Model setup remains explicit. `Systran/faster-whisper-small` revision `536b0662742c02347bc0e980a01041f333bce120` is 486,212,372 bytes in four files. The optional `dropbox-dash/faster-whisper-large-v3-turbo` revision `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf` is 1,621,665,983 bytes in five files. Both upstream cards declare MIT; the fixed cards, Whisper MIT notice and exact ordered file pins/digests are retained in `packaging/notices/models/manifest.json`. The worker validates the chosen model against source-pinned hashes. Preparation tools do not download or bundle either model.

A public external probe preserves this audited method:

```sh
node scripts/packaging/offline_validation.mjs \
  --app "/PATH/WITH SPACES/ClipDeck.app" --output ../offline-method-next
```

Use Node 24. It creates fresh HOME/app-data/HF directories, injects the guard at the first paused packaged main line, retains stdout/stderr/NetLog, checks normal renderer security, repeats live canaries, proves proxy-stop failure, compares all bundle files/links/directory modes and verifies strict deep signatures before/after. `--emulation-only-control` performs the local-only negative control. The probe reports `workflowAcceptance: false` even when the method succeeds. The adapted public Electron entry point must be executed and reviewed against the final app; its new workflow-hook/manifest code is not accepted merely because the underlying prerequisite method passed.

For an actual full-flow run, provide `--workflow-module /PATH/TO/REVIEWED-WORKFLOW.mjs --timeout-ms 1200000`. The module exports an async default function receiving `{app, out, main, renderer, evaluate}` and returns saved artifact/interaction receipts. It must exercise the genuine UI/backend/native dialogs and retain real media/timing/export evidence. It must not replace backend methods, supply simulated success, weaken controls, or auto-select native dialog paths. The harness records deliberate before/after canaries separately from natural workflow network attempts and Node child launches. The rejecting proxy stays live during the workflow and is stopped only at the final control. Setup/cancellation/recovery is a separate online phase; choose the prepared verified local model explicitly through the real UI in the isolated profile. The workflow owner, not this harness, decides R15/R18 acceptance from complete receipts.

The Node wrappers allow the exact bundled FFmpeg/ffprobe paths through `spawn` and `execFile`, including the real media caller's `promisify(execFile)`. They forward arguments/options/environment unchanged, retain Node's `{stdout, stderr}`, error output and `Promise.child` behavior, synchronize builtin ESM exports, and account for each child launch. Shell execution, other executables, synchronous APIs and worker threads fail closed. The worker is allowed only through the exact OS-denied launch recipe. These wrappers do not intercept Electron's C++ helper launcher, `utilityProcess.fork`, arbitrary native fork/exec or helper grandchildren. The proxy is not a universal raw Chromium UDP/WebRTC or native-addon network boundary. Chromium's route-availability UDP connect can occur without a sent-byte event. New utility/native children or networking stacks require renewed inspection and extended controls. Debugger/proxy connections are owned local test channels. The guard is absent from executable app main/preload resources; the matching application-source archive may contain these inert test tools for reproducibility.

Tests for packaging boundaries: `python3 -m unittest discover -s tests/packaging -v` and `node --test tests/packaging/offline_guard.test.mjs` (Node 24). Run the repository's required tests/typecheck/build and real acceptance checks under the coordinated release window; do not infer completion from this guide.

## Rebuilding resource assets

The source companions contain the original CLI and maintained decoder build recipes and pinned upstream inputs. A deliberate resource upgrade requires rebuilding, inspecting loader paths, removing developer references, preserving/rebuilding full notices, recording a complete portable worker manifest and rerunning the native/offline/transcription prerequisite checks before updating any lock. Never replace a pinned asset silently.

The current source companions contain unchanged upstream source archives, full licenses and the neutral compiler/pkgconf wrappers alongside their actual new build recipes. The media recipe retains GPL/version3/x264, disabled networking and file/pipe-only protocols. The separately linked decoder recipe retains minimal PCM/WAV FFmpeg under LGPL, the PyAV local version suffix, pinned build requirements, relocation/RECORD regeneration and ad-hoc signing. `/opt/clipdeck-runtime` is a configure prefix; `DESTDIR` installs under the chosen source/build directory and does not install globally into `/opt`. Run from a new extracted companion on a Mac with Command Line Tools:

```sh
cd ../source-rebuild/clipdeck-media-corresponding-source
./build-media.sh
```

For the decoder, supply `BUILD_PYTHON` pointing to a cp312 interpreter with the companion's `build-requirements.lock.txt` installed, then run `./build-decoder.sh` from its extracted directory. The companion includes the unchanged upstream inputs, compiler wrappers and `normalize_wheel.py`; no developer installation is copied. Review and audit rebuilt outputs before updating any runtime lock. Upstream source archives remain unchanged; neutral configure/compiler paths are deliberate build changes, not metadata substitutions. Current native/loader/signature/offline-ASR prerequisite execution is attributed to the resource builder's recorded checks; final packaged execution remains required.

The media recipe's initial log-directory omission was repaired in the source companion itself. A fresh extracted supplied script created its log directory and entered pkgconf configuration before a deliberate bounded stop; no full native rebuild was repeated for that one mkdir correction. `resource-rebuild.json` records the sole changed source member, unchanged remaining members/flags and retained native identities.

The following diagnostic-only procedure is **historical 002 reproduction**, not the current locked asset route. `packaging/source-normalization.json` preserves the old identities/transforms and is excluded from the current resource metadata lock. Do not run this tool on the already-neutral 003 companions. The old procedure preserved all six upstream archives and parameterized only three media/four decoder diagnostics; it did not rebuild the binaries, which were subsequently superseded by the compiled 003 assets.

`packaging/source-normalization.json` records the historical original/public identities, per-member before/after hashes, byte-preserved members and all six upstream source digests. Each historical companion retains this receipt and `PUBLIC-NORMALIZATION.md`. The tool scans owned text and outer metadata for private paths, rejects unexplained remnants, retains member names/types/modes/links, and writes neutral outer owners and timestamps. It does not rewrite nested upstream archives or runtime binaries. The original archives remain preserved outside publication. To reproduce from those explicitly pinned historical originals, choose new outputs:

```sh
python3 scripts/packaging/normalize_sources.py \
  --role media --input ../original-assets/clipdeck-media-corresponding-source.tar.gz \
  --original-sha256 01d934a450828cae733f9c17d62f534525e4405fbf4ee81f998cf586b13c2105 \
  --output ../public-assets/clipdeck-media-corresponding-source.tar.gz \
  --receipt ../public-assets/media-normalization.json
python3 scripts/packaging/normalize_sources.py \
  --role decoder --input ../original-assets/clipdeck-maintained-decoder-corresponding-source.tar.gz \
  --original-sha256 742497d05084b1b97c1a113dd9fd0282ad2bce4e6188c4f45df22b1d90755001 \
  --output ../public-assets/clipdeck-maintained-decoder-corresponding-source.tar.gz \
  --receipt ../public-assets/decoder-normalization.json
```

Compare historical outputs to `source-normalization.json`, not the current lock. They are not current release assets. Current preparation uses the four exact 003 identities in `resources.lock.json` unchanged, and checks the complete current worker manifest and notice metadata. Keep old archives and receipts preserved when upgrading; never replace an asset silently.

The media runtime archive is reproducible from the reviewed executable pair:

```sh
python3 scripts/packaging/create_media_asset.py \
  --bin-dir /PATH/TO/REVIEWED/runtime/bin \
  --output ../clipdeck-media-runtime-9.0.2-macos-arm64.tar.gz
```

It includes only those two CLIs, sets stable archive ownership/timestamps, preserves executable modes and prints the asset identity. It does not compile or bless arbitrary binaries. Compare the identity against the reviewed lock. The worker's public provenance records its official standalone base, pinned dependency versions, maintained decoder and normalization. The existing verified worker archive is used unchanged; no old venv or superseded Python candidate is copied.

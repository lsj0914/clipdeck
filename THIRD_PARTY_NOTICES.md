# Third-party notices

ClipDeck application source and original branding artwork are licensed **GPL-3.0-or-later**; see `LICENSE`. Third-party components retain their own copyright notices and licenses. This file is an index, not a replacement for their full texts.

| Component | Release/revision | License and retained notice |
| --- | --- | --- |
| Electron / Chromium | Electron 44.5.1, official Darwin ARM64 ZIP | Electron MIT; complete `Electron-LICENSES.chromium.html` covers bundled Chromium components. Full texts copied from the pinned official distribution. |
| Mantle / ReactiveObjC | Electron DEPS pins `2a8e2123a3931038179ee06105c9e6ec336b12ea` / `74ab5baccc6f7202c8ac69a8d1e152c29dc1ea76` | MIT and all additional upstream credits retained under `packaging/notices/electron/`; provenance includes the exact Electron DEPS. |
| FFmpeg / ffprobe | 9.0.2 | This CLI build enables GPL, version 3 and x264; distribute under GPL-3.0-or-later. Full GPL text, upstream licensing explanation and x264 COPYING retained. Matching source, configure flags and recipe are bundled and must accompany release downloads. |
| x264 | `b35605ace3ddf7c1a5d67a2eb553f034aef41d55` | GPL-2.0-or-later; combined CLI uses GPL version 3. |
| Independent JPEG Group | Code incorporated by FFmpeg | This software is based in part on the work of the Independent JPEG Group. Copyright notices and terms remain in the matching FFmpeg source. |
| Standalone CPython | 3.12.15 / python-build-standalone 20261003 | Python-2.0/CNRI-Python and bundled library licenses, retained in `runtime/worker/licenses/PYTHON.json` and `licenses/python-base/`. The standalone build framework is MPL-2.0; its exact source revision and archive are identified in public worker provenance. |
| Maintained PyAV decoder | 16.0.1 + ClipDeck FFmpeg 8.1.2 | PyAV BSD-3-Clause; minimal dynamically linked FFmpeg LGPL-2.1-or-later, without GPL codecs. Full BSD/LGPL notices, corresponding source, modifications and rebuild/relinking inputs accompany the bundle. The old vendor PyAV wheel is not shipped. |
| Worker dependencies | 23 pinned dependencies + base pip | Individual MIT, BSD, Apache-2.0, MPL-2.0, PSF and other compatible upstream terms are recorded with exact full-text paths/hashes in `packaging/worker-license-inventory.json`. NumPy, ONNX Runtime and CPython retain their bundled component notices, not just a top-level license label. |
| Silero VAD | Required v6 ONNX asset shipped by faster-whisper | MIT; retained upstream notice under `packaging/notices/models/`. The asset hash is pinned in worker provenance and the worker script. |
| React / React DOM / scheduler | Versions resolved in package-lock.json | MIT full texts copied from installed reviewed packages; exact versions/hashes recorded in the final bundle notice inventory. |
| TanStack React Virtual / virtual-core | Versions resolved in package-lock.json | MIT, same retained full-text and final inventory policy. |
| Instrument Sans | fontsource-variable 5.3.0 | SIL Open Font License 1.1. Full package notice plus built renderer notice. |
| Noto Sans SC | fontsource-variable 5.3.0 | SIL Open Font License 1.1. Full package and upstream notices plus built renderer notices. |
| JetBrains Mono | fontsource-variable 5.3.0 | SIL Open Font License 1.1. Full package notice plus built renderer notice. |
| Optional Whisper small model | Systran/faster-whisper-small `536b0662742c02347bc0e980a01041f333bce120` | MIT; no model is bundled. Its upstream model card, the Whisper MIT notice and model file pins are retained for the explicit preparation flow. |
| Optional Whisper large v3 turbo model | dropbox-dash/faster-whisper-large-v3-turbo `0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf` | MIT; no model is bundled. The fixed upstream conversion card, Whisper MIT notice and five model file pins are retained in `packaging/notices/models/manifest.json`. |

The preview's `Contents/Resources/notices/inventory.json` records the full notices, font notices and corresponding-source archives actually included. `runtime/worker/` preserves the complete pinned license inventory. `packaging/resources.lock.json` pins asset identities and checked public metadata; the full application source archive must match the committed release source. Model files and user media are separate from the distributed app.

The current media and maintained-decoder resources were rebuilt with a neutral `/opt/clipdeck-runtime` configure prefix, relative include/library paths and compiler source/debug mapping to `/clipdeck-build`. No compiled-byte string patching was used. `packaging/resource-rebuild.json` records current archive identities, source/recipe inventories and independent archive-byte/license checks; all six upstream source inputs remain unchanged. `packaging/worker-wheel-inputs.json` retains the 23 pinned wheel inputs, including the rebuilt BSD decoder. `packaging/source-normalization.json` is a preserved historical receipt for the superseded metadata-only 002 candidate and is excluded from current resource inputs.

Build-only npm tools are not copied into the app; consult their installed package notices when distributing those tools themselves. No IBM Plex font is included in the current build. A changed dependency, asset or decoder requires a fresh notice inventory and source/license review before distribution.

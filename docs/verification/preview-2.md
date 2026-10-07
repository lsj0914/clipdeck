# Experimental desktop preview 2

[Release and exact downloads](https://github.com/lsj0914/clipdeck/releases/tag/v0.1.0-preview.2) · [Bounded verification summary](preview-2.json)

This is a technical preview for Apple Silicon Mac. The application and matching application-source archive are tied to `ded3e4d812cd77ad014d0290bbbf4ac052c81e8b`, with [unit/native CI passing](https://github.com/lsj0914/clipdeck/actions/runs/37604862084). Later documentation commits do not change the tested binary identity. It is ad-hoc signed, without Developer ID signing or notarization. Gatekeeper may reject the download; use the [exact-source development steps](https://github.com/lsj0914/clipdeck/blob/ded3e4d812cd77ad014d0290bbbf4ac052c81e8b/README.md#develop-and-verify) rather than disabling security protections.

## A project you can actually edit

Download `ClipDeck-USGS-demo-20261007.zip`, extract the folder, and open `USGS-first-response.clipdeck`. Keep its `sources` directory beside it. Three real filmed USGS interviews supply twelve passages in a chosen, interleaved order. The saved transcripts let you edit without another recognition run. The included `outputs/USGS-first-response-final.mp4` is the actual completed native export.

The separate [50-second desktop walkthrough](https://github.com/lsj0914/clipdeck/releases/download/v0.1.0-preview.2/ClipDeck-desktop-walkthrough.mp4) shows real navigation, playback and expanded inspection. It is a silent native capture from 623 actual screenshots over 50.03 seconds, resampled to 600 frames at 12 fps. It does not measure import or recognition speed.

Original footage is public domain according to the linked USGS source records. Credits and the original acquisition manifest are included in the demo. Original burned captions and logos were supplied with the footage; ClipDeck did not generate them. No endorsement is implied.

## Checks performed on this candidate

- Relocated application, strict bundle signatures and all 5,116 file/link/directory entries matched the packaged candidate.
- Native picker reopened the portable project with three ready sources and twelve cuts.
- Source/Assembly controls routed word and bottom-cut navigation to the selected video, preserving playing or paused state. The second assembled passage's first picture was compared with actual source and decoded preview frames.
- Expanded preview/Escape, compact-window navigation and loop boundary/pause cleanup were exercised.
- A same-content relink preserved transcripts and selections. A separate wrong-content replacement left two other sources ready, marked the affected source changed, and blocked preview/export. This was not a fresh equal-length-replacement or active-job mutation test.
- A synthetic one-second silent-audio file produced zero recognized words and could still create a manual 100–800 ms cut; an invalid range added nothing.
- Actual native export completed, was opened and played in the app, expanded/reduced, and returned to editing. Normal Cmd-Q exited with code 0.

The actual example file is 116.8 seconds, H.264 1920 × 1080 at 30 fps with 48 kHz stereo AAC. The production validator confirmed 3,504 decoded frames, 5,606,400 decoded/presented audio samples and canonical presentation timestamps. All original input hashes remained intact.

## Limits retained

This is not complete R01–R18 acceptance. No human listening/lip-sync review, recognition word-error rate, universal punctuation-quality claim or whole-Electron kernel network-denial claim is made. The example's English transcripts come from the earlier packaged recognition campaign; byte-identical processing/recognition workers and cached transcripts were reused for this candidate's navigation/export checks.

The current renderer has not received a fresh complete large-project performance campaign; [historical performance measurements](benchmarks.md) keep their original source identities. First assembly preparation still encodes the cuts and can take tens of seconds; cached previews are reused.

Packaged execution was checked on local macOS 27.0.1 ARM64. CI native checks ran on macOS 15.7.9 ARM64. A metadata floor of macOS 14 does not establish execution there; macOS 14, Intel Mac, Windows and Linux remain unverified.

The published files contain the curated public demo, application/source, silent walkthrough and bounded summary. Private recordings, projects, account data, model caches, raw desktop traces and machine-path receipts stay outside the public assets. Named private-path/media scans are scoped checks, not a universal secret-audit guarantee.

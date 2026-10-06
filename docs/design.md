# ClipDeck workbench

Implementation reference for the React desktop renderer. This records the accepted direction and implementation, not completed product acceptance. Full loaded-media visual review remains a release gate.

## Intent

The creator is working through local interviews, lessons, podcasts or talking-head recordings. They need to read, hear and keep passages, arrange them across sources and produce a playable rough cut. Reading leads; source provenance, boundaries and assembly remain visible. The interface should feel quiet and precise during repeated work.

The accepted field-note direction is expressed through selected passages, aligned time anchors and ordered cut references. There is no notebook costume, decorative timeline, fixture import route or marketing dashboard. Domain anchors are speech cadence, original recordings, word boundaries, retained passages, edit beats and assembly continuity.

## Work areas and hierarchy

| Area            | Intent and hierarchy                                                                                                                                       | Density                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Project toolbar | Project identity and saved state lead; Open/Save and history are secondary; export is the endpoint.                                                        | 64px height, 32px controls                              |
| Sources         | A narrow source list identifies recordings, duration and readiness; selected source has a tonal surface and ordinal cue.                                   | 208px at 1280px, 12px text, 8–16px spacing              |
| Transcript      | Principal reading surface. Seventeen-pixel speech text sits beside subdued twelve-pixel source time anchors; selected endpoints carry a one-pixel bracket. | 24px side padding, 1.75 line height, up to 70ch measure |
| Selection tray  | Inclusive source bounds and selected word count remain above the assembly; audition and Add are adjacent.                                                  | 76–84px height, 12px metadata                           |
| Monitor         | Source and Assembly are explicitly distinct modes. Media remains unadorned, with working seek, time and playback controls.                                 | 360px rail at 1280px, 16px inset                        |
| Inspector       | Boundary seconds remain editable and invalid values stay visible. Notes and audition refer to the selected cut.                                            | 12px labels, 14px inputs, 16px grouping                 |
| Assembly        | Project cutOrder is the actual sequence. One tile per cut, source identity, original range and duration; total uses canonical 30fps frame quantization.    | 192px at 1280×820; 240px cut width                      |
| Processing      | Model preparation and processing jobs have separate plain-language states, genuine progress, cancellation, retry and verified export reveal.               | Native controls and a scrollable nonmodal pane          |

## Tokens and assets

Surface depth uses subtle tonal steps with low-opacity dividers, without shadow effects. Source rail and toolbar share the workbench surface; transcript is one step brighter.

- `--workbench #1b2026`; `--reading #242a31`; `--raised #2e353d`; `--control #171c22`.
- `--ink #eef0f2`; `--quiet-ink #a9b2bc`; `--faint-ink #8d98a4`.
- `--select #e6b778` is reserved for selection and primary action; `--selection-fill #514535`.
- Playback `--play #9ab9d4`; failure `--error #f1a19a`; success `--success #b4cfb1`.
- Local Instrument Sans variable for Latin and Noto Sans SC variable for Chinese: both pinned Fontsource 5.3.0. Chinese glyphs and punctuation no longer depend on an unrelated operating-system font. Seventeen-pixel transcript text stays regular with 1.75 leading and modest positive tracking; ordinary controls remain 12–14px.
- Brand is 18px/700 with tight tracking; section titles are 600; the empty-state statement is 26px/550 with 1.22 leading (20px at minimum size). Compact toolbar and segmented controls use 13px/550, separating them from quieter regular-weight explanations. Project names keep bilingual text at the same baseline.
- Local JetBrains Mono variable, pinned Fontsource 5.3.0, supplies upright tabular timecodes, durations, ordinals and numeric boundary fields. Prose remains proportional. A real-window review rejected Geist Mono's visually sloping zero despite its verified Regular/zero-italic-angle metadata.
- All fonts use SIL OFL 1.1; complete distribution copyright/license files and Noto's upstream Adobe notice ship in `public/licenses/`, copied by Vite. `public/licenses/README.txt` records official upstream repositories and pinned packages. Font binaries are bundled by Vite from local dependencies; there are no remote stylesheets or font requests.
- Authored 24-unit SVG action icons share 1.6px round strokes; icons encode controls, never decorative scenes.
- Four-pixel spacing base; 5px controls, 6px grouped switches/cuts, 8px processing pane. Native buttons/selects/inputs keep keyboard behavior.

## Responsive desktop contract

At 1440×900, sources are 220px and monitor 380px, assembly 208px. At 1280×820 they are 208px/360px/192px. Under 1040px the sources become a toggleable rail and the monitor alternates video/inspector. At 1000×700 and 800×600, the assembly remains pinned at 168px, with essentials visible. This is a desktop editor with minimum 800×600; it does not claim phone support. A short viewport scrolls within the reading/monitor regions, rather than pushing assembly offscreen.

## Interaction and authority

The application consumes `window.clipdeck` only. Main owns assets, jobs, models, edits, history and save state. Test API doubles live only in `tests/renderer` and are never included in production. Rejections are plain `{code,message}` service errors, with focus moved to the visible error without scrolling the app shell.

Selection is based on immutable word IDs with inclusive chronological endpoints. Click seeks; Shift-click/Shift-arrow extends; pointer dragging selects; E adds. A fresh `crypto.randomUUID()` and authoritative transcript revision are bound before every add, including repeated selections. Groups of up to 36 words are virtualized; selection can span unmounted groups. Chinese adjacent words do not gain artificial display spaces.

Manual ranges use integer milliseconds from at most three decimal places of seconds, reject inverted/out-of-bounds input and retain failed input for correction. Silent sources start in this path. Cuts support dragging plus explicit earlier/later controls and Alt-arrow alternatives, removal and main-owned undo/redo.

Source audition stops at its selected out boundary. Continuous assembly uses only a completed native preview job whose project ID and revision match the current project; stale or unproven previews never become playable. Any needs-review cut blocks assembly preview/export. Export progress is a native job and completed results expose the native reveal action.

Transient transcription drafts are readable but cannot be added. Completed sources remain editable while another source processes. Cancellation/retry operate on actual jobs. Missing/changed source states expose relink and explain which cuts need reselection. Snapshot capabilities disable unfinished services honestly.

## Verification handoff

The renderer has interaction tests for seek/select/add, unique cut IDs/revisions, pointer and keyboard selection, audition boundaries, silent range validation, cut reordering and undo, service-error retry/focus, stale preview invalidation, partial transcription/cancel, concurrent source editing, persistence/relink calls and 1,000-word virtual selection. Assertions exercise behavior rather than copying CSS.

An actual sandboxed Electron run rendered empty and unavailable-capability states at all four desktop sizes, plus model setup and a genuine service rejection at 800×600. One real issue was repaired: error focus could scroll the whole shell and empty-state content could spill across assembly at minimum height. The confirming pass kept toolbar and assembly visible. The Impeccable detector returned exit 0 with no findings.

Remaining acceptance: imported real media, offline English/Chinese transcription, live word selection and source/assembly playback, save/reopen/relink, rendered export, loaded-state typography/overflow and an independent visual review after native services are integrated. Empty-state captures and DOM tests do not establish those outcomes.

## Review round 1 refinements

Unavailable sources clear their word selection, and the E command independently checks readiness. Selection-construction errors enter the visible service-error path. The virtual transcript viewport remains a keyboard entry point: focusing it restores a visible word without changing the retained selection.

The inspector now edits the cut label as well as boundaries and notes. Loop audition is explicit, repeats only within that cut's original-source interval, and stops when the source, view or inspected cut changes. It can be stopped directly. Its playback context is distinct from the continuous assembly.

Assembly playback maps its playhead through cumulative integer 30fps cut frames. A separate playback marker and source/time readout identify the current cut, while the inspector keeps its manually selected cut. Seeking and pausing retain that context; stale preview invalidation removes it.

Snapshot save/recovery failures appear in a persistent accessible alert independently of rejected UI commands. They expose Save a recovery copy and Open saved project through the native bridge; save-success announcements are suppressed until the returned snapshot clears the error.

## Review round 2 refinements

Source scrubbing cancels the entire audition and pauses it, while explicit Stop loop always pauses. Replacing an audition range first cancels the previous one. Pause events synchronize position only; paused media cannot restart through a time-update or animation-frame check. Repetition at the physical media end requires a genuine ended state. Pending metadata playback is disarmed when audition stops.

The transcript has one sequential keyboard entry: a mounted roving word, or the viewport while that word is unmounted. Viewport re-entry hands focus to a visible word and removes itself from sequential focus order, allowing both Tab and Shift+Tab to leave normally without changing selection.

Optional native batch import failures are shown per filename in an accessible alert, beside the successful imported sources. Choose videos again reopens the actual native import action; a mixed result is never presented as total success or total failure.

## Typography correction, October 6

The user's typography correction supersedes the earlier IBM Plex choice. Instrument Sans provides broader letterforms and a clearer title/brand voice; Noto Sans SC keeps the bilingual surface consistent across installations. Weight and rhythm change by role without scaling up the editor. Existing ink-gray surfaces, amber selection, layout, behavior and 17px transcript baseline remain in place.

The typography evidence uses real Electron 44 windows at 1280×820 and 800×600, real project edits, a generated local video imported through native services, a genuine partial-import failure, a bilingual manual cut, and a completed native Chinese transcription from a generated 13-second audiovisual fixture. Native dialogs are directed to explicit fixture paths by the test harness; the renderer bridge and service results are real. This verifies typography and local layout, not the human picker workflow or source/assembly playback and export acceptance.

## Source preview lifecycle

Selecting a ready source without a proxy requests native preparation once. The UI records request identity by project, asset and fingerprint, recognizes native job retirement or URL revocation during relink, and resets requests after successful open/relink. Existing queued/running jobs suppress duplicates, including repeated clicks on historical retry cards. Failed or cancelled work waits for explicit retry; a late response for another project never becomes the current error. Transcription and editing remain available while source conversion runs.

The monitor shows native stage/progress/cancellation and accessible failure/retry. Source video stays unplayable until a video-frame callback reports nonzero frame and element dimensions. Metadata, can-play events and successful audio decoding are insufficient. A 15-second frame wait exposes recovery; media errors require retry/relink. URL changes remount the element and clear old frame authority, audition and playhead state. A same-source word seek made before its initial proxy arrives is applied on metadata; audition waits for decoded readiness. An inspected cut from a different source switches the monitor before waiting for its frame.

DOM tests simulate frame callbacks and media events to verify lifecycle decisions. Actual frame delivery, paused poster decoding, playback/seek/loop timing and source protocol authorization remain native acceptance checks after one coherent build with the render service.

## Long passage labels

An assembly card, its accessible name and tooltip render at most a 180-character excerpt (plus an ellipsis), while native cut text and word IDs remain intact. Inspector labels over 512 characters show a 280-character summary and explain that the full text is kept. Read or edit full text explicitly mounts the full editor; Hide full text returns to the summary. Short labels retain their immediate input. Saving boundaries or notes retains the original full label, and the expanded editor accepts the same five-million-character maximum as the existing domain contract.

This bounds incidental text shaping when a huge passage is added. The measured 50k-word performance gate still requires the unchanged native fixture and finite three-process benchmark; the DOM regression does not establish a latency improvement by itself.

Font assets are never inlined: Vite's `assetsInlineLimit: 0` keeps even small Unicode subsets as local WOFF2 files. CSP explicitly permits fonts from `'self'` only; the existing registered `clipdeck-media:` media source remains unchanged. Actual combined desktop smoke verifies the local-font build without font CSP errors.

## Source integration review refinements

Deferred cut audition is checked against the current canonical cut before playback. Changed bounds, source identity, review status or a newer seek cancel that intent; the normal source transition can still wait for its first decoded frame. Retrying a background source reconciles that target's published job before checking its request guard, so a second terminal failure/cancellation can be retried without selecting that source. Unpublished requests and active native jobs still suppress duplicates.

The long-text disclosure remains one mounted button while its editor expands/collapses. Hiding the editor therefore retains keyboard focus, with `aria-expanded` and `aria-controls` describing the controlled region; opening still focuses the text editor.

## Task 7: reading through delivery

The Instrument Sans / Noto Sans SC / JetBrains Mono ink-and-amber workbench remains the visual foundation. The repair changes operation order and available working space rather than adding a new visual theme.

The reading pane now has a fixed heading, source/script view switch, a bounded body and an in-flow contextual selection tray. That tray exists only for an actual editable text selection. Empty assemblies use 90–94px; populated assemblies use 148–154px. Sources become a workspace-relative drawer below 1100px, so error banners cannot leave it anchored to the old toolbar offset. Manual ranges have their own scrolling body and no irrelevant text-selection tray. Seventeen-pixel text, smaller paragraph gaps, narrower utility rails and contained portrait video preserve reading space. These are implementation dimensions, not a claim that the new four-size desktop inspection has passed.

Transcript paragraphs follow existing sentence punctuation and verified pauses, with bounded continuation chunks for long unpunctuated passages. Word IDs and timestamps stay intact. Search indexes the continuous displayed wording and maps a phrase back to its original word range; match navigation and editing selection are separate. Select match is explicit, as are Select all text and double-click paragraph selection. Dragging at a viewport edge keeps scrolling until release; vertical keyboard movement targets the closest word on the next rendered line and retains the virtualized focus entry behavior.

EN/中文 interface preference starts from the system language and persists locally. It is independent of each source's recognition language and vocabulary. Native diagnostics and native processing-stage details remain verbatim, alongside localized actions. Source transcription settings show the verified current model separately from the available model catalog, download size when supplied by native services, and the small/turbo memory tradeoff without an accuracy promise. Per-source language/vocabulary and unpublished request guards survive source and reading-mode switches. Existing text remains editable until native re-recognition succeeds.

Correct text opens the selected words as individual timestamped fields, up to the native 1000-word bound. It sends only changed text with current source fingerprint, transcript revision and original IDs; English leading separators are retained. The panel explains that sound and timing stay unchanged. Rejection preserves the input and selection. Corrections do not reset source position; a new ASR origin does. Native correction/history owns derived label updates, custom label preservation and undo/redo.

Inspector drafts are retained per cut across navigation. Save and keyboard Save validate and apply all drafts before native persistence; failures keep unapplied input visible. Opening another project with drafts also requires successful persistence first. Drafts do not accidentally replace newly corrected derived text when only a note or boundary was changed. Explicit Apply remains undoable. Boundary fields display MM:SS.MMM and also accept seconds, with use-playhead and 33ms nudges. Audition of an unapplied inspector draft is disabled until Apply/Save.

Assembly script presents full cut-order text in measured, virtualized 800-character chunks without truncating saved text. Cut selection stays in script mode; View in source is explicit. Position editing supports moving a distant cut without repeated arrow clicks. The compact bottom sequence still supports drag and keyboard ordering. Add feedback is visible and offers Undo.

Source URLs supplied by native services are tried directly. Readiness needs a nonzero decoded frame and a completed current-element seek; metadata and canplay alone cannot enable transport. Decode errors or the 15-second verification deadline request one compatible source preview per identity, and stale frames/auditions are retired. An attempted or failed proxy cannot trigger an automatic normalization loop; retry and native job cancellation remain explicit. Text editing does not depend on preview readiness.

Export opens a summary of actual cut count, canonical duration, output dimensions, 30fps MP4/H.264/AAC and fit-with-bars behavior before the native destination picker. Drafts are committed before preview/export. Only a completed native export's approved URL can enter the finished-video viewer; native Reveal supplies the actual filename/location. Saving a project visibly explains that it references, rather than embeds, the original media.

Task 7 review round one tightens the asynchronous boundaries. Open checks canonical unsaved/error state after applying drafts, so cancelling or failing Save cannot remove the obligation on a second attempt; any new draft accepted while that save is pending blocks navigation and remains visible. Correction fields and their close/reopen controls follow the same busy contract as inspector edits while Apply is pending. Export validates/applies drafts before presenting a summary captured from the resulting project revision; later edits invalidate that review and require Update export summary before the native destination picker can open.

Task 7 review round two exempts only the untouched initial workspace from Open's automatic save requirement: revision zero, native default name, no assets/transcripts/cuts/order, never saved, no recovery/error and no undo/redo history. Native storage may label this initial state dirty before any user edit. Meaningful renamed, imported, edited, recovered or error states retain the canonical save guard.

Task 7's derived text uses one shared token-boundary rule for source reading, phrase search and newly added cuts. Explicit token whitespace is preserved; unspaced Han boundaries stay continuous, punctuation joins its neighboring word, and ordinary Latin words receive a single missing separator. Derived labels trim outer whitespace only. Original token text, IDs and time anchors remain unchanged; existing custom labels are rendered and edited exactly as authored. New cuts declare their derived text origin so correction synchronization can distinguish them from custom titles. Assembly mode names its heading as Assembly script/成片稿; script editing and correction fields follow the interface locale, and one selected word/cut uses singular English copy.

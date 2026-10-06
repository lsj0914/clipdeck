# ClipDeck

<!-- impeccable:product-schema 1 -->

## Platform
web

The interface is React rendered inside an Electron desktop application. The first verified distribution target is macOS ARM64; it is not a hosted editor.

## Users
The accepted product design targets interview, podcast, lesson and talking-head creators making a rough cut from several local recordings. This audience is a product hypothesis, not a claim of completed customer research.

## Product Purpose
Import a creator's own videos, transcribe locally, choose meaningful speech, assemble selections from multiple sources, audition and adjust boundaries, then export an actual playable MP4. The user's goal is a substantial public open-source project with the quality and adoption potential to earn 500+ stars; that number is not guaranteed.

## Positioning
The proposed adoption case is a coherent multi-source editing workflow with matching preview/export, offline English and Chinese transcription, recoverable projects and reproducible correctness evidence. Local text-based editing already exists in other products. No first, unique, faster or easier claim is established.

## Operating Context
Creators read transcripts while checking original footage and continuously arranging a rough cut. They need their own media, familiar desktop file dialogs, persistent projects, word time anchors and explicit source versus assembly playback. Model preparation is a distinct first-run activity; later processing stays local.

## Capabilities and Constraints
The binding requirements are R01–R18 in docs/superpowers/specs/2026-10-06-clipdeck-design.md. Planned capabilities include multiple real-media import, local model preparation, offline transcription, manual cuts for silent sources, word selection, reorder/undo, adjustable in/out points, matched continuous preview, three output aspects, cancellable jobs, save/reopen/relink and recovery. Implementation and packaging remain in progress; this file does not claim these already work.

Project files reference original media rather than containing it. Source changes invalidate old selections. Renderer APIs are restricted; main process owns paths/jobs. Export completion requires validated output and atomic commit. The first release excludes cloud accounts, automatic viral-clip scoring, elaborate effects, collaboration and professional project-format export.

## Brand Commitments
Name: ClipDeck. The accepted spec sets a restrained ink-gray workbench with transcript as the principal reading surface, original video and inspector adjacent, a narrow source column and an always-visible assembly strip. State and selection have both shape/label and color cues. Copy should name the user's action plainly, with no fabricated usage, customer or benchmark claims.

## Evidence on Hand
Actual development tools and local English/Chinese transcription readiness have been exercised. Product acceptance evidence is still being produced. Generated speech fixtures are labeled synthetic. Downloaded recorded test speech has separate provenance and does not imply a filmed creator interview or permission to redistribute every sample.

## Product Principles
1. Start with the creator's own input and keep a complete import-to-export path.
2. Preview and export use the same deterministic edit plan.
3. Explain missing media, model and processing failures with an actionable recovery.
4. Treat saved files, decoded outputs and actual installation as completion evidence.
5. Make repeated editing fast and keyboard accessible.

## Accessibility & Inclusion
English and Chinese transcripts; visible focus, keyboard alternatives to dragging, reduced motion, long-name/text resilience and useful empty/error states are required by the accepted design.

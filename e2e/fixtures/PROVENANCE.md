# Battery fixture provenance

These files are the deterministic media the UI battery uploads through the
media bin's file input. They were moved here from `public/samples/` in 0.18.0,
when the app's "Load sample media" affordance was removed.

| File                | Size    | Origin                                                                 |
| ------------------- | ------- | ---------------------------------------------------------------------- |
| `sample-video.mp4`  | 620 KB  | Not recorded. No git history, metadata, or license note survives.       |
| `sample-audio.mp3`  | 97 KB   | Not recorded. No git history, metadata, or license note survives.       |
| `sample-image.png`  | 112 KB  | Not recorded. No git history, metadata, or license note survives.       |
| `editor-parity.veproj.json` | 6 KB | Project fixture created for the editor-parity battery step.             |

The repository history and the files' metadata do not record where the three
media files came from, so no license is claimed. They are kept because the
locked 0.18.0 decision is to keep the existing battery fixtures rather than
replace them. If provenance is supplied later, record it here.

The 15-minute climbing video used for manual preview, split, and drag
performance checks is not committed and is not part of this fixture set.

# Flows — Web Video Editor

The behavior contracts for each user flow. These are the things that must stay true when the code
changes; [architecture.md](architecture.md) explains the machinery behind them, and the entries in
[testing.md](testing.md) lock them down. Sibling docs: [docs index](README.md) ·
[structure.md](structure.md) · [design-system.md](design-system.md) · [deployment.md](deployment.md).

Stable hooks used across flows and tests:

- `[data-testid="preview-canvas"]`, `[data-testid="time-display"]`, `[data-testid="play-pause"]`
- `[data-testid^="clip-"]`, `[data-testid="clip-link-badge"]`, `[data-testid="clip-context-menu"]`
- `[data-testid="track-insert-line"]`, `[data-testid="track-insert-label"]`
- `[data-testid="text-drag-outline"]`, `[data-testid="linked-av-hint"]`
- `[data-testid="track-header-<id>"]`, `[data-testid="track-context-menu"]`, `[data-testid^="track-menu-"]`
- `[data-lane-kind]` on each lane and `[data-track-row]` on the newly inserted row
- `[data-drop-blocked="true"]` — a lane marked as an illegal drop target for the duration of a drag
- `[data-timeline-scroll]` — the timeline's scroll container
- Panel ids `panel-media`, `panel-preview`, `panel-inspector`, `panel-timeline`
- Drag payloads `application/x-media-id` and `application/x-media-kind-<kind>`

## Import media

- The media bin accepts multi-file selection, OS drag-and-drop, and **Load sample media**, which
  fetches the three bundled files from `/samples/*`.
- **Idempotent samples.** Loading samples never duplicates: `filterNewSamples` drops names already in
  the bin, a re-entrancy ref blocks double clicks, and the button disables + spins while importing. If
  nothing is new, it toasts "Sample media already loaded".
- Import probes duration/size, generates a JPEG thumbnail (≤160 px), decodes audio for waveform peaks
  (`WAVEFORM_BUCKETS = 1000`) and records `hasAudio`.
- Removing an asset leaves clips with a dangling `mediaId`; they render as offline and can be relinked.

## Place media on the timeline

- **Quick-add (`+`)** appends the clip at the end of the timeline on a compatible track.
- **Drag from the bin onto a lane** drops the media on that track.
- **Drag onto a row edge (12 px) or below the last track** shows a kind-coloured insertion line plus a
  `+ V2` / `+ A2` preview label and inserts a **new track at that exact z-position** (`addTrack` with
  `atIndex`, skipping the convention sort). The drop is one undoable `[addTrack, addClip]` batch.
- The ruler zone and the sticky header column never show a drop indicator.
- Dropping a video **with audio** places two clips sharing a `linkId` — see [A/V links](#av-links).

## Select, link, and razor

- Plain click selects a clip's link group; **Shift+click adds** another group; **Ctrl+click toggles**;
  **Ctrl+A** selects all; **Ctrl+Shift+A** deselects.
- The status bar reads "N clips selected"; linked clips show a link badge and both halves highlight.
- **Right-click** a clip for the context menu (Cut, Copy, Paste at playhead, Split at playhead,
  Duplicate, Link, Unlink, Ripple Delete, Delete). Right-click keeps an existing multi-selection.
- **Ctrl+L** is a smart toggle: unlinks when the selection is linked, otherwise links it. `Link` needs
  ≥2 non-text clips from ≥2 distinct groups.
- **Razor tool (`C`)** cuts the clicked clip's group exactly at the pointer; `V` returns to select.

## Edit clips

- **Move** — drag a clip within its lane or across compatible lanes; the whole selection moves with the
  same time delta (and the same track-index offset per partner where compatible). One drag = one undo
  entry (transient gesture). The gesture follows the pointer across as many lanes as it visits, because
  its listeners live on `window` rather than on the clip element: a clip that changes lane is re-rendered
  inside the new lane's list, and the remount used to destroy the drag at the first lane it crossed.
- **Reaching a lane** — holding a dragged clip within 24px of the top/bottom edge of the track area
  scrolls the timeline (1px → 14px per frame with depth), so a lane that is not among the visible rows
  can still be reached and dropped on.
- **Refused drops** — dropping a clip over a lane of the wrong kind marks that lane
  (`[data-drop-blocked="true"]`) while the pointer is over it and toasts the reason on release, instead
  of snapping back silently. The document does not change.
- **Empty lanes do not linger** — the edit that takes a lane's last clip removes the lane with it, in the
  same history entry, so one undo restores both. A lane that was already empty is kept, and the last lane
  always survives ([architecture.md](architecture.md#invariants), rule 17).
- **Trim** — drag either edge; video/audio clips are bounded by their source (the `inPoint + duration ≤
asset.duration` invariant), images and text are unbounded.
- **Split** — `Ctrl+K` (Add Edit) splits every clip the playhead crosses; with a selection it splits
  only the selected groups. Both halves of a link group re-pair with a single fresh `linkId`.
- **Duplicate (`Ctrl+Shift+/`)** copies the group butt-to-tail with an independent fresh link.
- **Delete** removes the whole link group; **Ripple Delete (`Shift+Del`)** also closes the gap on each
  affected track (merged removed intervals, so crossfade overlaps never double-count).
- **Snapping (`S`)** toggles snapping to clip edges, the playhead, and timeline bounds
  (`SNAP_THRESHOLD_PX = 8`).

## A/V links

- A video with audio lands as a linked pair: video part on a video track, `audioOnly` twin on an audio
  track (waveform included). The engine shadows the video part's embedded audio while the twin exists,
  so there is **no double audio**.
- The pair selects, moves, splits, duplicates, deletes, cuts/copies/pastes as one unit. `Ctrl+L` or the
  context menu unlinks, after which each half is independent.
- The inspector shows a "Linked with the audio clip…" hint and routes gain/mute to the twin.

## Crossfade

- The inspector's crossfade switch adds `transitionOut` to the clip and pulls the next clip left to
  overlap; durations clamp to `TRANSITION_MIN..TRANSITION_MAX` and to the available overlap.
- The video dissolve and audio ramp use the same linear alpha math and stay in sync.
- Removing the transition only clears the flag; the overlap remains (the later clip wins visually).

## Text overlays

- `T` adds a text clip at the playhead on a text track; content and style (size, colour, family,
  bold/italic, alignment, position, shadow) are edited in the inspector.
- **Drag the text in the program monitor** to reposition it: a dashed outline
  (`[data-testid="text-drag-outline"]`) shows the box, one drag is one undo step, and the geometry is
  measured by `measureTextBox`, the twin of the compositor's renderer.

## Layers, opacity, and playback

- New tracks stack by convention (text → video → audio); the newest track of a kind appears above the
  older ones. Any explicit `atIndex` placement is honoured verbatim.
- Adding a layer scrolls the track area by exactly the height of the inserted row, cancelling the shift
  it would otherwise push onto the lanes below — the browser clamps it, so a timeline that still fits
  does not move at all. Without this, the lane holding your clips scrolled out of view and the new layer
  looked unusable.
- **Managing a layer** — right-click a track header (or double-click its name) for Rename Track…, Mute/
  Unmute Track and Delete Track. Delete is disabled while only one lane remains, because the model
  forbids removing the last track. Rename takes focus when it is chosen from the menu, so the name you
  type goes into the field rather than being swallowed by the closing menu.
- Per-clip **opacity** (0–100 %) multiplies with crossfade alphas, so a clip on a higher track blends
  through to the track below.
- **Play / pause (Space)**, `J`/`K`/`L` shuttle (browsers cannot play backwards, so `J` stops like `K`),
  frame stepping, Home/End, and Up/Down edit-point navigation. Transport state mirrors into
  `[data-testid="play-pause"]` and `[data-testid="time-display"]`.
- Scrubbing while paused re-seeks active video elements and redraws once `seeked` lands.

## Export

- `exportTimeline` runs a dedicated `PlaybackCore` on an offscreen canvas, captures
  `canvas.captureStream(fps)`, taps audio from a `MediaStreamAudioDestinationNode`, and encodes WebM
  via `MediaRecorder` (`vp9,opus` → `vp8,opus` → `video/webm` → `video/mp4`).
- The dialog shows progress, supports cancel, previews the result (`export-result-video`), and
  downloads `<project name>.webm`.
- Known limitations: rendering is 1× real-time, and Chrome omits the WebM `Duration` header (the file
  plays fine — see [README](../README.md)).

## Save, load, autosave, restore

- **Save (`Ctrl+S`)** serializes to `.veproj.json` (version 1) and downloads it; object URLs are
  stripped and never persisted.
- **Open** hydrates every asset with `missing: true`; relinking is automatic on a matching re-import or
  manual per asset.
- **Autosave** writes to `localStorage` (`web-video-editor:autosave:v1`, 800 ms debounce) after each
  settled change; transient drag frames are skipped.
- On startup a valid autosave raises a banner: **Restore** replaces the doc (undoable) or **Discard**
  clears it.

## Workspace and menus

- Every panel is resizable and collapsible; sizes and visibility persist across sessions
  (`src/lib/editor/workspace.ts`), and a corrupt stored layout is sanitized instead of crashing.
- The menu bar mirrors Premiere Pro's menus with **no dead items** and **no fake shortcuts**: item
  enablement is computed from editor context, and the shortcut column only lists wired keys.
- Below 768 px the workspace falls back to a fixed stacked layout.

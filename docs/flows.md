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
- `[data-testid="marquee-rect"]` (the live box while a marquee drag is in flight)
- `[data-testid="sequence-marker"]` / `[data-testid="clip-marker"]` (with `data-marker-id`,
  `data-marker-time`, `data-marker-selected`), `[data-testid="marker-dialog"]`,
  `[data-testid="marker-context-menu"]`, `[data-testid^="marker-menu-"]`
- `[data-testid="track-header-<id>"]`, `[data-testid="track-context-menu"]`, `[data-testid^="track-menu-"]`,
  and `data-targeted` on the header ("true" / "false")
- `[data-lane-kind]` on each lane and `[data-track-row]` on the newly inserted row
- `[data-drop-blocked="true"]` — a lane marked as an illegal drop target for the duration of a drag
- `[data-timeline-scroll]` — the timeline's scroll container
- Panel ids `panel-media`, `panel-source`, `panel-preview`, `panel-inspector`, `panel-timeline`
- `[data-testid="source-panel"]` (with `data-selected-asset`), `[data-testid="source-preview"]`,
  `[data-testid="source-image"]` (stills), `[data-testid="source-time"]`, `[data-testid="source-mark-in"]`,
  `[data-testid="source-mark-out"]`, `[data-testid="source-clear"]`, `[data-testid="source-span"]`
  (with `data-invalid`)
- `[data-testid^="placement-mode-"]` (the sticky Place / Insert / Overwrite toolbar control),
  `aria-pressed` mirrors the active mode
- Drag payloads `application/x-media-id` and `application/x-media-kind-<kind>`

## Import media

- The media bin accepts multi-file selection, OS drag-and-drop, and **Load sample media**, which
  fetches the three bundled files from `/samples/*`.
- **Idempotent samples.** Loading samples never duplicates: `planSampleLoad` skips names already in the
  bin and online, overlapping loads share ONE run (single-flight), and every write re-checks the live
  bin (`sampleImportAction`), so a press landing while the fetches are still in flight cannot add a
  twin. A re-entrancy ref blocks double clicks, and the button disables + spins while importing. If
  nothing is new, it toasts "Sample media already loaded". A sample that is in the bin but **offline**
  is refetched and relinked in place, so the button is also the recovery path after a restore, when
  every asset hydrates without a URL. A batch stays bound to the project that planned it: opening or
  restoring another project mid-flight drops the rest instead of writing the old project's files into
  the new one.
- Import probes duration/size, generates a JPEG thumbnail (≤160 px), decodes audio for waveform peaks
  (`WAVEFORM_BUCKETS = 1000`) and records `hasAudio`.
- Removing an asset leaves clips with a dangling `mediaId`: the span renders black (the offline
  overlay names only assets the bin still has), the export refuses until it resolves, and undo is
  the recovery.

## LUT import (.cube)

- The Inspector's **Color grade** section loads a `.cube` per clip (picture clips only: a 3D cube's
  pass needs a decoded frame). Loading is ONE command batch: `importProjectLut` adds the file to the
  project's LUT library (one entry per unique import, referenced by `Clip.lutId`) and `setClipLut`
  assigns it, so the whole load is one undo step and a refusal writes nothing.
- The library budget is enforced by the command, not the UI: the base64 payloads may total at most
  `LUT_LIBRARY_MAX_CHARS` (3,000,000 characters, about 2.25 MB of binary). An import that would cross
  it is REFUSED with the current and projected sizes; it never warns-and-proceeds and never
  downsamples silently, because a proceed that later trips the localStorage quota costs crash
  recovery.
- Load-time hydration is a trust boundary, not an error path: a hand-edited or damaged file's
  malformed, oversized or over-budget entries are dropped and the load still succeeds. When at least
  one entry is dropped the loader logs ONE warning naming the count, so the library cannot shrink
  invisibly.
- A `LUT_1D_SIZE` file applies as three per-channel shaper tables in one SVG `feComponentTransfer`,
  referenced as `url(#lut-<lutId>)` BEFORE the clip's grade reference, and shared by every clip using
  it. A `LUT_3D_SIZE` file is not separable, so it may never take that path: it runs a trilinear
  pixel pass over the decoded source in BOTH the preview compositor and the exporter (one shared
  helper, resolving each grid's red axis into a reusable table so the pixel loop blends four corners
  instead of eight), ahead of the ctx.filter chain. A 3D cube contributes no filter reference at all, since a
  `url()` naming no mounted node would invalidate the whole filter string.
- `TITLE`, `#` comments, CRLF, `DOMAIN_MIN`/`DOMAIN_MAX` and the 0..1 float convention are handled; a
  missing or conflicting size, an out-of-bounds size, an inverted domain, a malformed row or a wrong
  row count is refused with a message the Inspector shows instead of loading a wrong table.

## Place media on the timeline

- **Quick-add (`+`)** appends the clip at the end of the timeline on a compatible track.
- **Drag from the bin onto a lane** drops the media on that track. How the drop lands is picked by
  the sticky three-way toolbar control (`dropMode`, session-only, never saved):
  - **Place** (default): today's plain drop. The pointed lane is used when it fits, otherwise the
    drop silently relocates to the first targeted compatible lane, the first compatible lane, or a
    newly created one. Nothing is displaced, so same-lane overlap stays legal (crossfades rely on it).
  - **Insert**: clips at or after the edit point shift right by the placement span, and a clip
    straddling the point splits there with its right half shifting. Link groups are always in sync:
    the affected-lane set expands through every group a shift or split touches, so a pair moves as one
    unit and split right-halves re-pair under one fresh `linkId`. A clip whose cut cannot respect the
    split headroom (either side at or under `MIN_SPLIT_HEADROOM` within the `+ EPS` band, the
    comparison rule's `length <= MIN_SPLIT_HEADROOM + EPS`) is left untouched with its group partners
    and the rest of the batch still commits (per-clip fallback, no toast).
  - **Overwrite**: the span `[at, at + span)` is replaced. Partial coverage trims the covered edge,
    interior coverage splits once at `at` then head-trims the right fragment (the kept fragment stores
    the POST-move source anchor), sub-`MIN_CLIP_DURATION` remnants are deleted with the clip, and fully
    covered clips go entirely (taking their lane with them, invariant 17). It is all-or-nothing: when
    a retained side cannot be represented (the left side sits at or under the split headroom, or the
    right side would land under the floor) or a trim would read past its source, the WHOLE placement
    is refused before anything is written, with one toast naming the reason. A placement span under
    the 0.1 s floor refuses the same way in both modes (one toast, nothing built).
- A **wrong-kind lane drop refuses** in Insert and Overwrite (one toast, nothing written) instead of
  relocating; Place keeps its documented fallback. Refusal precedence: an incompatible lane beats the
  mode, and an atomic placement refusal beats commit. Every refusal decides and toasts BEFORE
  `store.apply`, so a refusal never leaves a partial batch.
- **Drag onto a row edge (12 px) or below the last track** shows a kind-coloured insertion line plus a
  `+ V2` / `+ A2` preview label and inserts a **new track at that exact z-position** (`addTrack` with
  `atIndex`, skipping the convention sort). The drop is one undoable `[addTrack, addClip]` batch. This
  path still means "create a track": it does not honor `dropMode`.
- The ruler zone and the sticky header column never show a drop indicator.
- Every lane placement (any mode) applies as ONE command batch, so one undo restores the whole
  operation.
- Dropping a video **with audio** places two clips sharing a `linkId` — see [A/V links](#av-links).

## Three-point editing (Source monitor)

- Clicking a bin row selects it (`data-selected`, `aria-pressed`) and feeds the **Source Monitor**
  panel; selecting a different asset clears both marks and the source time, and removing the selected
  asset clears the selection. The panel's `<video>` element is a singleton: switching assets or
  unmounting the panel releases the previous element, so at most one is ever live. A still image has
  no source window and never attaches that element: the panel draws
  `<img data-testid="source-image">` itself, and its in/out controls and transport disable.
- `sourcePlayhead` is the ONE owner of the source time: the preview element's playback/seek callbacks
  write it, and the panel readout, the `I`/`O` marks and the placement range all read it, so panel,
  keys and marks cannot disagree.
- **`I` / `O`** mark In / Out at the source playhead (no-op without a source selection; ignored inside
  form fields like every other binding). Marks clamp to `[0, asset.duration]`; one-sided marks leave
  the other end open (in only: `[in, end]`, out only: `[0, out]`).
- **`,` (insert) / `.` (overwrite)** place the marked span (or the whole asset when unmarked) at the
  sequence playhead, independent of the sticky toolbar toggle. Lane resolution is the targeting rule
  (first targeted compatible lane → legacy compatible lane → create one). Images have no source
  window: the in/out controls disable and `,`/`.` place `DEFAULT_IMAGE_DURATION` (4 s). An inverted
  or sub-floor range (`out <= in`, or an effective span under `MIN_CLIP_DURATION - EPS`) is refused
  with one toast and places nothing. No source selected is a no-op.

## Select, link, and razor

- Plain click selects a clip's link group; **Shift+click adds** another group; **Ctrl+click toggles**;
  **Ctrl+A** selects all; **Ctrl+Shift+A** deselects.
- **Marquee (box) selection**: drag on empty lane space to select every clip the box covers, with
  each hit clip's A/V link group expanding as one unit. **Shift** adds the covered groups, **Ctrl/Cmd**
  toggles them, and a drag that crosses no clip clears the selection (replace mode). A click that
  never moves keeps the old deselect behavior; modifier clicks leave the selection alone. Pushing the
  box against the top/bottom or left/right edge auto-scrolls the timeline on both axes.
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
asset.duration` invariant), images and text are unbounded. A reversed clip keeps the same two-sided
  behavior: its head shows the span's HIGH source end and its tail the LOW one, so a head move holds the
  low anchor and a tail move holds the high one, and either edge reveals the source on its own side
  rather than sliding the picture under the drag.
- **Split** — `Ctrl+K` (Add Edit) splits every clip the playhead crosses; with a selection it splits
  only the selected groups. Both halves of a link group re-pair with a single fresh `linkId`.
- **Duplicate (`Ctrl+Shift+/`)** copies the group butt-to-tail with an independent fresh link.
- **Delete** removes the whole link group; **Ripple Delete (`Shift+Del`)** also closes the gap on each
  affected track (merged removed intervals, so crossfade overlaps never double-count).
- **Snapping (`S`)** toggles snapping to clip edges, the playhead, timeline bounds and every
  reachable marker (`SNAP_THRESHOLD_PX = 8`).

## A/V links

- A video with audio lands as a linked pair: video part on a video track, `audioOnly` twin on an audio
  track (waveform included). The engine shadows the video part's embedded audio while the twin exists,
  so there is **no double audio**.
- The pair's rate is a shared contract: change either half's speed and the engine drops the pair's
  audio (preview and export alike) until both halves run at the same effective rate.
- A twin whose media is gone still counts as the pair's sound carrier, so the pair stays silent until the
  asset returns.
- Deleting the twin while the video part remains hands the sound to the video part: its embedded
  audio plays in both preview and export. `Ctrl+L` unlinks rather than deletes; the kept twin stays
  audible, and both unlinked halves then play their own sources.
- Linking clips for convenience makes no sound contract: a manual link without a twin keeps every
  member's own audio and rates, and a kind-audio clip merged into a pair's group keeps its own sound
  even when the pair's halves disagree on rate.
- The pair selects, moves, splits, duplicates, deletes, cuts/copies/pastes as one unit. `Ctrl+L` or the
  context menu unlinks, after which each half is independent.
- **Targeting is the destination default for lane-less placements**: `Target Track` in the track
  header menu (an untargeted lane dims its kind icon) steers bin quick-add and Add Text to the
  first targeted compatible lane. Paste keeps a compatible original lane while that lane is
  targeted, and reaches the first targeted compatible lane only when the original lane cannot be
  used; when no lane of that kind is targeted the legacy landing order applies (original lane,
  then first compatible). Dropping onto a fitting lane or between rows, and duplicating a clip, keep
  the destination the pointer or the source lane gives them, and a video's audio twin follows the
  same rule. `Select Track Clips` takes a whole lane and expands A/V link groups.
- The inspector shows a "Linked with the audio clip…" hint and routes gain/mute to the twin.

## Markers

- `M` adds a marker: with a primary selected clip it lands on that clip in **source seconds**,
  clamped into its visible span, so a playhead before or after the clip still lands on screen; with
  no live clip selection it lands on the sequence ruler at the playhead (clamped to the sequence
  span).
- Click a marker tab to seek to it and select it; a marker selection and the clip selection are
  mutually exclusive. `Delete`/`Backspace` prefers the selected marker, `Escape` clears it. Dragging
  a tab moves it (one drag = one undo step, through the transient gesture protocol); a click that
  never moves only selects and seeks.
- Double-click a tab, use its context menu, or pick Marker › Edit Selected Marker… to open the
  dialog (name, one of eight colors, notes, delete). `Shift+M` / `Ctrl+Shift+M` seek to the
  next/previous reachable marker, never wrapping. Reachable means inside the sequence: the playhead
  cannot seek past the sequence end, so a marker beyond it stays visible and editable yet is not a
  target (the Marker menu greys that jump out). On an empty sequence that end is 0, so the marker
  `M` places (clamped to the span) sits exactly at the playhead and there is nowhere to walk.
  Markers that share a time are one stop: navigation is by time, so the extra tabs stay reachable
  by click.
- Markers are snap targets for clip moves and trims, and a dragged marker snaps to other clips'
  edges, the playhead and other markers (a clip marker never snaps to its own clip, whose edges it
  can never cross).
- A clip marker is anchored to its SOURCE time: trimming, rate-stretching or reversing keeps it on
  the same media frame. A trim that moves it outside the visible span hides it from the timeline
  while keeping it in the project, and extending the clip brings it back. A split gives both halves
  the full marker list, and each half renders only what its own span contains.
- Markers never affect playback or export (no burn-in, no chapter metadata).

## Crossfade

- The inspector's transition switch adds `transitionOut` to the clip and pulls the next clip left to
  overlap; durations clamp to `TRANSITION_MIN..TRANSITION_MAX` and to the available overlap. A type
  picker beside the duration slider switches the transition between cross-dissolve and dip to black.
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
  through to the track below. When opacity (or any animatable property) has keyframes, the curve
  replaces the static value during preview and export alike.
- **Keyframes and Effect Controls**: selecting a clip shows the Clip / Effect Controls tabs. Each
  animatable property row has a keyframe diamond (add/remove at the playhead), an easing picker that
  is always visible (on a property with no curve it stores that property's default easing for new
  keyframes), and, once animated, a light graph whose dots drag in time (one drag = one undo step).
  The graph draws every segment's real bezier shape, and the active segment carries two handles: a
  drag or the arrow keys shapes that segment's quad beyond the presets, one undo step per drag. The
  picker and the handles edit the active segment's start keyframe. Keyframe times are clip-local, so
  moves and duplicates carry their animation along and splitting redistributes the curves (exact
  for every easing: an eased segment carries the exact bezier data of its shape, and a cut
  subdivides that bezier with de Casteljau so both halves re-time the original). A head trim of a
  ramped clip rebases the curve the same way, so the kept span keeps reading the frames it read
  before the cut. A reversed clip's time-remapping row mirrors its axis (the value, the dots and
  the drawn curve all measure on the mirrored time `sourceTimeAt` reads, the handles and the picker
  edit the segment's start keyframe on that axis, and the diamond still targets the keyframe the
  mirrored playhead sits nearest), and the picture-only rows stay hidden for a clip that carries no
  picture.
- **Dragging a keyframe dot past its neighbour** keeps the segment's shape on its pair. A segment's
  easing lives on the keyframe that STARTS it, so a crossing re-homes the curve onto the new start,
  mirrored when the pair now runs the other way and named for the mirrored preset (`easeOut` reads as
  `easeIn`), while a pair that was not adjacent before starts linear. The dot under the pointer keeps
  following it across the swap, and the whole drag stays one undo step.
- **Rate stretch (Alt-drag a clip edge)** keeps the source span fixed and re-derives the speed from
  the new duration (clamped 0.25x to 4x); a clip left over-consuming a shorter relinked asset has the
  span clamped to the readable tail so the drag still applies (when even the minimum span cannot fit,
  the drag changes nothing and says why). The Inspector's Speed section does the same numerically and
  carries the Reverse toggle. A clip with a `timeScale` curve is skipped, because the curve (not the
  static rate) sets its speed: the drag falls through to a plain trim, and the Speed slider and the
  clip's speed badge stay off while the curve exists.
- **Play / pause (Space)**, `J`/`K`/`L` shuttle (browsers cannot play backwards, so `J` stops like `K`),
  frame stepping, Home/End, and Up/Down edit-point navigation. Transport state mirrors into
  `[data-testid="play-pause"]` and `[data-testid="time-display"]`.
- Scrubbing while paused re-seeks active video elements and redraws once `seeked` lands. Scrubbing
  while playing pauses playback first (Premiere behavior), so dragging the playhead can never inject
  a force-seek per pointer move into a running clock.

## Color scopes

- The preview panel carries a collapsible **Scopes** section (off by default), local to the panel:
  it adds no workspace panel id and no menu entry. Four meters read the MONITOR canvas, so what they
  show is what the user sees (grades, opacity and crossfades included) rather than the source frames:
  a luma histogram, an RGB balance read, a waveform and a vectorscope.
- The read is bounded twice. The monitor is drawn down into a scratch canvas of at most 256x144
  (`scopeSampleSize`), so the pixel read never scales with project resolution, and the interval runs
  at ~10 Hz instead of per frame. The waveform groups that sample by COLUMN (it walks the real row
  stride), the vectorscope bins it over the Rec.709 chroma plane into a 32x32 density grid.
- A tainted canvas (cross-origin media) must not throw into the render loop: the meters log once and
  report "Meters unavailable" instead. The interval keeps retrying while the banner is up, so a
  canvas that becomes readable again (a resize resets origin-clean, a relink removes the tainting
  media) recovers on its own, and closing the scopes, or a parent swapping the monitor node, resets
  the latch.
- Testids: `scopes-panel`, `scopes-toggle`, `scopes-meters`, `scopes-luma`, `scopes-balance`,
  `scopes-waveform`, `scopes-vectorscope`.

## Export

- `exportTimeline` (WebCodecs) executes the pure frame plan from `export/offline.ts`: per output frame
  it decodes the source samples (`VideoSampleSink`, frame-accurate, honoring speed and reverse),
  composites onto an offscreen canvas, and encodes H.264 through Mediabunny (`CanvasSource`).
- Audio is mixed in one `OfflineAudioContext` render (gain keyframes, pan, EQ, compressor, crossfade
  ramps) and encoded as an AAC track (Opus where the browser cannot encode AAC, notably desktop
  Linux and Firefox), so the file is an MP4 with a correct duration.
- The dialog shows progress, supports cancel, previews the result (`export-result-video`), and
  downloads `<project name>.mp4`. On browsers without WebCodecs it disables itself and says why.
- `Export to file` (Chromium/Edge only, behind a `showSaveFilePicker` probe) streams the same MP4
  straight to a file the user picks, through a `chunked: true` `StreamTarget`; the destination is
  committed only after the muxer finalizes and aborted on cancel or any failure, and the result view
  shows the saved name and bytes. The dialog also shows a size estimate and nudges to it past ~100 MB.
- Export runs offline (no realtime capture) and does not need tab focus; wall time tracks source
  decode speed. HEVC and ProRes are deliberately not offered: ProRes has no shipping browser
  `VideoEncoder`, and HEVC is left out on value grounds (an encoder exists, and a probe could gate it
  safely); see [README](../README.md).

## Proxies

- A video over 1920 px on its long edge can be transcoded to a session lower-resolution A/V stand-in
  (`View > Use Proxies`, the Media bin's build action, or the import prompt). The pure `proxy.ts`
  picks the dimensions (even, long edge capped at 1280) and the AVC bitrate; `media/proxies.ts` builds
  the MP4 with the mediabunny stack, preserving each source frame's timestamp and duration.
- The proxy carries the source's audio: the demuxed track decides, and a build that cannot decode it
  fails rather than shipping a silent proxy. The export always reads the original.
- While proxies are on, the media pool, the preview engine and the Source monitor resolve the effective
  URL, so a toggle or a finished build reroutes already-mounted elements without losing the source
  playhead. The URLs are session-only and revoked on relink, removal, File > New and project open.

## Frame blending at sub-frame rates (both render paths)

- A clip whose read is strictly below the source frame rate (a slowed clip, or a time-remapping ramp
  whose read crosses frame boundaries) gets a partner read one OUTPUT frame later. The decision is one
  shared function, `blendPartnerTime` in `frame-blend.ts`, so the export plan and the preview engine
  cannot disagree about which frame pairs with which: `planVideoFrame` carries it as `blendTime`, and
  the playback engine parks its blend element on it.
- The WEIGHT also comes from one function, `blendWeight`, over the pair's own timestamps. No nominal
  source frame rate is assumed anywhere: the exporter weights the two samples its decoder returned,
  and the preview weights the two frames its elements report they PRESENTED through
  `requestVideoFrameCallback`.
- Drawing is one routine, `drawBlendedContain` in `playback/compositor.ts`, called by the preview
  compositor and the exporter: both layers are graded (a 3D cube runs per layer, because the LUT
  scratch is reused) and composited ADDITIVELY over black into a scratch canvas sized to the drawn
  rect, and the result goes down once at the clip's alpha, filter and geometry. Two plain
  `globalAlpha` draws would attenuate each other rather than average.
- Every case where the pair cannot be trusted falls back to the single stepped frame the preview had
  before: a browser without `requestVideoFrameCallback`, a partner frame that has not decoded yet, a
  presented frame that is stale, ahead of its read, or replaced by a seek still in flight. A speed
  edit back to realtime releases the parked element.
- The monitor already draws the export's other rules through shared code (`drawContain` geometry, the
  shared filter string from `color.ts`, the shared 3D pass), and this closes the last one: a slowed
  clip looks the same in the program monitor and in the file.

## Compound clips

1. Select one or more clips on a video lane, then `Sequence > Create Compound Clip` (or the clip
   context menu). `commandsToCreateCompoundClip` builds one `createCompoundClip` command; the command
   verifies the selection is in one sequence, guards the cycle and depth limits, creates a new
   `Project.sequences` entry from the selected clips (rebased to local 0), removes the originals, and
   places the container on the selection's video lane (or the first video lane for an audio/text-only
   selection). One undo step.
2. Double-click the container to open its sequence; the timeline and preview switch to that sequence's
   tracks and a breadcrumb appears above the lanes. Click a crumb to jump back; `Project` returns to the
   root.
3. Editing inside a sequence is the normal edit set, scoped to that sequence's lanes. Deleting the last
   clip on a nested lane prunes the lane, EXCEPT when it is the sequence's only lane: at least one lane
   always survives (the same rule the root has), so a one-lane sequence keeps its lane after its last
   clip goes. Deleting the last container of a sequence prunes the sequence (and any descendants it
   alone reached) in the same committed history entry, so undo restores it.
4. The preview composites a compound as a group and mixes its audio through the container's gain/mute/
   volume curve; the export does the same, starting from the project root and never consulting the open
   path.

## Save, load, autosave, restore

- **Save (`Ctrl+S`)** serializes to `.veproj.json` (version 4; versions 1, 2 and 3 still load) and
  downloads it; object URLs are stripped and never persisted.
- **Open** hydrates every asset with `missing: true`. Bundled samples then refetch themselves
  (`hydrateSampleMedia(doc)`), which the restore path shares: their bytes are the app's own. The merge
  lands BEFORE the doc is installed, so the load is ONE undo step; relink commands applied afterwards
  would each push their own history entry, and one Ctrl+Z would drop a single sample back to offline
  and black out the preview again. Anything else relinks automatically on a matching re-import, or
  manually per asset.
- While the playhead sits on a clip whose media is offline, the monitor paints **Media offline** with
  the file names and a relink hint. The frame is genuinely black and silent; the overlay is what keeps
  that from reading as a broken preview.
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

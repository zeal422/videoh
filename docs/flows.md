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
- Panel ids `panel-media`, `panel-source`, `panel-preview`, `panel-inspector`, `panel-timeline`,
  `panel-captions`
- `[data-testid="source-panel"]` (with `data-selected-asset`), `[data-testid="source-preview"]`,
  `[data-testid="source-image"]` (stills), `[data-testid="source-time"]`, `[data-testid="source-mark-in"]`,
  `[data-testid="source-mark-out"]`, `[data-testid="source-clear"]`, `[data-testid="source-span"]`
  (with `data-invalid`)
- `[data-testid^="placement-mode-"]` (the sticky Place / Insert / Overwrite toolbar control),
  `aria-pressed` mirrors the active mode
- Drag payloads `application/x-media-id` and `application/x-media-kind-<kind>`

## Public entry and editor boot

- `/` is the public landing page. It has no preloader and no editor shell. The header, hero, and
  closing CTA link to `/editor`; the hero and CTA also link to the public GitHub source. The page
  composes the angled timeline hero, feature strip, product showcase, tools band, privacy panel,
  a visible FAQ, and the closing CTA.
- `/editor` renders `EditorBoot`. The preloader stays up for the client-only shell import plus the
  3.2s minimum show, then the editor appears. A rejected import shows Try again, and a second failure
  offers Reload page. The public route never mounts this boot.
- The public site and the editor share design tokens but not component trees. Public components do not
  import the editor store, media, playback, or export modules.
- The old password screen and login route are gone. There is no access cookie.

## Import media

- The media bin accepts multi-file selection and OS drag-and-drop. Import probes duration/size,
  generates a JPEG thumbnail (≤160 px), decodes audio for waveform peaks
  (`WAVEFORM_BUCKETS = 1000`) and records `hasAudio`.
- Import hashes the file (SHA-256) and writes the bytes to OPFS under
  `<project-id>/<content-hash>` with a MIME sidecar before the asset reaches the doc, so a saved
  project can restore it after a reload. A write failure (unsupported OPFS, quota, private mode)
  still imports the asset for this session, leaves `contentHash` unset, and warns with the file name.
- Re-importing a file whose name matches an offline asset relinks it in place instead of adding a
  twin. The relink patch is shared with the per-asset Relink button.
- Removing an asset leaves clips with a dangling `mediaId`: the span renders black (the offline
  overlay names only assets the bin still has), the export refuses until it resolves, and undo is
  the recovery.

## Filmstrips

- A mounted video or image clip asks the runtime cache for a strip after a 140ms debounce. The pure
  planner samples cell centers through `sourceTimeAt`, so trim, speed, reverse, and time remapping
  change the frames; a move or a same-bucket zoom reuses the cached key.
- One job runs at a time. Requests dedupe by key, queue FIFO, and a same-clip trim or zoom retargets
  its queued job in place. A relink, asset removal, or project replacement disposes the old strip and
  hidden element before React re-renders, and a stale job cannot install.
- The timeline root publishes `data-filmstrips-ready` only when every mounted request has settled (a
  poster fallback counts). No strip data enters the Doc, autosave, or the project file.
- Thumbnails are cached per asset and source time, so a split reuses the frames the other half
  already decoded and decodes only the missing cells. Only the visible tile of a long clip is
  generated, at layout density; an off-screen clip gets a bounded head tile. Per-clip and
  timeline-header progress bars show `Thumbnails 12/24` after 300 ms.

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
- **Dragging into empty space** resolves by the pointer's gap. A gap between two lanes of the dragged
  kind creates a track at that boundary; the dragged kind's own outer edge creates a track there; any
  other gap, including a mixed-kind gap, moves to the nearest compatible lane, or to the dragged
  kind's outer edge when no compatible lane exists. A row-edge (12 px) or
  below-the-last-track drop shows a kind-coloured insertion line plus a `+ V2` / `+ A2` preview label
  and inserts a **new track at that exact z-position** (`addTrack` with `atIndex`, skipping the
  convention sort). The drop is one undoable `[addTrack, addClip]` batch. This path still means
  "create a track": it does not honor `dropMode`.
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

## Select, link, and edit tools

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
- **Ctrl+L** is a smart toggle: unlinks when the selection is linked, otherwise links it. The Clip > Link
  menu row links or merges only; Unlink is explicit. `Link` needs ≥2 non-text clips from ≥2 distinct groups.
- **Razor tool (`C`)** cuts the clicked clip's group exactly at the pointer; `V` returns to select.
- **Ripple trim (`B`)** trims one clip edge and shifts every later clip on the SAME track by the
  same end delta. The edited clip's start stays anchored. A head trim changes the duration, and on a
  forward clip it also moves the in point; a reversed clip keeps its low in point anchor because its
  head shows the high source end. A tail trim changes only the duration. Linked partners on other
  tracks do not shift; this is the recorded Invariant 14 exception, and the toolbar tooltip says so. An existing
  transition overlap is preserved by shifting its partner with the same delta; any other overlap
  refuses. A locked lane refuses before the drag starts.
- **Slip (`Y`)** drags a clip body to change which part of its source it shows. `start` and
  `duration` never move; only `inPoint` changes. A linked pair that reads the same source window
  slips both halves by the same delta; a mixed-window group, a text/compound clip, an image, and a
  time-remapped clip refuse with a message. The readout shows the source in/out and the actual
  delta, and `data-in-point` exposes the value for browser proof.
- **Pen (`P`)** edits the selected clip's automation curve on the timeline. Audio clips expose
  volume; video, image, text, and compound clips expose opacity. Click the curve to add a point at
  the interpolated value, drag a dot to change its time and value, Alt-click or press
  Delete/Backspace to remove one, and use the arrow keys to nudge time by a frame or value by one
  step. The Pen never moves or trims the clip: body and edge presses only select. A selected clip
  shows a flat curve under the Pen; without it, opacity appears only when opacity keyframes already
  exist. A solo video with embedded audio edits opacity with the Pen while its volume dots stay
  directly draggable. Locked lanes refuse, and every gesture is one undo entry.

## Edit clips

- **Move** — drag a clip within its lane or across compatible lanes; the whole selection moves with the
  same time delta (and the same track-index offset per partner where compatible). One drag = one undo
  entry (transient gesture). The gesture follows the pointer across as many lanes as it visits, because
  its listeners live on `window` rather than on the clip element: a clip that changes lane is re-rendered
  inside the new lane's list, and the remount used to destroy the drag at the first lane it crossed.
- **Reaching a lane** — holding a dragged clip within 24px of the top/bottom edge of the track area
  scrolls the timeline (1px → 14px per frame with depth), so a lane that is not among the visible rows
  can still be reached and dropped on.
- **Refused drops** — dropping a clip over a lane of the wrong kind, or over a locked lane, marks that
  lane (`[data-drop-blocked="true"]`) while the pointer is over it and toasts the reason on release,
  instead of snapping back silently. A locked destination refuses the whole drop (partners included)
  and rolls back any earlier time shift from the same drag, like a locked source. The document does
  not change.
- **Empty lanes do not linger** — the edit that takes a lane's last clip removes the lane with it, in the
  same history entry, so one undo restores both. A lane that was already empty is kept, and the last lane
  always survives ([architecture.md](architecture.md#invariants), rule 17).
- **Ripple trim** — with `B` active, drag either edge. The same source bounds and rate-stretch
  decision apply, but the shift set is every later clip on the edited track. The clip does not move;
  its end does. A forward clip's head trim moves its in point; a reversed clip keeps that low anchor
  and lets the duration carry the change. A tail extension pushes the run right, a tail shrink pulls
  it left, a head shrink pulls the end left, and a head extension pushes it right. Later clips keep their mutual spacing.
  The planner commits the trim and every shift as one validated transient batch, so a refused
  shift writes nothing.
- **Slip** — with `Y` active, drag the body horizontally. The pointer delta is converted with the
  current px/s and the clip's speed, and inverted for a reversed clip. The command layer validates
  the source window against the asset and writes the whole linked group only when every member
  reads the same window.
- **Trim** — drag either edge; video/audio clips are bounded by their source, with the consumed source
  span (not the timeline duration) required to fit; a `timeScale` ramp that over-consumes is clamped
  to the last readable frame. Images and text are unbounded. A reversed clip keeps the same two-sided
  behavior: its head shows the span's HIGH source end and its tail the LOW one, so a head move holds the
  low anchor and a tail move holds the high one, and either edge reveals the source on its own side
  rather than sliding the picture under the drag.
- **Split** — `Ctrl+K` (Add Edit) splits every unlocked clip the playhead crosses; locked lanes and
  any link group with a locked member are skipped. With a selection it splits only the selected groups.
  Both halves of a link group re-pair with a single fresh `linkId`.
- **Duplicate (`Ctrl+Shift+/`)** copies the group butt-to-tail with an independent fresh link.
- **Delete** removes the whole link group; **Ripple Delete (`Shift+Del`)** also closes the gap on each
  affected track (merged removed intervals, so crossfade overlaps never double-count).
- **Close Gaps** shifts each clip on a track left over the empty time before it, transition-aware, so
  an overlap is never mistaken for a gap. Linked partners move by the same delta or the whole close
  refuses, and sequence markers stay at their absolute times. Menu and context entries only.
- **Join Clips** merges two adjacent same-source clips into one, keeping the previous clip's id and
  source window. It refuses anything it would have to reinterpret: a gap or overlap, a different
  speed or direction, a source discontinuity, an outgoing transition, any keyframe curve, text,
  compound, or a clip property that differs. Links join lane by lane or refuse whole.
- **Snapping (`S`)** toggles snapping to clip edges, the playhead, and every reachable marker
  (`SNAP_THRESHOLD_PX = 8`). The timeline end is not a clip-drag target: the dragged clip can define
  it itself, which would make the clip stick to its own tail.

## A/V links

- A video with audio lands as a linked pair: video part on a video track, `audioOnly` twin on an audio
  track (waveform included). The engine shadows the video part's embedded audio while the twin exists,
  so there is **no double audio**.
- The audio twin draws the waveform. A video-bearing clip never does, including an unlinked video
  half after `Ctrl+L`; that half keeps its filmstrip instead (0.18.0).
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

## Volume automation

- Volume is one existing keyframe curve, `clip.keyframes.volume`, evaluated by `animatedValue`. The
  envelope, the Effect Controls volume row, the Clip tab summary, and the shared graph are four views
  of that same data. There is no second automation store and no new keyframe property.
- The envelope appears on the clip that carries the sound. For a linked A/V pair that is the audio
  twin; the video half stays clean. A solo video with embedded audio shows it, while text, image, and
  compound clips without sound do not (a compound is checked through its sequence). A muted clip keeps
  its curve and dims it, so unmuting reveals the same automation.
- The curve is one `AutomationEnvelope` instance per property, a white line above the waveform and
  below the label and trim handles. It samples `animatedValue` every ~2px, so an eased segment draws
  its real shape. A selected clip with no volume curve shows a flat line; an idle clip shows nothing.
  Opacity is the same component on a picture clip, drawn 0..1, and appears without the Pen only when
  opacity keyframes already exist. The plot spans the full clip height (0.18.0), is inset 8px from the
  trim handles, and each visible 6px dot sits inside a 12px hit target; the dot center reaches the
  clip edge and the hit target is clamped fully inside the endpoints.
- A press on a dot starts no transient until the pointer moves 3px in screen space. A shorter
  press/release is a click. Once the threshold is crossed, vertical movement edits gain in dB
  (converted back to linear and clamped 0..2), horizontal movement edits time (clamped to
  `clip.duration`), a crossing re-sorts the array while the grabbed point follows the pointer, and the
  release commits one undo entry. A foreign commit ends the gesture; pointercancel restores the base
  document.
- Double-clicking the line adds a point at the interpolated value (the first point seeds the curve at
  the click time with the static gain). Alt-click removes a dot on release while under the threshold;
  a moved Alt-press neither removes nor drags. Delete/Backspace on a focused dot removes it, Left/Right
  nudge one frame, and Up/Down change gain by 0.5 dB. Razor, ripple, and slip make the whole envelope
  inert so the modal tool owns the pointer. The Pen keeps its target curve live: single-click add,
  crosshair over the line, and a solo video's volume dots remain directly draggable while opacity is
  the Pen curve. That dots-only volume overlay hides the volume line and leaves only its points, so
  the video never shows two curves at once.
- The Clip tab replaces the old linear Audio section with a dB Volume summary: the current level at
  the playhead, mute, the static gain slider, and the shared `KeyframeGraph` on the dB scale. The
  graph's dots, curve, and easing handles all read the same dB mapping, so a unity point sits on the
  0 dB line instead of halfway up a linear gain box. A selected video half targets its linked twin
  and labels which clip is being edited. The Effect Controls volume row uses the same dB readout and
  graph.
- Storage stays linear. The display domain runs from -60 dB to +6 dB, a gain at or below -60 dB plots
  at the floor and reads `-inf dB`, and rounding happens only in the formatter. The preview mixer and
  the export schedule still read `animatedValue(clip, 'volume', local)`, so an edit changes the same
  curve the engines play.

## Keyframe Pen

- The Pen is a mode, not a modifier. `P` selects it, the toolbar button shows the pressed state, and
  `Escape` returns to select only when no gesture is live. Ctrl/Meta-modified keys never reach the
  single-key tool map (the browser owns them), while Shift+letter shortcuts still do. A live drag or
  a pending automation press owns the tool: both the toolbar buttons and the keyboard wait for it.
  The active tool is session state and is not stored in the project.
- The property is structural: an audio lane or an `audioOnly` clip exposes volume; everything with
  picture, including text, image, a compound, and a solo video, exposes opacity. A visual clip that
  carries embedded audio still edits opacity with the Pen; its volume envelope is the direct-drag
  surface.
- A selected clip shows its curve even with no keyframes, so the first point can be added. A click on
  the 10px line hit path adds one point at the clicked local time with the curve's interpolated
  value; an existing point within one frame of the click is replaced at its own time, and a
  double-click does not add a second point or a second undo entry. A dot drag
  changes time and value, clamps to the clip and the property's bounds, re-sorts a crossing, and
  commits one undo entry. Alt-click removes on release while under the 3px threshold; a moved
  Alt-press neither removes nor drags. Delete/Backspace removes the focused point, Left/Right nudges
  one frame, Up/Down changes volume by 0.5 dB or opacity by 5%.
- The Pen never moves or trims. A body drag only selects, an edge drag only selects, and the trim
  handles fall back to the default cursor. Shift and Ctrl selection modifiers keep working. A locked
  lane refuses the add, drag, removal and keyboard edits before anything is written. Pointercancel
  cancels a live drag or a pending Alt-click removal and leaves the document unchanged.
- The overlay is pointer-transparent except for its dots and line hit path, so empty clip space still
  selects the clip, the label stays readable, and the z-10 trim handles win any overlap. On a solo
  video under the Pen the opacity curve is rendered first and the volume dots second, so a volume dot
  keeps pointer priority while the line belongs to opacity.

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
  picker beside the duration slider switches the transition between cross-dissolve, dip to black, wipe,
  slide and push; the spatial types add a direction picker, and wipes add an edge picker plus a feather
  slider for feathered edges.
- The video dissolve and audio ramp use the same linear alpha math and stay in sync.
- Removing the transition only clears the flag; the overlap remains (the later clip wins visually).

## Text overlays

- `T` adds a text clip at the playhead on a text track; content and style (size, colour, family,
  bold/italic, alignment, position, shadow) are edited in the inspector.
- **Title presets** reuse a style across clips: the Inspector's Presets section applies a built-in
  (Title, Subtitle, Lower third, Caption) or a saved preset, saves the selected clip's style under a
  new name, and renames or deletes user presets. The Add Text toolbar picker births a clip already
  styled. Presets live on the project, so they save and load with the file.
- **Drag the text in the program monitor** to reposition it: a dashed outline
  (`[data-testid="text-drag-outline"]`) shows the box, one drag is one undo step, and the geometry is
  measured by `measureTextBox`, the twin of the compositor's renderer.
- **Font picker (0.25.0).** The Inspector's Font control lists the built-in system families first,
  then the project's uploaded fonts by display name. Selecting writes `TextStyle.fontFamily` through
  `setTextStyle`; the generated family string is the reference, so a later rename changes only the
  label.
- **Font upload (0.25.0).** The upload dialog accepts WOFF2, WOFF, TTF, or OTF up to 8 MB. The file
  is checked by extension and header, hashed, and staged as a `FontFace` that must load before the
  entry commits. The bytes are written to the OPFS `fonts/<hash>` namespace and the font entry plus
  the clip's family are applied in one command batch. A staging, parse, or store failure toasts and
  leaves the project untouched; a project change during the upload discards the staged face. Opening
  or switching to a project loads its fonts in the background and repaints the monitor once they
  land; export awaits `ensureProjectFontsReady` (every face loaded plus `document.fonts.ready`)
  before the first exported frame. A missing or corrupt font warns and falls back to Arial; the
  project stays editable.
- **Animated text presets (0.25.0).** The Inspector's Text animation section applies Fade In, Slide
  Up, Pop, or Slow Reveal as ordinary opacity/position/scale keyframes with documented easing. The
  command refuses when any target property already has a curve and names the property; applying is
  one undo step and never writes a custom preset format.
- **Shapes (0.25.0).** Graphics > Add Rectangle/Ellipse/Triangle/Star/Polygon/Heart inserts a shape
  clip at the playhead on a video track. The Inspector edits kind, fill, optional stroke color and
  width, rectangle corner radius, and star/polygon point count; every edit is re-sanitized by
  `setClipShape`. Shapes use the normal position, scale, rotation, flip, opacity, blend, and keyframe
  surface, render through one shared path in preview and export, and take their gizmo and rotation
  origin from the generated path bounds.
- **Stickers (0.25.0).** Graphics > Stickers opens a grid of bundled local SVGs. Choosing one fetches
  the same-origin asset, imports it through the normal image path (probe, thumbnail, content hash,
  OPFS write), and adds an image clip at the playhead as one undo step. There is no remote request,
  no sticker marketplace, and no new schema.

## Track groups (0.26.0)

- `Sequence > Group Selected Tracks` groups the distinct tracks the selection touches when it spans at
  least two tracks in the open sequence; the group is auto-named ("Group 1") and the group command
  refuses a mixed-sequence selection. A track can also join an existing group from its context menu.
- A grouped header shows a compact layers chip. Its menu selects every member's clips, toggles mute,
  solo, hide, and lock across the members, renames the group, removes the track, or deletes the group.
  The solo row appears only when the group has an audio member; hide targets video and text lanes only.
- Group controls write the members' own `muted`/`solo`/`visible`/`locked` flags: solo targets audio
  members only and hide targets video and text members only. The mixed-state rule
  is: if every participant already has the flag on, the next action turns all off; otherwise it turns
  all on. A member edited after a group action shows a mixed label, never an override.
- Group membership is metadata, so grouping or unlocking a locked lane is allowed; clip edits on a
  locked member still refuse through `LOCK_RULES`. Removing a group clears membership and leaves every
  track and clip intact. Removing a lane or pruning its emptied lane drops a group left empty, so the
  name is reusable and the group stops counting toward the limit. Compound creation and template application leave their new tracks ungrouped.

## Brand kit (0.26.0)

- Graphics > Brand Kit opens the palette manager. Colors are strict `#rrggbb` values with trimmed
  names (24 max, unique hex values and ids); font references are safe family strings (16 max) and may
  name a font this project no longer has.
- A saved color appears as a swatch beside the text color, shape fill, and shape stroke controls.
  Clicking a swatch writes the existing field through `setTextStyle`/`setClipShape`; the plus button
  saves the current value. Saving and applying are ordinary undoable commands.
- The Font picker lists saved families in a Brand kit group. An unavailable reference renders
  disabled with an "(unavailable)" label; the project still loads and the rest of the palette works.
- Hydration is lenient: invalid colors, duplicate ids or values, oversized palettes, and malformed
  font references drop with one warning. A missing font reference is preserved.

## Local templates (0.26.0)

- Graphics > Templates opens the gallery: three built-in cards (Title card, Lower third, Rolling
  credits) and the user's saved templates from IndexedDB. Applying one installs a fresh compound
  sequence at the playhead on the open sequence's top video lane (creating a video lane when none
  exists), opens the new sequence, and records one undo entry.
- Templates hold text and shape clips only. Saving the current sequence keeps those clips and drops
  media, audio, compound containers, and track group membership. Clip opacity, rotation, the flip
  pair, static position/scale values, and visual keyframe curves survive the round trip; effects and
  transitions do not. A sequence with neither text nor a shape refuses to save. The template version
  is its own field; older builds refuse a newer version.
- The parser validates before any id is minted: version, unknown fields, duplicate track/clip ids,
  path-like names, strict colors, shape kinds, lane-kind fit, track/clip/text/duration limits, and a
  `linkId` on a shape (shape clips cannot be linked). Repeated `linkId` values are one group. Applying
  mints fresh sequence, track, and clip ids plus one fresh link id per group, so two applications never
  share identity. A template naming a font this project does not have refuses whole. A saved record
  that fails the parser is skipped by the gallery and is not shown; clearing site data is currently
  the only user-facing way to remove it.

## Captions

- **SRT import.** The Captions panel's Import SRT reads a `.srt` file, parses
  it (malformed cues skip with a count), and stamps one flagged text clip per
  cue on a first-free `Captions` track in one undo step. A file with zero
  valid cues, or an unreadable file, toasts a refusal and writes nothing.
- **Editing cues.** The panel lists every flagged root clip in export order
  (cue number, start/end seconds fields, text field). Start edits move the
  clip, end edits tail-trim it, text edits rewrite it, all through the
  existing clip commands. Clicking a cue number returns to the root sequence
  first when a compound is open, then seeks to the cue start. New Cue stamps
  a blank flagged clip at the playhead (converting compound-relative time
  to root-absolute, and staying unavailable when the open path is shared by
  two containers), creating the Captions track in the same undo step when
  none exists yet.
- **SRT export.** Download SRT writes the flagged root clips in export order
  (overlaps kept, blank and sub-floor cues skipped). Zero cues, or a clip
  past the supported range, refuses with one toast and downloads nothing.
- **VTT export.** Download VTT writes the same cue list as WebVTT (header,
  dot timestamps, no sequence numbers), through the same collector and
  the same refusal path. The anchor-click download itself is proven by the
  battery, not unit tests: jsdom cannot run `URL.createObjectURL`.
- Captions are text clips: they render in the monitor and burn into the MP4
  through the shared text draw, with no visibility toggle in this release.
  Desktop-only: below 768 px the shell mounts a fixed compact layout with
  no workspace panel system (the menu bar, toolbar, export dialog and status
  bar still render, but the Source and Captions panels are not mounted and
  the Window visibility toggles render disabled), so SRT import, SRT/VTT
  export and New Cue live only in the desktop Captions panel.

## Layers, opacity, and playback

- New tracks stack by convention (text → video → audio). Video and text prepend inside their kind, so
  the newest video is above older ones; audio appends below the last audio track. Any explicit
  `atIndex` placement is honoured verbatim.
- Adding a layer scrolls the track area by exactly the height of the inserted row, cancelling the shift
  it would otherwise push onto the lanes below — the browser clamps it, so a timeline that still fits
  does not move at all. Without this, the lane holding your clips scrolled out of view and the new layer
  looked unusable.
- **Managing a layer** — right-click a track header (or double-click its name) for Rename Track…,
  Target Track, Solo Track (audio lanes), Lock Track, Select Track Clips, Mute/Unmute Track and Delete
  Track. Delete is disabled while only one lane remains, because the model forbids removing the last
  track. Rename takes focus when it is chosen from the menu, so the name you type goes into the field
  rather than being swallowed by the closing menu.
- **Solo** — audio lanes show `M` and `S` buttons beside the lock. Soloing any audio lane leaves only
  the non-muted soloed audio lanes audible; video and text lanes are excluded while a solo is active,
  so a solo video's embedded audio goes silent. Multiple solos are allowed, and a soloed lane that is
  also muted stays silent. The rule is evaluated per sequence: a solo inside a compound applies when
  that sequence renders, while the parent sequence keeps its own solo state. Preview, the offline
  plan and the MP4 mix read the same `audibleTrackIds` set.
- **Lock** — every lane has a lock button that stays visibly lit while set. A locked lane's clips
  still select, inspect, copy and play, but every edit is refused: move, trim, rate stretch, split,
  delete, paste/drop, transitions, effects, clip properties, keyframes, clip markers and the volume
  envelope. Link-group edits refuse when any member's lane is locked, media removal/relink refuses
  while a locked clip uses the asset, and removing an open lane that holds a locked clip's link
  partner refuses. Track controls, selection, inspection, compound open, undo/redo and autosave stay
  available, so the lane can be unlocked and pre-lock edits can still be undone. The command layer is
  the authority (`LOCK_RULES`); the UI refuses gestures early and shows one toast naming the lane.
- Per-clip **opacity** (0–100 %) multiplies with crossfade alphas, so a clip on a higher track blends
  through to the track below. When opacity (or any animatable property) has keyframes, the curve
  replaces the static value during preview and export alike.
- **Transform** (0.24.0): a visual clip rotates from -3600 to 3600 degrees (the authored value keeps
  its turns, so 720 is two full turns), and flips horizontally or vertically through an explicit
  boolean pair. Rotation is keyframe-able as the `rotation` property, and both preview and export read
  one shared matrix (`T(center) R F T(-center)` left of the position-and-scale factor). Text rotates
  and flips around its measured text box center, not the canvas center, so left- and right-aligned
  lines do not orbit; its scale keeps the existing frame-center origin. `style.x`/`style.y` remain the
  text placement fields. A selected visual clip shows a monitor gizmo: drag inside the box to move,
  a corner handle to scale uniformly, and the top handle to rotate. Each drag is one transient
  gesture and one undo entry, an existing rotation curve gets a keyframe at the captured drag-start
  time (a playhead move mid-drag cannot scatter the drag across keyframes), and a locked
  lane hides the handles and refuses the drag. The Clip tab Transform section covers compound
  clips too, and its rotation field edits the keyframe at the playhead while a rotation curve
  exists, since the static value has no visible effect then.
- **Keyframes and Effect Controls**: selecting a clip shows the Clip / Effect Controls tabs. Each
  animatable property row has a keyframe diamond (add/remove at the playhead), an easing picker that
  is always visible (on a property with no curve it stores that property's default easing for new
  keyframes), and, once animated, a light graph whose dots drag in time and value (one drag = one undo
  step). A bottom handle resizes the graph per property; the height is workspace state, never Doc or
  undo state.
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
  clip's speed badge stay off while the curve exists. On a linked A/V pair, a rate stretch edits only
  the half you drag; the twin keeps its rate, and the pair's audio is dropped while the rates disagree
  ([architecture.md](architecture.md#av-link-groups)).
- **Play / pause (Space)**, `J`/`K`/`L` shuttle (browsers cannot play backwards, so `J` stops like `K`),
  frame stepping, Home/End, and Up/Down edit-point navigation. Transport state mirrors into
  `[data-testid="play-pause"]` and `[data-testid="time-display"]`. A focused button owns Space and
  activates itself instead of toggling playback. Play warms the active elements before starting the
  clock: a paused scrub's behind `<video>` is seeked and both A/V halves wait for readiness, while a
  resume at the parked position does not re-seek. The monitor holds the paused frame instead of black.
  A user pause stops the clock and snaps the pause time to the last video frame the element
  presented, so the timecode and picture match. It drops the cached still frame for the active clips
  before it repaints the paused frame; a frame left at an earlier playhead cannot flash first. The
  stop path detaches tracked seek listeners, while internal recovery, terminal, sequence-end, and
  frame-step halts do not repaint. A pause during a decode recovery leaves that clip to the
  recovery: it does not force a new decode, and the canvas may still show the pre-error frame until
  the recovery's frame or element seek lands.
- Scrubbing while paused requests a WebCodecs frame for each active video clip and redraws when it
  lands, keeping the last good frame while a decode is pending. A clip without a usable sink falls
  back to re-seeking its `<video>` and redrawing on `seeked`. The paused draw clears play-path seek
  tracking before positioning an element. Scrubbing while playing pauses playback
  first (Premiere behavior), so dragging the playhead can never inject a force-seek per pointer move
  into a running clock.
- **Decode recovery.** A `MEDIA_ERR_DECODE` error pauses the core, reloads the same element, skips
  to the next verified keyframe (or a bounded six-second source nudge for reversed or ramped video
  clips), and resumes if it was playing. A verified keyframe only has to advance past the
  error position, even by less than one frame; the fallback needs one project frame. An audio-only
  element, including the audio half of a linked A/V pair, never moves the master clock: a decode or
  network failure gets one in-place reload at the same read, and a second failure inside the retry
  window mutes that clip and reports a toast instead of the damaged-media overlay. An unsupported
  source or an aborted load is muted at once. The toast names the cause. It bypasses the shared
  overlay notice, so a picture-damage notice already on screen stays visible. A failed reload
  releases the element, keeps its
  attempt record, and resumes when it was playing so the next sync creates a fresh element. An
  element that keeps reporting `seeking` longer than `SEEK_STALL_MS` stops being skipped; the next
  sync retries the seek or the play call instead of leaving the picture on the start frame. A
  committed skip's record clears once the playhead passes its skipped range in timeline time, and
  its notice clears shortly after, including when playback stops at the sequence end. The
  overlay reports the skipped range. A second clip's video error is deferred, then consumed once,
  while an audio-only failure retries in place without waiting for the video recovery slot. A
  terminalization outside a recovery drops the queue because no recovery finally runs to drain it;
  a user pause during a recovery also drops it.
  A project replacement drains the queue through the new project's recovery and treats a stale
  recovery as not owning a reused clip id, so the new clip is synced and its error is deferred. A
  seek or play drains the rediscovered queue so the new position is handled; a recovery start
  removes its own queued entry so it cannot replay. A same-clip code 3 is ignored only while the
  recovery still owns the element and epoch; a code 4 terminalizes the active record in place and
  extends its timeline range without shrinking it. A pause cancels and discards, a seek or play
  cancels and drains; a doc edit calls `core.refresh`, which repaints without cancelling and skips
  the reloading element. A terminal error halts, latches the element, restores `failedFrom`,
  releases its blend partner, and keeps priority over deferred overlapping clips until a seek
  outside the range clears the record. The compositor does not
  resolve a terminal element. A deleted clip drops its recovery record, notice range, and deferred
  error. A code 4 during resume cancels the pending `startPlayback` without marking a user
  cancellation. A clip removed or retimed during the resume is re-resolved after the await and emits
  no stale notice; a retimed clip drops its stale record. A reloaded video element is parked on the
  committed keyframe before the commit check, and the commit seek is forced, so neither a near-start
  keyframe nor the position `load()` left behind is mistaken for the target. An unexpected recovery
  throw is
  logged as `[playback] decode recovery failed`.
  A partner-element error pauses the parked partner and disables blending for that
  read. A recovery target at the sequence end stays paused at the end. The overlay is latest-only,
  with clip-owned clearing; an out-of-range terminal seek releases the element, clears the latch
  and notice, and lets the next sync create a fresh element.

## Effects (crop, blend modes, chroma key, track matte, motion blur)

- Each clip carries an ordered **effect stack** (Effect Controls, below the Color group): crop, chroma
  key, track matte and motion blur, with duplicates allowed and every entry individually bypassable.
  Entries apply top-first in stored order, except motion blur, which always evaluates last regardless
  of list position. Clip Motion and Opacity apply after the whole stack, so crop always precedes
  Motion. New effects arrive through the picker's plus button; there is no drag-reorder.
- **Crop** takes four sides in percent plus edge feather and a Zoom toggle that refills the frame
  with the cropped remainder. Feather converts as percent of the smaller frame dimension and can
  never invert the rect. When opposing edges sum to 100 % or more the crop consumes the frame and
  the clip draws nothing (zoom cannot refill nothing). Edges and feather keyframe with diamonds.
- **Blend modes** are a fixed clip field under the Inspector's Opacity section, not a stack entry:
  Normal plus the canvas-supported Premiere set (Multiply, Screen, Overlay, Soft/Hard Light, Darken,
  Lighten, Color Dodge/Burn, Linear Dodge, Difference, Exclusion, Hue, Saturation, Color,
  Luminosity). The blend composites with the backdrop before opacity multiplies. Exotic modes
  (Dissolve, Divide, Subtract, Vivid/Linear/Pin Light, Hard Mix) are recorded non-goals: no canvas
  primitive exists for them.
- **Chroma key** (Ultra-Key-lite) keys on an eyedropper-sampled color with hex fallback: similarity,
  blend softness, clip black/white and despill. Arming the eyedropper makes the next Program Monitor
  click sample the pixel (Escape or a second click cancels; a tainted canvas keeps the old key with
  a notice). All keyer params are static.
- **Track matte** names a source track by id in the clip's own sequence (cross-sequence refused);
  the source must sit above the clip. The matte composites by luma or alpha, optionally reversed.
  The source track keeps showing (Premiere behavior); hide it with the track eyeball. A hidden
  track still serves as a matte source. Removing the source track drops pointing entries in the
  same undo step, and moving a clip drops the mattes the move orphans. An unresolvable matte
  skips the effect instead of crashing, in preview and export alike.
- **Motion blur** accumulates the clip's own animated position/scale across a shutter window
  (angle over the frame interval, up to 8 samples, shutter 0 bypasses free). Transition
  slide/push offsets stay sharp. Chroma params and the matte mask freeze at frame time inside
  the window while Motion and crop geometry (including animated feather) re-evaluate per
  sub-sample; the chroma pass itself re-runs per sub-sample in stored order, since animated
  crop upstream changes its input. The shutter
  angle keyframes; everything else about blur is static.
- A track **eyeball** (video/text lanes only) hides the lane from the video composite in preview
  and export; audio muting stays on the track mute toggle. Effect entry curves split with the clip
  and ride trims untouched, exactly like flat keyframe curves.
- Preview and export evaluate the same stack through shared helpers (`effects.ts`,
  `chroma-key.ts`, the soft-rect mask), so the monitor and the file cannot diverge across
  transitions, compounds or nesting.

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
  composites onto an offscreen canvas at project size, and encodes H.264 through Mediabunny
  (`CanvasSource`). The delivery container is MP4, MOV, or MKV. A custom output size is contain-fitted
  into a second canvas with black bars, never stretched, so transitions, effects, and text geometry
  keep the project canvas.
- Audio is mixed in one `OfflineAudioContext` render (gain keyframes, pan, EQ, compressor, crossfade
  ramps) and encoded as an AAC track (Opus where the browser cannot encode AAC, notably desktop
  Linux and Firefox), so video files are MP4, MOV, or MKV with a correct duration. Audio-only WAV uses
  PCM; MP3 and M4A use their browser encoders and are disabled by the dialog when unavailable. An
  audio-only export refuses a timeline with no audible mix instead of writing an empty container. A
  video export can proceed without audio; the audible-mix gate disables only audio-only containers.
- The dialog shows progress, supports cancel, previews the result (`export-result-video`, or
  `export-result-audio` for an audio-only file), and downloads `<project name>` plus the container
  extension. It validates a custom bitrate (0.5 to 40 Mbps) and output size (16 to 4096 pixels per
  side, even-rounded) before starting. It disables an audio-only container whose encoder or audible
  mix is missing, while a video container is disabled only when WebCodecs is unavailable. On browsers
  without WebCodecs it disables itself and says why.
- `Export to file` (Chromium/Edge only, behind a `showSaveFilePicker` probe) streams the same file
  straight to a file the user picks, through a `chunked: true` `StreamTarget`; the destination is
  committed only after the muxer finalizes and aborted on cancel or any failure, and the result view
  shows the saved name and bytes. The dialog also shows a size estimate and nudges to it past ~100 MB.
- Sequence Settings offers 16:9, 9:16, 1:1, 4:5, 4:3, and 21:9 presets. They set the project width and
  height only. Clip positions are absolute, so existing clips do not move or scale when the canvas
  changes.
- Export runs offline (no realtime capture) and does not need tab focus; wall time tracks source
  decode speed. HEVC and ProRes are deliberately not offered: ProRes has no shipping browser
  `VideoEncoder`, and HEVC is left out on value grounds (an encoder exists, and a probe could gate it
  safely); see [ROADMAP](../ROADMAP.md).
- After a successful file or blob export, `ExportDialog` calls `trackExportSuccess()`. That sends
  `export-success` every time and `first-export` once per browser profile while the local marker
  persists. Cancelled and failed exports do not call it.

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
   path. Track solo is per sequence too: the container's own lane is gated by the parent's solo set,
   while the nested tracks are gated by the child sequence's own set.

## Save, load, autosave, restore

- **Save (`Ctrl+S`)** serializes to `.veproj.json` (version 9; versions 1 to 8 still load, and a v9
  file needs this build), including the media content hashes, the project font library, track groups,
  the brand kit, shape clips, and the static stretch pair (clamped 0.1..4, absent at 1), writes a claim shard for every hash the snapshot references, and downloads the file. A
  refused claim downloads nothing: a copy is never written with unclaimed media. Object URLs are
  stripped and never persisted.
- **Open** parses synchronously, then rehydrates: each asset with a `contentHash` reads its verified
  bytes, rebuilds the `File` from the serialized name plus the sidecar MIME type, and creates a fresh
  object URL before `installProject` runs once. Project fonts are staged as already-loaded `FontFace`
  objects and join the registry at install, so a superseded open never swaps the live faces. An asset
  without a hash, or with missing or damaged bytes, stays `missing` and relinks. The open writes the
  claim shard before install; a failed claim still opens the project, warns, and disables Clean Unused
  Media until a save claims the bytes. A load superseded by a newer open or File > New revokes the
  URLs it created and installs nothing.
- Every open tab holds the shared Web Lock `media-project:<project-id>`. The boot doc announces itself
  on mount even though it never installs, an open or restore prepares the incoming project's hold while
  the live project keeps its own until the install commits. Each load owns a distinct prepared hold, so
  a discarded or superseded load releases only the hold it acquired, never another project's or a newer
  load's. Clean Unused Media drops this tab's hold, requests the lock exclusively, and
  deletes only when no other tab has the project open. A clean re-reads the doc, both history stacks,
  the autosave slot, and every claim shard at delete time, refuses when the open project changed before
  the deletes, and refuses outright without Web Locks or with missing claims.
- Re-importing a file with a matching name relinks it automatically, or the user can relink each asset
  from the media bin. A relink writes the new bytes first, then updates the asset's `contentHash`; a
  failed write applies a session-only relink with the hash cleared. A relink writes only media details
  through a whitelist: the asset's identity is immutable, a non-undefined source handle must pass the
  browser-side `isNativeFile` guard, and a relink that clears `missing` must leave a usable URL. A
  whitespace-only URL is rejected. Removing an asset never deletes stored bytes, because undo restores
  the entry; deletion belongs to Clean Unused Media or Clear All Stored Media.
- While the playhead sits on a clip whose media is offline, the monitor paints **Media offline** with
  the file names and a relink hint. The frame is genuinely black and silent; the overlay is what keeps
  that from reading as a broken preview.
- **Autosave** writes to `localStorage` (`web-video-editor:autosave:v1`, 800 ms debounce) after each
  settled change; transient drag frames are skipped. The snapshot carries the project font library
  (names and hashes, never bytes), so a restore relinks the same stored faces. Every writer serializes
  its ownership check and the slot write under the Web Lock `videoh-autosave:v1` (or one IndexedDB
  transaction when Web Locks is missing). A fresh ownership record from another tab makes this tab
  read-only: it loads the slot, shows a reload prompt, and never writes over the imported project. A
  stale record is taken over with a new epoch, and a former owner that resumes sees the epoch and
  stops writing. An import releases only the epoch it claimed, so an older overlapping import cannot
  stop a newer one's heartbeat or delete its record. A pause request carries its import id: a tab
  stays paused while any request is live, a failed import resumes only the tabs it paused, and a
  provisional read-only tab rechecks ownership when that import releases its claim. A pause whose
  importer crashed is recovered after the owner lease expires: with no live owner and an unchanged
  slot the tab resumes, with a replaced or never-observed slot it stays paused and read-only instead
  of overwriting the import, and with a live owner the check is rescheduled. The owner
  record's `storage` event triggers the same recheck, so a tab that went read-only resumes even
  when `BroadcastChannel` is unavailable, and the same event carries acquisitions too, so an idle
  tab that sees a foreign record becomes read-only before its next write. A record that arrives
  after its lease expired is still treated as an acquisition, then rechecked against the slot, so a
  suspended tab that wakes to queued events stops instead of saving over the import; it resumes
  only when the slot is unchanged. A same-session takeover keeps the record the probe found
  unanswered: one that appears or changes while the claim waits is refused instead of replaced. A
  restart keeps an existing read-only tab read-only when the
  slot changed with no live owner, and a completed write marks saved only while the live doc is
  still the one it serialized. The recheck also requires the slot to still match the text
  this tab last saw or wrote; if an import replaced it, the tab stays read-only instead of resuming
  over the imported project. A resume also leaves a pending restore banner alone, so the saved
  session stays until the user chooses Restore or Discard. A resumed tab writes its pending
  document, and each retry
  carries a write sequence so an older snapshot cannot replace a newer save. A retry keeps the
  sequence of the write it repeats: allocating a fresh sequence per attempt would let an old
  document overwrite a newer edit that committed between attempts. The pause and resume
  messages themselves travel over `BroadcastChannel`, but the slot also carries a durable import
  marker written by every project-scoped slot write (a bundle import and its retries). A tab that
  observed an older marker and missed the pause refuses to write after the lease expires and asks
  for a reload; a tab that mounted after the import accepts the current marker and keeps editing.
  A failed marker write blocks the slot and leaves the requirement in memory, so the next ordinary
  autosave for the imported project must land the marker before it can save. The import records the
  requirement before its doc becomes live, so the debounced save that follows the install cannot
  race it. A coordination remount
  keeps the marker the live document already observed; only a fresh page adopts the current one. An
  ordinary autosave writes the marker only to finish an unfinished import requirement and never
  creates one, so multi-tab editing keeps last-write-wins.
  Coordination teardown releases the tab's presence lock, so a remount or an
  in-page unmount cannot leave another tab waiting for an acknowledgement that never comes, and it
  invalidates an initialization still awaiting its session probe so a torn-down tab cannot reclaim
  ownership or start a heartbeat. In 0.29.6 each probe owns a map entry and timer, so two overlapping probes settle independently.
  An initialization probe holds ordinary saves until it resolves; the reclaim compares the strict
  live slot with the text this tab last saw or wrote and refuses a storage read failure. Replies
  must name the current session, acknowledgements must name an expected tab, and every owner-record
  write is checked. A failed claim, reclaim, heartbeat refresh, save-time refresh, or missing-record
  re-establish turns autosave off for the session, and a peer-present or storage-failure read-only
  arms one lease check so a crashed peer cannot strand the tab until reload. A changed import fence is permanent for this session, so it keeps the tab read-only and stops the retry timer. It also clears the in-memory ownership flag: a remount may
  reclaim a fresh same-session record, but it cannot refresh or recreate a stale one. Discarding a restore clears only the slot text its banner was built
  from, and never while a live record names another tab, so a stale banner cannot delete a project
  that tab imported.
- Without Web Locks and IndexedDB, bundle import and install-record writes refuse: two tabs cannot
  serialize an ownership check or a registry append, and guessing is worse than asking for a reload.
  They also fail closed when IndexedDB is present but cannot open or start a transaction; a broken
  transaction store is not treated as coordination. Normal editing still uses the slot. Coordination
  teardown drops the transient pause state and a remount re-evaluates the ownership record, so a
  missed pause resume cannot leave the editor paused until a full page reload.
- On startup a valid autosave raises a banner: **Restore** rehydrates and installs the doc (undoable)
  or **Discard** clears it. Discarding a restore that is still rehydrating prevents it from installing.
  A restore writes no claim; the autosave slot is a live reference, so Clean Unused Media keeps its
  hashes until the slot stops referencing them.

## Project bundle (0.28.0)

- **Export Project Bundle** writes `<project-name>.vebundle.zip`: `manifest.json`, the unchanged
  `project.veproj.json`, every `Doc.media` entry under `media/<asset-id>/<name>`, and every
  `Project.fonts` entry under `fonts/<font-id>/<name>`. The manifest has a bundle version separate
  from the project schema, a creation date, and each entry's id, path, display name, MIME type, byte
  size, and SHA-256.
- The snapshot is captured once, before any bytes are read, so an edit during the write cannot mix
  project states. Before it hashes anything, the export compares each stored entry size (from the
  store listing) and each session `File` size with the 512 MiB media entry, 8 MiB font entry, and
  1 GiB total budgets, so an oversized asset or font is refused without materializing it. If the store is supported but its listing
  fails, the export refuses rather than hash without a size check. A hash that exists in both the
  media and font namespaces keeps the larger stored size, so a damaged oversized copy is not hidden
  by a small one. Media bytes come from the project's OPFS
  namespace; an asset with no stored copy falls back to its session `File`, and a hash that cannot be
  verified refuses the export. Every
  `Doc.media` entry is required, including unused bin items, because the project JSON lists them. A
  referenced font with no stored bytes warns and asks for confirmation; an unused missing font is
  left out with a warning only. Sanitized names cap their length without splitting a surrogate pair,
  so the manifest path and the ZIP entry path stay identical. The bundle writer stores entries without compression, because media
  and fonts are already compressed.
- The writer uses the File System Access picker when available and streams the archive to the file,
  one chunk per read; otherwise it builds one Blob, and refuses above 512 MiB before the build because the whole archive would live in memory. That estimate includes the local headers, central-directory records, paths, and end record the ZIP adds around the payload. The picker is requested before any media is read,
  because `showSaveFilePicker` needs transient user activation and hashing a large project can
  outlast it. A handle chosen before a missing-font confirmation is kept for the confirmed retry, so
  the user does not have to pick the file twice; unmounting the menu bumps an export generation, so a
  preparation still running cannot publish that handle for a later export. No server is involved.
- **Open Project Bundle** reads the central directory, rejects encrypted, compressed, Zip64,
  duplicate-path, truncated, and over-count archives, validates the manifest and every path
  (`..`, absolute paths, backslashes, NUL, control characters, and duplicate ids refuse), parses the
  project through the normal validator (a newer project version refuses), and matches every
  `Doc.media` id and every `Project.fonts` id. Missing media, extra entries, wrong sizes, and hash
  mismatches refuse the whole bundle; a missing font is a warning because the project can fall back
  to Arial.
- Each entry's bytes are verified against the manifest SHA-256 and CRC before anything is written.
  Media then goes through the normal `importFile` probe, so a malformed file is refused as a media
  error instead of crashing the editor; the media and font loops check the project generation, so a
  newer open stops a hostile bundle before the next probe; a serialized duration survives when the
  probe reports zero or
  a non-finite value, which keeps a WebM recording without a duration header intact. Fonts are
  re-validated by header and size, independent of the display name, before they are stored. The
  project's `contentHash` values are checked
  against the manifest; a project that predates content hashes adopts the manifest hash after the
  bytes verify.
- Import writes into the project's existing content-addressed store, using the same temp-write,
  verify, quarantine, and promote rules as any import, so a valid hash is reused and never
  overwritten. The claims directory must already be a complete record; a missing or unreadable one
  aborts before installation. The import holds the incoming project's shared `ProjectLock` from
  before its claim shard through the registry append, so a clean in another tab cannot take the
  exclusive lock during that window. Before `installProject` the import writes one claim shard
  carrying its install id. After the install succeeds it records that id durably, then writes the
  imported doc to the shared autosave slot while holding ownership. The payload is serialized
  from the live doc after the registry append lands, so an edit made during the append reaches the
  slot instead of being overwritten by older JSON; if the slot write then loses a race with a newer
  edit, the tab reports pending rather than saved. A bundle slot write and every retry of it are
  scoped to the imported project: if another project becomes live during the append, the import
  records the install and leaves that project's slot alone, and a retry is dropped once its project
  is no longer live, so neither can report the newer project saved. If a bookkeeping step after
  `installProject` fails, the import keeps the installed project and its live media URLs and returns
  opened with a warning, because the project already replaced the live doc. A failure before any
  payload exists retries from a fresh serialization of the live doc, so clearing the failure
  completes the registry append and the slot write with no further edit. A failed registry or
  slot write marks autosave error, so the unload warning stays active until a retry saves. A failed install removes
  only the claim shard and leaves promoted bytes for Clean Unused Media; a failed registry or slot
  write keeps the ownership, the claim, and the paused tabs, and retries on the next autosave. The
  imported doc keeps its project id, so a project with the same id keeps resolving its own hashes.
- A missing install registry is not recreated from one import or saved copy alone. If any project
  holds an install-tagged claim shard, history is marked unknown first, so recovery keeps those
  shards instead of treating another project's completed install as an orphan. An append that would
  exceed the registry bounds, or whose write fails, marks history unknown for the same reason. A
  pending install is also mirrored durably as a bounded per-project map, so recovery keeps every
  claim across a reload until its append lands; startup restores every record and retries it, and a
  slot write flushes only its own project's record. The map's read-modify-write runs inside the
  autosave section, and an append clears only the install it captured, so a newer install for the
  same project survives an older append's cleanup. A retry that finishes after a newer edit leaves
  autosave pending instead of reporting the newer document saved. A restored retry whose live doc is another
  project only appends the install record and leaves that session's slot alone, so finishing the
  bookkeeping cannot overwrite the saved session it booted beside. The cost is explicit: if the
  imported project's first slot write never landed, a reload that boots another project completes
  the bookkeeping but cannot restore the imported project from autosave, which is why the failed
  write says that closing the tab before the retry saves can lose the imported project. Retry
  freshness compares document
  content without the serialization timestamp, so an unchanged document is still retried after a
  failed attempt instead of being dropped as stale.
- Before installation, the import holds the shared media lock and the same-tab media reservation,
  so a clean cannot run between promotion and install. Other editor tabs
  receive `autosave-pause`, cancel their pending timer, wait for any in-flight write, and
  acknowledge. A known tab that does not acknowledge within two seconds refuses the import. After a
  successful install every other tab stays paused with a reload prompt; after a failed pre-install it
  resumes. The install writes once, with the same history reset as any project open.
- A crash can leave a shard written before the install. Recovery runs inside the clean action under
  the media lock: it reads the durable installed registry and retires a shard whose install id was
  never recorded, without deleting the promoted bytes; a shard with no install id (a normal save) is
  always kept, and a missing or unreadable registry keeps every shard and warns. If an append finds
  install-tagged claims but no registry entry for the project, it marks the install history unknown
  first; the marker survives later appends, so a recreated registry never makes recovery treat the
  older claims as orphans. The registry is append-only and keyed by project id, so a saved copy's
  claim survives a later project switch. Project ids are user-controlled strings, so registry lookups
  use a null-prototype dictionary: `constructor` and `__proto__` cannot read inherited values or
  mutate the prototype.
- Hostile-archive and memory limits: 4096 entries, 512 MiB per media entry, 8 MiB per font
  entry, 1 GiB total, an 8 MiB manifest, a 64 MiB project file, and 512-character paths. These are a memory budget rather than
  a disk budget: import reads one entry into a full buffer several times (CRC, SHA-256, probe, and
  store write), and the no-picker export fallback holds the entire archive in memory. The manifest
  validator rejects an oversized entry or total before any entry bytes are read, so a bundle cannot
  force an allocation beyond the budget.

## Durable media storage and cleanup

- Stored keys are `<project-id>/<content-hash>`; the hash is the SHA-256 of the bytes, so an entry is
  immutable and two copies can resolve different revisions of the same source. A sidecar
  `<content-hash>.json` holds the MIME type, and every read verifies the hash, so a partial or damaged
  entry reads as missing and is rewritten on the next import. A damaged entry is quarantined while the
  replacement writes, and restored only when its bytes still verify if that write fails, so a damaged
  entry is never resurrected and a valid copy another writer promoted survives.
- An explicit save and open write an immutable `claims/<claim-id>.json` shard listing the hashes that
  copy may use. Shards only grow and are never merged, so concurrent saves cannot lose a claim. A
  missing or unreadable claims directory disables content-hash deletion; clean may only remove temp and
  quarantine files. A project that already stores hashes but has lost its claims directory is not
  repaired with an empty record: clean stays blocked and an explicit save refuses until Clear All
  Stored Media resets the project. Stored hashes count in both the media root and the `fonts/`
  namespace, so a text-only project with lost claims is not mistaken for an empty one either. An
  unreadable shard also refuses a new claim, so a save fails instead of publishing beside records it
  cannot read. An open classifies the blocked state as `claims-missing`, `unclaimed`, or
  `storage-unavailable`, and the Storage dialog renders guidance per cause instead of always pointing
  to a save. The claim write keeps its own cause, so a store that becomes unreadable after the
  inspection reads `storage-unavailable` rather than a rejected claim. A successful save, hashed or not, clears the block only when every stored media and font
  hash is referenced by the saved snapshot or protected by a claim; a no-hash save clears only when
  existing claims protect every stored hash, which is the path after Clear All.
- Clean Unused Media lists candidates with their sizes and requires confirmation. It keeps every hash
  reachable from the live doc, both history stacks, the autosave slot for this project, and every claim
  shard, and it reports the reclaimed size. Same-tab imports, relinks, Freeze Frame writes, and
  rehydration wait for a running clean, so a candidate hash cannot be rewritten between the reference
  snapshot and the delete. A nested operation passes its parent reservation token while a clean
  drains that reservation, so an import staging a claim or a font cannot deadlock Clear All; an
  unrelated top-level write waits for the clean instead of joining it. Clean also refuses while an
  imported project's install record is still
  pending, so recovery cannot retire the import's claim before the registry append lands. The
  pending check runs again inside the exclusion, after the preview yield, so an install that landed
  while the preview was read cannot have its claim retired by recovery. Clear All
  Stored Media is the only action that removes claims; it names that
  saved copies lose their media and fonts and that the current bundle covers only the current
  document, needs a second confirmation, and the confirmation is bound to the project it named. It holds the same-tab clean flag, waits for an in-flight media write before it
  snapshots the directory, and runs the deletes under the exclusive project lock, so another open tab
  cannot write during or after the snapshot. Without a matching shared hold, or without Web Locks to
  coordinate with, it refuses instead of reporting a partial clear as complete. A failed delete is reported as a
  failure, never as "nothing to clear".
- The storage dialog shows project usage, the origin estimate, and a persistent-storage request. A
  quota or unsupported-OPFS failure never blocks an import; it degrades to a session-only asset with a
  warning, and clearing site data removes stored media and falls back to relink.

## Freeze frame

- Freeze Frame captures the composited frame at the playhead. It refuses when nothing visible is under
  the playhead, when a visible source is offline, or when the active sequence cannot accept a new
  track, before any encoding starts. A clip whose evaluated opacity is zero draws nothing, so an
  offline source on a fully transparent clip does not block a still of the footage beneath it, and a
  playhead with only fully transparent clips refuses as empty instead of encoding black.
- The frame renders at project size through the same compositor as the preview, on an opaque surface,
  and encodes a PNG. The PNG imports through the normal media path (thumbnail, hash, OPFS), then one
  batch adds the asset, a new video track at index 0 of the active sequence, and a 2 second still clip
  at the playhead. The new clip is selected and the playhead does not move. Overlapping instances of
  one compound sequence each load the source frame for their own local time, and a project or active
  sequence that changes during the render cancels the still instead of landing it on the new one.
- A new top track means a locked source lane and a clip at the playhead cannot block or cover the
  still. Undo removes the clip and the asset entry but keeps the stored bytes, so redo restores a
  working still; clean reclaims those bytes only once history no longer reaches them.

## Capture (0.27.0)

- The media bin's Record menu starts a voiceover, screen, or camera take. Permission is requested only
  when Start is pressed, and a denied permission is a normal path that shows the browser's message.
- Screen recording carries exactly one audio source: system audio, the microphone, or none. System
  audio and microphone are never mixed, because a microphone hears the speakers and the mix would
  contain the system sound twice. Choosing the microphone adds its track to the display video stream,
  so MediaRecorder encodes one audio track. The microphone choice is disabled with a reason when the
  browser cannot capture it.
- A browser stop-sharing event ends the take once, through the same path as Stop. Closing the dialog
  during a take cancels it and stops every track, and a permission request that resolves after close is
  stopped before a recorder exists; no recording survives the dialog. A screen take whose shared
  display ends while the microphone prompt is open aborts and stops both streams instead of recording
  from an ended source.
- A take belongs to the project it started in. A project replacement while the take is saving discards
  the completion instead of importing it into the new project.
- Every take is repaired before import. A MediaRecorder WebM can report an infinite duration, so the
  recorder seeks past the end to read the real value. Firefox writes audio-only WebM with no duration
  and cannot seek it at all, so a take with no readable container duration falls back to the
  recorder's own measured length instead of being refused. The verified duration reaches
  `importFile` as a hint, and the stored header is left unchanged.
- The codec string follows the stream. A video-only stream records with a video-only MIME type, because
  Firefox accepts `video/webm;codecs=vp8,opus` for a stream with no audio track and then emits no data
  and never fires stop. A stop that never lands finalizes with the bytes already buffered after 20
  seconds, so the dialog cannot sit in Saving forever.
- A take stops and saves itself at 10 minutes or 512 MiB, with a warning at 80 percent of either. The
  byte trigger fires at 480 MiB and keeps the crossing and final chunks, because a completed
  MediaRecorder stream is what the browser guarantees is playable. The 512 MiB ceiling is enforced:
  a chunk that would cross it is dropped, the take is saved from the chunks already recorded, and the
  dialog says its end may be missing. If one chunk is larger than the whole ceiling, there is nothing
  to save, and the dialog says the limit was reached before a chunk could be saved instead of
  returning silently. A final chunk is normally far smaller than the 32 MiB headroom; the drop is the
  backstop for a browser that flushes late. The caps exist because MediaRecorder
  buffers chunks in memory until stop. A cap stop, or the browser stopping the recorder, still
  imports the take without waiting for a Stop click.
- A voiceover can be placed at the playhead on an audio lane after import; otherwise it stays in the
  bin. Screen and camera takes stay in the bin.
- Recordings are ordinary assets: the same import path, OPFS persistence, thumbnail and waveform
  probing, relink, and export as any picked file. A recording the store could not keep stays
  session-only and offers Download a copy in the media bin before a reload drops it.

## Workspace and menus

- Every panel is resizable and closable. Each desktop panel header offers a `Close Panel` menu, and
  the Window menu restores a closed panel. Closing the last panel in a row unmounts that row and
  returns its space to the other row; closing all six shows the empty-workspace recovery prompt.
  Sizes and visibility persist across sessions (`src/lib/editor/workspace.ts`), and a corrupt stored
  layout is sanitized instead of crashing. A legacy `collapsed` payload is ignored.
- The menu bar mirrors Premiere Pro's menus with **no dead items** and **no fake shortcuts**: item
  enablement is computed from editor context, and the shortcut column only lists wired keys.
- The right edge of the menu bar carries a **Full screen** button, outside `role="menubar"` so it
  keeps native button semantics and Enter/Space activation. It enters or exits the page Fullscreen
  API, follows `fullscreenchange` so Escape and external exits update the label, and reports a
  rejected request or missing API through the existing destructive `Action failed` toast.
- Below 768 px the workspace falls back to a fixed stacked layout.

## Change appearance

- View > Appearance opens the palette picker: Default plus thirteen tinted palettes, ordered by hue
  from Garnet to Orchid. The dialog is hosted by `MenuBar.tsx`, the list is `THEMES` in
  `src/lib/editor/theme.ts`, and the dialog caps its height and scrolls when the window is short.
- Selection applies immediately and writes the id under `web-video-editor:theme:v1`, separate from
  the workspace layout key. Choosing Default removes the key and the `data-palette` attribute, so
  the base `.dark` tokens are the default.
- The boot effect in `src/components/editor/EditorBoot.tsx` applies the stored palette behind the preloader. The dialog
  mounts only while it is open, so every open reads the stored value and applies it.
- Palettes override only the 17 chrome tokens. Clip kinds, markers, the monitor, scopes, the splash,
  and `--destructive` stay fixed, and the monitor and scopes keep their neutral NLE surfaces.
- If the browser blocks `localStorage` at the getter, the app falls back to Default instead of
  failing the boot or the dialog; a selection still applies for that session but cannot persist.

## Hardening pass (0.28.3)

- Slider previews in the Inspector and Effect Controls open one transient gesture on their first
  frame. The release still calls `apply`, so it rolls the open gesture back to its pre-drag base and
  records one history entry. A `pointercancel` or unmount discards the preview and ends only the
  gesture this slider opened: it compares the token recorded for each frame and leaves a gesture
  owned by another control alone. A preview frame, release, or keyboard step that no longer owns the
  live slot is dropped, so it cannot overwrite or roll back that control's edit; the slider starts
  its own gesture once the owner releases. A keyboard step commits before Radix reports the value, so the
  slider finalizes that preview after the event instead of leaving a pointerless transient, and a
  drag that returns to its starting value cancels its preview on release. A window blur clears the
  slider's local pointer ownership after the shell commits the dangling gesture, so a drag ended by
  an app switch cannot turn the next keyboard step into a pointerless preview. A stale gesture is
  cancelled before a fresh UI test fixture. The project name input holds a local draft tagged with
  its project id: it commits once on blur or Enter, reverts on Escape, is discarded when another
  project is installed while the field is focused, and leaves Enter and Escape to an active IME
  composition.
- Command payloads are validated at the boundary in `commands.ts`: names, finite numbers, booleans,
  EQ bands, text style, transition type, media asset fields, trim edge, marker patches, and keyframe
  arrays refuse with `EditorCommandError`. `sanitizeKeyframes` reads a non-array as empty and drops
  primitive entries, and templates reject unknown keyframe fields.
- Freeze Frame skips a seek when the element already shows the target time. A reversed-clip
  overwrite guards its low `clip.inPoint` anchor in both the interior and keep-right branches, and
  a reversed head trim validates the kept span so it can shorten an over-consuming timeScale ramp
  instead of refusing. A transition span clamps to the clips' shared interval, and clips beyond
  the transition pair draw at full opacity in both the preview and the export plan.
- A project epoch change clears the playback image cache; scrub resets clear the running map, an
  obsolete drain checks its token before dequeueing so it cannot take a newer request, and a stale
  cleanup cannot remove a newer decode's entry. Export keeps every mediabunny `Input` in a
  caller-owned list and disposes it in the `finally`, including when a later track probe rejects. A
  font commit bumps only its own family's epoch, so an in-flight load for another family still
  registers.
- Claim writes reserve media activity against a same-tab clean. A claim is a durable reference, so
  it keeps every referenced hash, including one whose bytes are offline at save time; if another
  copy later restores the bytes, the saved copy's claim still protects them from cleanup. The clean
  plan unions claims with live references, so the claim cannot hide a deletion. An unreadable
  pending-install map reads as pending. The zip reader compares local header name bytes with the
  central record and rejects local extra fields, while the manifest rejects control characters in
  the MIME type. Clear All counts font temp and quarantine bytes, and an empty sidecar type counts
  as a fallback.
- Hydration clamps media geometry at zero and style x/y to 0..1, gives a present-but-invalid project
  id a type-preserving 64-bit recovered key, so special numbers stay distinct, and counts
  unreachable sequence depth. An unreadable value gets a per-value tagged identity instead of throwing.
  Non-finite playheads
  are ignored, placement uses the default duration for a non-finite asset duration, a non-finite
  caption start produces no batch, and a throwing recorder handler cannot skip teardown.

## Gesture ownership (0.28.4)

- The gesture slot refuses a second begin. `beginTransient` returns `null` and leaves the live base,
  display doc, pointer, and token untouched. `ownsTransient(token)` is the one predicate for "this
  session still owns the slot", and a null token never owns it.
- Every direct drag begin (the preview gizmo and text drags, clip gestures, sequence and clip
  markers, the automation envelope, the keyframe dot, and the keyframe handle) captures the returned
  token and bails before it installs drag state. The marker and envelope drags retry the begin on a
  later frame and set their token ref only after a token arrives, so a refused drag leaves no
  half-built gesture and no stale ownership. An envelope retry that acquires the slot after a
  foreign edit validates its captured keyframe first; if the point disappeared while the retry
  waited, it cancels the empty transient and clears the pending press instead of holding the slot
  until pointerup.
- Every release and cleanup path that can end a gesture compares the token it captured before
  committing or cancelling: the keyframe dot and handle, clip gestures, sequence and clip markers,
  and the automation envelope. The marker and envelope cleanup stores that token instead of a
  boolean, so a foreign edit that ended the drag, a second pointerdown, or an unmount cannot cancel
  a replacement gesture that owns the slot now.
- The Inspector shape and text sections own one `useTransientOwner` session each. Focus begins the
  session, every preview frame runs through `preview`, blur commits only an owned session, and
  unmount commits an owned session. A refused focus drops its changes while a foreign gesture is
  live and retries `begin()` on the next change once the slot frees; it never overwrites, ends, or
  commits the foreign gesture.
- `NamedSlider` uses `ownsTransient` for the preview cleanup and the release commit. A release whose
  own preview gesture was retired by a foreign edit is dropped instead of recording its leftover
  value as a fresh history entry; a keyboard step that never opened a preview still commits.
- The shared UI event names and the timeline scroll attribute live in `src/lib/editor/ui-contracts.ts`.
  Producers and consumers import them, while the CSS rule and the DOM-contract tests keep the literal
  attribute value.

## Monitor selection and snapping (0.29.5)

- Clicking a visible clip in the program monitor selects it. The hit test reads the same
  transformed box the gizmo draws (`pickVisualClipAt` in `playback/monitor-geometry.ts`): the
  topmost rendered track first, skipping audio and hidden tracks, clips outside the playhead,
  missing media, and fully transparent clips (keyframed opacity included). Shift adds and
  Ctrl/Meta toggles. An empty click clears the selection unless the selected live text clip owns
  the drag surface.
- A press on the already-selected live text clip starts the existing drag; a first click on an
  unselected text clip only selects it.
- `S`, the toolbar magnet, View > Snapping, and Inspector > Transform > Snapping are one flag.
  With it on, a monitor move snaps the box's left/center/right and top/center/bottom lines to the
  frame edges, the frame center, and every other visible clip's transformed bounds. Amber
  full-height and full-width guides show the match. The target set is captured at pointer-down;
  pressing Play or moving the playhead cancels the drag instead of using stale targets. A text move
  converts the winning project delta back through `scaleX`/`scaleY` and verifies the clamped box
  still lands on the guide.
- Rotation snaps to the nearest 15-degree step within 3 degrees, before the bounds, so a 720-degree
  turn stays two turns.
- 0.29.6 pauses a playing monitor before capturing geometry and consumes the press when that pause
  moved the playhead or no controller is attached. The next press recomputes the quad, text box,
  targets, and selected identity from the post-pause store, and a press on a stale overlay is
  consumed so React can catch up.
- Inspector > Transform also exposes Stretch X and Stretch Y (0.1..4), a Reset stretch button, and
  the shared Snapping switch.

## Static stretch and smaller handles (0.29.5)

- Shift + corner drag scales X and Y independently. The gesture captures the uniform `scale`,
  stretch, rotation, grab offset, and corner; `scaleFromCornerDrag` projects the pointer onto the
  clip's rotated axes and returns per-axis ratios, so a pre-stretched clip multiplies its captured
  stretch instead of double-counting the effective scale. Releasing Shift (or pressing it mid-drag)
  resets the transient and reapplies the correct frame from the last pointer position; a pointerup
  with no intervening move finalizes the frame its Shift state asks for. Each gesture is one undo
  entry.
- The uniform `scale` curve stays the one animation source; `stretchX`/`stretchY` are static,
  clamped, and omitted at 1. Project format v9 persists them; v1..v8 load with stretch 1.
- The visible handle is a 5px CSS radius and the hit target 12px (10/24px diameters), measured from
  the canvas CSS scale; an unmeasured rect uses the project-relative fallback.

## Audio mute recovery (0.29.5)

- A decode failure on a sound carrier mutes it so the picture continues. The toast names the clip
  and time, uses playing or paused copy, and offers Retry. The clip and its linked video half wear an
  amber `AUDIO MUTED` badge until the audio actually recovers or the clip is removed. One
  `console.warn` records the clip id, name, MediaError code, and timeline time.
- Retry, Play, and a seek more than one second from the failed time move the clip to a pending
  state: the badge stays, the failure budget resets, and an errored element is released so a fresh
  one is created. A seek back inside the failed range re-blocks an ordinary pending retry (no reload
  or toast loop); an explicit Retry stays armed. Play re-arms every muted clip and badges clear per
  clip as each recovers.
- Recovery requires audio evidence: the pending clip must be active and its audio element must hold
  current data at the expected read (or present an audio sample). A video frame does not clear the
  badge. Readiness listeners are bound to the element and retry generation, so a late event from a
  superseded retry is ignored.
- Deleting a clip clears its mute synchronously on every doc change, including during playback, so a
  rapid delete and undo cannot resurrect the badge. Project replacement clears every muted id even
  when the new project reuses it.

## Media and Project tabs (0.29.5)

- The left panel has Media and Project tabs. Media is the default runtime-only tab and keeps import,
  record, storage, relink, and the asset list. Project lists generated text, shapes, and compound
  clips in the ACTIVE sequence (nested sequences too); imported media never appears.
- Each row is one button: type icon, label (text, shape kind, or sequence name), start and duration,
  and a `Go to` hint. Activation reveals a hidden track, selects the clip, and seeks to its
  sequence-local start. The list is empty on a sequence with no generated clips. The tablist uses
  `role="tab"`/`tabpanel`, `aria-selected`, `aria-controls`/`aria-labelledby`, a roving `tabIndex`,
  and ArrowLeft/ArrowRight/Home/End activation.

## Audit hardening (0.28.5)

A read-only audit of the 0.28.4 tree produced 26 fixes. The flow-visible changes:

- **Export:** `finishExport` rechecks the cancel handle immediately before `close()` and aborts the sink, and both call sites pass the handle. The dialog skips its success block (and returns to setup) when cancellation landed while the export resolved, and a superseded export's completion is ignored so it cannot reset a newer export's view or clear its Cancel handle. The video path checks cancellation after font readiness, decode setup, the audio mix, `output.start()`, image preload, and before `finalize()`. A rejected `createImageBitmap` closes its decoded sample through a `finally`, for the primary and the blended sample.
- **Proxy builds:** `transcode` disposes its mediabunny `Input` in a `finally` on success, a missing video track, and a stale generation. The `OfflineAudioContext` has no Web Audio `close()`, so it is left to garbage collection.
- **Freeze Frame:** the source seek goes through `clampSourceTime`, so a reversed head and an over-consuming `timeScale` ramp capture the last readable frame the monitor and export show.
- **Text drag:** the gesture captures its clip id at pointerdown. A selection switch or a playhead move outside that clip cancels the transient instead of writing the newly selected clip or dereferencing an undefined one, and the release rechecks the same validity so a change after the last frame cannot commit a stale preview, including a release outside the canvas that the shell safety net would otherwise commit.
- **Monitor hit testing:** the transform gizmo root spans the monitor but no longer hit-tests it. Its move box and handles opt in, so a click outside them reaches the canvas and starts the text drag, while a click on the box runs the same style-anchor move through the gizmo. Pointer capture keeps a started gizmo gesture on the root.
- **Playback:** the image cache records the URL it decoded from, so a relink with no project epoch reloads the picture. An audio recovery carries an ownership token alongside its element, is cleared with the failure budget on project replacement, and its late completion can only clear its own lock, so it cannot mute a reused clip id or unlock a newer recovery in the new project. A suspended AudioContext uses the performance clock and re-anchors from the playhead on either clock transition, so a suspension between ticks cannot reuse a stale performance anchor. Presented-frame callbacks are cancelled on release, partner release, and dispose.
- **Offline gates:** `hasOfflineMedia` and `offlineAudibleMedia` share one span-aware walk. A child compound propagates `min(parentLimitEnd, startAt + clip.duration)`, so media a compound never renders cannot block an export; an equivalent sequence window at any root position is scanned once, a compound's unused inPoint does not shift the child window, the walk stops after the first offline hit, and the audio gate still stops at a muted or soloed-out compound.
- **Autosave:** the resume write compares the document it serialized before reporting saved, an older retry completion returns when a newer retry replaced it, and a `read-only` result reports "Autosave off" in both the debounced and resume paths.
- **Hydration and commands:** hydration drops a clip whose material kind does not fit its lane and warns with its own count, and `addSequence` applies the same lane predicate to every supplied clip so an accepted sequence survives a save and reload, the sequence graph check is iterative and throws before a deep chain can overflow the stack, `addClip` normalizes `inPoint` for every kind, `addTrack` refuses an unknown kind, and `setTextStyle` merges then sanitizes through the hydration range. Live placement classifies any string text as text material too, so a clip carrying both media and text is refused on a video or audio lane instead of being accepted and then dropped on reload.
- **Small fixes:** waveform peaks use proportional buckets that include the tail, clean and clear count paired sidecar bytes and size a directory-shaped sidecar quietly so the main entry is still deleted, auto-ducking emits one floor keyframe at a loud clip head, keeps pre-dialogue unity when the attack is zero, and holds the floor one millisecond before snapping back to unity on a zero-duration release, a tail-trim snap below `MIN_CLIP_DURATION` and a move start clamped at zero report no snap guide, a blocked `localStorage` getter falls back to the default workspace, and each indexable route carries its page's rendered date.

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [0.6.4] - 2026-10-06

### Added

- **The Effect Controls graph now draws each segment's real bezier curve, and the active segment's two
  handles shape it.** The graph used to draw dots only, and a segment's easing could only
  be picked from the presets. Every stored pair now renders as its exact cubic: a linear pair as a line,
  an eased pair from its quad, and a subdivided split/trim segment from its own sub-curve data rather
  than re-deriving it from the preset name (an eased segment survives a cut with both halves on the
  original curve). The active segment puts two amber handles on the drawn curve: a drag (one undo step
  through the same transient protocol as the dots) or the arrow keys (0.02 per press, clamped) writes
  that segment's free quad and normalizes the name to `linear`, because a hand-made shape matches no
  preset. A mirrored time-remap row draws `mirrorQuad(stored)` and the pointer maps back through the
  same single conversion, so the drawn curve, the handles and the data cannot disagree.
- **Per-property default easing for newly authored keyframes.** Each property row can store a default
  (linear, easeIn, easeOut or easeInOut). The diamond's first keyframe and a slider-created keyframe
  stamp it as the name AND the preset's exact quad, so a later split or trim subdivides the real shape.
  Derived keyframes (split boundaries, trim rebases, ducking output, paste) keep the shape of the
  segment they came from and never take the default. Defaults are stored on the project, save with it
  and load back; an unknown property or name from a hand-edited file is dropped without throwing.
- The battery gains a 46th step, `f05b curve: handle drag reshapes an eased segment`: it seeds a
  keyframe, writes a second one with the opacity slider, presses `Ease in/out`, arrow-nudges the
  outgoing handle, drags the incoming one with a real pointer event, then undoes every commit and
  asserts the curve is gone, all `data-active-quad` assertions against exact numbers.

### Fixed

- **The curve SVG is now exactly the graph row's box.** An absolutely positioned replaced element
  with a square viewBox takes its size from the 1:1 intrinsic ratio whenever a side is left to
  `auto`, so the overlay came out as tall as the row is WIDE (229px inside a 40px row) and `h-full`
  alone traded that for a box as narrow as the row is tall: either way the viewBox stretched with the
  box and the drawn curve stopped meeting the percent-placed dots (19px off on a 10% value span).
  The overlay pins both dimensions now, the static lock names the classes, and the battery asserts
  the two boxes agree, which is layout no jsdom test can see.
- **Dragging a keyframe dot past its neighbour no longer strands the segment's easing.** A segment's
  shape lives on the keyframe that STARTS it, so a plain time sort moved the pair apart: the new
  start carried no quad (the segment drew linear) while the old start kept a quad for a segment that
  no longer began there. `rehomeSegmentShapes` re-homes each preserved pair's curve onto its new
  start, mirrored when the pair now runs the other way and named for the mirrored preset (`easeOut`
  reads as `easeIn`); a pair that was not adjacent before stays linear and drops the stale quad. Only
  a write that moves ONE keyframe's time counts as a reorder, so the slider re-inserting a keyframe at
  the playhead (which shifts the tail by one index, and on a plateau looks index-aligned) passes
  through untouched instead of dropping a shape.
- **A keyframe dot dragged past another keeps following the pointer.** The drag targeted the keyframe
  by its array INDEX, but the store keeps the array sorted by time, so the moment the dot crossed a
  neighbour the index named the keyframe it had just passed: the grabbed dot froze and the other one
  ran to the pointer on every later frame (and, with the re-homing above, the segment's curve flipped
  back and forth with it). The gesture remembers the time it last wrote and looks its keyframe up by
  it, which is the same rule the dot's own time is written with.

### Changed

- **The easing picker now edits the active segment's start keyframe, not the keyframe nearest the
  playhead.** With the playhead in a segment's second half, or on or past the last keyframe, a press
  used to edit a keyframe whose interpolation changes nothing visible; it now edits the segment the
  user sees, exactly what the handles edit.
- **The easing control is now visible on every animatable property row, including unanimated ones.**
  It used to be absent entirely until a property had a curve; with no keyframes it runs in "Default
  easing" mode (its own caption and aria-label), sets the per-property default above, and a press on
  the already-pressed name is a no-op with no history entry.
- Internal: `ease-segment.ts` gained `mirrorQuad`, `withQuadHandle` and `withEasing`, `keyframes.ts`
  gained `keyframeDefaultEasing`, the command layer gained `setKeyframeDefault`, and hydration keeps
  only known properties and interpolation names in `Project.keyframeDefaults`.

## [0.6.3] - 2026-10-04

### Fixed

- **A video clip with no linked audio twin now exports its embedded audio instead of going silent.** Both export paths picked audio with `asset.kind === 'audio' || clip.audioOnly`, so a video clip whose twin was deleted (or that was never linked) was skipped while the preview kept playing it. The plan and the mix now share one `clipRendersAudio` predicate in `links.ts` that mirrors the preview's shadow rule (`computeGain`), so preview and export cannot disagree again; the predicate requires a playable asset before every branch, so offline media (kind-audio, carrier or solo video) stays out of the plan. The mix's early-out and its scheduling loop now share one `scheduledAudioSource` gate (file, audibility, mute, reverse, rate), so a timeline whose only clips are skipped (muted, reversed or rate-dropped) returns no audio track at all instead of a silent one.
- **A manually linked video part keeps its embedded audio in the export (a decided parity rule, not a side effect).** A manual link has no `audioOnly` carrier, so the preview never shadows its video part; the export used to drop that part and now matches the manual-link rule from 0.6.2. This is a deliberate, user-visible behavior change for manual links: after `Ctrl+L` the kept twin and the unmasked embedded audio both play, in preview and export alike, and the link-id model is unchanged.
- **Auto-ducking resolves each dialogue clip's playability once, not once per sample.** The reversed, rate-changed and offline checks are per-clip facts; they now build the eligible source list before the sampling loop instead of re-running across all 97 samples per music clip.
- **The eased-segment parameter solve shares the bezier solver.** `parameterAtX` had a hand-rolled Newton+bisection copy with a 32-deep fallback while `bezier.ts` used 40; `makeSolveT` is exported and both now solve with the same scheme and depth (the Newton phase is identical, the fallback tightens to about 9e-13), so subdivision data and evaluation cannot disagree about a cut.
- **`setClipDenoise`'s comment now matches the handler**: an off clip stores `false` and the saved file carries `"denoise": false` (hydration reads only `true`, so absent and false load alike; no behavior change).
- **Release notes key each highlight by position**, so two identical lines in one release cannot collide, and the keyframe-dot nudge reads `frameToTime` instead of inlining seconds-per-frame.
- **A foreign easing quad under a linear keyframe name now renders and clears correctly.** Hydration keeps a valid `easeOut` while normalizing an unknown interpolation name to `linear` (every evaluator reads the quad first), but the Effect Controls dot and the easing picker read the name only: the segment rendered eased while the UI showed Linear, and clicking Linear did nothing. The dot's dashed state, the pressed easing button and the clear path now follow the segment's shape, so picking Linear normalizes the foreign data. The picker's no-op guard compares against the displayed interpolation too, so a foreign quad that matches a different preset no longer makes a click on the other name a silent no-op.
- Cosmetic: the stale bisection-depth comment in `bezier.ts` and the em dashes added across docs, comments and `e2e/battery.sh` in the 0.5.6 to 0.6.2 range are gone.

### Changed

- Internal: the trim engine's pure math (the source-fitting bisection, both `timeScale` curve rebases and the source-consumption rule the split command shares) moved to `src/lib/editor/trim.ts`, with direct unit tests; `commands.ts` keeps the policy and dispatch. No behavior change.
- The battery's export step now locks the exported MP4's stream layout: `export_track_kinds` downloads the result and reads its moov/trak/mdia/hdlr handler types, so the first render must carry an audio track while an audible clip exists (which also proves the parser reads non-empty kinds) and, after `mute_all_audio` mutes every audio-capable clip, the second render must carry none. That absent assertion is the browser-level lock on the silent-track regression above, red-first proven against the unfixed code. The Effect Controls same-name guard also gained its missing test: re-picking the displayed preset must keep the exact pre-click quad object, pinned by reference identity (deep data alone cannot tell the no-op from a deep-equal stamp).

## [0.6.2] - 2026-10-04

### Fixed

- **A rate-changing time-remap curve no longer desyncs a linked A/V pair.** A real ramp, or curves that leave the pair's effective rates disagreeing (a flat non-identity constant on one half), now silences both halves (preview, export and ducking alike) instead of playing the twin at its own rate; the identity seed and a solo clip's own constant keep their audio. The predicate `linkGroupHasRamp` became `linkGroupChangesRate`.
- **A clip whose media stops resolving no longer plays on as a ghost.** Removing an asset from the bin while its clips stay on the timeline (recoverable via undo) now stops and releases their pooled elements; the elements return the moment the media resolves again.
- **A rate-changing curve on a clip whose media is gone no longer mutes the half that still plays.** The link predicate ignores members whose media cannot resolve: media that cannot play cannot desync anything.
- **A carrier whose media is gone still holds the pair together.** The rate predicate tested carrier-ness on its playability-filtered member list, so deleting a twin's asset turned the A/V pair into a lookalike manual link and stopped the pair's rate rule from applying; carrier-ness is now tested on the whole group, while the rate comparisons keep ignoring unplayable members. In a merged group this also brings the export plan in line with the preview, which already silences the shadowed member.
- **A manually merged audio clip is no longer muted in the preview.** The twin shadow exists to hide the video part's EMBEDDED audio; a separate audio clip linked into an A/V pair's group has its own track and keeps its own sound, so the preview now matches the export mix, which already played it.
- **A kind-audio clip merged into an A/V pair no longer rate-locks the pair.** The rate predicate folded every playable group member into the comparison, so retiming a music clip linked into a carrier group (even while the pair itself ran at one rate) silenced the pair and the clip alike; the comparison now binds only the group's A/V members (the carriers and the video-bearing parts). The kind-audio clip keeps its own resampled rate and sound and drops its own audio only when it carries a real ramp itself.
- **`releaseMissingClips` and `syncMedia` share one asset test.** A clip whose asset is url-less without being flagged missing, or flipped to an image, has its element released instead of ghosting through a gap between the two predicates.
- **A flat time-remap curve exported audio of the wrong length.** The export buffer duration now reads the curve's constant rate, the same value its playback rate uses, so a 4s clip with a 0.5x flat curve renders 4s of audio instead of 8, and the mirror case no longer ends early in silence.
- **The Effect Controls speed readout now shows the rate the curve applies.** A flat curve's constant is what playback and export use, so the label and the disabled slider report it instead of the stale static speed, falling back to the static value for a real ramp.
- **A loaded project can no longer carry a timeScale curve on a picture-less clip.** Hydration drops the curve when the clip carries `audioOnly` or its media resolves to an audio asset: the curve could only ever silence the link group, and the rows that could clear it are hidden.
- **The export gate now checks the clips the export uses, not the media bin.** A clip whose mediaId no longer resolves blocks the export before it renders black and silent, and an offline asset nothing uses no longer refuses a clean export.
- **Auto-duck no longer dips for dialogue that cannot play.** Restoring a session rebuilds media with a cleared url and `missing` set while the waveform peaks come back from the saved project, so the duck curve dipped the music against source that is never heard; the dialogue curve now requires the asset to be playable before sampling its peaks.
- **A plain static speed difference between an A/V pair's halves now silences the pair.** The rate predicate compared rates only when a `timeScale` curve existed, so dragging the Speed slider (or the Alt-drag rate stretch) on one half played the picture against the twin at its own rate; it now compares every member's effective rate, curve or static, so a disagreement drops the pair's audio exactly like a curve disagreement, and auto-duck no longer dips the music against that silent pair, while equal speeds (including a shared non-identity value) keep it.
- **Manual links are no longer rate-locked.** The rate predicate silenced every member of any link group whose speeds disagreed, so merely linking two clips that already ran at different speeds muted both; the disagreement rule now applies only to A/V pairs (groups with an `audioOnly` carrier), while a clip with its own real ramp still drops only its own audio.

### Changed

- Internal cleanup: `playback/core.ts` uses the shared `hasTimeScaleRamp` predicate, the reversed-`timeScale` axis rule lives in one `rowAxis` helper in Effect Controls, and the dead `COLOR_NEUTRAL` re-export is gone.

## [0.6.1] - 2026-10-01

### Fixed

- **A clip deleted during playback kept playing audibly.** `syncMedia` only
  iterates clips that exist, so nothing paused the deleted clip's element,
  disconnected its nodes, or released it: it stayed audible for the rest of the
  session and a 20x add/delete cycle grew the pool to 22 elements. The engine
  now reconciles the live clip-id set every tick and releases anything absent.
- **A relinked media element was never re-wired into the audio graph.** The
  pool rebuilds the element on a url change, but the cached gain chain keyed on
  clip id plus shaping signature kept feeding masterGain from the OLD element's
  source node (the clip went silent; a denoise toggle then left two live
  chains). Chain entries now record their element and rebuild on identity
  change, which also stops leaking the old source node.
- **One click on the Time-remapping diamond muted the clip and dropped it from
  the export.** The seed curve is the identity, but the mute predicate keyed on
  curve length, so `sourceTimeAt` was provably unchanged while both render
  paths dropped the audio and the Speed slider locked. Ramp predicates are now
  semantic (`hasTimeScaleRamp` = a curve no constant rate can follow; a flat
  curve is resampled at its constant value), and consumption ownership stays on
  curve existence (`hasTimeScaleCurve`) so command-layer duration math is
  unchanged. A flat non-identity curve now drives the element and export buffer
  rate like a constant speed.
- **Export silently produced an all-black MP4 when assets were offline.** A
  restored session's url-less assets skip both the audio mix and every draw,
  then `finalize()` succeeds with a success toast. The export dialog now gates
  its start button on the same condition the preview warns about
  (`hasOfflineMedia`).
- **Cancel and error paths leaked the WebCodecs VideoEncoder.** The `finally`
  only closed decoded frames; mediabunny releases encoders solely through
  `Output.cancel()`/`finalize()`, so each abandoned export pinned a hardware
  encoder until the tab died. The `finally` now cancels any non-finalized
  output.
- **Eased volume exported flat when the shape rode under the linear name.**
  The sampling gate read the keyframe's display name while the preview
  evaluates the segment shape; a project file can carry a valid `easeOut` quad
  under a normalized `linear` name, and the export then rendered a straight
  ramp. The gate now follows the shape (`segmentControls`), the same source the
  preview reads.
- **Hostile project `fps`/`width`/`height` bypassed the command-layer clamps.**
  `deserializeDoc` applied only a finite check, so a hand-edited file could
  install `fps: 1e308` (export frame count `Infinity`, the render loop never
  terminates) or a 100000-wide canvas the UI could never set. Hydration now
  clamps with the same bounds `setProjectSettings` uses.
- **`renderAudioMix` decoded the same media file once per clip.** A music bed
  placed 20 times decoded the identical file 20 times inside one render, each
  allocation alive through the whole mix. Buffers are now memoized per asset id
  (failures included, so a broken file fails once).
- **A multi-frame head trim of a ramped clip anchored off the gesture's
  frozen origin.** `ClipView` derives every pointermove's `inPoint` from the
  snapshot taken at pointerdown, so after the first frame the caller's value
  already contains every prior delta; the rebase re-added them on top of an
  anchor that had already advanced, and the kept span read the previous
  frame's `(integral - spanDelta)` of source too early. The error scaled with
  the pointermove count, so the same gesture differed between 30 and 120 Hz
  (1.48 frames @30fps on a 1x..2x ramp, 4.4 on 1x..4x, and up to 19 on a
  0.25x..2x ramp; a flat 1x curve was unaffected and the one-shot result was
  already exact). The anchor now advances by the consumed integral from the
  live `inPoint`, so the per-move increments compose back to the one-shot
  result.
- **A head trim of an over-consuming ramped clip composed the clamp and the
  rebase into a broken window.** A relink can leave a clip reading past its
  asset's end (a legal saved state the render freezes), and the rebase pins the
  kept span's read end by continuity, so no head position could heal it: the
  clamp's duration and the rebase's anchor produced a window that neither fit
  nor stayed continuous (measured over-runs of 1.66s, 1.90s and 1.32s on the
  repro cuts). The command now recovers after the rebase: hold the rebased
  anchor and shrink the span to fit, or, when the cut fell inside the frozen
  region, slide the window onto the asset's readable tail (the content shifts
  by the over-run, the same cost the Alt-drag recovery accepts). A reversed
  tail move's re-derived anchor recovers the same way, and a head drag keeps
  its right edge anchored.
- **Extending a forward ramped clip's head re-cut the picture.** The rebase
  fired only on a shrink, so the caller's raw inPoint (timeline seconds, not
  the source the reveal consumes) applied as given: on a 1x..4x ramp at inPoint
  10, a 1s extension read [9, 23] where the kept span holds [10, 20]. The
  rebase now covers the extension direction: the curve shifts right by the
  revealed head (exact for any easing, a shift asks nothing of the shape), the
  old head rate constant-extends across the reveal, and the anchor keeps the
  old head's frame minus the reveal consumed at that rate. A REVERSED head extension
  needed no fix (the low anchor is pinned and the mirrored read covers the
  reveal by itself), which the old asymmetry proved.
- **The `!fits` rate-stretch corner paid three whole-document clones per
  pointermove.** The corner validates the pair up front to surface the
  command's own message, but the clamped span cannot change mid-drag, so the
  verdict is now reached once per gesture and reused: a validated pair
  dispatches without a second clone, and a rejected one applies nothing for
  the rest of the drag (previously the two `applyTransient` calls still ran on
  every move after the validation, three clones per frame in the corner).
- **Keyframe dots promised a keyboard path they did not have.** The dots are
  focusable `role="slider"` elements, but the graph wrapper swallowed arrow
  keys to protect the global shortcut, leaving a screen-reader user silence.
  Each dot now nudges its own time by one frame on Left/Right (clamped to the
  clip, mirrored for a reversed time-remapping row so Left moves the dot left
  on screen, stepping while held like a native slider thumb). Fixing this also
  fixed a real focus bug: the dots' React keys contained their time, so every
  move remounted the dot and dropped focus mid-interaction.
- **Splitting an eased keyframe curve re-timed the clip.** A preset easing is
  a function of normalized progress and cannot be re-scaled onto a shortened
  span, so the split halves drifted from the original curve (up to ~1s of
  source). Easing is now DATA: a keyframe can carry the exact bezier control
  quad of its outgoing segment (`easeOut`, hydrating from old files through
  the preset name), and a cut SUBDIVIDES the crossing segment with de
  Casteljau, stamping the exact sub-curves on both halves. Splits, forward and
  reversed head trims and reversed tail trims are now exact for every easing;
  the bezier x-solver was tightened to 1e-9 so the subdivision data survives
  re-evaluation.
- **The slider a11y fix lived in a generated shadcn file.**
  `src/components/ui/` is meant to stay untouched, and the forwarding could not
  ride a root prop (Radix names the `role="slider"` thumb from its own props),
  so the label now travels through an editor-owned `NamedSlider` that composes
  the same primitive; the generated Slider is back to stock and the thumb
  naming is unchanged (tests and the battery still address sliders by role and
  name).
- **Three mirrored and corner trim-window bugs the linear tests could not
  see.** A reversed head trim stamped the crossing segment's sub-curve on the
  array END it appends to, where no segment starts, and re-applied the preset
  name over the shortened span: an eased reversed head trim drifted 6.4e-3 s
  of source where the split and forward paths are exact. The mirrored read
  integrates the kept curve from the source-side origin, so the left
  sub-curve now rides on the last surviving keyframe and the boundary reads
  linear. The reversed-tail guard validated the caller's `inPoint` at the
  requested duration, which is not the window the move produces (a reversed
  tail pins the HIGH end): extending a clip whose high end sat exactly on the
  asset's end was rejected although the reveal below the low anchor was
  legal. And a forward head extension could persist a negative `inPoint` when
  the old head rate exceeded the gesture's static-rate room (a 2x head
  extended 1s from `inPoint` 1 landed at -1); the rebased anchor is now
  validated for bounded material and the move rejected instead of writing an
  unreadable window. Unbounded clips (an image, a text clip, a clip whose
  asset is gone) have no source window: their `inPoint` stays pinned at 0 and
  the rebase never touches it.
- **Constant-rate trims ignored the clip's speed.** `inPoint` counts source
  seconds, but the trim gesture handed over a timeline delta and the rooms
  assumed a 1x span: at 2x, a 1s head trim moved the anchor by 1 source second
  instead of 2 (re-cutting the kept span by the difference), the head room was
  twice the timeline the source actually buys, and the tail room was twice
  over. The command now derives a constant-rate head anchor from the timeline
  move, and `trimRooms` converts the forward rooms through the rate exactly as
  the reversed ones already did. Reversed and ramped paths are untouched.
- **A forward ramped head extension grew its curve on every drag frame.** Each
  `pointermove` dispatched its own `trimClip`, and the extension rebased the
  curve on top of the previous frame's result while unshifting a redundant pin
  keyframe: a 1s drag in 60 steps left 62 keyframes (one per frame, without
  bound), and every later `sourceTimeAt` then scanned 60 extra segments in both
  the preview and the export. The pin changed no rendered value (every reader
  constant-extends the curve before its first keyframe), so it is gone and the
  shifts compose: N steps now land on the exact one-shot curve, at the same
  keyframe count and anchor.
- **An over-consuming head trim that did not move the head re-anchored the
  source below 0.** The over-consume clamp shortens a window that already read
  past the asset, and `spanDelta` counted that clamp as a head shrink, so the
  rebase fired for a head that never left its frame. On a curve slower than 1x
  (`integral - span` negative) the anchor went negative (measured `inPoint`
  -0.2667 for a 0.6x, 4s span at `inPoint` 0 on a 2s asset). The rebase is now
  gated on the caller actually moving the head: a no-movement trim keeps its
  anchor and the shortened span is what fits the asset.
- **Re-picking the active easing un-subdivided a split or trimmed curve.** The
  picker renders a segment's `interpolation` name as its pressed button, but a
  bounded segment also carries the exact subdivided sub-curve in `easeOut`.
  Clicking the already-pressed name rewrote that data with the full-span preset
  (0.34s of source drift at the midpoint on a 1x..4x split eased ramp), so a
  click on a control that looked inert changed the picture. Picking the name a
  keyframe already shows is now a no-op while it carries exact data.
- **`withSegmentControls(kf, undefined)` kept the old `easeOut`.** The doc
  promised `undefined` meant linear, but the spread left any existing field in
  place, so a caller asking for linear silently kept the previous shape. The
  field is now deleted.
- **The battery step-count drift lock, an Alt-drag recovery battery step, and
  the docs battery counts** (45 steps) from the 0.6.0 verification round.

## [0.6.0] - 2026-09-29

### Added

- **Keyframe easing.** Every keyframe carries an interpolation: linear
  (unchanged default), easeIn, easeOut or easeInOut, solved by a hand-rolled
  cubic-bezier evaluator (`bezier.ts`, the Premiere default control points) that
  both render paths share. The easing picker in the Effect Controls graph
  rewrites the active keyframe through the existing `setClipKeyframes` command;
  saved files hydrate the field with unknown names falling back to linear.
- **Speed curves (time remapping).** `timeScale` joins the animatable properties
  (bounds reuse the clip speed limits 0.25..4), and `sourceTimeAt` integrates
  the curve from the clip start, so a clip can ramp from 1x to 4x inside one
  clip. Timeline duration and export frame count never change: what moves is
  where each frame reads its source. The preview steps ramped clips per tick
  (the same parked-seek path reverse uses, so the browser's variable-rate audio
  is never asked to do something it cannot), audio is dropped for a ramp's whole
  link group at all three gain/mix sites through one derived predicate, and
  split redistributes the curve so both halves play the unsplit frames (exact
  for every easing: an eased segment's bezier is subdivided at the cut with de
  Casteljau and the halves carry the exact sub-curves); a trim re-validates the
  kept span through the same integral, and a head trim rebases the curve so the
  kept span keeps reading the frames it read before the cut (eased cuts
  subdivide the same way).
- **Temperature/tint grading.** A white-balance shift (-100..100 each) compiled
  to one SVG `feColorMatrix` per graded clip, referenced by id from both render
  paths' filter chains, so the preview and the export cannot disagree. The
  Inspector's Clip tab gains the two sliders; the file format carries the two
  fields (neutral collapses to absent).
- **Scopes in the monitor.** A collapsible section inside the preview panel
  (default off) draws a luma histogram and an RGB balance meter from a bounded
  256x144 downsample read at ~10 Hz, never the full 4K frame per render.
- **Noise reduction.** A "Reduce noise" switch on audio-bearing clips builds a
  fixed broadband chain (rumble high-pass, hiss low-pass, a gentle peaking cut
  in the hiss band) into BOTH the preview mixer and the offline export mix from
  one shared builder, and joins the shaping signature so toggling it mid-playback
  rebuilds the chain. A rendered-response test measures white-noise band energy
  through the spec biquad formulas (rumble and top octave halved, the speech
  band preserved, the hiss band measurably cut).

### Fixed

- **Preview and export color stacks were two copies of one string builder.**
  They had drifted only in rounding, but that was enough to silently drop a
  saturation of 1.00049 from the preview while the export kept it. Both paths
  now consume one `buildColorFilter` (`color.ts`), locked by static wiring tests
  plus a hardcoded expectation of the exported filter string, so a value can
  never round away on one side again.
- **The reversed-clip trim is proved in pixels.** The new battery step
  `f05_reverse_frame` (the battery runs 45 steps) reverses the trimmed 1.50 s
  video part, parks on the timeline frame at 0.60 s, samples the composited
  monitor, drags the tail left a fixed 0.5 s and re-parks on the same time: the
  kept frame must sample identical. That pins the tail's low anchor end to end
  in the real compositor, which jsdom cannot see. Proven red first: the run on
  the pre-fix pinning failed with a changed frame sample.
- **The battery's clip counter counted the Inspector's sliders.**
  `clipcount()` matched `[aria-label^="Clip "]`, which also matches the
  Inspector's own slider labels, so exact-count assertions silently depended on
  which clip was selected; the new grade sliders (two more such labels) surfaced
  it as a duplicate step failing with "D moved -1 clips". Timeline clips are now
  counted by their testids, the same identity the selection-ring helpers use.
- **The export's EQ bands skipped the clamp the preview applies.** `mp4.ts`
  assigned `clip.eq.{low,mid,high}` raw while the preview clamped them to
  +/-24 dB, so a hand-edited project exported a different EQ than it previewed.
  Both paths now read one named bound from `constants.ts`, locked by a static
  test.
- **The speed controls lied on a clip with a time remapping curve.** The curve,
  not the static rate, decides how a ramped clip consumes source, so the Speed
  slider changed a field the engines never read, the clip badge advertised a rate
  that was not in effect, and Alt-drag rate stretch threw inside `trimClip` and
  was swallowed, so a lengthening drag simply stopped responding. The slider is
  disabled and the badge hidden while a curve exists (with a pointer to the Time
  remapping row), and Alt-drag falls through to a plain trim.
- **Adding a ramped clip applied the constant-rate length rule.** `addClip`'s
  `clampClipToMedia` still divided the remaining source by the static speed, so a
  ramped clip carrying a stale high speed was truncated even though its curve fit
  the asset. The add path and `setClipSpeed` now share one ramp predicate, both
  leaving the curve to decide how much source the span consumes.
- **The export flattened every eased volume curve.** 0.6.0 taught the preview to
  ease with the keyframe `interpolation` field, but `clipGainSchedule` still
  emitted every keyframe as a plain ramp, so the Web Audio automation the
  exporter schedules rendered straight lines where the monitor eased (up to 18
  points of gain on a 4 s fade). An eased segment is now sampled into 16 short
  linear ramps, keeping the two paths within half a percent of each other; a
  linear curve still emits exactly the schedule it always did.
- **A reversed clip's time-remapping row sat on the wrong axis.** `sourceTimeAt`
  indexes a reversed clip's `timeScale` curve at `duration - local`, while the
  Effect Controls row read the playhead, wrote the diamond's keyframe and
  plotted its dots in plain clip-local time, so the whole curve appeared
  mirrored: at local 0 the slider read 1.00 where the engine applied 2.00. That
  row's axis is now flipped to match (self-inverse), for the value, the diamond,
  the slider write and the graph's dots and drags. The two lookups that measure a
  DISTANCE to the playhead (the keyframe the easing picker edits and the one the
  diamond removes) now measure it on that same axis too, so they no longer target
  the other end of the curve.
- **Trimming the head of a reversed clip re-cut the footage.** A head move
  advanced `inPoint` by the caller's timeline-local delta, but a reversed clip's
  head edge shows the span's HIGH end, so the surviving window jumped a full
  head-length up the source: a 4 s ramped clip trimmed to 3 s rendered source
  6.25..1.00 instead of the 5.25..0.00 the retained locals showed. A reversed
  head move now keeps the low anchor and lets the duration carry the change,
  which repairs the long-standing constant-rate case too.
- **A rejected Alt-drag rate stretch applied half of itself, silently.** The
  gesture dispatched `setClipSpeed` then `trimClip` through `applyTransient`,
  which swallows command errors on purpose (slider previews rely on it), so the
  rejection never reached the gesture's `catch`: the speed change stayed applied
  along with the duration it re-derived, and the "Cannot rate-stretch that far"
  toast was unreachable code. The pair is validated against the live doc
  whenever the decision cannot guarantee the trim fits, so a rejection changes
  nothing and the toast fires.
- **The Time remapping row was offered on audio clips.** A ramp drops its link
  group's audio in both render paths, so on an audio-only clip the row could
  never do anything audible: seeding a curve there silenced the pair while the
  picture half (which reads its OWN curve) stayed untouched. The row is
  picture-only now, like the reverse switch; the static Speed slider still
  re-times the audio element. Both gates key off the clip's `audioOnly` flag, not
  only the track kind, because `clipFitsTrack` lets an A/V pair's audio twin move
  onto a video track, where the track kind alone still offered the picture-only
  rows (a ramp seeded there muted the pair).
- **The keyframe graph's dots had no key behaviour of their own.** They are
  focusable `role="slider"` elements, so an arrow key pressed on a focused dot
  drove the global shortcut (frame-step, jump-to-edit) while the dot did
  nothing. The graph wrapper now carries the same arrow guard as the easing
  picker directly above it.
- **The documented temperature/tint gain range was wrong.** Temperature and tint
  sum into the red and blue rows, so the legal square reaches 0.625..1.375 at
  its corners, not the 0.75..1.25 the comment claimed and the axis-only test
  implied. The comment states the real range and the test pins all four corners.
- **The scopes stayed dead after the monitor was resized.** `unavailable` was
  set by the read's `catch` and cleared only by a canvas identity change or a
  close/reopen, while the sampling interval stopped for good; a resize resets a
  canvas's origin-clean flag, so the canvas could be readable again with the
  meters frozen. The interval now keeps running while the banner is up and
  clears the latch as soon as a read succeeds.
- **A reversed clip's tail edge slid the picture instead of trimming.** The
  round-5 fix gave a reversed clip's HEAD the right anchor (its head shows the
  span's high source end, so a head move keeps the low anchor and the duration
  carries the change) but the tail kept the forward rule, which pins `inPoint`.
  A reversed clip's tail is its LOW source end, so pinning `inPoint` moved the
  other end instead: dragging the tail of a 4 s reversed clip to 3 s shifted
  every kept frame one second up the source (a frame that read 3.5 read 2.5
  afterwards) while the edge under the pointer never changed. The tail now holds
  the HIGH end and re-derives the low anchor, mirroring the head rule: for a
  ramped span that is the curve's integral over the timeline the tail gave up,
  plus the curve shifted down onto the new origin with the rate at the cut pinned
  as a keyframe at 0. `trimClip` also takes the moved edge explicitly
  (`edge: 'head' | 'tail' | 'span'`) instead of inferring it from `inPoint`,
  which a reversed tail move cannot be read from, and the trim rooms the gestures
  clamp against are mirrored with it, so a reversed clip's head can extend into
  the source above it (it was refused whenever `inPoint` was 0) and its tail into
  the source below.
- **Every slider in the app was unnamed to assistive tech.** The shared shadcn
  `Slider` spread the caller's `aria-label` onto the Radix root, but the element
  that carries `role="slider"` is the THUMB, and Radix reads a thumb's accessible
  name from the thumb's own props (its built-in Minimum/Maximum labels only exist
  for two or more thumbs). The label therefore named nothing, so the Control
  panel's Temperature and Tint thumbs, whose `<label for>` cannot associate with a
  span either, were announced as unnamed sliders. The shared slider now forwards
  the label to the thumb (a single-value slider only, so a multi-thumb caller
  keeps Radix's own labels), the grade rows use their visible labels, and f05_gain
  reaches the gain slider by role and name instead of a CSS walk.
- **The battery could not tell a failed snapshot from an absent feature.**
  `snap()` discards agent-browser's stderr and every assertion pipes it into
  grep, so a failed, timed-out or empty read looked exactly like a missing
  control. `set -o pipefail` now carries the read's status through the pipeline.
- **f05_gain exercised the wrong slider.** f05_mute switches the Inspector to
  its Effect Controls tab to reach the denoise switch and nothing switched back,
  so the "gain reaches 200%" step sampled the Effect Controls Volume row instead
  of the Clip tab's Gain slider it is named for (the assertion passed because
  both top out at 200%). The step switches back, like f07_export already did.
- **A forward head trim could flatten the ramp it kept.** The rebase's boundary
  test inspected the END of the kept curve, but the forward branch appends its
  boundary keyframe at the START (local 0), so a survivor at exactly `2 * cut`
  shifted onto `cut` and the guard read that as "boundary present": the pin was
  skipped and the kept span played at the survivor's constant rate (flat 2x on
  the repro, 0.5 s of wrong source on the linear 1x..2x fixture, and unbounded
  in general: the error is the survivor's rate gap times the kept duration).
  Each branch now tests
  the end it appends to, and a regression test cuts the existing ramped fixture
  exactly in half, the collision the old guard missed.
- **Alt-drag rate stretch did nothing on a clip that over-consumed its asset.**
  A relink to shorter media replaces the asset and leaves clip windows
  untouched; the gesture held the source span fixed, so the trim's window guard
  rejected every pointer position (one toast, a dead edge). The decision now
  clamps the span to the asset's readable tail, which makes the dispatched pair
  satisfiable again and lets the drag recover the clip, and it reports when even
  the minimum span cannot fit. Only that corner still validates the pair against
  the live doc, so the common path no longer throws away a whole-document clone
  on every pointermove. The new battery step `f02_ratestretch_relinked` proves
  the recovery end to end: it imports a generated 2 s WAV, clips it, saves and
  reopens the project (leaving the file offline), relinks it to a 1 s WAV, and
  alt-drags the tail; the badge must show the clamped 1 s span's rate, not the
  doubled rate a held 2 s span would read.
- **Auto-duck dipped the music under reversed dialogue that can never be
  heard.** Both render paths drop a reversed clip's audio, but the ducking
  guard only skipped ramped link groups, so a reversed dialogue clip still
  drove the duck. It is skipped now.
- **Battery step counts drifted again.** `AGENTS.md` and `docs/structure.md`
  still said 42 steps for a run of 44 (45 with the new rate-stretch step); both
  are corrected, and
  `docs-drift.test.ts` now locks every battery step-count claim to the `step`
  count in `e2e/battery.sh`, so the next drift fails the suite. The never-called
  `clip_named_count` helper (a `grep -c` that exits 1 on a legitimate zero count
  under `pipefail`) is deleted.

## [0.5.6] - 2026-09-28

### Fixed

- **File > Open (and the toolbar's open button) never actually loaded a saved project.** The
  picker handed the file's raw JSON TEXT to the validator, which validates an already-parsed
  object, so every real open failed with "Invalid project file: root is not an object". The bug
  was as old as the project-file feature itself (0.3.0) and invisible to the unit tests, which
  call the validator with parsed objects; only the autosave restore (which parses correctly)
  ever worked. The picker path now runs through the same `parseSerializedDoc` the restore path
  uses, and a new regression test round-trips a real File object. Found by the extended battery:
  the save/open roundtrip step surfaced the silent failure.
- **The menu bar no longer shows a native vertical scrollbar at its right edge.** The bar is 32px
  tall (h-8) while the menu primitive pads 4px vertically and the labels stand 28px (h-7): 36px of
  content in a 32px box, so the bar overflowed by 4 invisible pixels. With the bar declared
  `overflow-x-auto` (for narrow windows), CSS promoted the vertical axis to auto too, and Chromium
  painted a full scrollbar with up/down arrows for an overflow nobody could see. The bar now
  collapses the primitive's vertical padding (py-0, the labels center in the 32px band) and forces
  `overflow-y-hidden`; horizontal scrolling on narrow windows is untouched. Locked by
  `menubar.test.tsx`.
- **The menu bar shows the running version at its right edge.** A small muted `v0.5.6` label sits
  where the stray scrollbar used to be, fed from `releases.ts` (the same gate-locked source as the
  welcome modal, so it cannot drift from package.json). It is static text, not a button.

### Added

- **A welcome modal greets you with what changed recently.** After login, the editor opens a
  release-notes modal once per new version: the last five versions, each with at least four short
  highlights, the newest chip filled emerald and the older ones outlined. The greeting is
  recorded in localStorage (`releases:lastSeen`), so it appears again only when the version
  changes, and it waits until the restore-session prompt is resolved (accepted, discarded, or
  never present) so two prompts never stack.
- **Help > What's new opens the same modal any time.** The menu label follows the running
  version, the row carries a light emerald tint (deeper when highlighted) so it stands out, and
  the entry sits next to Keyboard Shortcuts in the Help menu. Both entry points
  render one shared component (`ReleaseNotesModal`); the version blocks stagger in with a
  short slide and fade that is fully wrapped in `motion-safe:`, so reduced-motion users get
  an instant list.
- **The notes are hand-curated and gate-locked.** `src/lib/releases.ts` holds the compact
  text, distilled at release time, and `releases.test.ts` fails `bun run check` when the top
  entry falls behind package.json, when an entry loses a highlight, or when the versions stop
  ordering newest-first.
- **The E2E battery grew to 42 steps.** New coverage: the welcome modal (Help > What's new opens
  it, a recorded version stays silent on reload), a real non-bundled file import through the
  media bin's hidden input, duplicate (D), copy/paste, unlink (Ctrl+L) and ripple delete
  (Shift+Delete), a save-to-file capture plus File > New and reopening the saved `.veproj.json`
  end to end, and a welcome-modal dismissal in every fresh-start step (the greeting hid the app
  from the accessibility snapshot the battery drives with).

## [0.5.5] - 2026-09-27

### Fixed

- **Split, duplicate and paste no longer share marker ids between copies.** All three clone a clip
  whole, so two coexisting copies could hold markers with identical ids: deleting or editing a marker
  on one left the twin behind (extending a split half later resurrected it) and snap exclusion, which
  matches by id, dropped the twin from the targets. Every clone now re-ids its markers (`splitClip`,
  duplicate, paste).
- **A dragged clip no longer snaps to its own markers.** A clip's markers keep a constant offset to
  its own edges during a move, so a snap that fired once stuck for the whole drag and the clip landed
  away from the cursor. `computeSnapPoints` now skips markers of excluded clips alongside their
  edges, and the clip-marker drag passes its own clip too.
- **The snap guide no longer shows a snap the marker never took.** A clip-marker drag can snap at the
  clip edge and then clamp back inside the span; the guide now appears only when the clamped position
  is the snapped one (`snapGuide` in `snap.ts`).
- **`createMarker` clamps NaN and infinities to 0** instead of passing them through, so a bad input
  surfaces as a clamped marker rather than a thrown command error.
- **A clip move no longer snaps to its LINKED PARTNERS either.** Partners shift by the same delta as
  the dragged clip, so their edges and markers also keep a constant distance to it; the snap-point
  computation now excludes every moving clip, not just the one under the pointer.
- **A marker drag interrupted by an unmount no longer strands the store's transient state.** If the
  owning clip is deleted while a tab drag is in flight, the component's unmount cleanup cancels the
  gesture (guarded by an ownership flag so a lane-change remount never cancels a foreign drag).
  Before, the stranded transient blocked autosave for the rest of the session.
- **The menu bar stops re-scanning every marker on every playback frame.** `hasMarkers` is memoized
  on the doc, whose identity is stable while only the playhead moves.
- **A committed change during a drag gesture no longer corrupts the store.** `apply`, `undo` and
  `redo` now end any live transient: before, the gesture's cleanup could restore its base snapshot
  over the committed change, resurrecting a clip deleted mid-drag or reverting an undo, and the
  gesture's commit folded the foreign change into its single undo step.
- **The marker dialog no longer reopens on redo.** The dialog closes when its marker stops resolving
  (undo while open) and now also clears its edit state, so redoing the marker back does not pop the
  stale dialog open again.
- **Trimming one half of a linked pair snaps to the other half again.** The sticky-snap fix had
  over-excluded the selection partners for every drag mode; only a MOVE travels the partners, so the
  exclusion is now move-mode only.
- **The marker dialog's color swatches follow the radiogroup contract**: arrow keys move the
  selection instead of forcing a keyboard user to tab through all eight, and a second pointerdown
  during a marker drag cancels the abandoned drag instead of folding it into the new one. The
  swatches' arrows also stop at the dialog now, so moving the selection no longer steps the playhead
  (or jumps to the nearest edit point) at the same time.
- **A clip marker parked on the clip's end handle stays reachable.** `M` with the playhead past the
  clip end clamps the new marker to the clip's last frame, exactly where the end trim handle sits;
  the marker tabs now render above the trim handles, so such a marker is still draggable, editable
  and deletable instead of starting a trim.
- **A drag resolves cleanly when a foreign commit lands mid-gesture.** `apply`, `undo` and `redo`
  now roll the live gesture back to its base BEFORE taking the history snapshot, so drag frames
  never leak into `past`/`future` (undo used to restore a mid-drag doc nobody committed to), and
  every gesture slot carries a monotonic token: a drag whose slot was closed applies no further
  pointermove frames, which previously mutated the doc with no undo entry behind them.
- **One pointer owns a drag.** Every drag gesture (marker tabs, clip moves and trims, keyframe
  dots, preview text positioning) captures its initiating `pointerId` and ignores other pointers'
  move/up/cancel events, and the editor shell's dangling-commit safety net no longer ends a live
  gesture because a different pointer lifted. That net's blur listener is registered and removed
  with the same function object, so it cannot outlive the shell and commit a gesture after teardown.
  The release handlers follow the same rule: a clip's `pointerup`/`pointercancel` and a keyframe
  dot's both return early for a pointer that does not own the drag, so a second finger lifting can
  no longer commit the clip or keyframe the user is still moving. The keyframe dot also gained a
  `pointercancel` path that discards the drag without adding a history entry. The marquee box and
  the ruler scrub follow the same rule: a second pointer over the lanes no longer steers the box or
  resolves a partial selection when it lifts, and a second pointer on the ruler no longer ends the
  scrub (the ruler hands ownership to the newest pointerdown, so a lost `pointerup` cannot leave it
  unresponsive).
- **A sequence marker can no longer be parked past the sequence end.** The playhead is clamped to
  the sequence, so such a marker was unreachable: `Shift+M` returned it on every press and the
  playhead sat at the end forever. Adding (`M`) or dragging a sequence marker now stops at the
  sequence end, and navigation treats a marker already beyond it as a non-target (it stays visible on
  the ruler and in the project, it just cannot be sought to). The Marker menu's Go to Next/Previous
  Marker items use that same reachability predicate, so they grey out instead of offering a jump that
  would do nothing.

### Added

- **Markers on the timeline and on clips.** `M` drops a marker at the playhead: on the primary
  selected clip when one is selected (anchored to its SOURCE time and clamped into the visible span,
  so trims, speed changes and reversal keep it on the same media frame), otherwise on the sequence
  ruler. A marker carries a name, one of eight Premiere-style colors and notes (double-click a tab,
  use its context menu, or pick Marker > Edit Selected Marker). `Shift+M` / `Ctrl+Shift+M` seek to
  the next/previous reachable marker without wrapping, clicking a tab seeks and selects it, `Delete`
  removes the selected marker, and markers are snap targets for clip moves and trims in both
  directions (a dragged marker snaps to clips too). A trim that pushes a clip marker outside the
  visible span hides it while keeping it in the project, and extending the clip brings it back. The
  pure marker engine lives in `markers.ts` (`markers.test.ts`); the keyboard map, store selection and
  timeline UI are locked by `markers-keyboard.test.tsx` and `markers-timeline-ui.test.tsx`, and the
  E2E battery grew to 33 steps covering the sequence and clip flows.
- **A Marker menu** (after Sequence) and the matching Help > Shortcuts rows. Clip mute moved from
  `M` to `Shift+E`, the closest mapping to Premiere's clip enable on that key; the menu's displayed
  shortcut follows the real keybinding, and the Inspector's shortcut list now matches the map too
  (S snapping, Ctrl+K split, M add marker, Shift+E mute).
- **The docs test-count lock now covers the per-file inventory, not just the totals.**
  `docs-drift.test.ts` only checked the repo-wide headlines, so a row of `docs/testing.md` could
  drift from its suite unnoticed, and two rows collapsed onto one physical line dropped both files
  from the table while the headline total still matched. It now requires every row to name a real
  test file with that file's real case count, one row per file, and rejects a row whose cells were
  merged or whose first cell is not a backticked filename (only the header and separator rows are
  skipped).

### Changed

- **Project files are version 2.** Sequence markers (`project.markers`, timeline seconds) and clip
  markers (`clip.markers`, source seconds) serialize with the project; version 1 files still load
  (with no markers), and a file written by a newer app version is refused instead of loaded
  partially. The autosave key stays `web-video-editor:autosave:v1`, since the payload itself is
  versioned.
- **Timeline snapping now includes markers** (sequence markers plus visible clip markers), and a
  dragged marker is excluded from snapping to itself.

## [0.5.4] - 2026-09-27

### Added

- **Marquee (box) selection on the timeline.** Drag on empty lane space to select every clip the box
  covers; each hit clip's A/V link group expands as one unit, **Shift** adds the covered groups,
  **Ctrl/Cmd** toggles them, and a drag that crosses nothing clears the selection. A click that never
  moves keeps the old deselect behavior. Pushing the box against an edge auto-scrolls the timeline on
  both axes through the same 1px-to-14px ramp the clip drag uses. The hit math and the selection
  resolution live in the pure `marquee.ts` (`marquee.test.ts`); the pointer and auto-scroll lifecycle
  live in `TimelinePanel`. `marquee.ts` is part of the coverage gate, and the E2E battery covers the
  gesture (box drag selects, empty-space click clears).

## [0.5.3] - 2026-09-23

### Fixed

- **A restored session looked broken: black monitor, no explanation, no way back.** A restore (like a
  project load) hydrates every asset offline, because object URLs cannot survive a reload, and the
  engine correctly plays nothing for them. What was wrong is that the bundled samples could never come
  back: their bytes are the app's own, but "Load sample media" de-duped by name only, so with the
  samples already in the bin (all offline) it answered "already loaded" and never refetched them, and
  a sample-based project has no file on disk to pick in a manual relink. Samples now refetch and
  relink themselves on every restore or project load, and the button refetches offline samples instead
  of dead-ending. Imported files still need one manual relink, for the honest reason that the browser
  no longer has their bytes.
- **The monitor now says why a frame is black.** While the playhead sits on a clip whose media is
  offline, the preview paints **Media offline** with the file names and a relink hint, so a black
  frame no longer reads as a broken preview. Locked by `offline.test.ts` (per-frame detection) and the
  sample plan tests in `media-pool.test.ts` (fresh adds and offline relinks).
- **A restore or load is one undo step again.** The automatic sample recovery installed the doc first
  and then applied one `relinkMedia` command per refetched file, so a restore left two or three extra
  history entries behind: a single Ctrl+Z dropped one sample back to offline and blacked out the
  preview again. Samples are now merged into the document before it is installed (`hydrateSampleMedia`),
  so the load stays exactly one undoable operation.
- **Overlapping sample loads can no longer leave twin assets.** The media bin's re-entrancy ref only
  guarded one component instance, so a second load (another press landing while the first was still
  fetching, or a restore racing the button) could pass the dedup check and add a second asset with the
  same name and the same bytes. Overlapping calls now share one run, every write re-checks the live bin
  through `sampleImportAction`, and a batch is bound to the project that planned it: opening or
  restoring another project mid-flight drops the rest of the batch instead of writing the old
  project's files into the new one.
- **A relinked asset keeps the bytes the exporter reads.** Both relink sites built their own patch and
  both omitted the source `file` handle, and `mp4.ts` skips every video asset without one: a clip that
  was relinked after a restore played in the preview but silently vanished from an MP4 export. The
  patch fields now live in one place (`media/relink.ts`) and carry the handle.
- **A manual relink no longer recycles the old file's metadata.** The relink patch preserved a
  thumbnail, waveform and audio flag the previous file had produced, so replacing an asset with a
  different file kept the old thumbnail and still claimed to carry sound (which also corrupted the A/V
  split for future imports of the same asset). The manual relink now clears metadata the new file does
  not provide; sample recovery keeps preserving it, because it refetches the same bundled file.
- **A slow project load can no longer clobber a newer one.** While a load's sample hydration was still
  fetching, another open could install a different project first, and the slow load then overwrote it
  on landing, along with a success toast for a project the user had already left behind. All project
  opens now run through one shared coordinator (`openProjectFile`) that numbers each request and drops
  everything but the newest, and every other installer (File > New, session restore) invalidates
  in-flight loads too, so a pending open can never overwrite a project installed by any other means. A
  canceled file picker no longer invalidates a load that is already running, and the toolbar's open
  button no longer makes the user choose the same file twice (the file its input picked goes straight
  to the coordinator instead of triggering a second picker). Sample-recovery failures during a load
  are reported by the coordinator after its staleness check, so a load superseded mid-fetch can no
  longer raise stale error toasts for a project the user already left behind.

## [0.5.2] - 2026-09-22

### Fixed

- **Preview went permanently black after scrubbing during playback.** Every ruler move sought the
  media elements with force, and the drift corrector re-seeked whenever the element lagged the
  master clock by more than 120 ms. A seek is not instantaneous: the readback position updates
  immediately but the decoded frame arrives later (roughly 130 to 300 ms on a scrub longer than a
  second), so each re-seek interrupted the previous one and the element never finished a decode:
  black picture, no audio, playhead advancing, for the rest of the timeline. The engine now leaves
  an element with a seek in flight strictly alone: the seek completes, the frame lands, playback
  and audio resume. The drift threshold also moved above the worst-case seek latency (0.4 s), so a
  landed seek converges instead of reading as fresh drift. Locked by a mocked-browser test that
  models real seek latency.
- **Restored sessions played nothing in the preview even after relinking.** Restored assets have no
  URL until relinked, but the engine still built elements for them (empty sources stuck in
  error-state) and the relink path left elements stuck in the same seek-starvation loop as above.
  Missing assets are now skipped entirely (no phantom elements, no autoplay attempts on empty
  sources), and a relink swaps a live element in on the very next frame. Locked by tests for both
  the missing-asset skip and the relink recovery. The skip covers the paused scrub path too
  (`drawStill`), which still materialized a phantom `<video src="">` after the main fix.
- Scrubbing on the ruler now pauses playback first, as in Premiere. Dragging the playhead with the
  clock running was the one path that injected a force-seek per pointer move, and it could start the
  starvation loop above even with the seek guard in place. Playback state is restored on the next
  play press; the frame under the playhead is drawn while paused.

## [0.5.1] - 2026-09-22

### Fixed

- Splitting an animated clip preserves its curves. Both halves now get the curve's value at the cut as a
  boundary keyframe, so each half evaluates exactly what the unsplit clip did inside its own span. A ramp
  crossing the cut used to freeze on the left half (or fall back to the static value when the half held no
  keyframes), while the right half jumped straight to its first remaining keyframe.
- Auto-ducking holds the music at the ducked level for as long as dialogue is loud, then releases over
  `attackRelease` once it ends. The release ramp used to start back at the duck itself, so the music crept
  back toward full volume through the dialogue and was already at unity when the dialogue ended. The
  release endpoint is clamped to the clip edge (the clamp runs after the millisecond rounding, so a
  fractional clip length cannot round the last keyframe back outside the clip), and a duck still
  active at the edge simply holds the floor instead of stacking two keyframes on the same instant.
- The export audio gain schedule is sorted chronologically before it is handed to the AudioContext.
  No audible change: browsers keep a time-ordered event list regardless of insertion order, so this is
  a contract cleanup, not a bug fix.

## [0.5.0] - 2026-09-21

### Added

- **Keyframes with an Effect Controls panel.** Opacity, position X/Y, scale, volume and the color
  set (exposure, contrast, saturation, brightness, hue) are animatable per clip. The Inspector gains
  a Clip / Effect Controls tab split; each property row has a keyframe diamond (adds/removes at the
  playhead), a value slider and a light graph whose dots drag in time. Keyframe times are clip-local,
  interpolation is linear (an `interpolation` field exists so eased curves can land without a schema
  break), `splitClip` redistributes the curves, and every keyframe drag is one undo step through the
  transient gesture protocol.
- **Auto-ducking.** The Effect Controls audio section can compute a volume-keyframe curve for a
  music clip that dips under overlapping dialogue, estimated from the imported waveform peaks
  (`ducking.ts`), with a dialogue-source picker. The generated curve is undoable like any edit.
- **Audio shaping: pan, 3-band EQ, compressor** per clip, all native Web Audio nodes
  (`StereoPannerNode`, three biquads at 200 Hz / 1 kHz / 4 kHz, `DynamicsCompressorNode`) in both
  the preview graph and the offline export mix. The preview bakes these settings into a per-clip
  chain and rebuilds it when any of them changes, so an edit is audible without restarting playback.
- **Clip speed and reverse.** A per-clip speed scalar (0.25x..4x) with an Alt-drag rate-stretch
  gesture on either clip edge (`decideRateStretch`: source span fixed, speed re-derives, clamped)
  plus an Inspector slider. Reverse is a per-clip toggle; the export renders it frame-accurately,
  the preview shows a stepped approximation (video elements cannot play backwards in realtime), and
  reversed audio is dropped, as Premiere does. Clips show speed and reverse badges on the timeline.
- **Offline MP4 export via WebCodecs (Mediabunny).** The MediaRecorder/WebM pipeline is retired.
  The new exporter walks a pure frame plan (`export/offline.ts`), decodes source frames
  frame-accurately with `VideoSampleSink` (which is also what makes reverse and exact speed work),
  composites the animated/keyframed doc onto an offscreen canvas, encodes H.264 through
  Mediabunny's `CanvasSource`, and mixes audio through an `OfflineAudioContext` into an AAC track,
  falling back to Opus where the browser cannot encode AAC (desktop Linux, Firefox). Export needs
  no tab focus and no realtime capture, and produces a real MP4 with a correct duration header.
  Every track is opened before the output starts, which Mediabunny requires. Text overlays render
  through the same `drawTextClip` the preview compositor uses, and crossfade audio ramps ride a
  separate gain node so an exported dissolve blends exactly like the preview mix.
- **Color pass.** Per-clip exposure/contrast/saturation/brightness/hue applied through `ctx.filter`
  in both preview and export, so what you see is what you render. `buildFilter` skips the filter pass
  entirely at neutral values.
- **`MediaAsset.file`** keeps the source File for the session so the export can read frame-accurate
  data (object URLs cannot); it is stripped by serialization like the URL.

### Changed

- The README's feature list, limitations and export section now describe the MP4/WebCodecs pipeline
  (the WebM duration-header quirk is gone with the old exporter). The export dialog says the same:
  an offline frame-accurate render whose wall time tracks source decode, not playback speed.

### Fixed

- Reverse reads source frames backwards in the preview and in the export. The plan and the preview
  both used a forward source position, so a reversed clip rendered forward; the mapping now lives in
  one place (`sourceTimeAt`) and mirrors the source span for reversed clips.
- A clip that starts at 0:00 no longer exports silent. The mix scheduled a zero gain on the same
  instant as the clip's own gain, which muted the whole clip; the automation is now a pure schedule
  (`clipGainSchedule`) with the pre-start guard only applied to later clips.
- Text overlays now export. The frame plan already carried text draws, but the composite step skipped
  any draw without a decoded frame, and text clips have none.
- The export audio mix follows the preview's crossfade ramps again (`clipCrossfadeSchedule`), so a
  dissolve no longer hard-cuts in the exported audio.
- Project save/load keeps the 0.5.0 fields. Speed, reverse, pan, EQ, compressor, `animStatics` and
  keyframe curves are hydrated, clamped and sanitized on load instead of silently dropped, so an
  autosave restore no longer loses animation or re-timing work.
- EQ, compressor and pan edits are audible in the preview as soon as they change, instead of waiting
  for the clip's audio chain to be rebuilt for some other reason.
- A keyframe dot drag is one undo step again: the dot snapshots the transient base on pointerdown and
  commits on release, rather than pushing a history entry that undoes to the already-moved curve.
- Splitting a reversed clip keeps the source traversal: the right half keeps the original `inPoint` and
  the left half moves up by the right half's source span, so both halves read the same frames the
  unsplit clip did (forward clips are unchanged).
- A scaled clip (or title) grows from the frame center in the preview and the export: the offsets are
  computed from the scaled size instead of the fitted size, so a 2x scale no longer drifts right/down.
- A speed change reaches a clip that is already playing instead of waiting for the next pause.
- Volume, pan, EQ and compressor edits on one half of an A/V pair are routed to the audio twin, which
  is the pair's sound carrier; before, editing the video half wrote settings nothing could hear.
- Export waits for image decodes before the first frame (a still-decoding image left early frames
  blank) and closes each frame's decoded surfaces as it moves on, instead of holding every bitmap
  until the render ends.

## [0.4.5] — 2026-09-20

### Changed

- **The TypeScript configuration now matches the "strict" claim.** `noImplicitAny` is on,
  `typescript.ignoreBuildErrors` is removed from `next.config.ts`, and `reactStrictMode` is enabled
  (double-render issues in the engine path can no longer hide). No implicit-any errors surfaced: the
  codebase was already typed as if strict were fully on.
- **The verification gate is honest about what it is.** There is no CI server; docs now say "the
  verification gate" instead of implying a CI system exists. `bun run check` remains the golden
  rule after any change.
- **The timeline's gesture logic is now pure and tested in Node.** Lane hit-testing, cross-lane
  compatibility, snap edge choice, trim clamping and selection-partner shifting moved from
  `ClipView` into `src/lib/editor/clip-gesture.ts` with injected geometry (24 new tests). The
  component keeps rendering and DOM wiring; behavior is unchanged.

### Added

- **First React-render tests in the gate.** `timeline-panel-ui.test.tsx` (jsdom + Testing Library)
  renders `TimelinePanel`, asserts lanes and clip markup, and locks the drag commit contract:
  a whole gesture becomes exactly one undo entry, and a cancelled gesture leaves no history.
- **A docs drift lock.** `docs-drift.test.ts` parses the test-count claims in README, testing.md,
  structure.md and AGENTS.md and fails the gate when they disagree with the real suite. Repo-wide
  totals must match exactly; the scoped `src/lib/editor/__tests__` directory counts are compared
  against the real directory contents; unnamed scoped claims get an internal-sanity range. This is
  the mechanical version of testing.md's own "update the counts" convention, which had drifted twice.

### Fixed

- **Two snap-vs-clamp bugs in the extracted gesture math** (`clip-gesture.ts`): a snap point within
  the snap threshold but past the media boundary could override the raw clamps. On tail-trim the
  clip could extend past the asset's end; on head-trim the start could be pushed outside the legal
  window (revealing trimmed source or shrinking below the minimum duration). Snap results are now
  accepted only inside the same bounds the raw path clamps to; both locked with regression tests
  proven to fail on the unfixed code.
- `docs/testing.md`: the `compositing-ui.test.ts` inventory row was glued onto the `av-links.test.ts`
  line (second occurrence of this bug class; now prevented by the drift lock).
- `docs/testing.md`: the E2E battery was described as "28 steps"; it runs 29.
- Removed the orphaned `tailwind.config.ts` (Next starter default, unreferenced; Tailwind 4 tokens
  live in `globals.css`).
- Removed `rethrowFriendly` in `store.ts`, a catch block that rethrew the same error unchanged, so
  the surrounding try/catch did nothing.

## [0.4.2] — 2026-09-20

### Changed

- **Session cookies are no longer signed with the password itself.** The HMAC key is now derived from
  two materials: the new `GATE_SECRET` (independent, machine-generated — `openssl rand -base64 32`)
  and `GATE_PASSWORD`, via `sessionKey()`. Neither value alone can mint or verify a cookie; a stolen
  cookie can no longer be brute-forced for the password offline (the attacker lacks the secret);
  rotating the password still invalidates every live session at once. This revises 0.4.1's recorded
  decision, on review: the cost is one more env var, and it removes a whole attack category instead
  of arguing likelihood.
  - **Production refuses to boot without `GATE_SECRET`** — a silent password-only fallback there
    would quietly reopen the hole. Local dev without the secret falls back to password-only signing
    and prints a one-time warning, so the repo stays contributor-friendly.
  - The password never signs anything directly — it authenticates logins (`verifyPassword`) and is
    one of the two inputs to the signing-key derivation (`sessionKey(secret, password)`), so rotating
    it still rotates the key; the raw password is never the HMAC key itself.
  - 11 new tests: both-materials derivation, legacy-cookie rejection (old-scheme cookies do not verify
    and vice versa), rotation invalidation, cross-material rejection, and the full env-resolution
    matrix (open / both-set / production-throws / dev-fallback) plus init-caching semantics — the
    gate resolves once per process at init (a production misconfiguration surfaces at boot, not on a
    user's first request), the gate-open result is memoized correctly (a `??=` would have re-resolved
    it forever, caught by test before it shipped), and the dev-fallback warning fires exactly once.
    306 → 317 tests.

## [0.4.1] — 2026-09-20

### Fixed

- The gate proxy's asset bypasses matched by **prefix** (`startsWith('/icon')`), so a future route
  named like an asset (`/icon-admin`, `/favicon-api`) would have skipped the gate silently. The
  bypass set is now exact paths only (`/gate`, `/api/gate-login`, and Next's dev-only hot-reload
  endpoint); static assets stay handled by the matcher's exact exclusions. Locked by a static-source
  test that fails if a `startsWith` ever returns to the proxy's path logic.
- `docs/testing.md` was missing the `gate.test.ts` row from the per-file inventory (totals said
  27 files / 304 tests with only 26 rows listed); row added, totals updated to 27 / 306.
- `docs/deployment.md` claimed "the only route served without one [a session]" — inaccurate, since
  the login POST and static assets are also reachable unauthenticated. Reworded to name the real
  bypass set.

### Security decisions (reviewed, declined on purpose)

- **Server-side throttle store.** The failure counter lives in a signed cookie, so a client can reset
  it by clearing cookies or replaying an older value — any client-held state is client-controlled by
  definition. The real fix is server-side state, i.e. an external service for a friction feature on a
  private deployment. Declined: the password's entropy is the actual security boundary; the ramp only
  slows casual guessing. Revisit if the deployment ever becomes a target.
- **Independent signing secret.** The session cookie is signed with the password itself, so an
  attacker holding one valid cookie could brute-force the password offline from it. A second random
  env var mixed into the HMAC key would close that — but the scenario requires already possessing a
  valid cookie, which on HTTPS + HttpOnly means the attacker is effectively in anyway. Declined in
  favour of a strong password; cheap to add later if the threat model changes.

## [0.4.0] — 2026-09-20

### Added

- **Access gate** — a password-protected entry zone for public deployments (e.g. Vercel). Next 16's
  `src/proxy.ts` (the renamed middleware convention) checks a signed session cookie on every request;
  without one, only `/gate` — a minimal, token-styled password screen with zero client JS — is ever
  served, so the app bundle never reaches an unauthenticated visitor.
  - Password comes from the `GATE_PASSWORD` environment variable (`.env.example` documents it; unset
    means the gate is open, so a checkout without the variable is not a mystery outage). It is never
    committed to the repo.
  - Sessions last 24 hours (daily re-login), HttpOnly + SameSite=Lax + Secure in production, signed
    HMAC-SHA256 with the password itself — rotating the password invalidates every live session.
  - Constant-time password comparison; failed attempts counted in a second signed cookie with an
    escalating delay ramp (3 free tries, then 15 s doubling to a 15 min ceiling).
  - 11 unit tests for the sign/verify/expiry/tamper/throttle primitives (`src/lib/gate.test.ts`);
    verified against the production server with a real browser: stranger redirect, blocked deep
    routes, wrong/right password, throttle lockout even for the correct password, expiry, and the
    editor loading after login.
  - E2E battery gains a gate-login step (`g0`) and runs 29/29 against the gated build.

### Fixed

- Login redirects use relative `Location` headers. Absolute URLs built from `nextUrl` normalise the
  origin (e.g. `127.0.0.1` → `localhost` behind the standalone server or a reverse proxy), which
  stranded the fresh session cookie on the wrong host and re-fired the gate right after a correct
  login — found by the battery, not by reading code.

### Changed

- `.gitignore` exempts `.env.example` from the `.env*` rule so the documented variable ships with the
  repo; docs (`deployment.md`, `testing.md`, `AGENTS.md`) describe the gate, the battery login step,
  and the new inventory counts (27 files, 304 tests).

## [0.3.5] — 2026-09-20

Makes the timeline's layers behave the way a layers panel is expected to: a clip can be dragged onto
any layer, a layer can be deleted, an empty layer does not linger, and adding a layer no longer hides
the clips you meant to move onto it. Every claim below was reproduced against the running UI before it
was fixed; 293 unit tests, typecheck, the production build and the 28-step E2E battery are green.

### Added

- **A track-header context menu** (`TimelinePanel.tsx`): Rename Track…, Mute/Unmute Track, Delete
  Track. `renameTrack` and `removeTrack` existed in the command set but were dispatched by nothing, so
  neither was reachable from the UI at all. Delete is disabled for the last remaining lane (the model
  forbids removing it) and renaming is also on double-click.
- **Empty layers are removed by the edit that empties them** (`tracks.ts`, wired into the store). The
  clip move that takes a lane's last clip takes the lane with it, in the same history entry, so one undo
  restores both. A lane that was ALREADY empty is never removed — that is what keeps "add a layer, then
  fill it" working — and the last lane always survives.
- **Drag edge auto-scroll** (`timeline-scroll.ts`, `ClipView.tsx`): holding a dragged clip near the top
  or bottom of the track area scrolls it, ramping from 1px to 14px per frame with depth, so a clip can
  be dropped on a lane that is outside the visible rows.
- **Refused drops explain themselves**: a clip dragged over a lane of the wrong kind marks that lane
  while the pointer is over it and toasts the reason on release, instead of snapping back in silence.
  The refusal is total — the drag keeps applying the legal half of the gesture (the time shift, on the
  original lane) while the pointer sits over the blocked lane, so the drop cancels the transient edit
  rather than committing it and landing the clip at a new time under a toast saying the drop was
  invalid.

### Fixed

- **A clip drag went dead at the first lane it crossed** — the real reason "I cannot move the audio to
  another layer". A clip that changes lane is rendered inside THAT lane's clip list, so React unmounted
  the component mid-gesture: its pointer capture, its handlers and its gesture state died with it. The
  clip landed on the first lane it crossed into and every later pointer move was ignored, so a
  multi-lane move silently became a one-lane move. The gesture is now driven by listeners on `window`
  that outlive the element (and remove themselves when it ends), so a drag follows the pointer across
  as many lanes as it visits and commits as a single undo step.
- **Adding a track hid the lanes you were looking at.** A new lane takes its slot above the other lanes
  of its kind, pushing everything below it down by one row — and with only about two rows visible at a
  typical window height, the lane holding your clips scrolled out of view, which is what made the new
  layer look unusable. The timeline now scrolls by exactly the height of the inserted row, cancelling
  the shift; the browser clamps it, so when every lane still fits nothing moves at all.
- **The auto-scroll loop compounded into runaway scrolling.** Replaying the move inside a frame called
  back into `syncAutoScroll` with the handle already cleared, queueing a second loop on top of the
  running one — the scroll rate grew every frame (178px in under half a second). The next frame is now
  queued before the replay, and the rate holds at 1px per frame near the inner edge.
- **A second drag could steal the history base of the one already running.** `beginTransient()`
  snapshots the doc, and there is only one snapshot: the gesture start guarded against another drag
  with a per-INSTANCE ref, so a drag begun on a different clip (a different `ClipView`, with its own
  ref) was invisible to that check and overwrote the base — leaving the first gesture to push a base
  that was not its own. The shared store flag (`isTransientActive()`) is now consulted, and a second
  drag is refused while the first is live (the click still selects, it just cannot start a drag on top
  of one).
- **The "commit any dangling gesture" safety net pre-empted the gesture it was meant to back up.**
  `EditorShell` registers it on `window` at mount, so in the bubble order it ran BEFORE the drag's own
  pointerup listener and committed the edit before the gesture could decide anything — a refused drop
  that must roll back was frozen into history instead. The gesture's end handler is now capture-phase,
  which the DOM always dispatches before bubble listeners, so the owner decides first and the net only
  ever sees a closed transient.
- **Stale lane geometry resolved drops onto the wrong lane.** The lane boxes were captured at
  pointer-down and never refreshed, so any scroll — auto-scroll, a wheel, a resized timeline — left them
  pointing at the wrong rows. They are re-read on every move.
- **Choosing "Rename Track…" swallowed every keystroke.** The rename field mounts as the menu closes, and
  Radix hands focus back to the header just after, so the field was on screen but never focused — the
  name you typed went nowhere and Enter committed nothing. Only the menu path was affected (double-click
  rename has no menu to fight); the menu's close-focus restore is now suppressed for that one item and
  the field takes focus a frame later.

### Notes

- `removeTrack`, `renameTrack`, `addTrack` and the clip-move command were all correct; the failures
  reproduced here were reachability and gesture-lifetime defects in the timeline UI, not in the state
  core. No command semantics changed.
- The E2E battery gained no steps: the new behaviour is covered by `tracks.test.ts`,
  `timeline-scroll.test.ts` and the source-wiring locks in `compositing-ui.test.ts`, which is where this
  repo already keeps the assertions that need real layout to mean anything.
- The docs moved with the code: `structure.md` and `architecture.md` gained the two new modules (plus
  the prune invariant), `flows.md` the layer-management and drag flows, `design-system.md` the new
  blocked-lane state, and `testing.md` / `README.md` the new inventory totals.

## [0.3.1] — 2026-09-20

Three follow-ups: the dev server now reports failures honestly, the UI layer keeps only the components
the editor actually uses, and the 28-step UI battery scrolls each control into view before clicking it.
No editor behavior changed — 266 tests, typecheck and the production build are green. The battery passes
28/28 with identical results across runs; before the harness fix it reported 25/28 on the same app code.

### Fixed

- **The `dev` script reported success when the server failed to start** (`package.json`).
  `next dev … 2>&1 | tee dev.log` returns `tee`'s exit status, so a boot failure (port already in use,
  a startup crash) still exited 0. It now runs under `set -o pipefail`, matching `start`. Proven by
  occupying the dev port: the old pipeline exited 0, the new one exits 1.
- **The UI battery clicked off-screen controls** (`e2e/battery.sh`), failing three steps on a short
  viewport. The Inspector and the timeline are scroll areas shorter than their content, so a control
  below the fold has no clickable coordinates and the blind click lands on whatever is painted at that
  point instead — the Timeline header for the Inspector switches, the app footer for the audio clip.
  `f03 crossfade`, `f05 mute` and `f05 gain` all failed this way, and `click_clip` was silently missing
  its target in `f07 export prep` (a step that returns success unconditionally, so it never surfaced as
  a failure). Every target is now scrolled into view before it is touched — `insp()` for Inspector
  controls, `click_clip()` / `delete_clip()` for clips, and the spinbutton fills. This was a harness
  defect only: the app was verified correct by scrolling and clicking the same controls live, and the
  battery now reports 28/28 with byte-identical results across runs.

### Removed

- **30 unused shadcn/ui primitives** (`src/components/ui/`), leaving the 18 that app code actually
  reaches: badge, button, context-menu, dialog, dropdown-menu, input, label, menubar, progress,
  resizable, select, separator, slider, switch, textarea, toast, toaster, tooltip. The set was trimmed
  as a transitive closure, so a primitive imported by a kept primitive (or by app code outside `ui/`)
  was never removed; `bunx shadcn add <name>` restores any of them.
- **23 dependencies that existed only to back those primitives**: the `@radix-ui/*` packages those
  files imported, plus `recharts`, `embla-carousel-react`, `cmdk`, `vaul`, `input-otp`,
  `react-day-picker`, `react-hook-form`, `sonner` and `next-themes`.
- **17 dependencies that were already dead** — unreferenced by `src/`, the root config files or
  `globals.css`: `framer-motion`, `next-auth`, `next-intl`, `zod`, `uuid`, `date-fns`, `sharp`,
  `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `@hookform/resolvers`,
  `@tanstack/react-query`, `@tanstack/react-table`, `@mdxeditor/editor`, `react-markdown`,
  `react-syntax-highlighter` and `@reactuses/core`. (`sharp` is safe to drop because the app uses no
  `next/image`.) Runtime dependencies go from 63 to 23.

### Changed

- `theme.test.ts`'s portal-primitive guard drops its `popover.tsx` entry, since that file was removed
  with the trimmed primitives. The guard still covers menubar, dropdown-menu, select and dialog.
- Documentation re-synced with the code after the trim: the ui-primitive count (48 → 18) in
  `design-system.md` and `structure.md`; the menu action-id count (28 → 36) in `architecture.md`; the
  `setClipOpacity` row that was missing from the README's command table; and the `framer-motion`,
  `next-themes`, `sonner` and `popover` references that no longer exist in the project. The shadcn
  restoration command reads `bunx shadcn add <name>`, matching the project's Bun-only tooling.

## [0.3.0] — 2026-09-20

Repository hygiene pass: the project no longer carries any leftovers from the scaffold it was
bootstrapped from — unused vendor tooling, branding assets, and dead backend scaffold are gone. The
documentation set is complete and cross-linked, and a single `bun run check` gate now mirrors CI. No
editor behavior changed — the 266 tests stay green and the production build is unchanged.

### Removed

- **Vendor traces from the starting scaffold.** An unused vendor SDK dependency, its remote favicon,
  and the bundled vendor logo (`public/logo.svg`) are gone.
- **Deployment scaffolding** that never ran in this app: `.zscripts/` (nine template build/dev/start
  scripts), `Caddyfile`, and `tests/*runtime*.sh`.
- **Unused example and inbox folders**: `examples/websocket/` (it imported `socket.io`, which was never
  a dependency), `upload/`, `download/`, and `mini-services/`.
- **Unused backend scaffolding**: `prisma/`, `db/custom.db`, `src/lib/db.ts`, the hello-world
  `src/app/api/route.ts`, the `@prisma/client` + `prisma` dependencies, the `db:*` scripts, and the
  leftover `.env` (a single empty `DATABASE_URL`). The app is client-only and never used any of them.
- The internal `worklog.md`; its history is folded into the `0.2.1` entry below.

### Added

- **`bun run check`** — the full CI gate in one command (`format:check → lint → typecheck → test →
build`), plus the `typecheck` script (`tsc --noEmit`) it calls. Ordering rationale is documented in
  [docs/deployment.md](docs/deployment.md).
- **A complete documentation set** under `docs/`: an index hub, plus architecture, structure, flows,
  testing, and design-system references that cross-link to each other and to the README.
- A local `src/app/icon.svg` favicon coded to the editor's timeline palette, replacing the removed
  remote icon.

### Changed

- `.gitignore` rewritten: dropped the leftover scaffold entries, and added `*.log`, e2e result
  artifacts, and the local agent/editor workspaces (`.claude/`, `.kilo/`, `.freebuff/`).
- ESLint and TypeScript now exclude `.kilo/` (an agent worktree checkout) so the gate inspects only the
  project's own sources.
- The [README](README.md) now links to the docs set, and its stale limitations (single-selection,
  no ripple editing) and test counts were corrected.

### Fixed

- **`bun run start` reported success even when the server crashed** — the `… 2>&1 | tee server.log`
  pipeline returns `tee`'s exit status, so the server's non-zero status was swallowed. The script now
  runs with `set -o pipefail` (environment, redirection, and logging behavior unchanged).
- Two pre-existing type errors in the test suite that `next build` had been hiding via
  `typescript.ignoreBuildErrors`: a nullable `EditorCommand[]` access in `av-links.test.ts` and a
  canvas `getContext` cast in `browser-mocks.ts`. The new `typecheck` step now enforces them.

## [0.2.1] — 2026-09-19

The editor MVP: a browser-based multi-track video editor with a command-driven state core, a
canvas/Web Audio playback engine, Premiere-style editing UX, and WebM export. Reconstructed from the
project's build log, newest work first.

### Added

- **State core** — the `Doc` model (`{ project, media }`, all times in seconds), 22 validated commands
  applied through `applyCommand`, whole-document snapshot undo/redo capped at 100 entries, transient
  gestures that collapse a drag into one history entry, snapping, and crossfade math shared by the
  compositor and audio mixer.
- **Playback engine** — `PlaybackCore` with an `AudioContext` master clock, a per-clip media element
  pool, drift correction (120 ms), a per-clip Web Audio gain graph (`gain × clip mute × track mute ×
crossfade alpha`), and canvas compositing (bottom-to-top, contain-fit, styled text, opacity).
- **Timeline** — move, trim, split, duplicate, delete, cross-track drags, snapping, canvas ruler
  scrubbing, ctrl/wheel zoom, and a playhead-following scroll.
- **Cross-dissolve transitions** — per-clip `transitionOut` with a real overlap, clamped at render time.
- **Text overlays** — text tracks and clips with full styling, plus drag-to-position directly in the
  program monitor with a dashed outline.
- **Export** — `MediaRecorder` capture with low/medium/high bitrates, progress, cancel, and inline
  preview.
- **Persistence** — `.veproj.json` save/load (object URLs stripped), 800 ms debounced localStorage
  autosave, and a restore-or-discard banner.
- **Premiere-style editing UX** — a menu bar with no dead items or fake shortcuts; a resizable,
  collapsible, persistent panel workspace; a verified Premiere keyboard map (razor on `C`, Add Edit on
  `Ctrl+K`, ripple delete on `Shift+Del`, `Ctrl+L` link toggle, `J`/`K`/`L` shuttle).
- **A/V links** — videos with audio land as a linked video + audio-only pair that selects, moves,
  splits, duplicates, deletes, and pastes as one unit, with the engine shadowing the embedded audio to
  prevent double playback.
- **Multi-selection** — Shift/Ctrl click with link-group-aware group operations, a full clip context
  menu (cut/copy/paste/split/duplicate/link/unlink/ripple delete), and group-aware keyboard shortcuts.
- **Layer compositing** — per-clip opacity that stacks with crossfade alphas, and drop-between-tracks
  with a live `+ V2`/`+ A2` insertion indicator that places a new layer at the exact z-position.
- The `e2e/battery.sh` UI battery (28 steps) and the mocked browser-API harness used for A/B
  verification of the engine.

### Changed

- **New projects default to Full HD (1920×1080 @ 30fps)**, up from 1280×720, in both the factory and the
  deserialization fallback. Existing files keep their stored dimensions.
- `addTrack` inserts a new track at the head of its kind's group, so the newest track stacks on top
  (Premiere semantics).

### Fixed

- **Export cancel deadlocked** — cancelling paused the core without resolving `playbackDone`, so the
  recorder kept recording and the poll interval leaked. Found by the mocked harness, fixed by resolving
  in both the frame callback and the cancel guard.
- **The playhead painted over the sticky track headers** when the timeline scrolled, and left two
  magenta dots from row borders; fixed by splitting the line/diamond and confining them to the track
  rows with a documented z-scale.
- **The media bin and inspector could not scroll** — `PanelShell`'s content wrapper was a plain block
  box, so the panels grew to content height and were clipped; it is now a `flex min-h-0 … flex-col`
  wrapper.
- **The preview transport was clipped** when panels were resized; the panel is a flex container, the
  transport is `h-12 shrink-0`, and the volume slider keys off the panel width via a container query.
- **Load sample media could spam duplicates**; loading is now idempotent with clear feedback.
- **Unlinking silently skipped the audio twin**, and **pasting forged false link bonds**; both were
  caught by tests and fixed (the unlink loop no longer destroys its own anchor mid-iteration, and paste
  re-links per original group).

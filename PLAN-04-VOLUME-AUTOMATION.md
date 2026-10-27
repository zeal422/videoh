# PLAN 04: Volume automation and the dB inspector

Status: done
Depends on: [PLAN 01](PLAN-01-REFERENCE-AND-SPEC.md), [PLAN 02](PLAN-02-GEOMETRY-AND-CHROME.md),
[PLAN 03](PLAN-03-FILMSTRIPS.md)
Release: `0.13.0`
Goal: show and edit the existing volume keyframes directly on audio clips, and present the same curve
in dB in the Clip tab.

Plan 03 is a proof dependency for the `data-filmstrips-ready` marker used in this plan's browser
proof; the volume implementation does not import the filmstrip module.

## Why this uses existing state

Volume is already an animatable property:

- `Clip.keyframes.volume` holds the curve.
- `animatedValue(clip, 'volume', local)` evaluates it.
- `setClipKeyframes` writes it with one undo entry.
- The Effect Controls tab already has a volume row, a keyframe diamond, a graph, and eased segments.
- Auto-duck already writes volume keyframes.

This plan is a presentation and interaction layer over that state. It does not add a new automation
store or a second source of truth.

## Scope

1. A shared gain/dB display mapping.
2. An on-clip volume envelope with draggable points.
3. Add and remove point gestures.
4. A dB volume graph in the Clip tab.
5. Shared graph export so the Inspector does not fork.
6. Tests, browser proof, and the `0.13.0` release tasks.

## Non-goals

- No new keyframe property.
- No new audio mix path.
- No change to the static gain slider's storage. Gain stays linear 0 to 2.
- No automation for pan, EQ, or effects in this plan.
- No volume envelope on a video clip whose linked twin carries the sound. The envelope belongs on
  the audio twin, which is the audible clip.
- No change to auto-duck behavior.

## Current state to verify

- `src/lib/editor/types.ts`: `KeyframeProperty` includes `volume`; `Clip.gain` is linear.
- `src/lib/editor/keyframes.ts`: `animatedValue`, `clampPropertyValue`, bounds.
- `src/components/editor/effect-controls/EffectControlsPanel.tsx`: `AUDIO_PROPS`, `PropertyRow`,
  `KeyframeGraph`, `AudioShaping`, auto-duck.
- `src/components/editor/InspectorPanel.tsx`: Clip tab audio gain and mute.
- `src/components/editor/timeline/ClipView.tsx`: clip geometry and overlays.
- `src/lib/editor/store.ts`: `applyTransient`, `commitTransient`, `cancelTransient`.
- `src/lib/editor/playback/core.ts` and `src/lib/editor/export/offline.ts`: both read
  `animatedValue(clip, 'volume', local)`; the envelope must not change their values.

## 1. Gain and dB display

Keep storage linear. Create a pure module `src/lib/editor/volume-automation.ts` with these helpers:

- `gainToDb(gain)`: `20 * log10(gain)`. Gain 1 is 0 dB. Gain 2 is about +6.0 dB. Gain 0 is negative
  infinity.
- `dbToGain(db)`: `10 ** (db / 20)`. Clamp to the keyframe bounds, 0 to 2.
- `formatDb(gain)`: `0.0 dB`, `-6.0 dB`, `-inf dB`, with a consistent minus sign.
- A display domain of -60 dB to +6 dB. A gain at or below -60 dB renders at the floor and reads
  `-inf dB`. Do not draw at the floor and label a lower number.
- `sampleVolumeCurve(clip, count)` for the timeline overlay, using `animatedValue`.

Add `src/lib/editor/volume-automation.ts` to the coverage include list in `vitest.config.ts` and to
the coverage-scope sentence in `docs/testing.md`. Run `bun run test:coverage` once in this plan.

Rules:

- The volume readout in the Clip tab and the Effect Controls volume row uses dB. The slider keeps
  its linear gain stops, but the label beside it is dB. Do not show percent and dB for the same
  value in the same section. The Audio Gain dialog keeps both, as it does today.
- Keep the static gain slider's existing `aria-label="Clip gain percent"` so the accessible name and
  the `effect-controls-ui.render.test.tsx` lock stay stable. The visible readout is dB. If the
  accessible name changes later, update that test in the same change.
- The graph's y-axis labels show `0 dB`, `-6 dB`, and `-inf` at the floor.
- The keyframe values and the audio engine stay linear. Only the presentation changes.
- Round only at display time. Do not write rounded dB back into the doc.

Pure tests:

- `gainToDb(1) === 0`.
- `gainToDb(0.5) === -6.0206...` within tolerance.
- `gainToDb(0)` is `-Infinity`.
- `dbToGain(0) === 1`.
- Round-trip within tolerance for 0.01 to 2.
- Clamp to 0 and 2.
- `formatDb` for 1, 0.5, 0.001, and 0. A gain of 0.0005 reads `-inf dB` because it is below the
  -60 dB floor.

## 2. On-clip volume envelope

Create `src/components/editor/timeline/VolumeEnvelope.tsx`. It receives the clip, the visible pixel
width, the clip height, and the playhead if a playhead marker is shown.

When it renders:

- Audio-bearing clips only.
- The clip that actually carries the sound. For a linked A/V pair, the audio twin, not the video
  half.
- A solo video with embedded audio does show it, because that clip carries its own sound. The Plan
  06 Pen edits opacity on visual clips; this volume envelope stays directly draggable through its
  dots. Do not let the Pen switch this clip to a second volume curve.
- Text clips, image clips, and compound clips without audio have no envelope. A muted clip keeps its
  curve and shows it dimmed, because unmuting should reveal the automation. Do not hide the data.
- When the clip has volume keyframes, always show the curve and points.
- When the clip has no keyframes, show a flat line when the clip is selected or when the keyframe
  Pen is active (Plan 06). Do not add a flat line to every audio clip in the timeline.

Rendering:

- Sample `animatedValue(clip, 'volume', local)` across the clip width at about 2px intervals, so
  eased segments draw their real shape.
- Draw an SVG path with `vector-effect: non-scaling-stroke`.
- Draw a dot for every keyframe. The dot is a focusable slider with an aria label and value.
- Map x to `local` clip time and y to the dB display domain, with padding for the label strip and
  the bottom edge so dots are not clipped.
- Draw above the waveform, below the label and trim handles.
- Use a white line. Do not use the selection rose for the curve.
- Dim the curve when the clip is muted, but keep it editable.
- Show a small dB readout while dragging.

Hit testing:

- The SVG is `pointer-events-none`.
- Dots are `pointer-events-auto` with a hit target of at least 12px, even if the visible dot is 6px.
  Inset the dot layer by the trim-handle width so a keyframe at local 0 does not sit under the head
  trim handle. Trim handles win any overlap.
- Add a transparent hit path along the curve, 10px wide, for adding points.
- Clicking empty clip space must still select/drag the clip. Only the dot and the line hit path
  capture the pointer.
- When the razor tool is active, the envelope is entirely `pointer-events-none`; a razor click must
  cut, not start a keyframe drag.

Adding and removing:

- Double-click the line adds a keyframe at that local time with the interpolated value. Stop
  propagation so the compound-clip double-click does not open a sequence.
- Alt-click a dot removes it on a successful pointer release. Delete/Backspace while a dot is focused
  removes it.
- If the last keyframe is removed, the property returns to the static gain. The command layer
  already supports an empty array.
- If the user adds a point to a property with no curve, seed the curve with one point at the click
  time and the static gain value. The curve is constant until a second point is added.

Dragging:

- Pointerdown records the dot and pointer id, but do not begin the transient until the pointer moves
  at least 3px in screen space (`clientX`/`clientY`). Stop propagation on the initiating pointerdown.
  A plain press/release under the threshold is a click: keep the current dot selection and write
  nothing. The threshold is zoom-independent.
- Alt-click arms removal on pointerdown. It removes only on pointerup when the pointer stayed under
  the threshold; pointercancel clears the armed removal and leaves the doc unchanged. Do not begin a
  transient for an Alt-press. If it crosses the threshold, it neither removes nor drags.
- Once the threshold is crossed, begin the transient.
- Vertical drag changes value in dB space, converted back to linear and clamped 0 to 2.
- Horizontal drag changes time, clamped 0 to clip duration. A drag past a neighbour re-sorts the
  array and keeps the grabbed keyframe, exactly like the existing graph. Test a crossing.
- Use window pointer listeners with the initiating pointer id and the transient token, matching the
  existing keyframe graph.
- Commit on pointerup, cancel on pointercancel or a foreign commit. One undo entry per drag.
- Escape returns to the select tool only when no gesture is live; it does not cancel a live
  envelope drag. Existing clip move/trim gestures keep their current commit-on-pointercancel
  behavior; do not change them in this plan.
- Do not start a clip move or trim from the dot.
- Lock does not exist yet in Plan 04. Plan 05 depends on this plan and adds the locked-track refusal
  to every envelope gesture, with tests. Plan 04 must not block that extension.

Keyboard:

- Dots are focusable.
- Arrow left and right nudge time by one frame.
- Arrow up and down change gain by 0.5 dB.
- Delete removes the point. Swallow Delete, Backspace, and the arrow keys on the dot so the global
  frame-step, edit-point, and clip-delete shortcuts do not fire.

## 3. Clip-tab dB graph

The reference's Clip tab shows an Audio section with a dB volume graph. The current Clip tab shows
gain percent and mute, and the volume graph lives in Effect Controls.

Plan:

- Replace the existing `Audio` section in `ClipInspector` with the new `Volume` section. Do not leave
  two gain or mute sections. Keep the full Audio shaping section in Effect Controls.
- Place the `Volume` section after Opacity/Blend and before Color grade, matching the reference order.
- Show the current dB value, the mute switch, the static gain slider, and a compact graph of the
  volume curve.
- Extract the shared graph first. `Volume` uses the same `PropertyRow` and `KeyframeGraph` as Effect
  Controls. Do not copy the graph code.
- The graph in the Clip tab is the same data and the same interactions as the Effect Controls
  volume row.
- Data source: the clip's volume keyframes evaluated by `animatedValue`, the same data as the Effect
  Controls row. The timeline overlay may sample with `sampleVolumeCurve`; the Clip-tab graph uses
  `KeyframeGraph`. This is an automation curve, not an `AnalyserNode`, decoded buffer, or mixer
  meter; there is no FFT or audio sample rate.
- The Clip tab is a summary, not a second audio mixer.
- If the clip is a video half with an audio twin, the Clip tab's volume control targets the twin,
  as the current gain control does. Label it so the user knows which clip is being edited.

Shared graph export:

- Export `KeyframeGraph` from `EffectControlsPanel.tsx` and import it in the Clip tab. Keep the
  component and its `rowAxis` / `activeSegmentStart` helpers in place. Do not move them to a new
  file.
- The static source locks in `src/lib/editor/__tests__/effect-controls-ui.test.ts` read
  `EffectControlsPanel.tsx` and assert the graph internals. Moving the graph would break those
  locks and invite weakening them. Keeping it in place preserves the test contract.
- Add one optional `scale` prop: `linear` by default, `db` for volume. The prop switches the y-axis
  mapping and labels, not the stored values.
- Update imports in `EffectControlsPanel.tsx` and `InspectorPanel.tsx`. No behavioral change.
- If the export itself changes a locked line, update the test's expectation deliberately; do not
  delete the lock.

## 4. Interaction conflicts

This is where a timeline overlay usually breaks clip editing. Handle each case:

| Gesture                        | Expected result                                |
| ------------------------------ | ---------------------------------------------- |
| Clicking a dot                 | Select/focus the dot, not clip move            |
| Dragging a dot (3px+)          | Change time/value, one undo entry              |
| Double-clicking the line       | Add a keyframe, not open a compound sequence   |
| Alt-clicking a dot             | Remove the keyframe                            |
| Clicking elsewhere in the clip | Existing clip selection and move               |
| Dragging the clip body         | Existing clip move                             |
| Dragging a trim handle         | Existing trim                                  |
| Razor tool on the clip         | Existing cut, envelope ignored                 |
| Locked track (after Plan 05)   | Refuse the envelope edit with the lock message |

Add tests for each row that changes pointer behavior. The envelope must not block clip selection.

## 5. Tests

Pure tests in `volume-automation.test.ts`, plus the existing `keyframes` tests:

- dB conversion and formatting.
- Graph y mapping at 0, -6, -60, and +6 dB.
- Sample times for the envelope across clip duration.
- Eased curve sampling matches `animatedValue`.
- Add point at time t with the interpolated value.
- Remove point, including the last point.
- Clamp value and time.
- A keyframe at exactly `clip.duration` is accepted and preserved. A drag past the end clamps to
  `clip.duration`, not `duration - 0.001`; no epsilon subtraction exists.
- No mutation of the input clip.

Mocked browser tests:

- Dot drag writes a transient per move and commits once.
- A 2px screen-space move is a click and writes nothing; a 4px move starts one transient and one
  undo entry.
- Foreign commit ends the gesture and stops further writes.
- Pointercancel cancels and restores.
- Alt-click removes on pointerup; pointercancel leaves the keyframe and history unchanged. An
  Alt-press that moves past the threshold neither removes nor drags.
- Double-click line adds.
- Keyboard nudge and delete.
- A dot at local 0 is not reachable through the head trim handle; the trim handle wins.
- Dragging a dot past a neighbour re-sorts the curve and keeps the grabbed keyframe.
- With the razor active, a click on a dot cuts the clip and does not start a keyframe drag.
- A locked track refuses the edit after Plan 05.
- The audio engine gain schedule matches the curve after an edit. Use the existing playback/export
  mocked tests as the pattern.

Render tests:

- An audio clip with volume keyframes renders the envelope and dots.
- A video half with a linked twin does not render an envelope; the twin does.
- A solo video with embedded audio does render one.
- A muted clip renders a dimmed curve.
- The label, linked badge, waveform, and trim handles still render.
- The Clip tab shows the dB volume section and graph.
- The Clip tab renders one Volume section, not a duplicate Audio section.
- A video-half selection targets the twin.
- The envelope does not capture a click on empty clip space.

Static locks:

- `ClipView` includes the envelope behind the label and trim handles.
- The envelope is pointer-events none, with pointer-events auto on dots and the line hit path.
- The shared graph is imported by both the Clip tab and Effect Controls, not duplicated.
- Volume storage remains linear.

Browser proof:

- Wait for `data-filmstrips-ready` on the timeline root before screenshots or clip-pixel checks.
- Add three points to an audio clip, drag one, check the curve shape and the dB readout.
- Undo once per drag.
- Double-click adds, Alt-click removes.
- Confirm the clip can still be selected, moved, and trimmed around the envelope.
- Confirm auto-duck still writes a curve that renders.
- The audio gain itself is proven in the mocked preview and export tests, not in the browser. There
  is no audio meter.
- Narrow desktop (1024x768): dots remain hit-target usable; no label clipping.
- Console clean.

Flakiness controls:

- No audio output assertion in the browser. The mocked gain graph and the engine's scheduled values
  are the proof.
- Do not assert SVG path strings exactly. Assert the sampled point count, monotonic x, and y values
  that match `animatedValue` at known times. Do not accept "a path exists" as proof of a curve.
- Use fake timers for any debounce.
- Do not rely on pointer coordinates outside the clip after a layout change.
- Wait for the graph to be mounted before a drag.

## 6. Release tasks for `0.13.0`

- Atomic version bump: `package.json`, `src/lib/releases.ts`, `CHANGELOG.md`, and a new `0.13.0`
  row in the `ROADMAP.md` Shipped table. The user confirms the version before the bump.
- Update `README.md`, `docs/architecture.md`, `docs/flows.md`, `docs/design-system.md`,
  `docs/testing.md`, and `docs/structure.md` as affected.
- Recapture `public/screenshots/editor.png` with the volume envelope visible. Update the hero alt
  text in `src/components/site/Hero.tsx`, its mirror in
  `src/lib/editor/__tests__/public-pages.render.test.tsx`, and the photo credit if the image
  changes. Real capture only.
- Update test counts through `docs-drift.test.ts`.
- No new battery step is required unless the envelope cannot be proven in jsdom. If a step is
  added, update both `e2e/battery.sh` and `e2e/battery.timing.sh`, and the battery count docs.

## Acceptance criteria

- Volume keyframes render as a curve on the audible audio clip, sampled through `animatedValue`.
- Dots drag in time and dB value, one undo entry per drag.
- Double-click adds, Alt-click and keyboard delete remove.
- The curve is below the label and trim handles and does not block clip selection.
- The Clip tab shows a dB volume section and graph using the shared graph component.
- The mocked preview and export gain schedules match the curve after edits. No browser listening
  assertion.
- Auto-duck curves render and remain editable.
- A linked video half has no envelope; its twin does. A solo video with embedded audio does.
- No new keyframe property and no new automation store.
- `bun run check` is green.
- The `0.13.0` version bump and docs are complete.

## Risks

- **Gesture conflict.** Mitigation: pointer-events layering and the interaction table tests.
- **dB mapping confusion.** Mitigation: one display helper, one graph scale, linear storage.
- **Graph duplication.** Mitigation: extract the existing graph, do not copy it.
- **Audio/visual divergence.** Mitigation: test the existing preview and export gain schedules
  against the new curve.
- **Lock gap.** Plan 05 must revisit every envelope gesture and add the locked-track refusal.
- **Auto-duck regression.** Mitigation: a render test and a browser proof with auto-duck.

# 0.24.0 transform

**Created:** 2026-11-12
**Complexity:** High
**Effort:** L
**Schema:** 5 to 6
**Depends on:** 0.23.0
**Status:** implemented

## 1. Goal

Add the transform surface competitors already have:

- Rotate a visual clip.
- Flip horizontally or vertically.
- Animate rotation with keyframes.
- Move, scale, and rotate a clip directly in the monitor with a gizmo.

This is the second schema release, after the 0.23.0 media hash. Rotation, flip, and the gizmo all read the same transform state, so
they share one migration, one validation pass, and one preview/export parity proof. The release is one
commit and one version bump.

## 2. Anti-goals

- No 3D rotation, perspective, skew, or anchor point editor.
- No auto reframe, subject tracking, or smart crop.
- No negative scale support. Flip uses explicit booleans, not negative scale.
- No gizmo for audio clips or markers.
- No separate transform panel rewrite. Extend the existing Inspector and Effect Controls surfaces.
- No schema bump for flip beyond the one v6 bump that also carries rotation.

## 3. Current state, verified

- `KeyframeProperty` has opacity, position X/Y, scale, volume, exposure, contrast, saturation,
  brightness, hue, and timeScale. It has no rotation (`src/lib/editor/types.ts:194`).
- `KEYFRAME_PROPERTY_BOUNDS` has no rotation, and `SCALE_MIN` is 0.1 with `SCALE_MAX` 4
  (`src/lib/editor/constants.ts:154`).
- The compositor's transform type is `{ posX, posY, scale }` and every draw helper applies translate
  and scale around the frame center (`src/lib/editor/playback/compositor.ts:401`, `:408`).
- The monitor's drag surface currently positions text only, using `style.x` and `style.y`
  (`src/components/editor/PreviewPanel.tsx:33`).
- `SERIALIZATION_VERSION` is 4 and the loader accepts versions 1 through 4
  (`src/lib/editor/serialization.ts:103`).
- `TextStyle` has no rotation field. Rotation belongs on the clip so video, image, text, and compound
  clips share one transform.

## 4. Technical approach

### Data model

Add to `Clip`:

- `rotation?: number`, in degrees, absent means 0.
- `flipX?: boolean`, absent means false.
- `flipY?: boolean`, absent means false.

Add `rotation` to the animatable properties:

- `KeyframeProperty`.
- `AnimStaticProperty`.
- `KEYFRAME_PROPERTY_BOUNDS`.
- `KeyframeDefaults` through the existing partial record.
- The keyframe graph's property list and axis mapping.
- The Effect Controls keyframe row and inspector control.

Store degrees in `-3600..3600` (ten turns each way), clamped at the command, hydration, and keyframe
boundaries. The display shows the authored value, so 720 still means two turns; do not modulo it. Do
not store radians in the document and degrees in the UI, or the two will drift.

Flip is a boolean pair, not a negative scale. `SCALE_MIN` stays positive, and existing scale keyframes
keep their meaning.

### Rendering

Extend the shared transform value to `{ posX, posY, scale, rotation, flipX, flipY }`. The origin is
per visual kind, not always the frame center:

- Video, image, and compound: the frame center, because the drawn picture fills the fitted frame.
- Text: the measured text box center for rotation and flip. Text already positions through `style.x`
  and `style.y` (`src/lib/editor/playback/compositor.ts:1198`). A move drag writes those fields;
  rotation and flip write the clip transform. Rotating around the canvas center would make the text
  orbit, so the renderer and the gizmo use the text box center. Scale keeps the existing frame-center
  origin in this release, so a project with scaled text does not shift; the gizmo's text scale handle
  matches that origin. Unifying the text scale origin needs its own migration.
- Shapes (0.25.0): the shape path bounds center, supplied by the shape renderer.

For video, image, compound, and shape clips, apply one transform around the kind's origin:

1. Translate to the origin plus position.
2. Rotate by the resolved rotation.
3. Scale by the resolved scale, with the flip sign applied per axis.
4. Translate back by the origin.

For text, the final column-vector matrix is
`M = T(c') R F T(-c') · T(frameCenter + pos) S T(-frameCenter)`. Rotation and flip sit on the left of
the existing position-and-scale transform:

1. Compute the transformed text center `c' = frameCenter + pos + (textCenter - frameCenter) * scale`.
   Derive `textCenter` from the measured text layout box, not from `style.x` and `style.y` directly:
   `style.x` is the horizontal alignment anchor (left, center, or right) and `style.y` is the line
   block's vertical center, so for left or right alignment the anchor is not the box center. Measure
   the line widths and line height with the same helper as the selection outline, exclude shadow
   padding from the transform origin, and use the resulting box center. `textCenter` equals
   `(style.x * width, style.y * height)` only for center-aligned text.
2. Issue `T(c') R F T(-c')` first, where `R` is the rotation matrix and `F` is the flip matrix.
3. Then issue `T(frameCenter + pos) S T(-frameCenter)`.
4. Draw the text at `textCenter`.

Canvas 2D postmultiplies: issuing the position-and-scale calls first and the rotation calls second
would produce `A · B`, not `B · A`. Implement the order above, or set the composed matrix explicitly.
Compute `c'` from the parameters before either sequence. With rotation 0 and no flip, the rotation
factor is the identity, so existing scaled text does not move. The helper returns the matrix for the
gizmo and every draw path; do not bake a second origin into the gizmo, text renderer, or exporter.

Keep the existing stack order: effects run top-first with motion blur last, then clip Motion and
Opacity. Rotation and flip join the Motion step, so they apply after crop, chroma key, and track matte,
and before opacity and blend. Motion blur keeps sampling the same clip-local transform samples it uses
today, now including rotation and flip. Do not reorder this in one renderer only.

Every draw path must use the same helper: video, image, text, compound, matte source, effect path, and
the export frame path. Do not add a second rotation formula in the gizmo, text renderer, or exporter.

Text keeps its `style.x` and `style.y` placement for now. The clip rotation and flip apply to the text
layer after its layout. Do not move text positioning into the clip transform in this release, because
that would change existing text projects.

### Gizmo

Add a monitor overlay for the selected visual clip:

- A bounding box derived from the fitted frame for video, image, and compound clips, from the measured
  text box for text, and from the shape path bounds for shapes.
- Move by dragging inside the box.
- Scale from corner handles.
- Rotate from a rotation handle.
- Shift or other modifiers only if they already exist in the codebase for the same purpose. Do not
  invent a second modifier convention.

Keep the geometry in a pure helper so it can be tested without a browser. The helper must account for
the monitor's letterboxing, device pixel ratio, rotation, and flip. Pointer drags commit through the
existing transient gesture path, so one drag is one undo entry.

The numeric rotation control and flip toggles stay in the Inspector. Add rotation to the Effect
Controls keyframe row. If the monitor drag and the numeric field write the same field, they share the
same clamp and normalization. For a text clip, a move drag writes `style.x` and `style.y`; for every
other visual clip it writes position X and Y. Scale, rotation, and flip write the clip transform in
both cases.

When the clip has a rotation curve, a rotation drag writes a rotation keyframe at the playhead through
the same keyframe command path as the Effect Controls dot. It must update the effective animated
rotation, not only the static fallback, or the drag appears to do nothing. With no curve, write the
static rotation. Both paths share the numeric control's clamp and normalization, and the transient
gesture still commits one undo entry per drag.

### Serialization v6

- Increment `SERIALIZATION_VERSION` to 6.
- Update the header comment with the release and the new fields.
- Hydrate missing rotation to 0 and missing flips to false.
- Validate rotation as finite and clamp it. Validate flip as an explicit boolean; a truthy string or
  number is not a flip.
- Reject or sanitize unknown values the same way the existing hydration rules do.
- Add a v5 fixture that loads with neutral transform values.
- Add a hostile payload with `rotation: "45"`, `flipX: 1`, `rotation: Infinity`, and an out-of-range
  value.
- Round-trip a v6 doc with a rotation keyframe and both flips.

### Preview and export parity

Add a parity test that renders the same clip through the preview compositor and the export compositor
with position, scale, rotation, and flip set. Compare the resolved 2D transform matrix for each draw,
not a pixel sample, so the result is deterministic in the Node harness. Keep a small pixel comparison
only where the matrix cannot prove the result, such as the text box origin. Do not rely on the preview
alone.

## 5. File plan

New files:

- `src/lib/editor/transform.ts` or the existing geometry module, for the pure transform and gizmo
  geometry.
- `src/components/editor/TransformGizmo.tsx` or an overlay inside `PreviewPanel.tsx` if the existing
  overlay pattern is already there.

Expected modified files:

- `src/lib/editor/types.ts`: clip fields, keyframe property, anim static property.
- `src/lib/editor/constants.ts`: rotation bounds and defaults.
- `src/lib/editor/serialization.ts`: v6, hydration, validation.
- `src/lib/editor/commands.ts`: static setters and rotation keyframe paths through existing commands.
- `src/lib/editor/playback/compositor.ts`: transform helper and all draw call sites.
- `src/lib/editor/export/mp4.ts` and `src/lib/editor/export/offline.ts`: export parity.
- `src/components/editor/PreviewPanel.tsx`: gizmo integration.
- `src/components/editor/InspectorPanel.tsx` and the effect controls panel: controls and keyframe row.
- `src/lib/editor/__tests__/` for serialization, transform math, parity, and gizmo UI locks.
- `docs/architecture.md`, `docs/flows.md`, `docs/design-system.md`, `README.md`, `docs/testing.md`,
  `docs/structure.md`.

## 6. Phases and verification

### Phase 1: data model and serialization

- Add the fields, bounds, and defaults.
- Write the v6 hydration tests first and watch them fail.
- Verify v5 loads with rotation 0 and flips false.
- Verify hostile values are sanitized exactly as documented.
- Verify a v6 round trip keeps rotation, flips, and rotation keyframes.

### Phase 2: shared transform

- Extend the transform helper and convert every draw path.
- Verify the static transform matrix for rotation, both flips, and combinations.
- Verify text composes `T(c') R F T(-c') · T(frameCenter + pos) S T(-frameCenter)` and that Canvas
  call order produces `B · A` when `textCenter` is offset from `frameCenter`.
- Verify text, video, image, compound, matte, and effect paths use the shared helper.
- Verify no draw path still applies only position and scale.
- Verify left-, center-, and right-aligned text rotate and flip around the measured text box center,
  not the `style.x` anchor, and that shadow padding does not shift the origin.

### Phase 3: preview and export parity

- Add the parity test.
- Verify a rotated, flipped clip renders the same in both engines.
- Verify a clip rotated around the center does not shift its center.
- Verify export at a custom resolution still applies the transform correctly if 0.21.0 shipped that
  path.

### Phase 4: rotation keyframes

- Add rotation to the keyframe graph, defaults, and Effect Controls.
- Verify linear and eased rotation interpolation.
- Verify keyframe time mapping with trimmed and ramped clips.
- Verify the static value wins when the curve is empty.

### Phase 5: gizmo

- Add the overlay and pure geometry.
- Verify move, scale, and rotate pointer drags commit one undo entry per drag.
- Verify a rotation drag on a clip with an existing rotation curve writes or updates the keyframe at
  the playhead, leaves the static fallback alone, and undoes in one step.
- Verify rotated boxes, flipped boxes, letterboxed monitors, and device pixel ratio.
- Verify locked clips do not show active handles or refuse the drag.
- Verify text clips can be moved and rotated without breaking the existing text drag.

### Phase 6: docs, batteries, release cut

- Update the data model, transform flow, UI rules, and test inventory.
- Run `bun run check`.
- Run `bun run battery:pair`.
- Apply the atomic 0.24.0 bump with schema notes from the master plan.

## 7. Tests and locks

- Serialization: v5 to v6 defaults, v6 round trip, hostile rotation, hostile flip, out-of-range clamp,
  unknown fields, newer version refused.
- Transform math: rotation, flip X, flip Y, both flips, scale, position, center stability, composition,
  per-kind origin (frame, text box, shape bounds), text scale compatibility, scaled text whose frame and
  text-box centers differ under rotation and flip, left- and right-aligned text rotating around the
  measured box center, the Canvas call order for text producing `B · A` with `textCenter` offset from
  `frameCenter`, and effect stack order.
- Keyframes: rotation interpolation, easing, trim and ramp rebasing, empty curve falls back to static,
  and a gizmo drag on an animated rotation writes the keyframe at the playhead instead of the static
  fallback.
- Parity: preview and export matrix equality for a transformed clip, plus a text box origin sample.
- Gizmo: hit box per kind, corner scale, rotation handle, letterbox, DPR, pointer capture, one undo per
  drag, locked clip refusal, and animated-rotation drag updates the curve.
- Static locks: all draw paths use the shared transform helper.

## 8. Atomic release cut

Follow section 7 of `MASTER_PLAN.md`. The 0.24.0 commit must update:

- `package.json` to `0.24.0`.
- `src/lib/releases.ts` with four or more highlights and the actual ISO date.
- `CHANGELOG.md` with `## [0.24.0] - YYYY-MM-DD` and a schema note.
- `ROADMAP.md` with the shipped row and intro sentence. No Premiere gap status change.
- `README.md` features and `.veproj.json` version 6.
- `docs/architecture.md` serialization row and transform module notes.
- `docs/flows.md` transform and keyframe contracts.
- `docs/design-system.md` gizmo and control rules.
- `docs/testing.md` for the new tests and coverage scope.
- `docs/structure.md` if new files or test counts changed.

Do not bump to 6 for any other persisted field in this release.

## 9. Rollback

Revert the single release commit. A v6 project cannot be opened by the reverted build because the
loader refuses newer versions. Before rollback, export the affected projects or keep the commit. State
this in the release notes and in the rollback runbook.

## 10. Risks and decisions

- **Transform drift.** One helper or none. A second formula in the gizmo or exporter is the most likely
  bug.
- **Text positioning.** Keep `style.x` and `style.y` for text in this release. Do not silently migrate
  text geometry. Rotate and flip around the measured text box center, not the canvas center.
- **Rotation range.** `-3600..3600` degrees, documented and clamped at every boundary, including
  hydration and keyframes.
- **Origin drift.** A second origin formula in the gizmo, text renderer, or exporter is a bug. The
  pure transform helper returns both the matrix and the bounds each draw uses.
- **Flip semantics.** Flip is a boolean pair. Negative scale remains rejected.
- **Gizmo complexity.** If the gizmo cannot be finished safely, ship the fields, keyframes, and numeric
  controls and move the gizmo to its own release. Do not ship a half-working handle.

## 11. Definition of done

- Rotation persists, hydrates, keyframes, and renders in preview and export.
- Both flips persist, hydrate, and render in preview and export.
- v5 projects load with neutral values and v6 projects round-trip.
- The gizmo moves, scales, and rotates with one undo entry per drag and respects locks.
- `bun run check` and `bun run battery:pair` are green.
- The 0.24.0 schema bump and version bump are atomic in one commit.

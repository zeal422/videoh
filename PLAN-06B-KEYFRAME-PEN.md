# PLAN 06B: The keyframe Pen

Status: planned
Depends on: [PLAN 04](PLAN-04-VOLUME-AUTOMATION.md), [PLAN 05](PLAN-05-TRACK-CONTROLS.md),
[PLAN 06A](PLAN-06A-RIPPLE-SLIP.md)
Release: `0.16.0`
Split: this is the second half of the original Plan 06. The tool state, ripple trim, and slip
shipped in [PLAN 06A](PLAN-06A-RIPPLE-SLIP.md) as `0.15.0`.
Goal: make the reference's Pen tool real. It edits keyframes on the selected clip's visible
automation curve, with one toolbar icon, one shortcut, one cursor, a documented behavior, and tests.

## Scope

1. Extend the editor tool state from select/razor/ripple/slip to Pen.
2. Generalize the Plan 04 `VolumeEnvelope` into an `AutomationEnvelope` that renders volume or
   opacity.
3. Add the pure Pen keyframe helpers.
4. Add the toolbar button, shortcut, tooltip, and cursor.
5. Tests, browser proof, and the `0.16.0` release tasks.

## Non-goals

- No mask, roto, or Bezier shape drawing in the program monitor.
- No new keyframe property.
- No second automation overlay beside the generalized envelope.
- No clip move or trim while the Pen is active.
- No mobile-specific tool UI beyond the existing toolbar overflow.

## Current state to verify

- `src/lib/editor/store.ts` after 06A: `EditorTool = 'select' | 'razor' | 'ripple' | 'slip'`,
  `activeTool`, `setActiveTool`.
- `src/hooks/editor/useEditorKeyboard.ts` after 06A: V, C, B, Y, and Escape are assigned. P is free.
- `src/components/editor/Toolbar.tsx` after 06A: select, razor, ripple, and slip buttons.
- `src/components/editor/timeline/VolumeEnvelope.tsx` from Plan 04: the envelope surface to
  generalize.
- `src/lib/editor/volume-automation.ts`: the dB mapping, the curve sampling, and `clipCarriesSound`.
- `src/lib/editor/keyframes.ts`: `animatedValue`, `evaluateKeyframes`, and the sorted-curve helpers.
- `src/lib/editor/commands.ts`: `setClipKeyframes` and the `LOCK_RULES` inventory.
- `src/lib/editor/types.ts`: `Clip.keyframes.opacity` and `Clip.keyframes.volume` already exist.
- `src/lib/editor/links.ts`: `clipCarriesSound`-style carrier rules already decide which half of an
  A/V pair owns the waveform.

## 1. Tool state and shortcuts

Extend `EditorTool` to `'select' | 'razor' | 'ripple' | 'slip' | 'pen'`.

Shortcuts. P is unused in the current keyboard map, so use it:

- V: select.
- C: razor.
- B: ripple trim.
- Y: slip.
- P: Pen.
- Escape: select.

Check every existing shortcut before landing. If P is taken, stop and update this plan rather than
silently choosing a different key. Update:

- `useEditorKeyboard.ts`.
- The shortcuts dialog in `MenuBar.tsx`.
- The Pen tooltip.
- The toolbar active state.
- The cursor over the curve and the clip body.

Rules:

- The active tool is session state, not `Doc`, matching the existing behavior.
- Opening a project keeps the active tool.
- Only one tool is active. There is no modifier stack.
- The Pen does not move or trim the clip. A body drag selects; it does not start a move.
- Cancellation: pointercancel cancels a live Pen drag or a pending Alt-click removal and leaves the
  doc unchanged. Escape changes the tool only when no gesture is live; it does not cancel a live
  gesture.
- The Pen button must not appear until its behavior exists.

Toolbar:

- Add one button after the slip button, grouped with the edit tools.
- Use `PenTool` from lucide.
- A bottom-side tooltip with the name and shortcut.
- The button is active only while the Pen is the active tool.

## 2. Keyframe Pen

Definition:

- The Pen tool edits keyframes on the selected clip's visible automation curve.
- Audio clips expose volume. Video, image, and text clips expose opacity. A compound clip exposes
  opacity. Do not add mask or roto editing.
- The curve surface is the Plan 04 `VolumeEnvelope` generalized to an `AutomationEnvelope` that can
  render volume or opacity. Reuse it. Do not create a second overlay.
- When the Pen is active, the selected clip shows its automation curve even if it has no keyframes,
  so the user can add the first point. When the Pen is not active, a visual clip shows its opacity
  curve only when opacity keyframes exist; it does not add a flat line to every selected video.
  Volume keeps the Plan 04 visibility rule.
- A solo video with embedded audio is a visual clip for the Pen: the Pen edits opacity. Its volume
  envelope remains directly draggable through its dots. Do not expose two Pen curves on one clip.
- Clicking the curve adds a keyframe at that local time with the interpolated value. Dragging a dot
  edits time and value. Alt-click or Delete removes.
- The Pen does not move or trim the clip. Clicking the clip body selects it. Dragging the body does
  not move the clip while the Pen is active.
- The Pen is a mode, not a modifier on the select tool.
- A locked track refuses edits (Plan 05).
- The keyframe commands are existing `setClipKeyframes`; no new automation store.

Pure helpers:

Create `src/lib/editor/pen.ts` with these functions:

- `automationPropertyForClip(clip, trackKind)` returns `'volume'` when
  `trackKind === 'audio' || clip.audioOnly`, otherwise `'opacity'`. A visual clip that also carries
  audio still edits opacity with the Pen; its volume is the envelope dots.
- `automationValueAt(clip, property, local)` wraps `animatedValue`.
- `addKeyframeAt(clip, property, local, value, fps)` returns a sorted curve with the new point, or
  replaces an existing point within one frame at `fps`.
- `removeKeyframeAt` and `nudgeKeyframe` for keyboard.
- Reuse the Plan 04 dB mapping for volume and the 0 to 1 mapping for opacity.

Gesture:

- With the Pen active, clicking the curve adds a point. If the click is within the dot hit target,
  select/focus it.
- Use the same 3px screen-space (`clientX`/`clientY`) threshold as Plan 04. It is zoom-independent.
  A press/release under it is a click: on the curve it adds one keyframe; on a dot it selects/focuses.
  It does not start a drag. Crossing the threshold starts one transient drag. Alt-click uses the
  Plan 04 arm-on-pointerdown, remove-on-pointerup rule; pointercancel clears it and leaves the doc
  unchanged.
- Dragging a point writes transient updates and commits once.
- The overlay's hit path and dots are pointer-events auto; the rest of the clip remains selectable.
- The Pen cursor is a crosshair over the curve and the normal pointer over the clip body.
- Escape returns to select when no gesture is live; pointercancel cancels a live Pen drag or a
  pending Alt-click removal.

## 3. Tool interaction matrix

Add the Pen row to the matrix landed by 06A:

| Tool | Clip body drag | Clip edge drag | Click empty lane | Click clip                     |
| ---- | -------------- | -------------- | ---------------- | ------------------------------ |
| Pen  | No move        | No trim        | Clear selection  | Select, curve click adds point |

Modifiers:

- Shift and Ctrl selection modifiers keep working in Select, Ripple, Slip, and Pen. Razor keeps its
  current cut-first behavior.
- Alt on a Pen dot arms a removal; it does not rate-stretch a clip edge.
- Multi-touch: only the initiating pointer drives a gesture.

## 4. Tests and proof

Unit and render tests:

- `pen.test.ts` pure keyframe helper.
- `timeline-panel-ui.test.tsx` or new gesture tests for add, drag, remove, cancel, one undo, and the
  locked-track refusal.
- `tool-shortcuts.test.tsx` for P, V, C, B, Y, and Escape.
- Toolbar render tests for the Pen button, active state, tooltip, and no dead icons.
- Render tests for the curve visibility rules and the overlay z-order.
- Static locks for the tool matrix and the absence of a mask Pen.

Coverage:

- Add `src/lib/editor/pen.ts` to the coverage include list in `vitest.config.ts`.
- Add it to the coverage-scope sentence in `docs/testing.md`.
- Run `bun run test:coverage` once in this plan.

Browser proof:

- Wait for `data-filmstrips-ready` on the timeline root before screenshots or clip checks.
- Add a volume point to an audio clip and an opacity point to a video clip; undo.
- Confirm the clip did not move and the same frames remain at the same timeline time.
- Each tool's shortcut and cursor work.
- A locked track refuses the Pen.
- Undo once per gesture.
- Console clean.

Flakiness controls:

- Pure helpers are the primary proof. Gesture tests assert the command and the doc, not animation.
- Use the existing window-listener and transient-token patterns. Do not invent a second gesture
  system.
- No fixed sleeps. Wait on the overlay or use fake timers.

## 5. Release tasks for `0.16.0`

- Atomic version bump: `package.json`, `src/lib/releases.ts`, `CHANGELOG.md`, and a new `0.16.0`
  row in the `ROADMAP.md` Shipped table. The user confirms the version before the bump.
- Update `README.md`, `docs/architecture.md`, `docs/flows.md`, `docs/design-system.md`,
  `docs/testing.md`, and `docs/structure.md`.
- Recapture the hero screenshot with the Pen visible. Update the alt text in
  `src/components/site/Hero.tsx` and the mirror in
  `src/lib/editor/__tests__/public-pages.render.test.tsx`. Real capture only.
- Update the shortcuts dialog and the README shortcut list.
- Update test counts through `docs-drift.test.ts`.
- The full dev and production batteries remain the Plan 07 gate. Add battery steps for the Pen if
  jsdom cannot prove the user-visible result.

## Acceptance criteria

- The Pen edits volume on audio-only clips and opacity on visual clips, using the existing keyframe
  commands. A solo video edits opacity with the Pen; its volume envelope stays directly draggable.
- No mask or roto behavior is present.
- The Pen respects locked tracks.
- Every gesture is one undo entry and cancels cleanly.
- The tool matrix tests include the Pen row.
- `bun run check` is green.
- The `0.16.0` version bump and docs are complete.

## Risks

- **Pen overlap with Plan 04.** Generalize the envelope, do not copy it.
- **Two curves on one clip.** A solo video exposes opacity to the Pen and keeps its volume dots; do
  not draw both as Pen-editable curves.
- **Shortcut conflicts.** P is free in the current map. If that changes before implementation, stop
  and update the plan.

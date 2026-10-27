# PLAN 06: Ripple trim, slip, and the keyframe Pen

Status: planned
Depends on: [PLAN 04](PLAN-04-VOLUME-AUTOMATION.md), [PLAN 05](PLAN-05-TRACK-CONTROLS.md)
Release: `0.15.0`
Goal: make the reference's ripple, slip, and Pen tools real. Every toolbar icon has a mode, a
shortcut, a cursor, a documented behavior, and tests.

## Scope

1. Extend the editor tool state from select/razor to ripple, slip, and Pen.
2. Add a pure ripple-trim planner and gesture.
3. Add a pure slip planner and gesture.
4. Add the keyframe Pen over the Plan 04 envelope.
5. Add toolbar buttons, shortcuts, tooltips, and cursors.
6. Tests, browser proof, and the `0.15.0` release tasks.

## Non-goals

- No mask, roto, or Bezier shape drawing in the program monitor.
- No rolling edit, slide, or slide tool.
- No new transition or effect behavior.
- No new keyframe property.
- No all-track ripple. Same-track is the recorded `0.15.0` decision. It does not shift unrelated
  tracks; it is an explicit link-group exception described in section 2.
- No mobile-specific tool UI beyond the existing toolbar overflow.

## Current state to verify

- `src/lib/editor/store.ts`: `EditorTool = 'select' | 'razor'`, `activeTool`, `setActiveTool`; the
  transient API applies one command at a time, so the ripple batch needs a validated batch path.
- `src/hooks/editor/useEditorKeyboard.ts`: V selects, C razors, Escape returns to select.
- `src/components/editor/Toolbar.tsx`: select and razor buttons, placement modes, edit actions.
- `src/lib/editor/clip-gesture.ts`: `decideMove`, `decideTrimStart`, `decideTrimEnd`,
  `decideRateStretch`, `trimRooms`.
- `src/components/editor/timeline/ClipView.tsx`: pointer gesture lifecycle, window listeners,
  transient token, auto-scroll.
- `src/lib/editor/sequence-ops.ts`: insert/overwrite planners and shuffle logic.
- `src/lib/editor/actions.ts`: `commandsToRippleDeleteClips` resolves the selected link group and
  shifts every track that contains a removed member. It is not a same-track-only precedent.
- `src/lib/editor/links.ts`: `linkedClips` resolves a sequence-local link group.
- `src/lib/editor/sequence-ops.ts`: Invariant 14 says link groups stay in sync for placement. It is
  not a claim about the existing select trim.
- `src/lib/editor/factories.ts`: `sourceTimeAt`, `clampSourceTime`.
- `src/lib/editor/commands.ts`: `moveClip`, `trimClip`, `setClipSpeed`, `setClipReverse`,
  `setClipKeyframes`.
- `src/components/editor/timeline/VolumeEnvelope.tsx` from Plan 04: the envelope surface the Pen
  edits.

## 1. Tool state and shortcuts

Extend `EditorTool` to `'select' | 'razor' | 'ripple' | 'slip' | 'pen'`.

Shortcuts. B, Y, and P are unused in the current keyboard map, so use them:

- V: select.
- C: razor.
- B: ripple trim.
- Y: slip.
- P: Pen.
- Escape: select.

Check every existing shortcut before landing. If the map has changed and one of B, Y, or P is taken,
stop and update this plan rather than silently choosing a different key. Update:

- `useEditorKeyboard.ts`.
- The shortcuts dialog in `MenuBar.tsx`.
- Toolbar tooltips.
- The toolbar active state.
- The cursor on clips and the timeline.

Rules:

- The active tool is session state, not `Doc`, matching the current select/razor behavior.
- Opening a project keeps the active tool, matching the existing session behavior.
- The razor behavior is unchanged.
- The select behavior is unchanged.
- Only one tool is active. There is no modifier stack.
- Cancellation contract for the new tools: pointercancel cancels the gesture and leaves the doc
  unchanged. Escape changes the tool only when no gesture is live; it does not cancel a live
  gesture. Existing select and trim gestures keep their current commit-on-pointercancel behavior;
  do not refactor them in this plan.

Toolbar:

- Add three buttons after the razor, grouped with the edit tools.
- Use `BetweenHorizontalStart` for ripple, `MoveHorizontal` for slip, and `PenTool` for Pen.
- Bottom-side tooltips with the name and shortcut.
- The buttons must not appear until their behavior exists.
- If Plan 06 splits, land the buttons with their behavior in the same sub-plan.

## 2. Ripple trim

Definition:

- With the ripple tool active, dragging a clip's head or tail trims the clip and shifts the later
  clips on the same track to close or open the gap.
- Same-track scope. Do not shift unrelated tracks in this plan. Later linked partners on other
  tracks do not shift. This is an explicit exception to `sequence-ops.ts` Invariant 14, not a match
  for the existing ripple delete. The exception is recorded below.
- The clip under the pointer is the target. Linked clips follow the existing select-trim behavior:
  the dragged clip is trimmed, and its twin is not automatically trimmed. Link ids remain, but the
  pair can end with different starts or durations. Do not claim link-group sync after ripple trim.
- Existing `commandsToRippleDeleteClips` is not a precedent: it resolves the selected link group
  and shifts every track that contains a member. Ripple trim deliberately does less in `0.15.0`.
- All-track or linked-closure ripple is a separate plan. Do not expand this one silently.
- A locked track refuses the gesture before a transient starts (Plan 05).
- A rate-stretched clip uses the existing `decideRateStretch` decision. If it returns `fits: false`,
  the ripple gesture refuses with the existing message. Do not fall through to a normal trim.
- A clip with a time-remap curve follows the normal trim fallback, not rate stretch.

### Link-group invariant exception (`0.15.0`)

`sequence-ops.ts` documents Invariant 14: link groups are always in sync for placement. Ripple trim
is same-track by the recorded decision, so it is an explicit exception:

- The edited clip's linked twin is not trimmed.
- Later linked partners on other tracks are not shifted.
- Link ids remain, but starts and durations can diverge.
- The existing ripple delete is not a precedent; it expands the selected link group and shifts
  every track containing a member.
- The tooltip or help text must name the limitation: "Ripple trim works on one track. Linked partners
  on other tracks do not shift."
- If the owner requires linked sync, stop and revise this plan before coding. Do not silently
  implement a link-closure rule.

Pure planner:

Create `src/lib/editor/ripple-trim.ts`:

- Input: doc, clip id, edge (head or tail), proposed start/inPoint/duration, active sequence path.
- The dragged clip is the only trim target. Do not trim its linked twin; the pair exception is
  explicit above.
- Compute the trim using the same rooms and bounds as `decideTrimStart`/`decideTrimEnd`.
- For a head ripple trim, call `trimClip` with `edge: 'head'` and `start` equal to the old start.
  The command then applies the provided in point and duration without moving the start. Verify that
  this holds for reversed, speed-changed, and time-remapped clips; if the command refuses, the
  planner refuses with the same message.
- Compute the end delta. For a tail trim, the start and in point stay anchored, the duration changes,
  and the end moves by the duration delta. For a head trim, the start stays anchored, the in point
  changes, the duration changes inversely, and the end moves by the same delta. The edited clip's
  start does not move in either case.
- Resolve the affected set as the trimmed clip's immediate next clip by start order plus every clip
  after it. Shift that whole run by the same end delta. For an adjacent edit point this is the set
  of clips that start at or after the old end. It also includes a transition partner, whose start
  sits before the old end because the transition pulled it left; both clips move by the shared
  delta, so the overlap is preserved exactly. Do not shift the trimmed clip itself or any earlier
  clip. Do not expand this set through link groups; a linked partner on another track stays put by
  the recorded exception.
- Preflight the shifted starts before building the batch. Refuse a shifted start below 0. Treat an
  overlap as valid only when it already existed as a transition overlap: the earlier clip has a
  `transitionOut`, the later clip is its immediate next clip, and both move together so the overlap
  is unchanged. Every other overlap is a collision and refuses with a message. Because every later
  clip takes the same delta, their mutual overlaps are unchanged, so the only relation to re-check
  is the trimmed clip against the first later clip. Do not clamp individual starts; a per-clip
  clamp breaks the one shared end delta. The existing ripple delete clamps at 0, but this planner
  deliberately refuses instead.
- Preserve transitions, markers, keyframes, and link ids through the trim and the shifts. Preserving
  a link id does not promise start or duration sync. Do not create, remove, or re-time a
  transition.
- Return a discriminated result: `{ status: 'ok', commands }` for a non-empty atomic batch,
  `{ status: 'noop' }` when the proposal leaves the doc unchanged, or
  `{ status: 'refused', message }` when validation fails. Do not use `null` for both a no-op and a
  refusal.
- Never produce a non-transition overlap on the same track.
- Handle a head trim that extends the clip: the start stays anchored, the in point moves earlier,
  the duration grows, and the end moves right. If the asset lacks source, refuse.
- Handle a head trim that shortens the clip: the start stays anchored, the in point moves later,
  the duration shrinks, and the end moves left.
- Handle a tail trim that extends right: later clips shift right, even if they were adjacent.
- A clip with a transition that overlaps the next clip keeps that overlap. The partner is in the
  affected set and shifts by the same delta, so the transition span and stored duration are
  unchanged. Test it. An overlap that is not backed by a `transitionOut` refuses.

Gesture:

- Use the existing `ClipView` edge handles, but branch on `activeTool === 'ripple'`.
- Add `applyTransientBatch(commands: EditorCommand[])` to the store. It validates the whole batch
  with `applyCommands` on a clone, then installs the validated doc once. Do not call
  `applyTransient` once per command: a later refusal would leave an earlier shift in the doc.
- Derive the shift delta from the validated trim result, not the raw pointer proposal. If the command
  clamps the trim, recompute the shifts from the clamped end; if that cannot be done atomically,
  refuse the gesture.
- Show a ripple cursor and preview the trim and shifted clips through the batch transient.
- One undo entry on release.
- Pointercancel cancels; a foreign commit ends the gesture.
- If the planner returns `refused`, show its message and apply nothing. A `noop` shows no message
  and adds no history entry.
- Do not start a clip move; the body still selects or does nothing according to the tool.

Tests:

- Pure planner: head and tail trims, positive and negative end deltas, later clips shift, earlier
  clips do not move, a head trim keeps the clip start anchored while in point and duration change,
  reversed clips on both edges, speed 0.5 and 2, Alt rate stretch, transitions, markers, keyframes,
  link ids, left shift crossing 0 refusal, collision refusal, no-op, locked track refusal. A left
  shift that would cross 0 refuses before the batch; the doc is unchanged and no history entry is
  added.
- Result contract: `ok` always carries a non-empty batch; `noop` and `refused` carry no commands. A
  no-op proposal returns `noop`, not `refused`. A collision returns `refused` with a message.
- Transition case: a clip with `transitionOut` and an overlapping next clip shifts the partner with
  the same delta. Assert the overlap and the transition span are unchanged. An unexplained overlap
  refuses instead of being accepted as a transition.
- Explicit link-group exception: a later linked pair on two tracks shifts only the edited track's
  half. Assert the two halves now have different starts, both link ids are unchanged, and the
  unrelated track did not move. This test is the record of the `0.15.0` exception, not a claim of
  sync.
- Gesture: one undo, transient commit, cancel, foreign commit, pointercancel, no partial writes on
  refusal. A refusal shows its message and adds no history entry; a no-op shows no message and adds
  no history entry.
- Batch transient: if the second shift command is invalid, the doc is unchanged, no history entry is
  added, and no partial trim remains.
- Browser: ripple trim a tail and a head; verify the gap closes or opens, later clips shift, the
  head trim keeps the clip start anchored, and unrelated tracks do not move. A later linked partner
  on another track stays put; assert the known mismatch so it cannot be mistaken for sync.

## 3. Slip

Definition:

- With the slip tool active, dragging a clip horizontally changes which part of its source it shows,
  without moving the clip on the timeline or changing its duration.
- The clip's `start` and `duration` stay fixed. Only `inPoint` changes.
- Bounds: keep the source window inside the asset. For a forward clip, `0 <= inPoint` and
  `inPoint + duration * speed <= assetDuration`. For a reversed clip, the same source span rule
  applies; confirm against `sourceTimeAt`.
- Images have no source window. Slip is a no-op with a message; do not move the image.
- Text and compound clips have no source window. Refuse with a message.
- A clip with a time-scale curve is not slip-able in the first pass. Refuse with a message; the
  curve already re-times the source and a slip would need a piecewise rebase.
- A locked track refuses the gesture (Plan 05).
- A linked A/V pair: slip both halves by the same source delta when they share the same asset and
  duration, so sync is preserved. If the pair cannot share the delta, refuse the whole gesture.
  Document and test.
- A linked group with different assets: refuse the slip, because slipping one member would desync
  the group.

Pure planner:

Create `src/lib/editor/slip.ts`:

- Input: clip, asset duration, proposed delta in source seconds, linked group if any.
- Compute the new `inPoint` and clamp to the valid range.
- Compute the actual delta after clamping.
- Add a dedicated `setClipInPoint` command with validation that `start` and `duration` are unchanged
  and the source window stays inside the asset. Do not overload `trimClip` for an in-point-only
  change. The command applies to the dragged clip and to any linked clip that shares the source
  window. Add this command to Plan 05's lock inventory and make a locked track refuse it.
- Apply the same delta to every linked clip that shares the source window.
- Never move the clip start or duration.
- Never produce an out-of-bounds source window.

Gesture:

- With the slip tool, pointerdown on a clip body starts a horizontal drag.
- Map the pointer delta to source seconds using the current px/s and speed. For a reversed clip,
  invert the mapping so dragging right moves the source window in the visible direction.
- Preview with transient commands. One undo entry on release.
- Show a readout of the source in/out and the delta.
- Pointercancel cancels. Escape changes the tool only when no gesture is live.
- The clip does not move on the timeline.

Tests:

- Pure planner: forward, reversed, speed 0.5 and 2, clamp at both ends, no-op, image/text/compound,
  time-remap refusal, linked pair shared delta, linked group mismatch refusal. The
  `setClipInPoint` command round-trips, refuses a start or duration change, refuses an
  out-of-bounds source window, and is one undo entry.
- Gesture: one undo, cancel, foreign commit, no start/duration change, locked track refusal.
- Browser: add a read-only `data-in-point` attribute to the clip element (or a `data-testid` to the
  Inspector Trim readout), slip a video clip, and verify the same frames at the same timeline time
  change. The clip position and duration do not move. Confirm the linked audio stays in sync. Do not
  rely on a browser store handle that does not exist.

## 4. Keyframe Pen

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

Tests:

- Pure: property selection for audio/video/image/text/compound; a solo video selects opacity, not
  volume; add, replace within one frame, remove, nudge; clamps; sorted output; no mutation.
- Gesture: add on click, a 2px move is a click, a 4px move starts one drag, alt-click removes on
  release, pointercancel leaves a pending alt-click removal unapplied, keyboard nudge/delete, one
  undo, cancel, locked track refusal, no clip move while the Pen is active.
- Render: the Pen shows the curve on a selected clip with no keyframes; the select tool shows an
  opacity curve only when opacity keyframes exist; the overlay is behind the label and trim handles.
- Browser: add a volume point to an audio clip and an opacity point to a video clip; undo; confirm
  the clip did not move.

## 5. Tool interaction matrix

Add a table and tests for every combination:

| Tool   | Clip body drag     | Clip edge drag | Click empty lane | Click clip                     |
| ------ | ------------------ | -------------- | ---------------- | ------------------------------ |
| Select | Move               | Trim           | Clear selection  | Select                         |
| Razor  | Cut on pointerdown | Trim (current) | Clear selection  | Cut                            |
| Ripple | No move            | Ripple trim    | Clear selection  | Select                         |
| Slip   | Slip source        | No trim        | Clear selection  | Select and slip                |
| Pen    | No move            | No trim        | Clear selection  | Select, curve click adds point |

The current razor intercepts only the clip body; the edge handles still trim. Preserve that in this
plan. If cut-on-edge is wanted later, it is a deliberate behavior change with its own red-first
test, not a silent side effect.

Modifiers:

- Alt on a select edge is rate stretch. Alt on a ripple edge is rate stretch using the same
  source-span decision as the select tool, then shifting later clips by the end delta. If the
  normal rate stretch refuses, the ripple gesture refuses too. Do not fall through to a normal trim
  silently.
- Shift and Ctrl selection modifiers keep working in Select, Ripple, Slip, and Pen. Razor keeps its
  current cut-first behavior: it cuts before the selection code, so do not claim selection
  modifiers there.
- Multi-touch: only the initiating pointer drives a gesture.

## 6. Tests and proof

Unit and render tests:

- `tool-state` tests for the new tool union and shortcuts.
- `ripple-trim.test.ts` pure planner.
- `slip.test.ts` pure planner.
- `pen.test.ts` pure keyframe helper.
- `timeline-panel-ui.test.tsx` or new gesture tests for one undo, cancel, refusal, and tool matrix.
- `useEditorKeyboard` tests for B, Y, P, V, C, Escape.
- Toolbar render tests for the three buttons, active state, tooltips, and no dead icons.
- Static locks for the tool matrix and the absence of a mask Pen.

Coverage:

- Add `src/lib/editor/ripple-trim.ts`, `src/lib/editor/slip.ts`, and `src/lib/editor/pen.ts` to the
  coverage include list in `vitest.config.ts`.
- Add them to the coverage-scope sentence in `docs/testing.md`.
- Run `bun run test:coverage` once in this plan. New pure modules outside the include list are
  unmeasured.

Browser proof:

- Wait for `data-filmstrips-ready` on the timeline root before screenshots or clip checks.
- Ripple trim closes a gap on the same track and leaves other tracks alone.
- Slip changes the source frame at a fixed timeline time without moving the clip.
- Pen adds and removes a volume point and an opacity point.
- Each tool's shortcut and cursor work.
- Locked tracks refuse each tool.
- Undo once per gesture.
- Console clean.

Flakiness controls:

- Pure planners are the primary proof. Gesture tests assert the command batch and the doc, not
  animation.
- Do not use pixel color to prove a slip. Read the clip's `data-in-point` attribute; the Inspector
  Trim readout is only a fallback. There is no browser store handle.
- Use the existing window-listener and transient-token patterns. Do not invent a second gesture
  system.
- No fixed sleeps. Wait on the overlay or use fake timers.
- Split trigger: if the change exceeds 15 changed files or 500 changed lines, split at the gate:
  - `06a`: tool state, ripple trim, slip, released as `0.15.0`.
  - `06b`: keyframe Pen and the generalized automation envelope, released as `0.16.0`.
    The split is a mechanical plan change. Do not hide it inside one giant commit.

## 7. Release tasks for `0.15.0` (`0.16.0` for `06b` if split)

- Atomic version bump: `package.json`, `src/lib/releases.ts`, `CHANGELOG.md`, and a new `0.15.0`
  row in the `ROADMAP.md` Shipped table. The user confirms the version before the bump.
- Update `README.md`, `docs/architecture.md`, `docs/flows.md`, `docs/design-system.md`,
  `docs/testing.md`, and `docs/structure.md`.
- Recapture the hero screenshot with the new tools visible. Update the alt text in
  `src/components/site/Hero.tsx` and the mirror in
  `src/lib/editor/__tests__/public-pages.render.test.tsx`. Real capture only.
- Update the shortcuts dialog and the README shortcut list.
- Update test counts through `docs-drift.test.ts`.
- Add battery steps for ripple, slip, and Pen if jsdom cannot prove the user-visible result. Update
  both `e2e/battery.sh` and `e2e/battery.timing.sh`, and the documented counts.

## Acceptance criteria

- Ripple trim, slip, and Pen each work from the toolbar, shortcut, and pointer.
- Ripple trim shifts only the edited track and never creates an invalid overlap. An existing
  transition overlap is preserved by shifting its partner with the same delta; only an overlap not
  explained by a transition is refused. The plan explicitly documents and tests the Invariant 14
  exception; it does not claim linked-group sync.
- Slip never moves the clip or changes its duration; linked pairs stay in sync or the gesture is
  refused.
- Pen edits volume on audio-only clips and opacity on visual clips, using the existing keyframe
  commands. A solo video edits opacity with the Pen; its volume envelope stays directly draggable.
- No mask or roto behavior is present.
- Every tool respects locked tracks.
- Every gesture is one undo entry and cancels cleanly.
- The tool matrix tests are complete.
- `bun run check` is green.
- The `0.15.0` version bump and docs are complete (`0.16.0` for `06b` if split).

## Risks

- **Ripple semantics.** Same-track ripple is the recorded `0.15.0` decision. It is an explicit
  exception to Invariant 14, not a match for ripple delete: the existing ripple delete expands the
  selected link group and shifts every track containing a member. All-track or linked-closure ripple
  is a separate plan; do not expand this one silently.
- **Linked pair sync.** Ripple trims one half and shifts one track, so linked partners can diverge.
  The exception is documented, tooltipped, and tested. If the owner requires sync, revise the plan
  before coding. Slip refuses when a linked pair cannot share the delta.
- **Gesture complexity.** Reuse the existing transient and window-listener patterns; do not add a
  second gesture engine.
- **Pen overlap with Plan 04.** Generalize the envelope, do not copy it.
- **Scope growth.** Split Plan 06 if the change exceeds 15 changed files or 500 changed lines.
- **Shortcut conflicts.** B, Y, and P are free in the current map. If that changes before
  implementation, stop and update the plan.

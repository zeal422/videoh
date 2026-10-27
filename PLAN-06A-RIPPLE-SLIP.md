# PLAN 06A: Ripple trim and slip

Status: implemented, awaiting commit
Depends on: [PLAN 04](PLAN-04-VOLUME-AUTOMATION.md), [PLAN 05](PLAN-05-TRACK-CONTROLS.md)
Release: `0.15.0`
Split: [PLAN 06B](PLAN-06B-KEYFRAME-PEN.md) carries the keyframe Pen and releases as `0.16.0`.
Plan 06 split at its own gate (more than 15 changed files or 500 changed lines) before coding, as
the original plan required.
Goal: make the reference's ripple and slip tools real. Every toolbar icon has a mode, a shortcut, a
cursor, a documented behavior, and tests.

## Scope

1. Extend the editor tool state from select/razor to ripple and slip.
2. Add a pure ripple-trim planner and gesture.
3. Add a pure slip planner and gesture.
4. Add toolbar buttons, shortcuts, tooltips, and cursors.
5. Tests, browser proof, and the `0.15.0` release tasks.

The keyframe Pen, and the generalized automation envelope it needs, are
[PLAN 06B](PLAN-06B-KEYFRAME-PEN.md).

## Non-goals

- No mask, roto, or Bezier shape drawing in the program monitor.
- No rolling edit, slide, or slide tool.
- No new transition or effect behavior.
- No new keyframe property.
- No keyframe Pen in this plan. 06B owns it, and its button does not land here.
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

## 1. Tool state and shortcuts

Extend `EditorTool` to `'select' | 'razor' | 'ripple' | 'slip'`.

Shortcuts. B and Y are unused in the current keyboard map, so use them:

- V: select.
- C: razor.
- B: ripple trim.
- Y: slip.
- Escape: select.

Check every existing shortcut before landing. If the map has changed and B or Y is taken, stop and
update this plan rather than silently choosing a different key. Ctrl+Y is redo, but the modifier
branch returns before the single-key switch, so plain Y is free. Update:

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

- Add two buttons after the razor, grouped with the edit tools.
- Use `BetweenHorizontalStart` for ripple and `MoveHorizontal` for slip.
- Bottom-side tooltips with the name and shortcut. The ripple tooltip names the same-track
  limitation: "Ripple trim works on one track. Linked partners on other tracks do not shift."
- The buttons must not appear until their behavior exists. The Pen button waits for 06B.

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
  and the end moves by the duration delta. For a head trim, the start stays anchored, the duration
  changes inversely, and the end moves by the same delta. A forward clip's in point moves with the
  head; a reversed clip keeps its low in point anchor because its head shows the high source end.
  The edited clip's start does not move in either case.
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
- Handle a forward head trim that extends the clip: the start stays anchored, the in point moves
  earlier, the duration grows, and the end moves right. If the asset lacks source, refuse.
- Handle a forward head trim that shortens the clip: the start stays anchored, the in point moves
  later, the duration shrinks, and the end moves left. A reversed head trim keeps the low in point
  anchor and lets the duration carry either direction.
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
  clips do not move, a head trim keeps the clip start anchored while the duration changes and a
  forward clip's in point moves, reversed clips on both edges, speed 0.5 and 2, Alt rate stretch, transitions, markers, keyframes,
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

## 4. Tool interaction matrix

Add a table and tests for every combination:

| Tool   | Clip body drag     | Clip edge drag | Click empty lane | Click clip      |
| ------ | ------------------ | -------------- | ---------------- | --------------- |
| Select | Move               | Trim           | Clear selection  | Select          |
| Razor  | Cut on pointerdown | Trim (current) | Clear selection  | Cut             |
| Ripple | No move            | Ripple trim    | Clear selection  | Select          |
| Slip   | Slip source        | No trim        | Clear selection  | Select and slip |

The current razor intercepts only the clip body; the edge handles still trim. Preserve that in this
plan. If cut-on-edge is wanted later, it is a deliberate behavior change with its own red-first
test, not a silent side effect.

Modifiers:

- Alt on a select edge is rate stretch. Alt on a ripple edge is rate stretch using the same
  source-span decision as the select tool, then shifting later clips by the end delta. If the
  normal rate stretch refuses, the ripple gesture refuses too. Do not fall through to a normal trim
  silently.
- Shift and Ctrl selection modifiers keep working in Select, Ripple, and Slip. Razor keeps its
  current cut-first behavior: it cuts before the selection code, so do not claim selection
  modifiers there.
- Multi-touch: only the initiating pointer drives a gesture.

## 5. Tests and proof

Unit and render tests:

- `tool-state` tests for the new tool union and shortcuts.
- `ripple-trim.test.ts` pure planner.
- `slip.test.ts` pure planner.
- `timeline-panel-ui.test.tsx` or new gesture tests for one undo, cancel, refusal, and tool matrix.
- `useEditorKeyboard` tests for B, Y, P, V, C, Escape.
- Toolbar render tests for the two new buttons, active state, tooltips, and no dead icons.
- Static locks for the tool matrix. No Pen control or mask behavior lands in 06a.

Coverage:

- Add `src/lib/editor/ripple-trim.ts` and `src/lib/editor/slip.ts` to the coverage include list in
  `vitest.config.ts`.
- Add them to the coverage-scope sentence in `docs/testing.md`.
- Run `bun run test:coverage` once in this plan. New pure modules outside the include list are
  unmeasured.

Browser proof:

- Wait for `data-filmstrips-ready` on the timeline root before screenshots or clip checks.
- Ripple trim closes a gap on the same track and leaves other tracks alone.
- Slip changes the source frame at a fixed timeline time without moving the clip.
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
- This document is `06a`. `06b` owns the keyframe Pen and the generalized automation envelope.
  Do not grow this plan into the Pen. If the change exceeds its own remaining surface, stop and
  report before expanding it.

## 6. Release tasks for `0.15.0`

- Atomic version bump: `package.json`, `src/lib/releases.ts`, `CHANGELOG.md`, and a new `0.15.0`
  row in the `ROADMAP.md` Shipped table. The user confirms the version before the bump.
- Update `README.md`, `docs/architecture.md`, `docs/flows.md`, `docs/design-system.md`,
  `docs/testing.md`, and `docs/structure.md`.
- Recapture the hero screenshot with the new tools visible. Update the alt text in
  `src/components/site/Hero.tsx` and the mirror in
  `src/lib/editor/__tests__/public-pages.render.test.tsx`. Real capture only.
- Update the shortcuts dialog and the README shortcut list.
- Update test counts through `docs-drift.test.ts`.
- The full dev and production batteries remain the Plan 07 gate. Manual browser proof covers
  ripple and slip for this release; add battery steps in Plan 07 if jsdom cannot prove the final
  user-visible result.

## Acceptance criteria

- Ripple trim and slip each work from the toolbar, shortcut, and pointer.
- Ripple trim shifts only the edited track and never creates an invalid overlap. An existing
  transition overlap is preserved by shifting its partner with the same delta; only an overlap not
  explained by a transition is refused. The plan explicitly documents and tests the Invariant 14
  exception; it does not claim linked-group sync.
- Slip never moves the clip or changes its duration; linked pairs stay in sync or the gesture is
  refused.
- Every tool respects locked tracks.
- Every gesture is one undo entry and cancels cleanly.
- The tool matrix tests are complete.
- `bun run check` is green.
- The `0.15.0` version bump and docs are complete.

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
- **Scope growth.** The Pen and the generalized automation envelope belong to 06B. Do not fold them
  into this release.
- **Shortcut conflicts.** B and Y are free in the current map. If that changes before implementation,
  stop and update the plan.

## Implementation notes

Recorded after the build, so the plan matches what shipped:

- **Split.** The original Plan 06 crossed its own gate (more than 15 changed files or 500 changed
  lines), so it split into 06A and 06B before coding. 06A owns the tool state, ripple trim, slip,
  and `0.15.0`; 06B owns the Pen and `0.16.0`.
- **`applyTransientBatch`.** The store method validates the whole batch through `applyCommands` (the
  same guard as a committed batch) and installs the resulting doc once. The ripple gesture passes a
  frozen pre-gesture doc to the planner every frame, so an absolute proposal does not compose over
  the live, already-trimmed doc.
- **Rate stretch.** The Alt ripple path reuses `decideRateStretch` and then calls `planRippleShift`
  with the end delta the decision produced; a head stretch anchors the end and shifts nothing. The UI
  test pins the tail case (4s to 5s at 0.8x, later clip +1s).
- **Head trim anchoring.** `trimClip`'s constant-rate rebase assumed the head move lived in `start`.
  A ripple head trim leaves `start` anchored and supplies its own in point for a forward clip (a
  reversed clip keeps the low anchor), so the rebase now runs only when `start` actually moved. The
  speed-2 planner test failed before the gate and passes after.
- **`setClipInPoint`.** The command expands to the sequence-local link group that shares the source
  window and refuses a mixed-window group, so a direct caller cannot desync a pair. The lock rule
  checks every member lane.
- **Same-track link exception.** Ripple shifts only the edited track's later clips. The test asserts
  the linked partner on the other track stays put and the halves diverge on start. This is the
  recorded exception, not a sync claim.
- **Tool switching.** V, C, B, Y, and Escape wait while a transient gesture is active, so a live slip
  or ripple cannot be switched out from under its closures.
- **Pointercancel.** The first draft routed pointercancel through the same commit handler as
  pointerup, which is the existing select/razor behavior but wrong for the new tools. Ripple and slip
  now cancel and restore the base; select and razor keep their commit-on-pointercancel behavior. The
  UI test failed before the split and passes after.
- **No-op origin.** A slip or ripple drag that returned to its origin left the previous frame in the
  doc, so the release committed a change the pointer no longer asked for. `resetTransient` restores
  the frozen base without ending the gesture; no-op slip, ripple, and Alt rate-stretch frames use it.
  The slip readout clears on the slip no-op. The UI tests cover all three returns.
- **Volume envelope.** The prop renamed from `razorActive` to `inert`; every modal tool sets it.
- **Batteries.** The full dev and production batteries remain the Plan 07 gate, as recorded in the
  epic. This release uses unit tests plus manual browser proof.

## Trigger audit (implementation-discipline)

- **Baseline.** Clean tree at `06bf6b8`; `bun run check` green at 85 files and 1,823 tests; coverage
  95.07 / 90.62 / 96.73 / 96.98. No pre-existing failures.
- **Ladder.** `ripple-trim.ts` and `slip.ts` reuse `trimRooms`, `applyCommand`, `applyCommands`,
  `linkedClips`, `findMedia`, and the existing lock helpers. `applyTransientBatch` reuses
  `applyCommands` on one clone instead of a second commit path. `setClipInPoint` is a command variant,
  not a second automation store. The envelope prop rename reuses the Plan 04 component. Nothing new
  was added where an existing helper held.
- **Red-first.** The start-anchored speed-2 head trim test failed on the ungated `trimClip` rebase
  (`inPoint` stayed 4 instead of 6) and passes with the gate. The pointercancel test failed because
  the new tools shared the old commit-on-cancel handler; the cancel path fixed it. The no-op return
  tests and the store `resetTransient` test fail when `resetTransient` is disabled (the doc keeps the
  previous frame) and pass with it. The new command and planners had no prior behavior to fail
  against; their tests pin the new contract, including hostile inputs.
- **Final gate.** `bun run check` green at 88 files, 1,880 tests, 11 routes, and the production
  build. `bun run test:coverage` reports 94.77 / 90.35 / 96.53 / 96.87.
- **Browser proof.** At 1600x1000 on the bundled sample: a ripple tail drag took the video
  from 0..6 to 0..5.5 and moved the image from 14 to 13.5 while the linked audio twin stayed at
  0..6 (the recorded divergence); a ripple head drag kept the video start at 0, moved its in point
  to 0.5, shortened it to 5.0, and moved the image to 13.0; a slip drag on the trimmed audio clip
  read `In 1.00 / Out 8.00 (+1.00s)` and changed `data-in-point` from 0 to 1 while start and
  duration stayed 6 and 7; a locked V1 refused the ripple drag with a "Track locked" toast and no
  label changes. The B/Y/V/C shortcuts and the body/edge cursors were checked, and the page error
  and console logs were empty.
- **Findings.** None before implementation. No review round was run for this plan.
- **Lessons.** None appended to `LESSONS.md`; no scratch worktree was created.

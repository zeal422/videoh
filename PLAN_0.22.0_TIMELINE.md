# 0.22.0 timeline commands

**Created:** 2026-11-12
**Complexity:** Medium
**Effort:** M
**Schema:** 4, no bump
**Depends on:** 0.21.0
**Status:** planned

## 1. Goal

Add two editing commands that competitors already have and this editor does not:

- Close the gaps on a track in one action.
- Join two adjacent clips from the same source into one clip.

Both are command-layer features. They do not change `Doc`, serialization, preview, or export. The release
is one commit and one version bump.

## 2. Anti-goals

- No ripple delete rewrite. Ripple delete already exists.
- No automatic gap closing across every track at once.
- No compound clip or nested sequence editing.
- No general merge for different sources, different retiming, or different effects.
- No keyboard shortcut in this release. Menu and context menu entries are enough.
- No schema change.

## 3. Current state, verified

- The command catalog has 60 commands. It has trim, split, ripple delete, and link operations, but no
  close-gaps or join command (`src/lib/editor/commands.ts`).
- Track lock is enforced by the command layer through `LOCK_RULES`, not only by the UI
  (`src/lib/editor/commands.ts`, `src/lib/editor/tracks.ts`).
- A clip's transition overlap is part of the timeline geometry. Any gap calculation must use the same
  end and overlap helpers as the rest of the editor, not a second local formula.
- The Clip menu and context menu already host editing actions. New entries should follow the shared
  action executor pattern, with UI-owned enablement only where the command cannot decide.

## 4. Technical approach

### Close gaps

Add a command with a target track id and the active sequence scope. The command validates the track,
refuses a locked track, and returns a new `Doc`.

Algorithm, in prose:

1. Read the track's clips in start order.
2. Treat the interval from time zero to the first clip's start as a leading gap, then find every
   positive gap between the end of one clip and the start of the next. Use the existing
   transition-aware layout semantics so a crossfade overlap is not mistaken for a negative gap.
3. Walk the track once with a running offset. The first clip receives the leading offset, so a first
   clip that starts after zero moves to zero. Shift each later clip by the cumulative offset,
   preserving durations, source windows, effects, keyframes, and markers. This is equivalent to
   shifting the suffix once per gap, without the repeated work.
4. Stop when the track end is reached. No second pass is needed.
5. Build the planned delta for every clip: the cumulative offset for the target track, plus the partner
   delta for linked clips on other tracks. For each link group, every member must receive the same
   delta. If two members would receive different deltas, refuse the whole batch before moving anything.
6. Validate every partner track's lock state. If any partner track is locked, refuse the whole batch.
7. Revalidate every moved clip's transition span against its next clip with the existing transition
   helpers. If any span cannot remain valid, refuse the whole batch with a clear error.
8. If a partner would move before zero or collide with another clip, refuse the whole batch with a
   clear message.
9. Apply the result as one command so undo restores the entire close-gaps action.

Do not move sequence markers. They stay at absolute times even though the clips move, so a marker can
end up over different content; state this in the menu tooltip and docs. Do not move clip markers,
which are source-relative. Do not change transition durations. If the track is empty or already
gapless, return a no-op refusal or a no-op result consistent with the existing command style.

### Join adjacent clips

Add a command with two clip ids. Validate both clips and the same track.

Strict first-version conditions:

- Same `mediaId` and same media kind.
- The clips are adjacent within `TIME_EPSILON`, with no gap and no overlap.
- The previous clip has no `transitionOut` (the boundary into the next clip), and the next clip has no
  `transitionOut` (its outgoing transition to the clip after it). Either condition refuses; a later
  version can transfer the next clip's outgoing transition instead.
- Both clips have the same speed and reverse flag. Compare the previous clip's playback tail at
  `sourceTimeAt(previous, previous.duration)` with the next clip's playback head at `sourceTimeAt(next, 0)`;
  they must match within `TIME_EPSILON`. For a forward clip that is `inPoint + duration * speed` versus
  the next `inPoint`; for a reversed clip the mirror swaps the ends, so use the helper rather than a
  local formula.
- Both clips have the same non-source properties that the joined clip will keep: muted, audioOnly,
  gain, pan, eq, compressor, denoise, opacity, blend mode, temperature, tint, lutId, effects, anim
  statics, and clip markers. If any of these differ, refuse and explain why. `linkId` is handled by the
  linked-pair rule below, and `transitionOut`, speed, reverse, text, compound, and keyframes have their
  own rules above.
- Neither clip has any keyframe curve, on the clip or on an effect. Keyframe times are clip-local, so
  the next clip's curves would point at the wrong local times after the join. Identical curves are not
  enough because the next clip's curve is discarded. Rebasing is a later change, not part of this
  release.
- Neither clip is a compound clip or a text clip.

On success, extend the previous clip's source window by the next clip's source window and remove the
next clip. For a forward previous clip, keep `inPoint` and add the next duration. For a reversed
previous clip, set `inPoint` to the next clip's `inPoint`, which is its low anchor, and add the next
duration, so the joined tail lands on the next clip's low source end and the head stays on the original
high end. Verify both ends through `sourceTimeAt` within `TIME_EPSILON`. Leave one undo entry and keep
the previous clip's id and selection.

Link groups can contain more than two clips because manual Link merges whole groups. If either clip is
linked, collect every affected group and require a matching join for every member before applying the
batch: each selected clip's counterpart must pass the same conditions, and every member must receive a
consistent joined clip. If any member lacks a counterpart or the group cannot be joined atomically,
refuse the whole batch and keep every previous clip id and the previous selection. Do not leave a
partial join. `linkId` is stored per clip, not in a separate registry, so removing the next group
removes its metadata with the clips. Undo restores the whole doc snapshot, including every clip and
its `linkId` value.

A later release can relax the property equality rules and transfer effects deliberately. Do not do that
here.

### UI

- Clip menu: Close Gaps on the active track, Join Clips when exactly two adjacent same-source clips are
  selected.
- Timeline context menu: the same entries with the same enablement.
- Command menu ids and action executor entries if the existing pattern requires them.
- Tooltips or menu descriptions should state the target track for Close Gaps.

Do not put the command logic in the menu. The menu dispatches, the command validates and mutates.

## 5. File plan

Expected modified files:

- `src/lib/editor/commands.ts`: command union, validation, gap and join implementations.
- `src/lib/editor/commands.ts` or a small pure helper: gap and adjacency planning.
- `src/lib/editor/actions.ts` and `src/lib/editor/menus.ts` for menu participation if needed.
- `src/components/editor/MenuBar.tsx` and the timeline context menu for entries and enablement.
- `src/lib/editor/__tests__/` command tests and UI/static locks.
- `docs/architecture.md` command catalog, `README.md` editing list, `docs/flows.md` if the flow
  contract changes.

## 6. Phases and verification

### Phase 1: gap planner

- Add a pure gap planner with tests first.
- Verify a red test fails before the planner exists.
- Cover no gap, one gap, several gaps, transition overlap, locked track, empty track, and linked
  partners.

### Phase 2: close gaps command

- Wire the planner into the command layer.
- Verify one undo entry restores every moved clip.
- Verify a linked partner collision refuses the whole batch and leaves the doc unchanged.
- Verify a linked partner on a locked track refuses the whole batch before any move.
- Verify a link group that would receive conflicting deltas refuses the whole batch before any move.
- Verify a moved clip whose transition span cannot remain valid refuses the whole batch.
- Verify hostile track ids and sequence ids are rejected.

### Phase 3: join command

- Add the strict adjacency and property checks.
- Verify a red test for a rejected mismatch fails before the check exists.
- Verify a successful forward join preserves the source window, id, and selection.
- Verify a reversed pair joins with the correct joined source window and both playback ends.
- Verify a previous or next `transitionOut` refuses the join.
- Verify any clip or effect keyframe curve refuses the join.
- Verify a retained field mismatch (muted, audioOnly, grade, LUT, effects, markers) refuses the join.
- Verify transition, keyframe, effect, marker, compound, text, and linked cases, including a linked
  partner on a locked track.
- Verify a three-or-more-member link group joins as one batch or refuses atomically; refusal preserves
  every previous id and the previous selection, and no member is left joined.
- Verify the joined group keeps its `linkId`, the removed group's `linkId` is gone, and undo restores
  every previous clip.

### Phase 4: UI

- Add menu and context entries with enablement.
- Verify disabled states for non-adjacent, different-source, locked, and transitioned clips.
- Verify the menu dispatches through the shared action path.

### Phase 5: docs and release cut

- Update the command catalog and README.
- Run `bun run check`.
- Run `bun run battery:pair`.
- Apply the atomic 0.22.0 bump from the master plan.

## 7. Tests and locks

- Close gaps: no-op, one leading gap that moves the first clip to zero, one gap, multiple gaps,
  transition overlap, locked track, empty track, sequence markers unchanged, linked partner moved,
  linked partner on a locked track refuses the batch, linked group with conflicting deltas refuses the
  batch, moved clip with a transition span that cannot remain valid refuses the batch, linked partner
  collision refused, undo restores all clips.
- Join: adjacent forward success, reversed pair success with the correct joined source window, gap
  refusal, overlap refusal, different media refusal, different speed, reverse mismatch, source
  discontinuity, previous or next `transitionOut` refusal, effect mismatch, retained field mismatch
  (muted, audioOnly, grade, LUT), any clip or effect keyframe refusal, marker mismatch, compound
  refusal, text refusal, locked track, linked pair joined as one batch, linked partner mismatch
  refusal, linked partner on a locked track refusal, a three-or-more-member group that joins or
  refuses atomically without a partial join, joined group keeps its `linkId`, removed group's `linkId`
  is gone, undo restores every previous clip.
- Hostile input: unknown clip ids, duplicate ids, wrong types, clips from different sequences, and
  clips that do not exist after a concurrent command.
- Static locks: menu and context menu call the shared command path, not their own mutation code.

## 8. Atomic release cut

Follow section 7 of `MASTER_PLAN.md`. The 0.22.0 commit must update:

- `package.json` to `0.22.0`.
- `src/lib/releases.ts` with four or more highlights and the actual ISO date.
- `CHANGELOG.md` with `## [0.22.0] - YYYY-MM-DD`.
- `ROADMAP.md` with the shipped row and intro sentence. No Premiere gap status change.
- `README.md` editing list.
- `docs/architecture.md` command catalog and any helper module row.
- `docs/flows.md` if the timeline editing contract changes.
- `docs/testing.md` if tests or coverage scope changed.

Do not bump the schema.

## 9. Rollback

Revert the single release commit. There is no data migration. If Join is wrong in production, hiding
the menu entry is a temporary mitigation, but the command must still be reverted at the cause.

## 10. Risks and decisions

- **Close gaps and linked audio.** The default is to shift linked partners by the same delta, and to
  refuse the whole batch if a partner cannot move. This preserves sync. Do not leave one half behind.
- **Transition geometry.** Reuse existing helpers. A second gap formula will disagree with playback.
- **Join data loss.** The strict property checks are deliberate. Keyframes are refused entirely in v1,
  and the next clip's outgoing transition is refused rather than dropped. Relax them only with a
  separate plan that says which properties transfer and how markers, keyframes, and transitions rebase.
- **Marker behavior.** Sequence markers and clip markers do not move. State this in the docs.

## 11. Definition of done

- Close Gaps handles gaps, transitions, locked tracks, and linked partners with one undo entry.
- Join only merges safe adjacent same-source clips and refuses everything else.
- Menu and context entries are enabled only when the command can succeed.
- `bun run check` and the affected battery flows are green.
- The 0.22.0 version bump is atomic in one commit.

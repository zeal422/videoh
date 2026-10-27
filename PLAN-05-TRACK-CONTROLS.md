# PLAN 05: Track solo and lock

Status: done
Depends on: [PLAN 02](PLAN-02-GEOMETRY-AND-CHROME.md), [PLAN 04](PLAN-04-VOLUME-AUTOMATION.md)
Release: `0.14.0`
Goal: add real audio-track solo and real track lock, with both behaviors enforced in the command and
mix layers, not only in the UI.

## Scope

1. Extend the track model with `solo` and `locked`.
2. Add commands, hydration, serialization, and undo.
3. Apply solo identically in preview and export.
4. Enforce lock across every edit path.
5. Add the M/S and lock controls to the track header and context menu.
6. Tests, browser proof, and the `0.14.0` release tasks.

## Non-goals

- No video-track solo. Solo is an audio monitoring feature. Video tracks keep visibility and mute.
- No track groups, VCAs, or bus routing.
- No lock for media-bin removal beyond the explicit rule below.
- No lock inside a compound sequence from the container's lock. Lock applies to the sequence whose
  track holds the flag.
- No new keyboard shortcuts unless they are documented in the shortcuts dialog and tested. M/S
  header buttons are enough.

## Current state to verify

- `src/lib/editor/types.ts`: `Track` has `muted` and `visible`; no `solo` or `locked`.
- `src/lib/editor/commands.ts`: `toggleTrackMute`, `setTrackVisible`, `moveClip`, `trimClip`,
  `splitClip`, `deleteClip`, `addClip`, `removeTrack`, transitions, effects, keyframes, and marker
  commands.
- `src/lib/editor/serialization.ts`: `hydrateTracks` reads `muted` and `visible`; version 4.
- `src/lib/editor/playback/core.ts`: `PlaybackCore.computeGain` silences on
  `clip.muted || track.muted` plus the reverse/rate/link predicates at `:800-806`.
- `src/lib/editor/export/offline.ts`: `planAudioFrame` silences on `clip.muted || track.muted`
  plus the same predicates at `:287`.
- `src/lib/editor/export/mp4.ts`: `renderAudioMix`, `scheduledAudioSource`, and
  `docHasAudibleClips` are the shipped audio path. `scheduledAudioSource` has the per-clip gate at
  `:1006`; `scheduleTracks` is the compound recursion at `:842`.
- `src/components/editor/timeline/TimelinePanel.tsx`: `TrackHeader` has name, eye and mute controls,
  and the context menu. The clip count this plan originally listed is already gone: Plan 02 removed
  it, and a stale JSDoc line was the only remaining mention.
- `src/lib/editor/links.ts`: linked groups move, delete, split, and select together.
- `src/lib/editor/actions.ts`: ripple delete, split, delete, duplicate, link, unlink helpers.

## 1. Data model

Add to `Track`:

```ts
solo?: boolean
locked?: boolean
```

Rules:

- Absent `solo` and `locked` mean false. This is the opposite of `visible`, whose absent value
  means visible.
- Both are project data and undoable. They live in `Doc`, serialize, and survive autosave.
- Do not add a schema version bump if absent fields hydrate to false and old files still read. If
  the serialization format needs a new version for a different reason, follow the existing
  migration pattern and bump it. The tests must prove old files read and new files round-trip.
- Track clone helpers and factories must preserve both fields. Search every `Track` construction.
- `removeTrack` deletes the track and its flags with it. Undo restores them.

Commands:

- `setTrackSolo` with `{ trackId, solo }`.
- `setTrackLocked` with `{ trackId, locked }`.
- The existing `toggleTrackMute` remains. Do not add toggle variants for solo or lock; explicit
  setters are easier to test and reuse in menus.

Validation:

- Unknown track id throws `EditorCommandError`.
- Solo on a video or text track throws `EditorCommandError`. The command is invalid for that kind.
  The UI only shows S on audio tracks.
- Lock is valid on every track kind.
- Setting a value that is already set writes a history entry, matching the existing boolean setters.
  The command layer does not dedupe. The UI must only dispatch a setter when the value changes; do
  not claim a no-op history guard that does not exist.

## 2. Solo semantics

Solo is a track state, not a mute alias.

Definitions:

- `anySolo` is true when at least one audio track in the active sequence has `solo === true`.
- When `anySolo` is false, audibility is the existing rule: a clip is audible if its clip is not
  muted and its track is not muted.
- When `anySolo` is true, only audio tracks with `solo === true` are audible. A non-soloed track is
  silent even if it is not muted.
- A soloed track that is also muted remains silent. Solo does not override its own mute.
- Multiple soloed tracks are allowed.
- A solo video clip with embedded audio is not on an audio track, so it is silent while any audio
  track is soloed. If no audio track is soloed, it keeps its existing behavior. A linked A/V pair's
  audio twin is the carrier; the video half is shadowed as today.
- Solo is evaluated per sequence and applies wherever that sequence is rendered. A soloed track
  inside a compound mutes the other tracks inside that compound. The parent sequence has its own
  solo state. This matches track mute, which already applies inside a compound. Test the active
  nested sequence and the compound rendered inside the root.
- Track solo is not the same as clip mute. Both still multiply.
- Crossfade, clip gain, clip volume, pan, EQ, compressor, and denoise are unchanged. Solo is one
  more gate before the gain chain.

Implementation shape:

- Add two pure helpers in `src/lib/editor/tracks.ts`:
  - `anySoloFor(tracks): boolean`, true when any audio track in the list is soloed.
  - `audibleTrackIds(tracks): Set<string>`. With no solo it returns every non-muted track. With
    any solo it returns only the soloed audio tracks; a video track is excluded, so a solo video's
    embedded audio is silent while an audio track is soloed.
- This module is the one shared track audibility predicate named by the orchestrator. Keep the
  existing per-clip `clipRendersAudio(doc, clip)` in `src/lib/editor/links.ts`; do not create a
  second `audibility.ts` or a per-caller copy.
- Use the helpers in every audio path:
  - `PlaybackCore.computeGain` in `playback/core.ts`.
  - `planAudioFrame` in `export/offline.ts`.
  - `scheduledAudioSource`, `docHasAudibleClips`, and `scheduleTracks` in `export/mp4.ts`.
- Pass the owning sequence's `tracks` or `anySolo` through every recursion. A compound container is
  gated by the parent sequence's solo set first; its nested tracks are gated by the child sequence's
  own solo set. Do not apply the parent's solo set to the child's tracks or the reverse.
- `docHasAudibleClips` must use the same sequence-aware gate, or the export can create an audio
  track that `scheduleTracks` then leaves silent.
- The preview engine, the offline plan, and the shipped MP4 mix must produce the same audibility for
  the same doc and time. Add a parity matrix covering root solo, nested solo, both, mute plus solo,
  and a compound container on a soloed parent track.
- Do not copy the boolean rule into the three paths. One helper, three callers.

## 3. Lock semantics

Lock protects a track's clips from edits. Playback, selection, inspection, and scrolling remain.

Blocked operations on a locked track:

- Move a clip on, off, or within the track.
- Move a linked partner whose track is locked, even if the dragged clip is on an unlocked track.
- Trim a clip head or tail.
- Rate-stretch a clip.
- Split a clip.
- Delete, ripple delete, cut, or clear.
- Duplicate a clip onto the locked track.
- Link or unlink clips when any member is on a locked track.
- Create a compound clip when any source clip is on a locked track, or when the destination video
  track is locked.
- Paste, insert, overwrite, drop media, or bin quick-add onto the locked track.
- Add, edit, enable, reset, or remove a transition or effect on a clip on the locked track.
- Change clip properties that alter the edit: gain, mute, opacity, blend, keyframes, effects and effect
  keyframes, text content, text style, speed, reverse, LUT, color params, transform statics, pan, EQ,
  compressor, denoise, and clip markers. These are clip edits even though they do not move the clip.
- Import captions or add, edit, or delete a caption cue on a locked text track.
- Add or move a clip marker on a locked clip.
- Remove an unlocked track that holds the link partner of a clip on a locked track. The pair would
  lose a member, so the whole operation is refused.
- Remove a media asset used by a locked clip. Removing an unused asset is allowed.
- Relink a media asset used by a locked clip. This changes the clip's source.
- Remove a locked track. Removing an unlocked track is allowed.
- Menu actions and keyboard shortcuts that perform any of the operations above.

Allowed operations on a locked track:

- Rename a track. It is metadata, not a clip edit.
- Toggle visibility, mute, solo, or lock. These are track controls. The user must be able to unlock.
- Add a track.
- Add a sequence definition. It has no clips until a compound container is created, which is
  blocked when a source or destination track is locked.
- Add a sequence marker. Sequence markers are not clip edits.
- Import a project LUT or manage a text preset. Assigning the LUT or style to a clip is blocked by
  the clip-property rule.
- Change a keyframe default. It is a project preference, not a clip curve.
- Select, copy, inspect, play, and seek. Copy is read-only.
- Undo and redo. Undo can revert an edit made before the lock.
- Open a compound clip. Editing the nested sequence is editing that sequence, not the container's
  track.
- Marquee selection. Subsequent edits are refused.
- Project open, history, and autosave.

Enforcement:

- The guard lives in the command layer. A UI-only guard is not enough.
- The store's `applyTransient` is a second mutation entry. It currently calls `applyCommand` directly
  and swallows errors, so it bypasses the command-layer guard. Route `applyTransient`, and the Plan
  06 `applyTransientBatch` when it lands, through the same
  `assertCommandAllowed(doc, command)` / `LOCK_RULES` check before writing. Do not add a second lock
  map.
- Add a per-command affected-track resolver or an equivalent central check in
  `applyCommand`/`applyCommands` and the transient paths. It must map every command that can change a
  clip, a track's clips, or a media asset used by a clip to the tracks it touches.
- Encode the inventory as
  `const LOCK_RULES: Record<EditorCommand['type'], LockDecision> = { ... }`. The compiler then fails
  when a new command is added without a decision. Do not rely on a Markdown table as the only lock.
- Default a command that names a clip or track to BLOCKED unless it is explicitly exempt. A new
  command cannot inherit "allowed" by omission.
- Commands that are lock-exempt must be listed explicitly: `setTrackLocked`, `setTrackSolo`,
  `toggleTrackMute`, `setTrackVisible`, `renameTrack`, `addTrack`, `addSequence`, the sequence-marker
  commands, `importProjectLut`, the text-preset library commands, `setKeyframeDefault`,
  `addMediaAsset`, project settings, selection (not a command), project open, history, and autosave.
- If a command touches any locked track, the whole command batch is refused. No partial writes and
  no history entry.
- A transient write on a locked track must leave the doc byte-identical, must not start or commit a
  transient, and must show the lock message once. The check runs before the first pointermove, add,
  remove, or keyboard nudge, not only on release.
- `applyCommands` guards each command against the in-flight clone, not the pre-batch doc, so a batch that locks a lane and then edits it refuses. A later refusal discards the clone, so the caller still sees no partial write and no history entry.
- A command that moves a linked group must check every member's track.
- A command that deletes media must check every clip using it.
- A command that adds a clip via paste/drop/insert/overwrite must check the destination track.
- A command that removes a track must check that track's lock.
- The error message names the track, for example `Track V1 is locked. Unlock it to edit its clips.`
- The UI should also disable or refuse gestures early, but the command layer is the authority. Tests
  must cover the keyboard/menu path with the UI bypassed.

Edit-path inventory:

Before coding, create the typed `LOCK_RULES` map with every `EditorCommand['type']`. Columns in the
supporting table: command, can touch a clip, can touch a track, can touch media, lock decision,
affected-track resolver, test. A command with no map entry must fail the TypeScript build. Include:

- Toolbar actions, menu actions, context-menu actions, keyboard shortcuts.
- Clip drag, trim, rate stretch, razor, marquee, drop, paste, insert, overwrite.
- Inspector property changes and keyframes.
- Plan 04 on-clip volume envelope gestures: dot drag, double-click add, Alt-click remove, and
  keyboard nudge or delete.
- Captions and text.
- Transitions, effects, LUTs, color, blend, speed, reverse, markers.
- Media bin remove and relink are included in the inventory. Project open is lock-exempt because it
  replaces the whole project, not an edit to a locked track. Undo, redo, and autosave restore are
  also lock-exempt. Document these decisions in the inventory table.
- Compound sequences, nested tracks, `createCompoundClip`, and link/unlink changes.
- Removing an unlocked track that holds a locked clip's link partner.
- Plan 06's `setClipInPoint` is added to the same typed map when it lands. The TypeScript map is the
  completeness lock, not a manual table update.

## 4. UI

Track header:

- Audio tracks: show `M` and `S` text buttons. M is the existing mute state. S is solo.
  `aria-pressed` reflects state.
- Video and text tracks: keep the eye and mute/speaker controls. Add a lock button on every track.
- Use `Lock` and `LockOpen` from lucide. The locked state must be visible without hovering.
- Keep the target control in the context menu. Do not add a header target button; Plan 02 removed it
  to make room for the working controls.
- Header width is 168px. It fits the kind icon, a short name, and three 24px controls with the name
  truncated: eye/mute/lock on video and text lanes, or M/S/lock on audio lanes. The reference's
  narrower header cannot hold M/S/lock/mute at accessible hit sizes; record 168 as a deliberate
  deviation in Plan 01 and the decision log. Do not shrink hit targets below 24px.
- Keep the clip count absent. It is debug density the reference does not show, and Plan 02 already
  removed it.
- Add `data-testid` for solo and lock.
- Context menu adds `Solo Track` (audio only) and `Lock Track` checkboxes. Keep rename, target,
  select clips, mute, and delete.
- The track header's locked state should not look disabled as a whole. Only the edit affordances
  change.

Toolbar/timeline feedback:

- A refused drag shows a toast and no transient. The clip does not move.
- A refused trim does not start.
- A refused keyboard edit shows the toast once, not per key repeat.
- A locked track's clips keep their selection ring and can be inspected.

## 5. Tests

Data and serialization:

- `solo` and `locked` round-trip.
- Absent fields read false.
- Hostile values, non-booleans, and old version 1 to 3 files read false.
- A hostile `solo: true` on a video or text track hydrates as absent; the command refuses to create
  it.
- Track factories and clones preserve both flags.
- `removeTrack` and undo restore them.

Solo:

- No solo: mute rules unchanged.
- One solo: only that track audible.
- Two solos: both audible.
- Solo plus mute on the same track: silent.
- Solo plus mute on another track: the soloed track still audible.
- Solo video with embedded audio: silent when any audio track is soloed.
- Linked pair: the twin is audible, the video half stays shadowed.
- Compound sequence: solo applies inside the sequence wherever it renders. Parent and child solo
  states are independent. Test both.
- Preview and export parity matrix.
- Crossfade and gain still apply to a soloed track.

Lock:

- Every `LOCK_RULES` entry has a refusal test when BLOCKED and an allowed test when EXEMPT.
- Pointer drag, trim, razor, drop, and marquee follow-up edits.
- Keyboard delete, split, duplicate, cut, paste, ripple delete.
- Menu and context-menu actions.
- Inspector property changes.
- Direct `applyTransient` calls for envelope drag, add, remove, and keyboard nudge on a locked track
  leave the doc unchanged and add no history entry. Plan 06 extends the same test to
  `applyTransientBatch` when it lands.
- Direct command-layer refusals for `setClipAnimStatic`, `setClipPan`, `setClipEq`,
  `setClipCompressor`, `setClipDenoise`, `setEffectParams`, `setEffectEnabled`, `resetEffect`,
  `setEffectKeyframes`, `linkClips`, `unlinkClip`, `createCompoundClip`, and `addCaptionCue`.
- `importCaptions` is exempt: it always unshifts a NEW text track and never names an existing one, so
  no locked lane can be touched. The test proves it still lands with every lane locked.
- Plan 06's `setClipInPoint` is added to the typed map and has the same refusal tests.
- Plan 04 volume envelope gestures: dot drag, add, remove, and keyboard edit refuse on a locked
  track.
- Add/remove transition, effect, keyframe, marker.
- Linked group with one locked member refuses the whole move/delete/split.
- Media removal/relink used by a locked clip refuses.
- Remove a locked track refuses; remove an unlocked track succeeds.
- Remove an unlocked track that holds a locked clip's link partner refuses.
- Rename, visibility, mute, solo, and lock toggles are allowed.
- Selection, copy, inspect, play, and seek are allowed.
- Undo of a pre-lock edit is allowed.
- Compound open is allowed; nested edit is allowed.
- A refused batch writes nothing and adds no history entry.
- The toast names the track.

UI:

- M/S appear only on audio tracks.
- Lock appears on all tracks.
- `aria-pressed` and labels update.
- Context menu checkboxes match state.
- Header fits at 168px without clipping.
- Locked state is visually clear.
- The context-menu target toggle remains.

Browser proof:

- Wait for `data-filmstrips-ready` on the timeline root before screenshots or clip checks.
- The audio mix itself is proven in the mocked `playback-core`, `offline`, and `mp4` tests. Do not
  assert audibility by listening in the browser; there is no audio meter.
- Solo A1: the S button is pressed, the other tracks' S buttons are not, the doc has the expected
  solo flags, and unsolo restores the flags.
- Solo two tracks: both S buttons are pressed and both flags persist.
- Solo plus mute: the muted solo track keeps both flags; the mocked mix test proves it stays silent.
- Lock V1: try drag, trim, delete, split, effect change, paste/drop; each shows the toast and leaves
  the doc unchanged.
- Remove an unlocked track that holds a locked clip's link partner: refused.
- Unlock: the same edits succeed.
- Lock an A/V pair member: the pair move/delete is refused.
- Lock a track and reload: the lock persists.
- Undo/redo the lock and solo toggles.
- Console clean.

Flakiness controls:

- Assert on the command result and doc, not on toast timing alone. If a toast is asserted, wait for
  its text.
- Do not test audio by listening. Use the recorded gain graph and the export plan's values.
- Use one shared audibility helper. A test that copies the boolean rule is not proof.
- The typed `LOCK_RULES` map is the coverage lock. A new command fails the TypeScript build until
  its decision and affected-track resolver are added.
- No fixed sleeps for toast or pointer events; use user-event or the existing pointer harness.
- Avoid testing browser-level lock state through CSS only; assert `aria-pressed` and the command
  result.

## Implementation notes

Recorded after the build, so the plan matches what shipped:

- **Header.** No clip count existed when this plan started; Plan 02 had already removed it. The
  stale JSDoc line is corrected, and the header carries three 24px controls, not four.
- **`importCaptions`.** The command creates a brand-new text track, so it cannot touch a locked lane.
  It is exempt rather than refused, and the test proves a locked doc still accepts the import on a
  new lane. The direct-refusal list no longer includes it.
- **Trim scope.** `trimClip` checks the named clip's own lane. Move, delete, split, unlink, and link
  expand through `clipGroupTracks`, matching the plan's group-refusal list (move/delete/split). The
  consequence is deliberate: trimming one half of an A/V pair while the partner's lane is locked can
  desync the pair, because the command never writes the locked clip.
- **Store return.** `store.apply` now returns a boolean: true when the command landed, false when a
  `TrackLockedError` was converted into `lockNotice`. Callers with success side effects check it, so
  a refusal cannot show a success toast or clear a selection. The plan did not specify this; it is
  the smallest way to meet the no-false-feedback requirement.
- **Batch guard.** A review found that validating the whole batch against the original doc let
  `[setTrackLocked, addClip]` land an edit on a newly locked lane. `applyCommands` now guards each
  command against the state the in-flight clone will hand it; a later refusal discards the clone, so
  the caller still sees no partial write or history entry. `track-controls.test.ts` covers the
  command layer and the store path.
- **Matte references.** `removeTrack` strips `trackMatte` entries pointing at the removed lane from
  every remaining clip in the sequence. A review found the lock resolver only checked the removed
  lane and link partners, so removing an open matte source could edit a locked clip. The resolver
  now includes every lane whose clips reference the removed lane; tests prove the refusal and the
  open-lane removal.

## 6. Release tasks for `0.14.0`

- Atomic version bump: `package.json`, `src/lib/releases.ts`, `CHANGELOG.md`, and a new `0.14.0`
  row in the `ROADMAP.md` Shipped table. The user confirms the version before the bump.
- Update `README.md`, `docs/architecture.md` (solo/export paths), `docs/flows.md`,
  `docs/testing.md`, `docs/structure.md`, and `docs/design-system.md` as affected.
- Recapture the hero screenshot with the track controls visible. Update the alt text in
  `src/components/site/Hero.tsx` and the mirror in
  `src/lib/editor/__tests__/public-pages.render.test.tsx`, plus the photo credit if the image
  changes. Real capture only.
- Update test counts through `docs-drift.test.ts`.
- Add battery steps for solo, lock, and lock persistence if the jsdom suite cannot prove them.
  Update both `e2e/battery.sh` and `e2e/battery.timing.sh`, and the documented counts.

## Acceptance criteria

- Solo is real, audible in preview and export, and matches the matrix above.
- Lock refuses every listed edit at the command layer, with no partial writes and no history entry.
- Unlock restores normal editing.
- M/S and lock are visible and accessible, and every icon works.
- Lock and solo serialize, autosave, undo, and redo.
- Linked groups and compound sequences follow the documented rules.
- The header fits without clipping.
- `bun run check` is green.
- The `0.14.0` version bump and docs are complete.

## Risks

- **Missing an edit path.** Mitigation: command inventory, central guard, and a test row per path.
- **Solo divergence.** Mitigation: one pure helper used by the preview, the offline plan, and the
  MP4 mix, plus a parity matrix.
- **Linked group partial edits.** Mitigation: check every member's track before applying a batch.
- **Header crowding.** Mitigation: 168px and 24px hit targets; no clip count or header target button.
- **Nested sequence confusion.** Mitigation: solo is per sequence and applies inside a rendered
  compound; lock is per sequence. Test both.
- **Scope creep into track groups or VCAs.** Mitigation: explicitly out of scope.

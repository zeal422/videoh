# 0.26.0 libraries

**Created:** 2026-11-12
**Complexity:** High
**Effort:** L
**Schema:** 7 to 8
**Depends on:** 0.25.0
**Status:** implemented

## 1. Goal

Add three reusable project libraries:

- Track groups with shared mute, visibility, solo, and lock controls.
- A brand kit of saved colors and font references.
- Local templates that create a new sequence or project without media.

This is one schema release for track groups and brand kit. Templates are external data validated by
their own parser, so they do not add a `Doc` field. The release is one commit and one version bump.

## 2. Anti-goals

- No nested track groups, group hierarchy, or group-level transform.
- No separate group mute, solo, or lock state. Group controls write member flags, so member state stays
  the single source of truth.
- No logo upload in the brand kit. Logos are ordinary image assets.
- No brand kit sharing, cloud sync, or team library.
- No hosted template gallery, remote template download, or template marketplace.
- No templates with media files. Templates use empty placeholders.
- No template marketplace metadata, ratings, or thumbnails beyond a local preview.

## 3. Current state, verified

- `Track` has `muted`, `visible`, `solo`, and `locked`, but no group field
  (`src/lib/editor/types.ts:368`).
- `Project` already holds `luts`, `sequences`, `textPresets`, and `keyframeDefaults`, so project-level
  libraries are an established pattern (`src/lib/editor/types.ts:416`).
- Track lock and solo semantics are enforced in the command layer and shared by preview and export,
  not only by the UI.
- There is no brand kit or template type in `src`.
- `SERIALIZATION_VERSION` is 7 before this release.

## 4. Technical approach

### Track groups and schema

Add:

- `Project.trackGroups?: TrackGroup[]` with `{ id, name }` and optionally a color token.
- `Track.groupId?: string`.

Keep one group per track in the first version. A track with no `groupId` is ungrouped.

Group controls are batch controls over member tracks:

- Mute group: set every member's `muted` to the target value.
- Solo group: set every member's `solo` to the target value.
- Hide group: set every member's `visible` to the target value.
- Lock group: set every member's `locked` to the target value.

Because the writes land on the member tracks, there is no precedence table to maintain. A member may be
changed after a group action, and the group control shows a mixed state. The group is a shortcut and a
selection aid, not an override layer.

Mixed-state toggle rule: if every member is already on, the next toggle turns all off; otherwise it
turns all on. Document this in the UI tooltip and test it.

Commands:

- Create a group from the selected tracks.
- Rename a group.
- Add or remove a track from a group.
- Remove a group, leaving its tracks intact.
- Set a group flag through the batch member write.

Validation:

- Unique group ids and names after trimming.
- A track references at most one existing group.
- A group's members must all belong to one sequence. The command refuses a mixed-sequence group, and
  hydration drops a group whose members span sequences or clears the foreign members.
- Any command that creates a new sequence from existing tracks, including compound creation, leaves the
  new tracks ungrouped. No new sequence inherits a `groupId` from a track in another sequence.
- Removing a group clears the member `groupId` values.
- Locked tracks still participate in group selection and display, but group edits that would move or
  trim clips still respect the lock.
- Sequence scoping follows the existing command rules.

UI:

- Group chip or label in the track header.
- Group controls in the header of the first member, or a small group row. Keep it compact.
- Select group selects its member tracks.
- A track can be added to an existing group from the track context menu.

Do not add collapse and expand of grouped tracks in this release. It changes track layout and hit
testing more than it looks.

### Brand kit and schema

Add `Project.brandKit?: BrandKit` with:

- `colors: BrandColor[]`, where each entry has an id, a name, and a hex value.
- `fontFamilies?: string[]`, references to built-in or project font families.

Rules:

- Validate hex colors at the command and hydration boundaries. Only hex values. No `rgb()`, `url()`,
  or CSS variables.
- Trim and cap names. Reject duplicate ids and duplicate color values.
- Cap the palette at a documented size.
- Font references must be strings; a missing project font is allowed and shown as unavailable. Do not
  fail project load.
- The brand kit is editable from a small panel and usable from the text and shape color controls.
- Add a color from the current control, apply a saved color, rename, and remove.
- No logo field. A logo is an image clip.

Schema v8 carries `trackGroups` and `brandKit`. Hydrate v7 with neither. Reject duplicate group ids,
dangling `groupId` values, invalid colors, duplicate color ids, and oversized palettes.

### Templates

Templates are external data, not part of `Doc`. Use a small template file format with its own version
field. Do not reuse `SERIALIZATION_VERSION` for templates.

First release:

- A small built-in template set that creates a new sequence with tracks, title text, and optional
  shapes from 0.25.0.
- A user-saved template stored in IndexedDB: name, description, template version, and a deterministic
  sequence description. Do not include media.
- Templates never store `Track.groupId`. Saving strips group membership, and applying leaves the new
  tracks ungrouped, so a template cannot reference a group in another sequence. Group creation inside a
  template is a later feature.
- Applying a template builds a command batch and installs a new sequence in one undo entry. The apply
  planner mints fresh sequence, track, and clip ids, and one fresh link id per link group, on every
  application. It remaps every internal reference to the new ids and never reuses the template's stored
  ids. `addSequence` rejects a duplicate sequence id, but `addTrack` and `addClip` do not validate their
  ids, so the planner mints fresh ids itself before building the batch. Clear group membership on every
  new track.
- Validate the template file before applying: version, track and clip limits, text lengths, colors,
  shape bounds, ids, and internal references. Reject duplicate sequence, track, and clip ids within
  each namespace before any remapping, so a reference cannot resolve ambiguously. Repeated `linkId`
  values are valid because they define a link group; remap each group to one fresh link id. Reject
  path-like names and unknown fields.
- If a template references a font or shape kind that this build does not support, refuse with a clear
  message rather than partially applying it.

UI:

- A template gallery dialog with a few built-in cards and a saved templates section.
- Apply, save current sequence as template, rename, and delete.
- No preview thumbnails beyond a simple text description in the first version.

Do not add remote templates or a template editor.

## 5. Schema v8

- Increment `SERIALIZATION_VERSION` to 8.
- Update the header comment with the release and both surfaces.
- Hydrate v7 with no groups and no brand kit.
- Validate group ids, names, membership, sequence membership, and dangling references.
- Validate brand colors, color ids, names, palette size, and font references.
- Round-trip a v8 doc with a two-track group and a brand kit.
- Add a v7 fixture that loads with neither.
- Hostile payloads: duplicate group ids, `groupId` pointing at a missing group, `name` with control
  characters, duplicate color ids, `color: "javascript:..."`, an oversized palette, and a brand font
  reference with a malformed string.

Templates are validated by their own parser and do not bump `SERIALIZATION_VERSION`.

## 6. File plan

New files:

- `src/lib/editor/track-groups.ts` for membership and batch flag planning.
- `src/lib/editor/brand-kit.ts` for color validation and palette operations.
- `src/lib/editor/templates.ts` for the template schema, validation, and apply planning.
- UI components for the group header, brand kit panel, and template gallery.

Expected modified files:

- `src/lib/editor/types.ts`: `TrackGroup`, `Track.groupId`, `BrandKit`, `Project.brandKit`.
- `src/lib/editor/constants.ts`: group, palette, and template limits.
- `src/lib/editor/serialization.ts`: v8, hydration, validation.
- `src/lib/editor/commands.ts`: group, brand kit, and template apply commands.
- `src/lib/editor/menus.ts` and `src/components/editor/MenuBar.tsx`: group and template entries.
- `src/components/editor/timeline/` for group chips and controls.
- `src/components/editor/InspectorPanel.tsx` and shape controls for brand colors.
- `src/lib/editor/__tests__/` for groups, brand kit, templates, serialization, and UI locks.
- `docs/architecture.md`, `docs/flows.md`, `docs/design-system.md`, `README.md`, `docs/testing.md`,
  `docs/structure.md`.

## 7. Phases and verification

### Phase 1: group model and migration

- Add the group types and v8 hydration.
- Write the v7 to v8 and hostile group tests first.
- Verify dangling groups are dropped or cleared as documented.
- Verify duplicate group ids are rejected.

### Phase 2: group commands and controls

- Add create, rename, add, remove, and batch flag commands.
- Verify one undo entry per group action.
- Verify mixed-state toggle behavior.
- Verify group selection selects members.
- Verify removing a group leaves tracks and clips intact.
- Verify locked tracks still obey the lock rules.
- Verify compound creation leaves its new sequence tracks ungrouped.

### Phase 3: brand kit

- Add the project brand kit, validation, panel, and color application.
- Verify valid colors are stored once and duplicates are rejected.
- Verify invalid colors and oversized palettes are refused.
- Verify applying a brand color writes the existing text or shape color field.
- Verify a missing brand font is shown as unavailable, not a load failure.

### Phase 4: templates

- Add the template schema, built-in set, IndexedDB store, gallery, and apply command.
- Verify a template applies as one undo entry.
- Verify applying the same template twice mints fresh sequence, track, and clip ids, and one fresh link
  id per link group, and remaps every internal reference, so the two applications are independent.
- Verify a template with duplicate sequence, track, or clip ids is refused before any remapping, and
  repeated link ids are accepted and remapped as one group.
- Verify malformed, oversized, unknown-version, and missing-font templates are refused.
- Verify a template never writes media assets and never carries `Track.groupId`.

### Phase 5: docs, batteries, release cut

- Update the data model, group flow, brand kit, template flow, and UI rules.
- Run `bun run check`.
- Run `bun run battery:pair`.
- Apply the atomic 0.26.0 bump with schema notes from the master plan.

## 8. Tests and locks

- Groups: create, rename, add, remove, delete group, batch mute, batch solo, batch visibility, batch
  lock, mixed state, selection, undo, locked track, dangling group id, duplicate id, mixed-sequence
  refusal, sequence scope, compound creation leaves new tracks ungrouped.
- Brand kit: valid hex, invalid hex, duplicate ids, duplicate values, name trim and cap, palette cap,
  apply color, missing font reference, undo.
- Templates: built-in apply, saved apply, fresh ids per application, internal reference remap, version
  refusal, unknown shape or font, oversized track or clip count, hostile names, duplicate sequence,
  track, or clip ids rejected before remapping, repeated link ids remapped as one group, no media,
  `groupId` stripped on save and unset on apply, one undo entry.
- Static locks: group controls call the batch command path, not ad hoc track mutation.
- Serialization: v7 defaults, v8 round trip, hostile groups, hostile brand kit, newer version refused.

## 9. Atomic release cut

Follow section 7 of `MASTER_PLAN.md`. The 0.26.0 commit must update:

- `package.json` to `0.26.0`.
- `src/lib/releases.ts` with four or more highlights and the actual ISO date.
- `CHANGELOG.md` with `## [0.26.0] - YYYY-MM-DD` and a schema note.
- `ROADMAP.md` with the shipped row and intro sentence. No Premiere gap status change.
- `README.md` features, limitations, and `.veproj.json` version 8.
- `docs/architecture.md` serialization row and group, brand kit, and template module notes.
- `docs/flows.md` group, brand kit, and template contracts.
- `docs/design-system.md` group header, brand palette, and template gallery rules.
- `docs/testing.md` for the new tests and coverage scope.
- `docs/structure.md` for new files and test counts.

## 10. Rollback

Revert the single release commit. A v8 project cannot be opened by the reverted build. Export or keep a
copy before rollback. User-saved templates live in IndexedDB and are external to the project; they
survive a rollback but an older build cannot apply a newer template version, so validate the version and
refuse cleanly.

## 11. Risks and decisions

- **Group semantics.** Writing member flags avoids a second source of truth and a precedence table. If
  the product wants group-level state instead, stop and write the precedence table before coding.
- **Collapse and expand.** Out of scope. It is a layout feature, not a group flag.
- **Brand colors.** Hex only. Do not accept arbitrary CSS, which would be an injection surface.
- **Templates.** Keep them deterministic and local. Do not let a template file become an arbitrary
  project import path with media.
- **Release size.** Groups, brand kit, and templates are three surfaces. If review is too large, split
  templates into a patch release, but keep the schema bump with groups and brand kit only.

## 12. Definition of done

- Track groups select, rename, and batch-control member tracks with one undo entry.
- Group removal preserves tracks and clips.
- Brand kit colors persist, validate, and apply to text and shapes.
- Local templates create a new sequence without media and validate hostile input.
- v7 projects load with neutral defaults and v8 projects round-trip.
- `bun run check` and `bun run battery:pair` are green.
- The 0.26.0 schema and version bumps are atomic in one commit.

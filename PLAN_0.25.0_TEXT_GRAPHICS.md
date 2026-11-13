# 0.25.0 text and graphics

**Created:** 2026-11-12
**Complexity:** High
**Effort:** XL
**Schema:** 6 to 7
**Depends on:** 0.24.0
**Status:** planned

## 1. Goal

Add the text and graphic primitives competitors have:

- A font family picker for text clips.
- Custom font upload, stored with the project and loaded before preview and export.
- Built-in animated text presets built from existing keyframes.
- Shape layers: rectangle, ellipse, triangle, star, polygon, and heart.
- A local sticker picker that inserts bundled images through the existing image path.

This is one schema release: project font metadata and optional shape fields share the 6 to 7 bump. The
release is one commit and one version bump. It is the heaviest release in the sequence, so the phases
below are ordered to allow an honest split if the review or the gate cannot hold.

## 2. Anti-goals

- No AI caption generation, transcript editing, or word-level karaoke.
- No font marketplace, hosted font service, or remote font download.
- No full vector path editor. Shapes are parameterized primitives only.
- No shape morphing, masks, or boolean operations.
- No custom animated preset saving. Built-in presets apply keyframes; saving them is a later release.
- No sticker marketplace or remote sticker API. The set is bundled and local.
- No second schema bump for stickers. Stickers reuse image assets.

## 3. Current state, verified

- `TextStyle` already has `fontFamily`, and both text renderers use it
  (`src/lib/editor/types.ts:45`, `src/lib/editor/playback/text-box.ts:48`).
- The text Inspector exposes size, color, align, bold, italic, shadow, X, and Y, but no font family
  control (`src/components/editor/InspectorPanel.tsx:875`).
- `TextPreset` stores only `id`, `name`, and `style`. It has no keyframes
  (`src/lib/editor/types.ts:57`).
- Text is a clip with `text`, `style`, and `isCaption`; compound clips use `sequenceId`. There is no
  shape field (`src/lib/editor/types.ts:315`).
- Image imports support PNG, JPEG, GIF, WebP, AVIF, SVG, and BMP and are drawn through the image path
  (`src/lib/editor/media/probe.ts`).
- 0.23.0 provides the OPFS media store and the rehydration boundary that custom font bytes can reuse.

## 4. Technical approach

### Project fonts and schema

Add a project-level font library:

- `Project.fonts?: ProjectFont[]`.
- `ProjectFont` holds an id, a display name, a CSS family string, an optional weight, an optional
  style, and a content hash for its bytes. The font store keys bytes by the project id and that hash,
  the same content-addressed rule as media, so replacing a font in one copy cannot change another
  copy. The hash is part of the v7 font metadata.
- Font bytes live in OPFS under the project's font namespace. Do not put binary data in the project
  JSON.
- The CSS family string is generated from the font id, never from the display name, and is immutable
  for the life of the font entry. Renaming a font changes only the display name, so text clips and the
  brand kit keep resolving. Reject duplicate family strings at hydration.

Text clips keep storing `TextStyle.fontFamily`, which is already serialized. Existing projects load
with no font library and use the built-in family list.

Hydration rules:

- Reject malformed font entries and duplicate ids or duplicate family strings.
- Treat the generated CSS family as immutable. Hydration never regenerates it from the display name.
- Clamp or reject missing storage references.
- A missing font file is a warning, not a load failure. The text falls back to the built-in family and
  the project stays editable.
- A font entry that is not referenced by any text clip or brand kit is still valid, because the user
  may be about to use it.

### Font upload and loading

- Accept WOFF2, WOFF, TTF, and OTF. Set a size cap and document it.
- Validate the file before writing it. A corrupt font must not break project load.
- Create a `FontFace`, add it to `document.fonts`, and verify it loads before the font appears in the
  picker.
- Stage every new face under the import id or font id without adding it to the active registry. Validate
  and load it, then add it to the active registry only after the font entry is committed. On
  validation, load, upload, or project-install failure, delete every staged face, including any face
  added to `document.fonts` for the load check.
- On project switch, remove every `FontFace` this app registered for the previous project before
  registering the new project's faces. `document.fonts` is document-wide, and a stale face can answer
  the same generated family string. Keep the active faces in one registry keyed by project id, delete
  them on switch and on font removal, and verify the new project's content hash resolves. Do not assume
  a family string is unique across projects.
- Store the bytes through the 0.23.0 store under the project's font namespace, keyed by the font's
  content hash. If the store API is media-specific, add a namespace parameter rather than a second
  store.
- On project load, preload every project font and await `document.fonts.ready` before the first
  composite and before export.
- On export, wait for the fonts used by the timeline. A missing font must produce a warning, not a
  silent fallback mid-render.
- On remove, do not delete the bytes immediately. Removal is undoable, so reuse the 0.23.0 clean
  rule: the action reclaims a font file only when the font is no longer in `Project.fonts`, no text
  clip or brand kit references it, and the history no longer reaches the entry. Extend the 0.23.0
  claim shards, install reservations, live hash set, and BroadcastChannel message to include font
  hashes, so a saved copy's fonts are protected the same way as media.
- Undoing a font removal restores the entry and starts registering its `FontFace` before any text
  clip, brand kit, preview, or export can use it. The undo path restores `Project.fonts` and stages
  the face from the stored bytes; the registry exposes a load promise that preview and export await
  before using the family. A missing or corrupt file restores the metadata with a warning and leaves
  the missing-font fallback in place; never mark the face active before it loads.

### Font picker

Add a font family select to the text Inspector. List built-in families first, then project fonts. Show
the display name, not the generated CSS family. Selecting a font writes `TextStyle.fontFamily` through
the existing `setTextStyle` command.

Add an upload control nearby. Keep the upload dialog small: file, display name, optional weight, and
style. Do not add a font manager page.

### Animated text presets

Ship built-in presets that apply existing keyframes:

- Fade in.
- Slide up.
- Pop.
- Slow reveal through opacity.

Each preset is a command batch over the selected text clip. It writes opacity, position, or scale
keyframes with documented easing. It does not add a new persisted preset format.

A preset must not overwrite existing keyframes silently. First version: refuse when any target property
already has a curve, and name the property in the message. Merging is a later change. Do not add a
custom preset library in this release.

### Shape layers

Add `Clip.shape?: ShapeStyle` and a `ShapeKind` union for rectangle, ellipse, triangle, star, polygon,
and heart.

Fields:

- Kind.
- Fill color.
- Optional stroke color and stroke width.
- Optional corner radius for rectangles.
- Optional point count for stars and polygons.

Rules:

- Validate colors as hex values at the command and hydration boundaries.
- Clamp stroke width and corner radius.
- Clamp point count to a documented range.
- Shape clips have no media id, text, text style, or caption flag; enforce the mutual exclusion at the
  command and hydration boundaries, like compound clips.
- Shape source semantics follow text: `inPoint` is ignored, `speed` and `reverse` are rejected, and
  `duration` is the timeline length.
- Shapes use the same position, scale, rotation, flip, opacity, blend, and keyframe surface as other
  visual clips.
- Render shapes through one shared path used by preview and export.
- Include shapes in hit testing, selection bounds, and the monitor gizmo, with the shape path bounds
  as the transform and gizmo origin from 0.24.0.
- Add an Inspector section for fill, stroke, radius, and points.

Do not implement arbitrary SVG paths or a pen tool.

### Stickers

Ship a small bundled sticker set as local images under `public/`. Inserting a sticker:

1. Fetches the local asset.
2. Wraps it as a `File`.
3. Imports it through the existing image import path, so it gets a thumbnail and OPFS persistence.
4. Adds an image clip at the playhead or the selected track.

No new schema. Do not add a remote sticker API. Keep the set small and licensed for the repo.

## 5. Schema v7

One bump carries both font metadata and shape fields:

- Increment `SERIALIZATION_VERSION` to 7.
- Update the header comment with the release and both surfaces.
- Hydrate v6 projects with no fonts and no shapes.
- Validate font ids, names, families, weights, styles, content hashes, and storage references.
- Validate shape kind, colors, numeric bounds, and point counts.
- Reject or sanitize hostile payloads: duplicate font ids, CSS injection in family names, a malformed
  font content hash, `shape: { kind: "rect", fill: "url(...)" }`, negative stroke widths, huge point
  counts, and missing font references.
- Round-trip a v7 doc with a text clip using a project font and a shape clip.
- Add a v6 fixture that loads with no font library and no shapes.

If the release splits, 0.25.0 keeps the font metadata bump with schema v7. Shapes and stickers move to
a new release after it with schema v8, and 0.26.0 and every later release shift by one. Do not ship
shapes without a migration.

## 6. File plan

New files:

- `src/lib/editor/fonts.ts` or `src/lib/editor/media/font-store.ts` for font storage and loading.
- `src/lib/editor/shapes.ts` for the pure shape geometry and validation.
- `src/lib/editor/text-presets.ts` for the built-in animated presets.
- UI components for the font picker, shape controls, and sticker picker.

Expected modified files:

- `src/lib/editor/types.ts`: `ProjectFont`, `Project.fonts`, `ShapeStyle`, `Clip.shape`.
- `src/lib/editor/constants.ts`: font size cap, shape bounds, preset timings.
- `src/lib/editor/serialization.ts`: v7, hydration, hostile validation.
- `src/lib/editor/commands.ts`: font library commands, shape commands, preset application.
- `src/lib/editor/playback/compositor.ts` and `src/lib/editor/export/offline.ts`: shape and font render
  parity.
- `src/lib/editor/playback/text-box.ts`: font loading assumptions and fallback.
- `src/components/editor/InspectorPanel.tsx`, `MenuBar.tsx`, and a shape/sticker picker component.
- `src/lib/editor/__tests__/` for fonts, shapes, presets, serialization, and UI locks.
- `docs/architecture.md`, `docs/flows.md`, `docs/design-system.md`, `README.md`, `docs/testing.md`,
  `docs/structure.md`.

## 7. Phases and verification

### Phase 1: font metadata and schema

- Add `Project.fonts` and the v7 migration.
- Write the v6 to v7 and hostile font tests first.
- Verify old projects load with no font library.
- Verify duplicate ids, bad family strings, and missing storage are handled as documented.
- Verify renaming a font keeps the generated CSS family and leaves text and brand kit references
  resolving.

### Phase 2: font storage and loading

- Persist font bytes through the 0.23.0 store under the project id and content hash.
- Load project fonts before preview and export.
- Verify a corrupt font is rejected without breaking project load.
- Verify a missing font falls back and warns.
- Verify export waits for fonts and uses the uploaded family.
- Verify a project switch removes the previous project's faces and a reused family string resolves the
  new project's content hash.
- Verify a failed upload, validation, or project install removes its staged face and leaves the active
  registry unchanged.

### Phase 3: font picker and upload UI

- Add the picker and upload dialog.
- Verify built-in and project fonts list correctly.
- Verify selecting a font writes the existing text style field.
- Verify renaming a font changes only the display name.
- Verify removing a font that is still referenced is refused with a clear message; an unreferenced font
  is removed from the library and its bytes are left for the clean action.

### Phase 4: animated presets

- Add the built-in preset batch.
- Verify each preset writes the documented keyframes and easing.
- Verify a slide preset's position keyframes move text identically in preview and export, since both
  paths resolve the clip transform through `clipTransform`.
- Verify a preset refuses when a target property already has a curve, and names the property.
- Verify undo restores the previous text clip exactly.

### Phase 5: shapes

- Add the shape fields, validation, command, renderer, and Inspector controls.
- Write the shape parity test first.
- Verify rectangle, ellipse, triangle, star, polygon, and heart render in preview and export.
- Verify hit testing, selection bounds, rotation around the shape path bounds, flip, and the gizmo.
- Verify hostile colors, negative sizes, huge point counts, and missing fields.
- Verify a shape with a media id, text, text style, or caption flag is rejected at the command and
  hydration boundaries, and that `speed` and `reverse` are refused.

### Phase 6: stickers

- Add the local sticker set and picker.
- Verify insertion imports through the image path, persists to OPFS, and survives reload.
- Verify no remote request is made.

### Phase 7: docs, batteries, release cut

- Update the data model, text flow, design system, and test inventory.
- Run `bun run check`.
- Run `bun run battery:pair`.
- Apply the atomic 0.25.0 bump with schema notes from the master plan.

## 8. Tests and locks

- Fonts: metadata hydration, duplicate ids, CSS injection, corrupt bytes, unsupported type, size cap,
  immutable generated family, rename, load before render, missing fallback, project switch removes the
  previous faces and a reused family string resolves the new hash, staged faces are removed on upload,
  validation, or install failure, removal with references, removal then undo restores and registers
  the face before preview and export use, a library entry with no clip or brand-kit
  reference keeps its bytes, a font replacement in one copy leaves another copy's hash unchanged,
  export waits for fonts.
- Presets: each preset's keyframes and easing, refuse-on-existing-curve, undo, text-only refusal,
  preview and export text position parity.
- Shapes: each kind's geometry, fill and stroke, radius, point count, bounds, hit testing, rotation and
  flip around path bounds, preview and export parity, source-field exclusivity, hostile values.
- Stickers: local fetch, import, OPFS persistence, reload, no remote request.
- Static locks: the preview and export share the shape renderer; the font picker uses the project font
  list, not an ad hoc list; text position keyframes resolve through the shared `clipTransform` in both
  paths.

## 9. Atomic release cut

Follow section 7 of `MASTER_PLAN.md`. The 0.25.0 commit must update:

- `package.json` to `0.25.0`.
- `src/lib/releases.ts` with four or more highlights and the actual ISO date.
- `CHANGELOG.md` with `## [0.25.0] - YYYY-MM-DD` and a schema note.
- `ROADMAP.md` with the shipped row and intro sentence. No Premiere gap status change.
- `README.md` features, limitations, and `.veproj.json` version 7.
- `docs/architecture.md` serialization row, font module, shape module, and render notes.
- `docs/flows.md` text, font upload, shape, and sticker contracts.
- `docs/design-system.md` font, shape, and sticker UI rules.
- `docs/testing.md` for the new tests and coverage scope.
- `docs/structure.md` for new files and test counts.

## 10. Rollback

Revert the single release commit. A v7 project cannot be opened by the reverted build. Export or keep a
copy before rollback. Font bytes remain in OPFS and become unused; the stored-media clear action from
0.23.0 can reclaim them.

If shapes are the failing part, do not ship a partial v7. Either split the release as described or
revert the whole commit.

## 11. Risks and decisions

- **Font loading race.** The most likely defect is a first frame or export frame rendered before the
  font is ready. Preload and await.
- **Font identity.** The generated CSS family is the reference in `TextStyle` and the brand kit. Derive
  it from the font id and never regenerate it from the display name, or a rename silently breaks every
  text clip that uses the font.
- **Font removal.** Removal is undoable like media removal. Never delete bytes on the remove command;
  leave them to the 0.23.0 clean action.
- **CSS injection.** The family string crosses into canvas and CSS. Sanitize and test hostile names.
- **Duplicate families.** Generate unique CSS families, or two uploaded fonts will silently replace
  each other.
- **Shape hit testing.** Shapes need a real path, not a rectangle approximation. Test rotated and
  flipped shapes.
- **Release size.** This is the most likely release to split. If it does, fonts and text ship as
  0.25.0 with schema v7; shapes and stickers move to a new release with schema v8, and 0.26.0 and every
  later release shift by one. Update the master plan before coding the split.

## 12. Definition of done

- Font picker and upload work, persist, survive reload, and render in export.
- Animated presets apply and undo as one action.
- All six shape kinds render identically in preview and export.
- Stickers insert through the image path and survive reload.
- v6 projects load with neutral defaults and v7 projects round-trip.
- `bun run check` and `bun run battery:pair` are green.
- The 0.25.0 schema and version bumps are atomic in one commit.

# Master plan: 0.21.0 to 0.28.0

**Created:** 2026-11-12
**Baseline:** version 0.20.2, serialization version 4
**Mode:** planning only. No implementation is part of this change.
**Source:** `TO_DO.md`, competitor research, `AGENTS.md`, and
`.agents/skills/implementation-discipline/SKILL.md`.

## 1. Goal

Ship the non-AI competitor features in `TO_DO.md` as eight minor releases. The sequence is organized
by persisted surface and media lifecycle, not by feature category. Each release is one commit, one
release note, and one atomic version bump.

The ordering principle is simple: ship cheap visible wins first, add durable media before features that
produce media, then add schema surfaces in planned groups with one bump per release, then finish with
capture and project packaging.

## 2. Anti-goals

These are out of scope for this sequence and must not be smuggled into a release:

- Auto captions, transcript editing, silence removal, audio cleanup, text to speech, dubbing,
  background removal, eye contact correction, and auto reframe.
- ProRes export. `ROADMAP.md` already declines it because no shipping browser exposes a ProRes encoder.
- WebM and GIF export. WebM needs a separate codec path (VP8, VP9, or AV1 plus Opus) and GIF needs an
  encoder dependency. Both are follow-up decisions, not part of 0.21.0.
- Stock libraries, hosted templates, cloud projects, accounts, and real-time collaboration.
- Custom output frame rate. It changes frame count and audio length, so it needs its own release.
- ProRes proxy workflows, multicam, productions, and any other documented non-goal.

## 3. Operating rules

1. One release is one commit. The history confirms this is the repo pattern: `v0.19.3` and `v0.20.0`
   are each a single commit, including large multi-area releases.
2. One schema bump maximum per release. The 0.25.0 bump carries both text and shape surfaces by
   design; never add a second, unrelated field to that bump.
3. Media persistence lands before any feature that produces media: freeze frame, voiceover, screen
   recording, camera recording, custom fonts, and project bundles.
4. The version bump happens once, in the release commit, across every surface listed in section 7.
   There is no earlier bump and no follow-up bump commit.
5. No runtime dependency is added without an explicit gate. The only candidate is ZIP support in
   0.28.0, and the plan records the decision before implementation.
6. Tests come first. A new lock must fail on the unfixed code, then pass. Never weaken an assertion to
   make the gate green.
7. The full gate is `bun run check`. The release verdict adds `bun run battery:pair`, which covers both
   the dev and standalone artifact legs. Iteration uses focused tests, not a full battery.
8. The agent does not commit, tag, push, or deploy. The user owns the release commit and tag.
9. No em dashes, no curly quotes, sentence-case headings, and plain words in every file.
10. Surgical changes only. No drive-by refactors, no speculative abstractions, and no new files beyond
    what a release needs.

## 4. Release sequence

| Version | Theme                                                                           | Schema     | Previous | Plan                                                         |
| ------- | ------------------------------------------------------------------------------- | ---------- | -------- | ------------------------------------------------------------ |
| 0.21.0  | Export and framing: audio-only, MOV/MKV, bitrate and resolution, aspect presets | 4, no bump | 0.20.2   | [PLAN_0.21.0_EXPORT.md](PLAN_0.21.0_EXPORT.md)               |
| 0.22.0  | Timeline commands: close gaps, join adjacent same-source clips                  | 4, no bump | 0.21.0   | [PLAN_0.22.0_TIMELINE.md](PLAN_0.22.0_TIMELINE.md)           |
| 0.23.0  | Durable media: content-hashed OPFS store, rehydration, freeze frame             | 4 to 5     | 0.22.0   | [PLAN_0.23.0_MEDIA.md](PLAN_0.23.0_MEDIA.md)                 |
| 0.24.0  | Transform: rotation, flip, monitor gizmo, rotation keyframes                    | 5 to 6     | 0.23.0   | [PLAN_0.24.0_TRANSFORM.md](PLAN_0.24.0_TRANSFORM.md)         |
| 0.25.0  | Text and graphics: font picker, upload, animated text, shapes, stickers         | 6 to 7     | 0.24.0   | [PLAN_0.25.0_TEXT_GRAPHICS.md](PLAN_0.25.0_TEXT_GRAPHICS.md) |
| 0.26.0  | Libraries: track groups, brand kit, local templates                             | 7 to 8     | 0.25.0   | [PLAN_0.26.0_LIBRARIES.md](PLAN_0.26.0_LIBRARIES.md)         |
| 0.27.0  | Capture: voiceover, screen and camera recording                                 | 8, no bump | 0.26.0   | [PLAN_0.27.0_CAPTURE.md](PLAN_0.27.0_CAPTURE.md)             |
| 0.28.0  | Project bundle: ZIP with project, media, and fonts                              | 8, no bump | 0.27.0   | [PLAN_0.28.0_BUNDLE.md](PLAN_0.28.0_BUNDLE.md)               |

0.21.0 is implemented. Releases 0.22.0 through 0.28.0 remain planned and are not implemented by this plan.

The table's "Previous" column is release order, not a hard dependency. Section 5 lists the hard
dependencies: 0.27.0 and 0.28.0 are sequenced after 0.26.0, but they only require 0.23.0 and, for
0.28.0 fonts, 0.25.0.

## 5. Dependency graph

```text
0.21.0 export and framing
  |
  v
0.22.0 timeline commands
  |
  v
0.23.0 durable media + freeze
  |         \
  |          +--> 0.27.0 capture
  |          |
  |          +--> 0.28.0 project bundle
  v
0.24.0 transform
  |
  v
0.25.0 text and graphics
  |
  v
0.26.0 libraries
```

Hard dependencies:

- 0.23.0 must precede 0.27.0 and 0.28.0. Recordings and bundles both need durable media.
- 0.23.0 must precede freeze frame, which is part of 0.23.0 itself.
- 0.25.0 must precede 0.26.0 brand kit font references and 0.28.0 font bundling.
- 0.21.0 and 0.22.0 are otherwise independent. They are ordered first because they are cheap and do
  not touch the schema. The 0.22.0 row is release order only.
- 0.27.0 and 0.28.0 are ordered after 0.26.0 for release cadence. Recordings need 0.23.0, and bundles
  need 0.23.0 plus the 0.25.0 font library; neither needs track groups or the brand kit.

## 6. Schema roadmap

| Serialization version | Added in | Persisted surface                           | Compatibility                             |
| --------------------- | -------- | ------------------------------------------- | ----------------------------------------- |
| 4                     | 0.8.1    | Compound clip sequences                     | Baseline before 0.23.0                    |
| 5                     | 0.23.0   | Media content hash                          | v1 to v4 load; v5 files refuse older apps |
| 6                     | 0.24.0   | Rotation, flip, rotation keyframes          | v1 to v5 load; v6 files refuse older apps |
| 7                     | 0.25.0   | Project font metadata and shape clip fields | v1 to v6 load; v7 files refuse older apps |
| 8                     | 0.26.0   | Track groups and brand kit                  | v1 to v7 load; v8 files refuse older apps |

Rules for every bump:

- Increment `SERIALIZATION_VERSION` and update its header comment with the version and release.
- Add the migration or defaulting rule for old files. Additive fields must hydrate to neutral defaults.
- Validate hostile input at the boundary: non-finite numbers, out-of-range values, malformed ids,
  duplicate ids, wrong types, and unknown enum values. Do not trust the UI constraints.
- Keep the loader accepting every version from 1 to the current one. Refuse newer files. The released
  loaders that carry the project loader (v0.11.0, v0.18.0, v0.19.2, and v0.20.0 checked) all refuse
  `obj.version > SERIALIZATION_VERSION` before hydration, so an older build cannot accept and resave a
  newer file. Keep that guard in every bump.
- Add cross-version fixtures: the previous version loads with defaults, and a hostile payload is
  rejected or sanitized exactly as documented.
- Update `docs/architecture.md` serialization row and the `.veproj.json` version in `README.md`.
- Prove preview and export parity for every new visual field.
- Add the new persisted surface to the schema note in `CHANGELOG.md`.

Downgrade is not supported. A v5, v6, v7, or v8 project opened by an older build is refused by design.
Each schema release must say this in its release notes.

## 7. Atomic version bump contract

Every release ends with one release commit that updates every version surface together. A missing
entry fails `bun run check` through `releases.test.ts`, and a missing changelog or roadmap row is a
review failure even when the test is green.

Always update in the release commit:

| Surface                 | Required change                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `package.json`          | Set `version` to the release version.                                                                                       |
| `src/lib/releases.ts`   | Add the new head entry with the actual ISO date and at least four user-facing highlights. Never leave `releases[0]` behind. |
| `CHANGELOG.md`          | Add `## [x.y.z] - YYYY-MM-DD` with Keep a Changelog sections.                                                               |
| `ROADMAP.md`            | Add the shipped row and the intro sentence. Update a Premiere gap only if the release actually closes one.                  |
| `README.md`             | Update features, limitations, project format version, or export behavior when the release changes them.                     |
| `docs/architecture.md`  | Update the module map, command catalog, serialization row, and invariants that the release changes.                         |
| `docs/flows.md`         | Update the affected user flow contracts.                                                                                    |
| `docs/testing.md`       | Update the test inventory, counts, coverage scope, and battery record when they change.                                     |
| `docs/structure.md`     | Update the file tree and counts when files or tests are added.                                                              |
| `docs/design-system.md` | Update tokens, spacing, or UI rules when new controls are added.                                                            |
| `docs/seo.md`           | Update the launch checklist only when the public site or battery evidence changes.                                          |
| `docs/deployment.md`    | Update the verification record when the release battery is run.                                                             |

Conditional updates:

- `docs/architecture.md` serialization table and `README.md` project format only for 0.23.0, 0.24.0,
  0.25.0, and 0.26.0.
- `vitest.config.ts` coverage include list plus the coverage-scope sentence in `docs/testing.md` when a
  new pure module is added.
- `AGENTS.md` battery step count only when `e2e/battery.sh` gains or loses a step. The canonical count
  is drift-locked, and README, testing, and structure counts move together.
- `docs/README.md` only if a new permanent doc is added under `docs/`. The root plans are not docs.

Version bump order inside the release commit:

1. Finish and verify the feature.
2. Write the release notes, changelog, roadmap row, and docs with the final ISO date.
3. Bump `package.json` and `src/lib/releases.ts` together.
4. Run `bun run check` on the final tree.
5. Run `bun run battery:pair` on the artifact built from that tree.
6. If either check fails, fix it and repeat steps 4 and 5. Do not hand over a tree that changed after
   the battery.
7. Hand the single commit to the user. Do not tag or push.

## 8. Release gate

For every release, in order:

1. **Baseline.** From the previous release commit, run `bun run check` and record any pre-existing
   failure. Check whether the dev server is already running before starting one.
2. **Red test.** Add the smallest regression lock for the new behavior and watch it fail on the
   unfixed code. For pure logic, this is a Vitest test. For visual behavior, use a static-source lock
   or the mocked browser harness. For engine behavior, use the mocked media harness.
3. **Focused checks.** Run `bun run vitest run <affected files>` after each chunk.
4. **Iteration proof.** Exercise the affected UI with the dev server and `agent-browser` when the
   release has user-visible behavior. Close the session. If you started the server, stop it.
5. **Release cut.** Apply section 7: write the final notes and docs, then bump `package.json` and
   `src/lib/releases.ts` together.
6. **Full gate.** Run `bun run check` on the final tree. Read the tail for failures. Do not set a
   timeout under five minutes. This includes `docs-drift.test.ts`; fix the docs, never the test.
7. **Battery pair.** For the release verdict, run `bun run battery:pair`, which builds and serves the
   standalone artifact from the final tree and runs both legs with four shards each by default.
   `PAIR_SHARDS=1` is the sequential rollback, not the release path. Use `DETACH=1` when the harness
   may clean up background children, poll for `PAIR_EXIT`, and never report a partial run. Add a
   battery step only for a critical flow that unit tests cannot cover; keep the canonical step count
   locked and update the docs counts if it changes.
8. **Hand over.** If step 6 or 7 fails, fix it and repeat both. Hand over one commit whose tree has not
   changed since the battery passed. Do not tag or push.

## 9. Testing and documentation locks

- New pure modules go under `src/lib/editor/` and into the `vitest.config.ts` include list, plus the
  coverage-scope sentence in `docs/testing.md`.
- New test files get a row in the `docs/testing.md` inventory. The README headline, testing counts,
  and structure counts move together, enforced by `docs-drift.test.ts`.
- Browser APIs stay in `media/`, `playback/`, `export/`, the browser-bound persistence and project IO
  modules, or the browser-bound hooks. The state core stays Node-testable.
- Every edit action goes through `executeAction` or `store.apply` with commands. UI-owned dialogs and
  panel toggles stay in `MenuBar.tsx`.
- Every new command clones, validates, and returns a new `Doc`. Never mutate `doc` in place.
- Tests include hostile input, not only the values the UI emits: out-of-range numbers, colliding ids,
  untrimmed names, unknown enums, duplicate ids, and missing references.
- Serialization tests cover the previous version, the new version, a hostile payload, and a round trip.
- Visual fields get preview and export parity proof. Do not rely on the preview alone.
- Recording and file handling need cleanup tests: streams stopped, object URLs revoked, sessions
  closed, and no leaked processes.

## 10. Risk register

| Risk                                                      | Release | Mitigation                                                                                                     | Gate                                              |
| --------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| OPFS quota, eviction, private mode, Safari differences    | 0.23.0  | Feature detection, persistent-storage request, storage estimate UI, relink fallback, explicit missing state    | Browser proof in Chromium and a mock OPFS suite   |
| Freeze frame creates an asset that disappears on reload   | 0.23.0  | Freeze ships only after OPFS and writes through the same import path                                           | Reload proof with the frozen still present        |
| Removing media deletes bytes that undo still needs        | 0.23.0  | Remove never deletes; a confirmed clean action keeps every doc and history reference and skips pending imports | Undo and redo a removal, then run clean           |
| A cleanup deletes bytes an in-progress import wrote       | 0.23.0  | Pending marker, short grace window, and a cross-tab lock around import finalize and clean                      | Import and clean concurrently in two tabs         |
| MediaRecorder WebM carries no duration header             | 0.27.0  | Repair the duration before import and test with a real recorder fixture                                        | Import, then clip duration is finite and playable |
| Rotation and flip drift between preview and export        | 0.24.0  | One shared transform helper, matrix parity tests                                                               | Parity test plus battery pair                     |
| Gizmo math wrong under letterboxing or rotation           | 0.24.0  | Pure geometry helper, edge cases, undo transient test                                                          | Pointer tests and manual browser proof            |
| Custom fonts not loaded before first frame or export      | 0.25.0  | Await `document.fonts.ready`, project font preload, missing-font warning                                       | Export of a text clip with an uploaded font       |
| Font file hostile input or CSS injection                  | 0.25.0  | Validate size and type, sanitize family names, reject malformed font data                                      | Hostile font tests                                |
| Track group precedence ambiguity                          | 0.26.0  | Group actions write member flags, so member state stays the single source of truth; document it                | Precedence table and command tests                |
| Recording permissions, unsupported codecs, leaked streams | 0.27.0  | Feature detection, explicit denial UI, stop all tracks in `finally`, manual headed proof                       | Mock lifecycle tests plus browser proof           |
| ZIP bomb, path traversal, oversized bundle                | 0.28.0  | Entry count and size caps, path normalization, duplicate id rejection, manifest validation                     | Hostile archive tests                             |
| One-commit releases become unreviewable                   | All     | One schema surface per release, phase order inside the commit, focused tests before the gate                   | Review checklist in each plan                     |

## 11. Decisions to settle before coding

| Decision                    | Proposed default                                                                                                                                                                                                                                 | Release | Why it matters                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------- |
| Freeze frame representation | Generated still image at project resolution                                                                                                                                                                                                      | 0.23.0  | Keeps the v5 bump to one field and reuses the image path            |
| Close gaps scope            | Target track, shifting linked partners by the same delta or refusing the batch                                                                                                                                                                   | 0.22.0  | Prevents A/V desync                                                 |
| Join scope                  | Refuse clips with different effects or retiming, any keyframe curve, a boundary transition, or a different source                                                                                                                                | 0.22.0  | Avoids silent data loss                                             |
| Font storage                | OPFS under a font namespace keyed by content hash, with project font metadata                                                                                                                                                                    | 0.25.0  | Avoids a second storage system                                      |
| Track group semantics       | Group actions write the member track flags; no separate group state                                                                                                                                                                              | 0.26.0  | Removes mute, solo, and lock precedence ambiguity                   |
| Brand kit scope             | Colors and font references, no logo upload in the first release                                                                                                                                                                                  | 0.26.0  | Keeps the schema and the UI small                                   |
| Template format             | Built-in and user-saved JSON templates in IndexedDB, no media                                                                                                                                                                                    | 0.26.0  | Keeps templates out of `Doc`                                        |
| ZIP dependency              | Use a small lazy-loaded ZIP library only if the no-dependency store-only writer fails its size and streaming budget                                                                                                                              | 0.28.0  | Respects the no-new-dependency rule                                 |
| Capture codecs              | Prefer browser `MediaRecorder` output, import through the existing probe, warn on unsupported formats                                                                                                                                            | 0.27.0  | Keeps one import path                                               |
| Media store key             | `<project-id>/<content-hash>`, with each asset persisting its own hash                                                                                                                                                                           | 0.23.0  | Relinking one copy cannot change another copy's bytes               |
| Media deletion              | Remove never deletes bytes; a confirmed clean action keeps claimed, doc, history, autosave, and reserved hashes, unions live tab sets, skips pending imports, and refuses content-hash deletion on an unanswered tab or missing claims directory | 0.23.0  | Removing bytes on remove or load breaks undo and can race an import |
| Shared project id           | Copies share a cleanup directory, each doc's content hash resolves its own bytes, and explicit saves and opens write immutable claim shards                                                                                                      | 0.23.0  | Claims cover closed copies, so clean keeps every hash they may use  |
| Recording duration          | Repair a non-finite MediaRecorder WebM duration before import                                                                                                                                                                                    | 0.27.0  | The probe otherwise reads 0 and the clip is unusable                |
| Transform origin            | Per-kind visual bounds: frame for video/image/compound, text box for text, path bounds for shapes                                                                                                                                                | 0.24.0  | Rotating text around the canvas center makes it orbit               |
| Font identity               | Generated CSS family from the font id, immutable; the display name is cosmetic                                                                                                                                                                   | 0.25.0  | Renaming a font must not break text or the brand kit                |
| Bundle scope                | Bundle every `Doc.media` and `Project.fonts` entry, including unused bin items                                                                                                                                                                   | 0.28.0  | The project JSON lists them, so omitting them creates a broken bin  |
| Group scope                 | A group's members must all belong to one sequence                                                                                                                                                                                                | 0.26.0  | A project-level group spanning sequences has no meaning             |
| Release gate                | `bun run battery:pair` for both legs; `PAIR_SHARDS=1` is rollback only                                                                                                                                                                           | All     | The 0.20.2 pair runner is the canonical verdict                     |

If a decision changes, update the owning release plan and this table before writing code.

## 12. Definition of done

A release is done only when all of these are true:

- The feature matches its plan and anti-goals.
- New tests failed before the fix and pass after it.
- `bun run check` is green.
- `bun run battery:pair` is green on both legs for the release.
- The docs and counts are in sync, including the test inventory and coverage scope.
- The schema migration and hostile-input tests pass for 0.23.0, 0.24.0, 0.25.0, and 0.26.0.
- The release commit contains the atomic version bump for `package.json`, `src/lib/releases.ts`,
  `CHANGELOG.md`, `ROADMAP.md`, and every affected doc.
- `releases.test.ts` passes with `releases[0]` and `CURRENT_VERSION` equal to `package.json`.
- Nothing started by the agent is still running.
- The working tree is handed to the user uncommitted. The user commits, tags, and pushes.

## 13. Plan index

- [0.21.0 export and framing](PLAN_0.21.0_EXPORT.md)
- [0.22.0 timeline commands](PLAN_0.22.0_TIMELINE.md)
- [0.23.0 durable media and freeze](PLAN_0.23.0_MEDIA.md)
- [0.24.0 transform](PLAN_0.24.0_TRANSFORM.md)
- [0.25.0 text and graphics](PLAN_0.25.0_TEXT_GRAPHICS.md)
- [0.26.0 libraries](PLAN_0.26.0_LIBRARIES.md)
- [0.27.0 capture](PLAN_0.27.0_CAPTURE.md)
- [0.28.0 project bundle](PLAN_0.28.0_BUNDLE.md)

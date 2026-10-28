# PLAN: Editor parity with the reference

Status: done
Branch: `updates`
Baseline: `0.11.0`, 77 test files, 1,603 tests, 63-step UI battery
Reference: local only at `.design/editor-parity/editor-target.png` (never committed)
Plan owner: the agent implements and verifies. The user reviews, commits, pushes, tags, and deploys.

## Outcome

Make the editor's layout and behavior match the agreed reference screenshot through real controls,
in staged releases. Every visible control must work. No decorative icons, no mock-only states, and
no fake hero screenshot.

The reference is a direction, not a pixel spec. The owner supplied it with an AI prompt. It is kept
locally for the duration of this epic and retired when the real editor capture replaces it.

## Reference rules

- The image stays local. It is never added to git, `public/`, the README, the docs index, or the
  marketing site.
- The committed plans may describe the image and link to its local path. The image itself is not a
  deliverable.
- The final hero screenshot is a real `public/screenshots/editor.png` capture from the running
  editor, never the reference image.
- Content parity is not a goal. The reference uses a fictional brand and footage we do not own. We
  judge layout, density, and behavior with our own bundled sample project.

## Non-goals

- New stock footage, new brand assets, or a custom domain.
- A mask or roto Pen tool. The Pen tool in this epic edits keyframes only.
- Backend, account, collaboration, or cloud features.
- A mobile-first redesign. The existing compact layout must still work.
- Rewriting the playback, export, or command architecture.
- New dependencies unless a plan proves the existing stack cannot do the job.

## Working agreement

- One plan at a time, in order. Start each plan from the latest `updates` HEAD after the user's
  commit. Load `.agents/skills/implementation-discipline/SKILL.md` before the first edit and record
  its trigger audit with the change.
- The agent implements only the current plan. If the work grows, the plan is updated and work stops
  for review before the scope expands.
- The agent does not commit, push, tag, merge, or deploy. The user does.
- Every plan ends with a full `bun run check`, the targeted browser proof, and the owning docs
  updated. Release-bearing plans also bump the version atomically.
- A regression test must fail on the unfixed code before it counts. Static source locks must fail
  when the locked line is removed, not pass at zero matches.
- If a gate is red, fix the cause. Never skip a test, weaken an assertion, swallow an error, or add
  a suppression.

## Plan index

| #   | Plan                                                          | Status | Depends on  | Release gate                |
| --- | ------------------------------------------------------------- | ------ | ----------- | --------------------------- |
| 00  | [This orchestrator](PLAN-EDITOR-PARITY.md)                    | done   | none        | none                        |
| 01  | [Reference and spec](PLAN-01-REFERENCE-AND-SPEC.md)           | done   | 00          | none                        |
| 02  | [Geometry and chrome](PLAN-02-GEOMETRY-AND-CHROME.md)         | done   | 01          | internal commit, no release |
| 03  | [Filmstrips](PLAN-03-FILMSTRIPS.md)                           | done   | 01, 02      | `0.12.0`                    |
| 04  | [Volume automation](PLAN-04-VOLUME-AUTOMATION.md)             | done   | 01, 02, 03  | `0.13.0`                    |
| 05  | [Track controls](PLAN-05-TRACK-CONTROLS.md)                   | done   | 02, 04      | `0.14.0`                    |
| 06A | [Ripple trim and slip](PLAN-06A-RIPPLE-SLIP.md)               | done   | 04, 05      | `0.15.0`                    |
| 06B | [Keyframe Pen](PLAN-06B-KEYFRAME-PEN.md)                      | done   | 04, 05, 06A | `0.16.0`                    |
| 07  | [Integration and release](PLAN-07-INTEGRATION-AND-RELEASE.md) | done   | all         | `0.16.1` final gate         |

The plan count is 1 orchestrator plus 8 execution plans. Plan 06 split at its own gate before
coding: `06A` carries the tool state, ripple trim, and slip, and releases as `0.15.0`; `06B` carries
the keyframe Pen and the generalized automation envelope, and releases as `0.16.0`. Plan 07 is the
final QA gate, hero capture, and reference retirement, released as `0.16.1` after the owner
confirmed the patch version.

The version numbers are proposals. The user confirms each one at the gate. The repo rule stands:
a version bump is one atomic change across `package.json`, `src/lib/releases.ts`, `CHANGELOG.md`,
the roadmap, and every doc that records the running version.

## Release map

| Release  | Plans  | User-visible change                                                  |
| -------- | ------ | -------------------------------------------------------------------- |
| none     | 01, 02 | Spec, geometry, chrome                                               |
| `0.12.0` | 03     | Sampled filmstrips and the matching hero screenshot                  |
| `0.13.0` | 04     | On-clip volume envelopes and the dB inspector graph                  |
| `0.14.0` | 05     | Real track solo and lock                                             |
| `0.15.0` | 06A    | Real ripple trim and slip                                            |
| `0.16.0` | 06B    | The keyframe Pen over the generalized automation envelope            |
| `0.16.1` | 07     | Final QA gate, real hero capture, reference retired, 66-step battery |

Plan 02 is an internal commit so its geometry and chrome can be reviewed before the filmstrip work
depends on it. It does not bump the version. Plan 03 completes `0.12.0`.

## Element inventory

This is the one-page map. Plan 01 expands it into a row-by-row checklist with current file
evidence, target behavior, proof method, and owner plan.

| Region            | Current                                                                 | Reference target                                                                                                   | Plan         | Type                     |
| ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------ | ------------------------ |
| Menu bar          | File through Help, full screen, version                                 | Same plus a compact `videoh` wordmark at the left                                                                  | 02           | restyle                  |
| Toolbar           | Undo/redo, select, razor, placement, edit, text, tracks, snap, zoom, IO | Same density, grouped; ripple, slip, and Pen must work                                                             | 02, 06A, 06B | restyle and new behavior |
| Media bin         | 40px square thumbnail, name, kind badge, duration                       | Wider card, larger thumbnail, name, kind and duration                                                              | 02           | restyle                  |
| Program monitor   | Canvas, scopes strip, transport                                         | Same, larger share when Source is hidden, visible volume slider                                                    | 02           | restyle                  |
| Inspector         | Clip and Effect Controls tabs, full property sections                   | Clip tab gains a dB volume summary and graph                                                                       | 04           | new behavior             |
| Timeline ruler    | Compact seconds, playhead, snap guide                                   | Two-digit `mm:ss` labels, same playhead and snap guide                                                             | 02           | restyle                  |
| Track headers     | 160px, kind, name, clip count, eye, mute, targeting in menu             | 168px, no clip count, eye, mute, M/S, lock, target in menu                                                         | 02, 05       | restyle and new behavior |
| Video/image clips | Color block, label, linked badge, waveform, trim handles                | Sampled filmstrip frames behind the same overlays                                                                  | 03           | new behavior             |
| Audio clips       | Waveform, label, trim handles                                           | Volume envelope line and keyframe dots over the waveform                                                           | 04           | new behavior             |
| Status bar        | Project, format, duration, selection, px/s, undo steps, autosave        | Project, format, duration, selection, track counts, autosave                                                       | 02           | restyle                  |
| Panel frame       | Resizable, collapsible, uppercase headers, token colors                 | Same with tighter spacing, target panel shares, media upper row, full-height inspector, lower left/center timeline | 02           | restyle                  |

## Quality gates

Every plan runs these gates before it is handed back:

1. `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`.
   The combined command is `bun run check`.
2. The affected browser proof. Use `agent-browser` with a unique session and close it when done.
3. A console check with zero page errors.
4. The owning docs updated. Release plans also update `README.md`, `CHANGELOG.md`, the roadmap,
   `src/lib/releases.ts`, and every doc that records the version or counts.
5. A trigger audit recorded in the plan or the final report: baseline, ladder line for each new
   construct, red-first lock evidence, findings table if a review produced findings, and any lesson
   appended to `LESSONS.md`.

## Flakiness controls

These rules exist so the plans can be executed without time-based or environment-based failures.

- No hardcoded test counts in plan acceptance. The baseline counts are context. Any plan that adds or
  removes tests updates the counts through `docs-drift.test.ts`, release or not, never by guessing.
- Browser steps wait on a selector or a `data-*` readiness attribute. No fixed sleep as a
  synchronization primitive.
- Canvas unit tests assert recorded draw operations or DOM structure, not anti-aliased pixels. Real
  pixel checks run only in the browser against a bundled sample.
- Filmstrip performance is spike evidence, not a unit-test assertion. Do not put wall-clock budgets
  in the test suite.
- Screenshot comparison is a region checklist against the local reference, not a pixel diff. The
  content intentionally differs.
- Screenshots are taken with playback paused, the playhead fixed, zoom fixed, selection cleared or
  fixed, and filmstrips ready when the build has them. Wait for fonts and the
  `data-filmstrips-ready` marker on the timeline root from Plan 03 onward.
- Every filmstrip request carries a generation token. Stale requests cannot install a strip for a
  clip that has changed, unmounted, or switched media.
- Lock tests enumerate every edit path in a table. A path without a test is an incomplete plan, not
  an acceptable gap.
- Solo tests use one shared track audibility predicate: `anySoloFor(tracks)` and
  `audibleTrackIds(tracks)` in `src/lib/editor/tracks.ts`, plus the existing per-clip
  `clipRendersAudio(doc, clip)` in `src/lib/editor/links.ts`. Preview, offline plan, and MP4 mix
  read the track predicate. Two separate copies of the rule are a defect; do not add a second
  `audibility.ts`.
- No test may pass at zero matches. Presence locks must fail when the line is removed.
- No network access in unit tests. Media elements, audio contexts, and canvases use the existing
  mocked harness.
- No absolute paths in committed docs beyond the local reference path, which is relative to the
  repo root and gitignored.

## Risks

| Risk                                       | Impact                                  | Mitigation                                                                             |
| ------------------------------------------ | --------------------------------------- | -------------------------------------------------------------------------------------- |
| Hidden-video seeking is too slow           | Filmstrips arrive late or jank playback | Plan 01 spike with numeric go/no-go; coarse sheet or WebCodecs fallback                |
| Filmstrip cache grows without bound        | Memory pressure on long projects        | LRU cap, pixel budget, one job at a time, cancel stale jobs                            |
| Lock enforcement misses an edit path       | A locked track can be changed           | Command-layer guard plus an exhaustive edit-path inventory and tests                   |
| Solo logic diverges between preview/export | Different sound in monitor and file     | One shared audibility predicate, tested on both paths                                  |
| Geometry changes break ruler/drop math     | Misplaced clips or wrong drop targets   | Plan 02 updates constants and covers the math with existing tests                      |
| Tool scope grows                           | The epic stalls                         | Plan 06 split gate; masks are explicitly out of scope                                  |
| Reference drift                            | Endless visual changes                  | Plan 01 inventory and geometry contract; Plan 07 final audit, then retire              |
| Autosave/project bloat                     | Project saves fail                      | Filmstrips stay runtime-only; serialization tests prove no new Doc fields              |
| Hero screenshot is stale or fake           | Public site misrepresents the editor    | Real capture at each release; reference never used as the hero                         |
| Hero photo provenance                      | Mismatched image, alt text, or credit   | Owner supplies the photo, or the capture uses the bundled sample and updates all three |

## Definition of done

- All execution plans in the plan index are `done`, including `06A` and `06B`.
- The local reference image is deleted. The hero screenshot is a real capture from the final build.
- `public/screenshots/editor.png` and its alt text match the final editor.
- `bun run check` is green.
- The full dev battery and the standalone artifact battery are green. If steps were added, the
  documented count moves with them.
- The user has committed every plan on `updates`.
- No server, browser session, or scratch worktree is left running.
- The final report lists what changed, what was proven and how, what was skipped and why, and any
  remaining risk.

## Validation

This plan set was checked against the current tree on 2026-10-27:

- Every cited existing path resolves. Planned new files are named in the owning plan.
- Every relative link between plans resolves.
- The dependency graph is acyclic and each plan's release gate matches the release map.
- Prettier passes on every `PLAN-*.md`.
- `bun run check` is green at `0.11.0`: 77 test files, 1,603 tests, 11 routes, production build
  included.
- The plans were checked against the current source and both battery scripts. Findings were verified
  against the code and folded into the owning plan before execution starts.

## Decision log

| Date       | Decision                                                                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-27 | Reference is AI-generated from the owner's prompt, local only, never committed.                                                                                                                                                                |
| 2026-10-27 | Solo and lock are real features, not decorative icons.                                                                                                                                                                                         |
| 2026-10-27 | Ripple trim and slip are real tools. Ripple trim is same-track by decision. This is an explicit exception to Invariant 14, not a match for ripple delete: later linked partners on other tracks do not shift, and the edited pair can diverge. |
| 2026-10-27 | Pen means keyframe editing. Masks and roto are out of scope.                                                                                                                                                                                   |
| 2026-10-27 | A linked video half hides its waveform; the audio twin carries the sound. A solo video with no twin keeps its waveform.                                                                                                                        |
| 2026-10-27 | The Source monitor stays visible by default. The demo and hero capture hide it through the existing workspace state.                                                                                                                           |
| 2026-10-27 | Track headers are 168px, not the reference's narrower width. The working eye/mute/M/S/lock controls need 24px hit targets; the clip count and header target button are removed.                                                                |
| 2026-10-27 | Reference panel tree: media in the upper row, inspector full height on the right, timeline lower left/center. Captions are hidden for the demo and hero through workspace state. Plan 02 owns the presentation-only move.                      |
| 2026-10-27 | The demo project uses only the bundled sample media, arranged across 5 video and 4 audio tracks.                                                                                                                                               |
| 2026-10-27 | Work is staged on `updates`, one plan at a time, with the user committing between plans.                                                                                                                                                       |
| 2026-10-27 | Proposed releases: `0.12.0`, `0.13.0`, `0.14.0`, `0.15.0`, then the final gate.                                                                                                                                                                |
| 2026-10-27 | Plan 06 split at its own gate before coding: `06A` is tool state, ripple trim, and slip (`0.15.0`); `06B` is the keyframe Pen and the generalized automation envelope (`0.16.0`). Plan 07 targets `0.16.0`.                                    |
| 2026-10-27 | Ripple trim stays same-track. The owner confirmed the Invariant 14 exception: linked partners on other tracks do not shift, and the tooltip says so.                                                                                           |

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-09-20

Repository hygiene pass: the project no longer carries any leftovers from the scaffold it was
bootstrapped from — unused vendor tooling, branding assets, and dead backend scaffold are gone. The
documentation set is complete and cross-linked, and a single `bun run check` gate now mirrors CI. No
editor behavior changed — the 266 tests stay green and the production build is unchanged.

### Removed

- **Vendor traces from the starting scaffold.** An unused vendor SDK dependency, its remote favicon,
  and the bundled vendor logo (`public/logo.svg`) are gone.
- **Deployment scaffolding** that never ran in this app: `.zscripts/` (nine template build/dev/start
  scripts), `Caddyfile`, and `tests/*runtime*.sh`.
- **Unused example and inbox folders**: `examples/websocket/` (it imported `socket.io`, which was never
  a dependency), `upload/`, `download/`, and `mini-services/`.
- **Unused backend scaffolding**: `prisma/`, `db/custom.db`, `src/lib/db.ts`, the hello-world
  `src/app/api/route.ts`, the `@prisma/client` + `prisma` dependencies, the `db:*` scripts, and the
  leftover `.env` (a single empty `DATABASE_URL`). The app is client-only and never used any of them.
- The internal `worklog.md`; its history is folded into the `0.2.1` entry below.

### Added

- **`bun run check`** — the full CI gate in one command (`format:check → lint → typecheck → test →
build`), plus the `typecheck` script (`tsc --noEmit`) it calls. Ordering rationale is documented in
  [docs/deployment.md](docs/deployment.md).
- **A complete documentation set** under `docs/`: an index hub, plus architecture, structure, flows,
  testing, and design-system references that cross-link to each other and to the README.
- A local `src/app/icon.svg` favicon coded to the editor's timeline palette, replacing the removed
  remote icon.

### Changed

- `.gitignore` rewritten: dropped the leftover scaffold entries, and added `*.log`, e2e result
  artifacts, and the local agent/editor workspaces (`.claude/`, `.kilo/`, `.freebuff/`).
- ESLint and TypeScript now exclude `.kilo/` (an agent worktree checkout) so the gate inspects only the
  project's own sources.
- The [README](README.md) now links to the docs set, and its stale limitations (single-selection,
  no ripple editing) and test counts were corrected.

### Fixed

- **`bun run start` reported success even when the server crashed** — the `… 2>&1 | tee server.log`
  pipeline returns `tee`'s exit status, so the server's non-zero status was swallowed. The script now
  runs with `set -o pipefail` (environment, redirection, and logging behavior unchanged).
- Two pre-existing type errors in the test suite that `next build` had been hiding via
  `typescript.ignoreBuildErrors`: a nullable `EditorCommand[]` access in `av-links.test.ts` and a
  canvas `getContext` cast in `browser-mocks.ts`. The new `typecheck` step now enforces them.

## [0.2.1] — 2026-09-19

The editor MVP: a browser-based multi-track video editor with a command-driven state core, a
canvas/Web Audio playback engine, Premiere-style editing UX, and WebM export. Reconstructed from the
project's build log, newest work first.

### Added

- **State core** — the `Doc` model (`{ project, media }`, all times in seconds), 22 validated commands
  applied through `applyCommand`, whole-document snapshot undo/redo capped at 100 entries, transient
  gestures that collapse a drag into one history entry, snapping, and crossfade math shared by the
  compositor and audio mixer.
- **Playback engine** — `PlaybackCore` with an `AudioContext` master clock, a per-clip media element
  pool, drift correction (120 ms), a per-clip Web Audio gain graph (`gain × clip mute × track mute ×
crossfade alpha`), and canvas compositing (bottom-to-top, contain-fit, styled text, opacity).
- **Timeline** — move, trim, split, duplicate, delete, cross-track drags, snapping, canvas ruler
  scrubbing, ctrl/wheel zoom, and a playhead-following scroll.
- **Cross-dissolve transitions** — per-clip `transitionOut` with a real overlap, clamped at render time.
- **Text overlays** — text tracks and clips with full styling, plus drag-to-position directly in the
  program monitor with a dashed outline.
- **Export** — `MediaRecorder` capture with low/medium/high bitrates, progress, cancel, and inline
  preview.
- **Persistence** — `.veproj.json` save/load (object URLs stripped), 800 ms debounced localStorage
  autosave, and a restore-or-discard banner.
- **Premiere-style editing UX** — a menu bar with no dead items or fake shortcuts; a resizable,
  collapsible, persistent panel workspace; a verified Premiere keyboard map (razor on `C`, Add Edit on
  `Ctrl+K`, ripple delete on `Shift+Del`, `Ctrl+L` link toggle, `J`/`K`/`L` shuttle).
- **A/V links** — videos with audio land as a linked video + audio-only pair that selects, moves,
  splits, duplicates, deletes, and pastes as one unit, with the engine shadowing the embedded audio to
  prevent double playback.
- **Multi-selection** — Shift/Ctrl click with link-group-aware group operations, a full clip context
  menu (cut/copy/paste/split/duplicate/link/unlink/ripple delete), and group-aware keyboard shortcuts.
- **Layer compositing** — per-clip opacity that stacks with crossfade alphas, and drop-between-tracks
  with a live `+ V2`/`+ A2` insertion indicator that places a new layer at the exact z-position.
- The `e2e/battery.sh` UI battery (28 steps) and the mocked browser-API harness used for A/B
  verification of the engine.

### Changed

- **New projects default to Full HD (1920×1080 @ 30fps)**, up from 1280×720, in both the factory and the
  deserialization fallback. Existing files keep their stored dimensions.
- `addTrack` inserts a new track at the head of its kind's group, so the newest track stacks on top
  (Premiere semantics).

### Fixed

- **Export cancel deadlocked** — cancelling paused the core without resolving `playbackDone`, so the
  recorder kept recording and the poll interval leaked. Found by the mocked harness, fixed by resolving
  in both the frame callback and the cancel guard.
- **The playhead painted over the sticky track headers** when the timeline scrolled, and left two
  magenta dots from row borders; fixed by splitting the line/diamond and confining them to the track
  rows with a documented z-scale.
- **The media bin and inspector could not scroll** — `PanelShell`'s content wrapper was a plain block
  box, so the panels grew to content height and were clipped; it is now a `flex min-h-0 … flex-col`
  wrapper.
- **The preview transport was clipped** when panels were resized; the panel is a flex container, the
  transport is `h-12 shrink-0`, and the volume slider keys off the panel width via a container query.
- **Load sample media could spam duplicates**; loading is now idempotent with clear feedback.
- **Unlinking silently skipped the audio twin**, and **pasting forged false link bonds**; both were
  caught by tests and fixed (the unlink loop no longer destroys its own anchor mid-iteration, and paste
  re-links per original group).

# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [0.3.1] — 2026-09-20

Three follow-ups: the dev server now reports failures honestly, the UI layer keeps only the components
the editor actually uses, and the 28-step UI battery scrolls each control into view before clicking it.
No editor behavior changed — 266 tests, typecheck and the production build are green. The battery passes
28/28 with identical results across runs; before the harness fix it reported 25/28 on the same app code.

### Fixed

- **The `dev` script reported success when the server failed to start** (`package.json`).
  `next dev … 2>&1 | tee dev.log` returns `tee`'s exit status, so a boot failure (port already in use,
  a startup crash) still exited 0. It now runs under `set -o pipefail`, matching `start`. Proven by
  occupying the dev port: the old pipeline exited 0, the new one exits 1.
- **The UI battery clicked off-screen controls** (`e2e/battery.sh`), failing three steps on a short
  viewport. The Inspector and the timeline are scroll areas shorter than their content, so a control
  below the fold has no clickable coordinates and the blind click lands on whatever is painted at that
  point instead — the Timeline header for the Inspector switches, the app footer for the audio clip.
  `f03 crossfade`, `f05 mute` and `f05 gain` all failed this way, and `click_clip` was silently missing
  its target in `f07 export prep` (a step that returns success unconditionally, so it never surfaced as
  a failure). Every target is now scrolled into view before it is touched — `insp()` for Inspector
  controls, `click_clip()` / `delete_clip()` for clips, and the spinbutton fills. This was a harness
  defect only: the app was verified correct by scrolling and clicking the same controls live, and the
  battery now reports 28/28 with byte-identical results across runs.

### Removed

- **30 unused shadcn/ui primitives** (`src/components/ui/`), leaving the 18 that app code actually
  reaches: badge, button, context-menu, dialog, dropdown-menu, input, label, menubar, progress,
  resizable, select, separator, slider, switch, textarea, toast, toaster, tooltip. The set was trimmed
  as a transitive closure, so a primitive imported by a kept primitive (or by app code outside `ui/`)
  was never removed; `bunx shadcn add <name>` restores any of them.
- **23 dependencies that existed only to back those primitives**: the `@radix-ui/*` packages those
  files imported, plus `recharts`, `embla-carousel-react`, `cmdk`, `vaul`, `input-otp`,
  `react-day-picker`, `react-hook-form`, `sonner` and `next-themes`.
- **17 dependencies that were already dead** — unreferenced by `src/`, the root config files or
  `globals.css`: `framer-motion`, `next-auth`, `next-intl`, `zod`, `uuid`, `date-fns`, `sharp`,
  `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `@hookform/resolvers`,
  `@tanstack/react-query`, `@tanstack/react-table`, `@mdxeditor/editor`, `react-markdown`,
  `react-syntax-highlighter` and `@reactuses/core`. (`sharp` is safe to drop because the app uses no
  `next/image`.) Runtime dependencies go from 63 to 23.

### Changed

- `theme.test.ts`'s portal-primitive guard drops its `popover.tsx` entry, since that file was removed
  with the trimmed primitives. The guard still covers menubar, dropdown-menu, select and dialog.
- Documentation re-synced with the code after the trim: the ui-primitive count (48 → 18) in
  `design-system.md` and `structure.md`; the menu action-id count (28 → 36) in `architecture.md`; the
  `setClipOpacity` row that was missing from the README's command table; and the `framer-motion`,
  `next-themes`, `sonner` and `popover` references that no longer exist in the project. The shadcn
  restoration command reads `bunx shadcn add <name>`, matching the project's Bun-only tooling.

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

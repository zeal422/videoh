# AGENTS.md — Instructions for AI Coding Agents

Browser-based multi-track video editor. Everything runs client-side (object URLs, canvas, Web Audio,
WebCodecs), there is no backend, database, or environment configuration. Single page mounted from
`src/app/page.tsx` (client-only dynamic import of the editor shell). Stack: Next.js 16 App Router +
React 19 + TypeScript strict (`noImplicitAny` on, build-time type errors not ignored) + Tailwind 4 (tokens in `src/app/globals.css`) + shadcn/ui +
zustand 5 + Vitest. Run with **Bun**, never npm/pnpm/yarn.

Docs: [README.md](README.md) and the [docs/ index](docs/README.md) (architecture, structure, flows,
testing, design-system, deployment). Read [CHANGELOG.md](CHANGELOG.md) for release history; notable
changes must be documented there ([Keep a Changelog](https://keepachangelog.com/en/1.1.0) format).

## Commands

```bash
bun install          # install dependencies
bun run dev          # dev server :3000 (output mirrored to dev.log)
bun run check        # FULL gate: format:check → lint → typecheck → test → build
bun run test         # Vitest only (NOT bare `bun test` — Bun's runner ignores vitest.config.ts)
bun run test:coverage # Vitest with enforced coverage thresholds
bun run typecheck    # tsc --noEmit
bun run lint         # ESLint
bun run format       # Prettier write (src, docs, root config)
bun run build        # production build (standalone)
```

Golden rule: after any change run `bun run check`. If any step is red you are
not done. `build` uses `output: "standalone"` (see `next.config.ts`; don't break it).

Running the suite (these are the steps agents get wrong):

- `bun run check` takes minutes (the build dominates); read the tail of the
  output, failures print there. Don't set tool timeouts under ~5 min.
- Vitest flags (`--coverage`, `-t`, single files) must go through
  `bun run vitest run ...`. Bare `bun test` ignores `vitest.config.ts`, and so
  do its coverage include-list and thresholds.
- Coverage scope is the explicit include-list in `vitest.config.ts`. A new pure
  module is unmeasured until you add it there, plus an inventory row in
  `docs/testing.md`; the counts in README/testing/structure are drift-locked by
  `docs-drift.test.ts` and all three move together.
- `docs-drift.test.ts` failures after adding/removing tests or renaming battery
  steps are the intended signal: update the docs, never the drift test.
- After `bun run format`, re-run `bun run check`: Prettier can glue markdown
  table rows together, which docs-drift then counts as broken cells.
- Battery: `bun run battery` (`bash e2e/run-battery.sh`, see
  [docs/testing.md](docs/testing.md)). The runner starts a dev server only when
  the port is free, reads `GATE_PASSWORD` from `.env.local` itself, closes its
  browser session, and stops only a server it started, so nothing is left behind.
  It runs minutes (1080p export included) and needs `agent-browser` on PATH. For the SHIPPED
  artifact, build and serve it yourself (`bun run build && bun run start`) and run the battery: it
  reuses the server already on the port. Dev-green does not imply prod-green (minified chunks, copied
  `.next/static` + `public`).
  **Use `DETACH=1` whenever the harness may clean up background children**: a
  session ending mid-run kills the dev server and the battery with it, and the
  17 lines that did pass look exactly like a result. The verdict is strict, so a
  killed run cannot pass: fewer result lines than `step` lines in
  `e2e/battery.sh` exits nonzero with INCOMPLETE. Never report a battery result
  that did not come from a full run. Syntax-check edits with `bash -n
e2e/battery.sh e2e/run-battery.sh`. If the user started the dev server, leave
  it running.
  Full battery runs are the release verdict only, never the iteration loop:
  iterate with unit tests, manual `agent-browser` sessions, or prefix runs
  (comment out trailing `step` lines; the verdict adapts to what ran). Reserve
  full dev plus artifact batteries for the final gate.

## Map

- `src/lib/editor/` — the state core. Types, constants, factories, commands, snap, transition, links,
  clipboard, actions, tracks, timeline-scroll, store, serialization, persistence, workspace, menus. Pure
  TypeScript (no React, except the zustand stores); this is what unit tests target. See
  [docs/architecture.md](docs/architecture.md).
- `src/lib/editor/media|playback|export/` — the only modules allowed to touch browser APIs (media
  elements, Web Audio, canvas, WebCodecs).
- `src/components/editor/` — the UI. `src/components/editor/timeline/` holds the timeline.
- `src/components/ui/` — preinstalled shadcn/ui: use them, never modify by hand.
- `src/hooks/editor/useEditorKeyboard.ts` — the verified Premiere keyboard map.
- `src/app/` — `layout.tsx` (dark `<html>`, fonts, Toaster), `page.tsx`, `globals.css` (tokens),
  `icon.svg`.
- `src/lib/editor/__tests__/` — all tests (`*.test.ts`), plus the mocked browser harness in `mocks/`.
- `e2e/battery.sh`: 63-step UI battery, first step is the gate login (needs the dev server +
  `agent-browser`; set `GATE_PASSWORD` when the gate is active). Drive it through
  `e2e/run-battery.sh` (`bun run battery`), which owns the server, the password, the session and the
  strict verdict.
- `public/samples/` — bundled demo media used by "Load sample media".

## Critical rules

1. **Commands are the only mutation path.** UI dispatches an `EditorCommand` to the store; commands
   clone, validate, and return a new `Doc`. Never edit `doc` fields in place. If new state must be
   undoable, it lives inside `Doc`.
2. **Keep the state core browser-free** so it runs in Vitest's Node environment. Browser APIs belong in
   `media/`, `playback/`, and `export/`.
3. **Style through design tokens** (`bg-background`, `text-muted-foreground`, `border-border`, …) with
   [docs/design-system.md](docs/design-system.md). The kind colours (emerald/amber/violet clips, rose
   playhead, amber snap guide) are the deliberate exception; never hardcode surface hex values.
4. **All times are seconds (floats).** Frame conversion lives only in `time.ts`. `tracks[0]` is the
   topmost layer; the compositor draws last-to-first.
5. **Layout: panels must be flex chains.** A panel root is `flex min-h-0 min-w-0 flex-1 flex-col`, and
   `PanelShell`'s content wrapper is `flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden` — without
   it, content is clipped instead of scrolling (react-resizable-panels renders plain block boxes).
6. **Tests.** Add tests under `src/lib/editor/__tests__/`. A regression test must fail on the unfixed
   code before it counts as proof. Behavior that is about code shape (z-order, CSS, mounted markup) is
   locked with static-source assertions; runtime engine behavior uses the mocked harness.
   **Validate both directions at trust boundaries.** A value the UI constrains (slider bounds, unique
   names, reserved ids) must be re-validated when it arrives from a file, a command payload, or
   hydration, not just when the UI produces it. Regression tests must include hostile input
   (out-of-range numbers, colliding ids, untrimmed names), not only the values your own controls emit.
7. **Grep is an indicator, not truth.** Open the cited code and verify before writing any factual claim
   — in code, docs, or commit messages. Report problems regardless of when they were introduced.
8. **Dev server:** check first (`curl -s --max-time 3 http://localhost:3000`), never start a duplicate,
   and read the `dev.log` tail for state. If you started it, stop your own process group when done;
   never `pkill -f 'next dev'`. If the user started it, leave it running.
9. **Clean up browser sessions.** Headless browsers (`agent-browser`, puppeteer-style debug runs)
   leak processes that hold inotify instances and file descriptors — enough of them exhaust the
   system's 128-instance watch limit and crash Turbopack with `Too many open files`. Close every
   session you open; the owning tool's exit/stop command, never a bare `pkill chrome` (the user's real
   browser is Chrome too).
10. **Do not edit without explicit go-ahead.** Vague approval is not edit permission, and one task's
    approval doesn't extend to the next. Once approved, execute end-to-end without re-asking.
11. **Surgical changes only** — no drive-by refactors, no new dependencies when the existing stack
    suffices, no config flags to make errors disappear. Simplicity first.
12. **Fix-request lists (e.g. `TO_FIX.md`):** verify every finding against the current code before
    fixing; skip invalid ones with a reason; ask before product decisions; add regression tests; keep
    docs in sync; run the full `bun run check`.
13. **No em dashes. Never, in anything you write to the user: replies, docs, commit messages, code
    comments.** Use a period or a comma instead. If a thought needs separation, end the sentence.
    (Also from the unslop skill: no curly quotes, no decorative emoji, sentence-case headings, and
    prefer plain words over AI-vocabulary like "delve", "showcase", "leverage".)
14. **A version bump is one atomic change, never `package.json` alone.** In the SAME change edit every
    place the version lives: `package.json` (`version`); `src/lib/releases.ts` (a new head entry with its
    ISO `date` and four or more highlights, `CURRENT_VERSION` derives from `releases[0]`); `CHANGELOG.md`
    (a new `## [x.y.z] - <date>` entry, required); the roadmap, while the repo still keeps one; and each
    doc that records the running version (`docs/deployment.md`, `docs/testing.md`). Update `README.md`,
    `docs/architecture.md`, `docs/flows.md` and `docs/design-system.md` when the release changes what
    they describe. `releases.test.ts` fails `bun run check` when `releases[0]` or `CURRENT_VERSION` lags
    `package.json`, but it does not check the changelog or the roadmap, so those are on you.

## Workflow

For implementation work (a `PLAN-*.md`, a bug fix, any multi-step change), load the repo skill
`implementation-discipline` (`.agents/skills/implementation-discipline/SKILL.md`) first. It carries the
working order and gates, the trigger audit to record with the change, and the failure-adaptation loop
that appends lessons beside it in `LESSONS.md`. It complements the rules above and `bun run check`; it
does not replace them.

Read the relevant docs → make the minimal localized change → add or update colocated tests → run
`bun run check` → verify the UI (`bun run dev`, exercise the flow, keep the console clean) → update the
owning doc(s) and `CHANGELOG.md` → **do not commit**: the user commits and pushes. Commit messages, only
when asked, use Conventional Commits with a bullet body listing each notable change.

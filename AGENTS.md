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
  `bun run vitest run ...` — bare `bun test` ignores `vitest.config.ts`, and so
  do its coverage include-list and thresholds.
- Coverage scope is the explicit include-list in `vitest.config.ts`. A new pure
  module is unmeasured until you add it there, plus an inventory row in
  `docs/testing.md`; the counts in README/testing/structure are drift-locked by
  `docs-drift.test.ts` and all three move together.
- `docs-drift.test.ts` failures after adding/removing tests or renaming battery
  steps are the intended signal: update the docs, never the drift test.
- After `bun run format`, re-run `bun run check`: Prettier can glue markdown
  table rows together, which docs-drift then counts as broken cells.
- Battery: `BASE_URL=http://localhost:3000 OUT=results.txt bash e2e/battery.sh`
  (see [docs/testing.md](docs/testing.md)); export `GATE_PASSWORD` from
  `.env.local` first or step 1 fails. It runs minutes (1080p export included),
  needs `agent-browser` on PATH, and syntax-checks with `bash -n e2e/battery.sh`.
  Afterwards close your agent-browser session (the owning tool's close command;
  attribute leftovers by `ps -o pid,lstart`), and if you started the dev server,
  stop it and verify the port is free (`curl -s --max-time 3
http://localhost:3000` exits 7). If the user started it, leave it running.

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
- `e2e/battery.sh` — 45-step UI battery, first step is the gate login (needs the dev server +
  `agent-browser`; set `GATE_PASSWORD` when the gate is active).
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

## Workflow

Read the relevant docs → make the minimal localized change → add or update colocated tests → run
`bun run check` → verify the UI (`bun run dev`, exercise the flow, keep the console clean) → update the
owning doc(s) and `CHANGELOG.md` → **do not commit**: the user commits and pushes. Commit messages, only
when asked, use Conventional Commits with a bullet body listing each notable change.

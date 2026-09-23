# Testing — Web Video Editor

How the editor is verified. Sibling docs: [docs index](README.md) ·
[architecture.md](architecture.md) · [structure.md](structure.md) · [flows.md](flows.md) ·
[design-system.md](design-system.md) · [deployment.md](deployment.md).

## Commands

```bash
bun run test            # vitest run — single pass (NOT bare `bun test`)
bun run test:watch      # watch mode
bun run test:coverage   # v8 coverage with enforced thresholds
bun run check           # full gate: format:check → lint → typecheck → test → build
```

> Run the suite with `bun run test`, not `bun test`. Bun's own runner ignores `vitest.config.ts`, so
> the `@/` alias, the Node environment, and the coverage settings would not apply.

## Setup

`vitest.config.ts` runs everything in a plain **Node** environment (`environment: 'node'`), maps `@`
to `src`, and includes `src/**/*.test.ts`. Coverage is collected from the pure state modules only —
`commands`, `factories`, `snap`, `time`, `transition`, `tracks`, `timeline-scroll`, `serialization`,
`store`, `persistence`, `workspace`, `menus` — with thresholds **70 % statements / 60 % branches /
75 % functions / 70 % lines**. The access-gate primitives (`src/lib/gate.ts`) are also pure and unit-
tested, but deliberately excluded from coverage thresholds (HMAC timing paths are not worth chasing).

The state core is deliberately browser-free so it can be tested without jsdom. Browser APIs are
isolated in `media/`, `playback/`, and `export/`, which are tested either through the mocked harness
or by static wiring assertions.

## Inventory: 37 files, 488 tests

| File                                 | Tests | Focus                                                                                                                                                                                                                                                              |
| ------------------------------------ | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `commands.test.ts`                   |    34 | every command variant: validation, clamping, track/kind rules, split transitions (forward and reversed span mapping), z-order insertion                                                                                                                            |
| `keyframes.test.ts`                  |    18 | keyframe evaluation (linear interp, constant extension, duplicates), sanitize/clamp, split redistribution                                                                                                                                                          |
| `keyframe-commands.test.ts`          |    21 | setClipKeyframes / setClipSpeed / setClipReverse / animStatics / pan-EQ-compressor commands, split curves, ducking math (hold + clamped release, fractional clip edge)                                                                                             |
| `effect-controls-ui.render.test.tsx` |     7 | jsdom render: inspector tabs, keyframe diamond adds/removes at the playhead, keyframe dot drag = one undo step, A/V twin audio routing, audio clip gets volume + shaping                                                                                           |
| `effect-controls-ui.test.ts`         |    15 | static locks: Effect Controls rows, kf toggle/graph wiring, pan/EQ/compressor/duck, speed + reverse controls, rate stretch, MP4 dialog                                                                                                                             |
| `animation-preview.test.ts`          |     8 | keyframed opacity/position/scale evaluation, buildFilter stack (neutral elision, exposure gamma), speed-aware source time                                                                                                                                          |
| `offline-plan.test.ts`               |    30 | export frame quantization, draw plan (speed/reverse mirror/color/transform/crossfade), reversed source reads, gain + crossfade schedules, text draws, decoded-frame release                                                                                        |
| `clip-gesture.test.ts`               |    32 | pure gesture decisions: lane drop compatibility, move/trim clamping, snap edge choice, partner shifts, rate-stretch span math                                                                                                                                      |
| `timeline-panel-ui.test.tsx`         |     6 | first React-render tests (jsdom): lanes + clip markup render, drag commit = one undo entry, cancel leaves no history                                                                                                                                               |
| `context-menu-ui.render.test.tsx`    |     3 | jsdom render: the right-button release that opened a context menu does not activate the item under the cursor; real clicks still select                                                                                                                            |
| `docs-drift.test.ts`                 |     3 | locks doc test-count claims (README, testing, structure, AGENTS) to the real suite so counts cannot rot                                                                                                                                                            |
| `av-links.test.ts`                   |    32 | `hasAudio`, pair placement, group selection/audible routing, group delete/split/duplicate/unlink                                                                                                                                                                   |
| `compositing-ui.test.ts`             |    34 | static wiring locks across timeline/preview/clipboard/keyboard/link UI, plus the track menu and clip-drag plumbing                                                                                                                                                 |
| `gate.test.ts`                       |    24 | session sign/verify/expiry/tamper, key derivation (both-materials, rotation), env resolution + init caching, throttle ramp, proxy exact-path lock                                                                                                                  |
| `menus.test.ts`                      |    21 | menu structure, no duplicate ids, state resolution, shortcut wiring                                                                                                                                                                                                |
| `playback-core.mocked.test.ts`       |    25 | audio-graph wiring, drift correction, gain×mute×crossfade, shadowing, seek/step, shaping-chain rebuild, mid-playback rate, seek-starvation guard (no interrupting a pending seek), missing-asset skip in playback and still-frame paths + relink recovery, dispose |
| `workspace.test.ts`                  |    16 | layout sanitize/clamp/defaults/round-trip and corrupt-JSON handling                                                                                                                                                                                                |
| `store.test.ts`                      |    16 | history, transient lifecycle, multi-selection, active tool, dangling-id filtering, empty-track prune                                                                                                                                                               |
| `serialization.test.ts`              |    15 | `.veproj.json` round-trips, missing media, clamping, link/opacity/order and 0.5.0 re-timing/shaping/keyframe persistence                                                                                                                                           |
| `clipboard.test.ts`                  |     9 | copy/cut/paste, per-group re-linking, order independence                                                                                                                                                                                                           |
| `clip-media-pool.mocked.test.ts`     |     9 | per-clip element identity, relink recreation, source-node cache, lifecycle                                                                                                                                                                                         |
| `media-pool.test.ts`                 |    24 | sample load plan (fresh adds, offline relinks), duplicate guard, relink patch (source file handle) + static locks: shared project-open coordinator, single-flight, project binding, media bin / panel shell                                                        |
| `offline.test.ts`                    |     7 | offline-media detection per frame (names, A/V dedup, gaps, text/dangling clips) + monitor overlay wiring                                                                                                                                                           |
| `snap.test.ts`                       |     8 | snap points, edge selection, thresholds                                                                                                                                                                                                                            |
| `compositor.mocked.test.ts`          |     8 | black background, contain-fit, letterbox maths, scale-from-center, z-order, alphas, text                                                                                                                                                                           |
| `timeline-layers.test.ts`            |     7 | static locks for the timeline z-scale (playhead, headers, ruler, guide)                                                                                                                                                                                            |
| `transition.test.ts`                 |     7 | crossfade span + complementary alpha maths                                                                                                                                                                                                                         |
| `timeline-drop.test.ts`              |     6 | drop-target geometry (lane vs insert edge vs append)                                                                                                                                                                                                               |
| `tracks.test.ts`                     |     6 | empty-track prune: what it removes, what it keeps, and the last-track floor                                                                                                                                                                                        |
| `timeline-scroll.test.ts`            |     6 | drag auto-scroll ramp: edge bands, depth, direction, zero outside the band                                                                                                                                                                                         |
| `actions.test.ts`                    |     5 | multi-command actions: exact-index insertion, group operations                                                                                                                                                                                                     |
| `text-box.test.ts`                   |     5 | text-box geometry vs a fake `measureText` (align, anchor, clamp)                                                                                                                                                                                                   |
| `persistence.test.ts`                |     5 | autosave debounce, validity, clear/restore                                                                                                                                                                                                                         |
| `time.test.ts`                       |     5 | clamp, time/timecode formatting, frame stepping, ruler steps                                                                                                                                                                                                       |
| `preview-layout.test.ts`             |     4 | static locks for the preview panel's flex/transport layout                                                                                                                                                                                                         |
| `clip-opacity.mocked.test.ts`        |     4 | opacity folded into compositor alphas and crossfade stacking                                                                                                                                                                                                       |
| `theme.test.ts`                      |     3 | static locks: `<html class="dark">`, `color-scheme: dark`, no white portal surfaces                                                                                                                                                                                |

## Mocked browser harness

`src/lib/editor/__tests__/mocks/browser-mocks.ts` installs deterministic stand-ins for the browser
APIs the engine depends on (the MediaRecorder fakes left with the retired WebM exporter in 0.5.0):

- `FakeAudioContext` with a controllable clock and a recorded gain graph (reverse edges included), plus biquad / compressor / stereo-panner nodes that record the parameters the shaping chain sets
- `HTMLMediaElement` state machines (play/pause/paused/currentTime + `seeked` dispatch)
- a recording fake `CanvasRenderingContext2D` proxy
- `FakeMediaStream` + `FakeMediaStreamAudioDestinationNode` for the audio graph
- `ResizeObserver` no-op (Radix primitives measure via it and jsdom has none)
- a manual `requestAnimationFrame` pump, plus `installBrowserMocks` / `uninstall`

Suites using the harness are named `*.mocked.test.ts`. This harness has already paid for itself: it
caught a real export-cancel deadlock (the recorder kept recording and the poll interval leaked) that
the browser tests missed — see the entry in [CHANGELOG.md](../CHANGELOG.md).

## Static wiring locks

Some guarantees are about code shape rather than runtime behavior — CSS z-index order, a Tailwind
class contract (a `@container` query where a `sm:` viewport query would clip the transport), or a
component being mounted in a flex container. Those are asserted by reading the source or the
component's rendered output directly.
`compositing-ui.test.ts`, `timeline-layers.test.ts`, `preview-layout.test.ts`, and `theme.test.ts` are
the static-lock suites; each assertion carries a comment explaining the regression it prevents.

## Conventions

- **A regression test must fail on the unfixed code before it counts as proof.** Write it against the
  broken behavior first, watch it fail, then fix.
- Unit tests build docs through the `factories` constructors; commands validate and throw
  `EditorCommandError` on bad input.
- Keep the state core testable in Node — do not import browser globals into `src/lib/editor/` outside
  `media/`, `playback/`, and `export/`.
- When you add a test file or change the totals, update this table and the test-count references in
  the [README](../README.md).

## End-to-end battery

`e2e/battery.sh` drives the real UI through every product feature in 29 steps (import, quick-add,
playback + compositing, split/undo/redo, trim, crossfade, text, audio, menus, panels, autosave/save,
export at 1080p, settings, and a zero-console-error check). It was built for A/B verification of the
mocked harness against real browser APIs and still runs as a smoke test:

```bash
BASE_URL=http://localhost:3000 OUT=results.txt bash e2e/battery.sh
```

It needs the dev server running and `agent-browser` on `PATH`. Results are written as `PASS`/`FAIL`
lines so two runs can be diffed. `results*.txt` is gitignored.

Clicks are dispatched at an element's screen coordinates, and both the Inspector and the timeline are
scroll areas shorter than their content. A control can therefore be listed in the a11y snapshot and
still be below the fold, where a blind click lands on whatever is painted at that point (the Timeline
header, or the app footer) instead of the control — which is how `f03 crossfade` and both `f05` audio
steps used to fail on a short viewport. Every step scrolls its target into view first (`insp()` for
Inspector controls, `click_clip()` / `delete_clip()` for clips), which keeps results independent of the
window height. **When you add a step that clicks or fills an element, scroll it into view first.**

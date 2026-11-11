# videoh

A browser-based multi-track video editor. It runs entirely in the tab: no media uploads, no account,
and no project database. Your footage stays on your machine. Object URLs, canvas compositing, Web
Audio, and WebCodecs do the work.

Live site: <https://videoh.vercel.app>. Source: <https://github.com/zeal422/videoh>. License: [MIT](LICENSE).

The public site is at `/`; the editor is at `/editor`. The project is still pre-1.0, not a Premiere
replacement. The core path works end to end: import, cut, preview, and export an MP4.
[ROADMAP.md](ROADMAP.md) tracks the remaining gaps.

Built with Next.js 16, React 19, TypeScript, zustand 5, Tailwind CSS 4, shadcn/ui, and Vitest.

## Features

- **Media, filmstrips, and proxies.** Import video, audio, and images through the bin or drag and
  drop. The app probes duration and size, makes thumbnails, normalizes waveform peaks, and detects
  audio. Video clips draw sampled source frames for the visible span at layout density, reuse
  per-asset source-time frames across a split, and show per-clip plus timeline-header progress on
  long strips; a source over 1920px can build a session-only proxy, and export always reads the
  original.
- **Timeline and tracks.** Move a selection across compatible lanes, trim, split, duplicate, delete,
  snap, and drag to scroll. Drop into a same-kind gap or past the dragged kind's outer edge to create
  a layer at that z-position; other gaps move to the nearest compatible lane, or to the outer edge
  when none exists. Place, Insert, and Overwrite set how a mid-lane drop lands. Audio tracks append
  below and video tracks prepend above; lanes rename, mute, solo, lock, and delete from their headers;
  auto names renumber while custom names stay; the last lane is protected, and an emptied lane is
  pruned with the edit.
- **Editing, links, and markers.** Selection, Razor, Ripple Trim, Slip, and Pen, plus multi-select,
  marquee, track targeting, and ripple delete. A video with audio lands as a linked pair; compound
  clips fold a selection into a reusable nested sequence. The Source monitor marks In/Out for
  insert or overwrite, and sequence and clip markers carry names, eight colors, notes, and snapping.
- **Text and captions.** Styled text clips with built-in and saved presets, direct dragging in the
  monitor, SRT import, and an editable Captions panel with SRT/VTT download; captions burn into the MP4.
- **Effects, keyframes, and color.** Cross-dissolve, dip to black, wipe, slide, and push transitions;
  opacity, sixteen blend modes, crop, chroma key, track mattes, motion blur, per-segment bezier
  easing, color grading, monitor scopes, and a project-level 1D/3D `.cube` LUT library. Preview and
  export render every effect the same way.
- **Speed, remapping, and audio.** 0.25x to 4x, Alt-drag rate stretch, reverse, and a `timeScale`
  curve that ramps speed without changing timeline length. Per-clip gain, mute, pan, 3-band EQ,
  compressor, broadband denoise, volume automation, auto-ducking, and track solo/mute.
- **Playback and export.** An audio-clock-driven preview with a per-clip media pool and drift
  correction. Paused scrubbing uses WebCodecs and keeps the last good frame, falling back to the
  `<video>` element when a source has no usable sink. Offline MP4 export is frame-accurate H.264 with
  AAC, or Opus where AAC is unavailable,
  with progress, cancel, an in-dialog preview, and streamed export to disk.
- **Workspace and persistence.** Six resizable panels, a Premiere-style menu bar, appearance
  palettes, whole-document undo/redo, `.veproj.json` save/open, and autosave with restore.

The interaction contract behind each item is in [docs/flows.md](docs/flows.md).

## Quick start

```bash
bun install
bun run dev
```

Open <http://localhost:3000/editor>. Import video, audio, or image files with the **Import**
button (or drag them onto the media bin), then quick-add them with the `+` button on each asset.

Use a current Chromium-based browser for the full feature set. Export also needs WebCodecs:
Chromium, Edge, Firefox 130+, or Safari 26+. The WebCodecs scrub preview targets Chrome and modern
Firefox 130+; older browsers keep the `<video>` fallback.

### Keyboard shortcuts

The map follows Adobe Premiere Pro's default keybindings, checked against Adobe's shortcut docs.
Where the browser cannot map a shortcut 1:1, the app-specific extension is marked.

| Key                        | Action                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| `V` / `C`                  | Selection tool / Razor tool (click a clip to cut it)               |
| `B` / `Y`                  | Ripple trim tool (one track) / Slip tool                           |
| `P`                        | Pen tool: keyframes on the selected clip                           |
| `Space`                    | Play / pause (a focused button owns Space)                         |
| `J` / `K` / `L`            | Shuttle stop / stop / play (no reverse playback in the browser)    |
| `←` / `→`                  | Step 1 frame (`Shift`: 5 frames)                                   |
| `↑` / `↓`                  | Previous / next edit point (clip boundary)                         |
| `Home` / `End`             | Jump to start / end of timeline                                    |
| `S`                        | Toggle snapping                                                    |
| `Ctrl+K`                   | Add Edit: split selection (or all tracks) at the playhead          |
| `Delete` / `Backspace`     | Delete the selection (whole link groups)                           |
| `Shift+Delete`             | Ripple delete: delete and close the gap                            |
| `Ctrl+X` / `Ctrl+C`        | Cut (copy + delete) / copy the selection (multi-clip aware)        |
| `Ctrl+V`                   | Paste the clipboard at the playhead                                |
| `Ctrl+A` / `Ctrl+Shift+A`  | Select all / deselect all                                          |
| `Shift+click`              | Add a clip's link group to the selection (multi-select)            |
| `Ctrl+click`               | Toggle a clip's link group in the selection                        |
| `Ctrl+L`                   | Link the selection, or unlink when it is already linked            |
| `D` / `Ctrl+Shift+/`       | Duplicate the selection (link group)                               |
| `M`                        | Add a marker at the playhead (clip marker when a clip is selected) |
| `Shift+M` / `Ctrl+Shift+M` | Go to next / previous marker                                       |
| `Shift+E`                  | Mute / unmute the selected clip's audio side                       |
| `I` / `O`                  | Mark source In / Out at the source monitor's playhead              |
| `,` / `.`                  | Insert / overwrite the marked source (whole asset when unmarked)   |
| `G`                        | Audio Gain dialog                                                  |
| `T`                        | Add a text clip at the playhead (Premiere Type tool)               |
| `Ctrl+Z` / `Ctrl+Shift+Z`  | Undo / redo                                                        |
| `Ctrl+Y`                   | Redo                                                               |
| `Ctrl+S`                   | Save project JSON                                                  |
| `+` / `-`                  | Zoom timeline in / out                                             |
| `\`                        | Zoom the timeline to fit the whole sequence                        |

Shortcuts are ignored while typing in inputs, textareas, selects, or content-editable elements. A
focused button also owns Space. The full map lives in
[`useEditorKeyboard.ts`](src/hooks/editor/useEditorKeyboard.ts).

## Architecture

The editor has four layers and one strict direction: UI → command → store → view. UI never mutates
state directly; every edit is a named `EditorCommand` through `store.apply(...)`. Commands validate
and clone the document, the store keeps whole-doc snapshots for undo, and the framework-free
`PlaybackCore` reads the current doc through `getDoc()`. The data model, command catalog, and module
reference are in [docs/architecture.md](docs/architecture.md); the filesystem map is in
[docs/structure.md](docs/structure.md).

## Data model

The entire edit is one serializable document, `Doc = { project, media }`, and every time value is in
**seconds (floats)**. Timeline position is `clip.start`; a clip ends at `clip.start + clip.duration`.
Source position is `clip.inPoint`; `sourceTimeAt(clip, local)` maps clip-local time to source time,
including reverse mirroring and the `timeScale` curve integral. `tracks[0]` is the topmost layer, and
the compositor draws last-to-first.

The full `Doc` shape, field ranges, and hydration rules are in
[docs/architecture.md#data-model](docs/architecture.md#data-model).

## Commands

All mutations flow through 60 named commands in `src/lib/editor/commands.ts`, applied with
`applyCommand(doc, command)` or `applyCommands(doc, commands[])`. Each command validates its input
and returns a new doc; the input is never mutated. Undo pushes a whole-`Doc` snapshot before each
committed command, capped at `HISTORY_LIMIT = 100`; a drag commits one entry through the transient
helpers. The full catalog is in
[docs/architecture.md#command-catalog](docs/architecture.md#command-catalog).

## Export and persistence

Export is offline and frame-accurate: `export/offline.ts` builds a pure frame plan, and
`export/mp4.ts` decodes source frames, composites them, mixes audio in an `OfflineAudioContext`, and
encodes H.264 with AAC (Opus where AAC is unavailable). Quality presets set the video bitrate: about
2.5, 6, or 12 Mbps. Export needs WebCodecs; HEVC and ProRes are deliberately not offered, and
`Download` buffers the MP4 while `Export to file` streams it to disk.

Project files use `.veproj.json` (version 4; versions 1 to 3 still load). Object URLs are stripped;
offline assets hydrate as `missing` and relink by matching name or by hand. Autosave writes to
`localStorage` with an 800 ms debounce and offers restore on the next visit. The full contracts are
in [docs/flows.md](docs/flows.md#export) and
[docs/flows.md](docs/flows.md#save-load-autosave-restore).

## Testing

```bash
bun run check          # full gate: format:check → lint → typecheck → test → build
bun run test           # vitest run (single pass)
bun run test:coverage  # v8 coverage + thresholds
bun run battery        # 70-step UI battery (needs agent-browser; reuses :3000 or starts a server)
bun run battery:pair   # dev + artifact concurrently (needs a current build and free :3000/:3100)
```

Current state: **2311 tests across 100 files, all passing**. Coverage is enforced at 70/60/75/70 over
the Node-testable state modules. [docs/testing.md](docs/testing.md) has the inventory, the mocked
browser harness, and the battery details.

## Workspace, site, and license

The workspace has six panels (Media, Source Monitor, Program Monitor, Inspector, Timeline, Captions).
They resize and close. Sizes and visibility persist, each panel header menu and the Window menu close
or restore a panel, and closing the last panel in a row returns its space to the other row. Closing
all six shows a recovery prompt; below 768px the layout falls back to a fixed stacked layout.

The public site is part of the same Next.js app: `/` is the indexable landing page with the angled
timeline hero, feature strip, product showcase, tools band, privacy panel, FAQ, and CTA; `/editor`
is the `noindex, follow` editor, and `/about`, `/privacy`, `/terms`, and `/contact` are public pages.
`/sitemap.xml`, `/robots.txt`, and the Search Console verification file are served from the app and
`public/`. The source is MIT licensed; see [LICENSE](LICENSE) and [CONTRIBUTING.md](CONTRIBUTING.md).
Optional GoatCounter analytics use `NEXT_PUBLIC_GOATCOUNTER_URL`; page views and events are sent as
`sendBeacon` requests with no third-party script, and the footer privacy control opts out through
`skipgc`. See [docs/seo.md](docs/seo.md).

## Project structure

The full filesystem map is in [`docs/structure.md`](docs/structure.md). The core paths:

```text
src/lib/editor/            # state core (commands, store, serialization) + browser-bound media/, playback/, export/
src/components/editor/     # editor UI, including timeline/
src/components/site/       # public header, footer, landing sections, legal shell
src/hooks/editor/          # keyboard map and gesture state
src/lib/editor/__tests__/  # 100 test files (2311 tests) in src/lib/editor/__tests__; mocks/ = browser-mock harness
```

## Known limitations

- **Export requires WebCodecs.** Chromium, Edge, Firefox 130+, and Safari 26+ qualify. ProRes has no
  shipping browser encoder; HEVC is left out on value grounds.
- **Keyframe curves are eased, not overshooting.** There is no Hold interpolation, no spatial
  interpolation for position paths, and adjacent segments do not share a smooth joint.
- **Reverse preview is stepped and markers are editor-only.** The export is frame-accurate, but
  `<video>` cannot play backwards; markers render in the timeline and never affect the export.
- **A 3D LUT grades per pixel in JavaScript**, so a multi-clip 4K timeline with 3D cubes is limited
  by that pass. A 1D cube rides the shared SVG filter chain.
- **Some limits are deliberate.** Noise reduction is broadband only. Plain Delete leaves a gap;
  `Shift+Delete` closes it. Video and audio clips are bounded by their source; images and text are
  unbounded.
- **Offline media is marked.** A frame that needs an offline asset paints an overlay, audio stays
  silent, and export refuses until the asset is relinked.
- **Autosave depends on localStorage quota.** Large projects can exceed it.

[ROADMAP.md](ROADMAP.md) has the full Premiere gap analysis and the items deliberately left out.
The full documentation set is indexed at [docs/README.md](docs/README.md).

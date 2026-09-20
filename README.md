# Web Video Editor

A browser-based multi-track video editor MVP — a minimal Premiere Pro / CapCut-style editing experience that runs entirely client-side. Import media, arrange clips on a timeline, add cross-dissolves and text overlays, mix audio, preview in real time, and export to WebM. No uploads and no server-side processing: object URLs, canvas compositing, Web Audio, and MediaRecorder do all of the work in the tab.

Built with Next.js 16, React 19, TypeScript, zustand 5, Tailwind CSS 4 + shadcn/ui, and Vitest.

## Features

- **Media import** — video, audio, and image files via the media bin (multi-select) or drag-and-drop; automatic duration/size probing, JPEG thumbnails, normalized waveform peaks, and audio-track detection.
- **Multi-track timeline** — move clips (including across compatible tracks, with the whole selection following), trim either edge, split at the playhead, duplicate, delete, and snapping to clip edges, the playhead, and timeline bounds. Add video/audio/text tracks from the `+` button in the timeline's corner cell (or the toolbar `+` and the menus) — new tracks stack per the convention text → video → audio, and `tracks[0]` renders on top.
- **Manageable layers** — each track header has a context menu (or double-click the name) to **rename**, **mute** or **delete** the layer; delete is disabled for the last remaining lane. A layer the edit leaves **empty is removed with it**, in the same undo step, so a lane never lingers with nothing on it (a lane that was already empty is kept, which is what makes "add a layer, then fill it" work). Dragging a clip near the top or bottom edge of the tracks **scrolls the timeline** so it can reach a lane that is off-screen, and dropping it on a lane of the wrong kind marks that lane, and the drop is rolled back whole — the clip returns to where it started rather than keeping the part of the gesture that happened to be legal.
- **Multi-selection + manual A/V linking** — plain click selects a clip (its link group), **Shift+click adds** another clip's group, **Ctrl+click toggles** it, **Ctrl+A** selects everything; every group op (move, delete, cut/copy/paste, split, duplicate) acts on the whole selection. Select a video clip and an audio clip with Shift+click, then **right-click → Link** (or `Ctrl+L`) to bond them Premiere-style; `Ctrl+L` on a linked selection unlinks it again. A **Razor tool** (`C`) cuts a clip exactly where you click; **Shift+Delete ripple-deletes** the selection and closes the gap.
- **A/V linked clips** — dropping a video that HAS audio places it as a linked pair: the video part on the video track and an audio-only twin on the audio track (waveform included). The pair selects, moves, splits, duplicates and deletes together, and the audio twin is the sole sound carrier (no double audio). **Right-click any clip** for the Premiere-style menu — Cut, Copy, Paste at playhead, Split, Duplicate, **Link / Unlink Audio/Video**, Delete, **Ripple Delete** — and after unlinking, each half is fully independent.
- **Drop-between-tracks** — drag media from the bin onto the middle of a row to drop it onto that track, or onto a row's edge (or the empty strip below the tracks) to insert a brand-new layer at exactly that z-position: a kind-colored insertion line with a `+ V2` / `+ A2` preview shows where the layer will land — the Premiere-style way to build stacked compositions (put one video above/below/between others in one gesture).
- **Cross-dissolve transitions** — per-clip `transitionOut` with real overlap; the compositor and audio mixer both ramp.
- **Text overlays** — text tracks and clips with font size, color, family, bold/italic, alignment, position, and shadow. **Drag the text directly in the program monitor** to reposition it (a dashed outline shows the box; one drag = one undo step; precise control stays in the Inspector's Position X/Y sliders).
- **Layer compositing** — per-clip **opacity** (0–100 %) that stacks with crossfade alphas: put a clip on a higher track, lower its opacity, and the track below shows through — the same model as Photoshop/Premiere layering.
- **Audio control** — per-clip linear gain (0–2) and mute, per-track mute, waveforms drawn on audio-bearing clips.
- **Synced preview playback** — audio-clock-driven master clock, per-clip media element pool, canvas compositor, drift correction.
- **WebM export** — MediaRecorder real-time capture with low/medium/high quality presets, progress, cancel, and in-dialog preview.
- **Undo/redo** — up to 100 steps of whole-document snapshots; drag gestures collapse into a single undo entry.
- **Save/load project JSON** — `.veproj.json` files; media references survive, object URLs do not.
- **Autosave/restore** — debounced localStorage writes with a restore-or-discard banner on the next visit.
- **Premiere-style menu bar** — File · Edit · Clip · Sequence · Graphics · View · Window · Help, driven by a pure, unit-tested menu model; items whose preconditions are unmet render disabled (no dead entries).
- **Resizable workspace** — every panel (Media, Program Monitor, Inspector, Timeline) is user-resizable and collapsible; sizes, collapsed strips, and panel visibility persist across sessions. Window menu toggles panels, double-click a resize handle to reset its neighbor, and small screens fall back to a fixed stacked layout.

## Quick start

```bash
bun install
bun run dev
```

Open <http://localhost:3000> (or the preview URL shown by your workspace). For an instant demo, click **Load sample media** in the media bin — it imports the bundled samples from `public/samples/` (`sample-video.mp4`, `sample-audio.mp3`, `sample-image.png`) — then quick-add them to the timeline with the `+` button on each asset.

Use a current Chromium-based browser for the full feature set (MediaRecorder + Web Audio + canvas capture streams).

### Keyboard shortcuts

The map mirrors Adobe Premiere Pro's default keybindings (verified against Adobe's shortcut docs); app-specific extensions where the browser MVP cannot map 1:1 are marked.

| Key                       | Action                                                          |
| ------------------------- | --------------------------------------------------------------- |
| `V` / `C`                 | Selection tool / Razor tool (click a clip to cut it)            |
| `Space`                   | Play / pause                                                    |
| `J` / `K` / `L`           | Shuttle stop / stop / play (no reverse playback in the browser) |
| `←` / `→`                 | Step 1 frame (`Shift`: 5 frames)                                |
| `↑` / `↓`                 | Previous / next edit point (clip boundary)                      |
| `Home` / `End`            | Jump to start / end of timeline                                 |
| `S`                       | Toggle snapping                                                 |
| `Ctrl+K`                  | Add Edit — split selection (or all tracks) at the playhead      |
| `Delete` / `Backspace`    | Delete the selection (whole link groups)                        |
| `Shift+Delete`            | Ripple delete — delete AND close the gap                        |
| `Ctrl+X` / `Ctrl+C`       | Cut (copy + delete) / copy the selection (multi-clip aware)     |
| `Ctrl+V`                  | Paste the clipboard at the playhead                             |
| `Ctrl+A` / `Ctrl+Shift+A` | Select all / deselect all                                       |
| `Shift+click`             | Add a clip's link group to the selection (multi-select)         |
| `Ctrl+click`              | Toggle a clip's link group in the selection                     |
| `Ctrl+L`                  | Link the selection — or unlink when it is already linked        |
| `D` / `Ctrl+Shift+/`      | Duplicate the selection (link group)                            |
| `M`                       | Mute / unmute the selected clip's audio side                    |
| `G`                       | Audio Gain dialog                                               |
| `T`                       | Add a text clip at the playhead (Premiere Type tool)            |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo                                                     |
| `Ctrl+Y`                  | Redo                                                            |
| `Ctrl+S`                  | Save project JSON                                               |
| `+` / `-`                 | Zoom timeline in / out                                          |
| `\`                       | Zoom the timeline to fit the whole sequence                     |

Shortcuts are ignored while typing in inputs, textareas, selects, or content-editable elements (see `src/hooks/editor/useEditorKeyboard.ts`).

## Architecture

The editor is split into four layers with a strict unidirectional data flow: **UI → command → store (snapshot history) → view**.

```text
┌──────────────────────────────────────────────────────────────┐
│ ui/  (src/components/editor, src/hooks/editor)               │
│   Toolbar · MediaBin · PreviewPanel · InspectorPanel ·       │
│   StatusBar · ExportDialog · EditorShell ·                   │
│   timeline/ (TimelinePanel, Ruler, ClipView, Waveform) ·     │
│   useEditorKeyboard                                          │
└───────────────┬──────────────────────────────▲───────────────┘
                │ EditorCommand                │ doc, selection,
                │ (store.apply / transients)   │ playhead, zoom
                ▼                              │
┌──────────────────────────────────────────────┴───────────────┐
│ state/  (src/lib/editor)                                     │
│   store.ts  — zustand store, whole-Doc snapshot history      │
│   commands.ts — validate + clone + apply (the only mutator)  │
│   types · factories · time · snap · transition ·             │
│   serialization · persistence · actions                      │
└───────────────┬──────────────────────────────────────────────┘
                │ getDoc() each frame / prepare()
                ▼
┌──────────────────────────────┐   ┌────────────────────────────┐
│ engine/playback              │   │ engine/export              │
│   core.ts (PlaybackCore)     │   │   exporter.ts              │
│   compositor.ts · preview.ts │   │   (MediaRecorder capture   │
│   engine-ref.ts · media/*    │   │    of a dedicated core)    │
└──────────────────────────────┘   └────────────────────────────┘
```

- **UI** never mutates state directly. Every edit is a named `EditorCommand` dispatched via `store.apply(...)` (or as transient updates during drags).
- **Commands** validate input, clone the document, and return a new `Doc`. The store keeps a snapshot of the previous doc for undo.
- **The store** is the single source of truth. React components subscribe to slices of it; the playback engine reads the current doc via a `getDoc()` callback and reports the playhead back through the store, which flows to the views.
- **The engine** is framework-free: `PlaybackCore` owns the audio clock, the media element pool, the Web Audio graph, and canvas rendering. Export reuses the same core on an offscreen canvas.

A deeper module-by-module reference lives in [`docs/architecture.md`](docs/architecture.md). The whole documentation set — architecture, structure, flows, testing, and design system — is indexed at [`docs/README.md`](docs/README.md).

## Data model

The entire edit is one serializable document (`Doc = { project, media }`). All time values are **seconds (floats)**.

```jsonc
{
  "project": {
    "id": "proj_…",
    "name": "Untitled Project",
    "width": 1920, // 64..3840
    "height": 1080, // 64..2160
    "fps": 30, // 1..60
    "tracks": [
      {
        "id": "track_…",
        "kind": "video", // "video" | "audio" | "text"
        "name": "V1",
        "muted": false,
        "clips": [
          {
            "id": "clip_…",
            "mediaId": "media_…", // absent for text clips
            "linkId": "link_…", // A/V link group — shared by the pair's video part and audio twin
            "audioOnly": false, // true for the audio part of an A/V pair (sound, no picture)
            "start": 0, // timeline position (s)
            "duration": 4, // timeline length (s)
            "inPoint": 0, // source offset (s)
            "gain": 1, // 0..2, optional
            "muted": false,
            "opacity": 1, // 0..1 visual opacity, optional (default 1)
            "text": "Your text here", // text clips only
            "style": { "fontSize": 64, "color": "#ffffff", "…": "…" },
            "transitionOut": { "type": "crossfade", "duration": 1 },
          },
        ],
      },
    ],
  },
  "media": [
    {
      "id": "media_…",
      "name": "sample-video.mp4",
      "kind": "video", // "video" | "audio" | "image"
      "duration": 6, // images report 0 (unbounded length)
      "width": 640,
      "height": 360,
      "url": "blob:…", // object URL — NEVER serialized
      "thumbnail": "data:image/jpeg…", // optional
      "waveformPeaks": [0, 0.42, "…"], // optional, 1000 buckets 0..1
      "missing": false, // true after loading a project until relinked
    },
  ],
}
```

Time model conventions:

- **Timeline position** is `clip.start + clip.duration` (absolute seconds from the timeline origin).
- **Source position** is `clip.inPoint` — where playback starts inside the source media. A trimmed clip keeps `duration` on the timeline but moves `inPoint`; `inPoint + duration` never exceeds the source length for video/audio (images and text are unbounded).
- **Track order is compositing z-order**: `tracks[0]` is the _topmost_ layer. The default project is `V1` (video) over `A1` (audio) at **1920×1080 (Full HD) @ 30fps**; new tracks are conventionally ordered text, then video, then audio. Dropping media between tracks (`addTrack` with `atIndex`) places the layer at the exact z-position the user pointed at — explicit placement skips the convention sort, and any order is legal (e.g. an audio layer between two video layers) because the array order is what renders.
- Compatibility rules: video/image material goes on `video` tracks, audio on `audio` tracks, text clips on `text` tracks.

## Command pattern

All mutations flow through 22 named commands in `src/lib/editor/commands.ts`, applied with `applyCommand(doc, command)` / `applyCommands(doc, commands[])`. Each command validates its input (throwing `EditorCommandError` on unknown ids, out-of-bounds trims, and so on) and returns a **new** doc — the input is never mutated.

| Command              | Description                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addMediaAsset`      | Register an imported media asset in the bin.                                                                                                             |
| `removeMediaAsset`   | Remove an asset; clips keep a dangling `mediaId`.                                                                                                        |
| `relinkMedia`        | Patch an asset (usually a fresh `url`) and clear `missing`.                                                                                              |
| `addTrack`           | Append a track and re-sort to the text/video/audio order — or, with `atIndex`, insert at that exact z-position without re-sorting (drop-between-tracks). |
| `removeTrack`        | Remove a track (the last remaining track is protected).                                                                                                  |
| `renameTrack`        | Rename a track (empty names are ignored).                                                                                                                |
| `toggleTrackMute`    | Flip a track's `muted` flag.                                                                                                                             |
| `addClip`            | Add a clip to a track (kind-checked, clamped to source).                                                                                                 |
| `moveClip`           | Move a clip to a new track and/or `start` position.                                                                                                      |
| `trimClip`           | Set `start`, `inPoint`, and `duration` (bounds-checked).                                                                                                 |
| `splitClip`          | Split a clip at a time into two adjacent clips; the right half starts a fresh link group (the group-split action re-links the right halves together).    |
| `deleteClip`         | Remove a clip from its track.                                                                                                                            |
| `unlinkClip`         | Break the A/V link bond on every member of the group.                                                                                                    |
| `linkClips`          | Bond 2+ selected clips into ONE link group (merge-safe: groups that extend beyond the selection merge whole).                                            |
| `setClipGain`        | Set linear gain, clamped to `GAIN_MIN..GAIN_MAX`.                                                                                                        |
| `setClipMuted`       | Set a clip's `muted` flag.                                                                                                                               |
| `setClipOpacity`     | Set visual opacity, clamped to `OPACITY_MIN..OPACITY_MAX`; omitted at 1 when saved.                                                                      |
| `setTextContent`     | Change a text clip's content.                                                                                                                            |
| `setTextStyle`       | Merge a partial `TextStyle` into a text clip.                                                                                                            |
| `addTransition`      | Add a crossfade by pulling the next clip left to overlap.                                                                                                |
| `removeTransition`   | Clear a clip's `transitionOut` (the overlap remains).                                                                                                    |
| `setProjectSettings` | Patch project name/width/height/fps (clamped).                                                                                                           |

**Undo/redo.** The store pushes a whole-`Doc` snapshot onto `past` before each committed command; `undo` pops it and moves the current doc to `future`. Doc JSON is small (kilobytes), so full snapshots are cheap and make every command trivially reversible. The stack is capped at `HISTORY_LIMIT = 100` entries, and undo/redo drop the selection if the clip no longer exists in the restored doc.

**Transient gestures.** Timeline drags must not spam the history. A gesture calls `beginTransient()` (snapshot the base doc), applies every pointermove via `applyTransient()` (no history; invalid mid-drag states are swallowed), and finishes with `commitTransient()` — which pushes exactly one history entry if the doc actually changed — or `cancelTransient()` to restore the base. Result: one undo step per drag, regardless of how many frames it spanned.

## Playback engine

`PlaybackCore` (`src/lib/editor/playback/core.ts`) drives both preview and export:

- **Master clock** — the `AudioContext` clock when Web Audio is available (sample-accurate and drift-free); otherwise `performance.now()`. On `play()` the timeline time is anchored to the clock, and each `requestAnimationFrame` derives the playhead from the elapsed audio time.
- **Per-clip media pool** — `ClipMediaPool` gives every clip its own `HTMLVideoElement`/`HTMLAudioElement` parked in a hidden container, so two clips can reference the same asset simultaneously (after a split or across tracks).
- **Drift correction** — every frame the engine compares each active element's `currentTime` with the expected source time (`inPoint + (t - start)`); drift over 120 ms triggers a resync seek.
- **Web Audio graph** — each element feeds a `MediaElementAudioSourceNode` into a per-clip `GainNode`, all connected to a master `GainNode` that routes to both `audio.destination` (speakers) and a `MediaStreamAudioDestinationNode` (export tap). Per-frame gain is `clip.gain × clip mute × track mute × crossfade alpha`, applied with a 20 ms ramp. Without Web Audio the engine falls back to element `volume`.
- **Compositor rules** (`compositor.ts`) — tracks composite bottom→top onto a black frame; video/image clips are drawn contain-fit (letterboxed, aspect preserved); text clips render styled, shadowed multi-line text; two overlapping clips crossfade with complementary alphas, otherwise the later clip simply wins visually; audio tracks draw nothing.
- **Scrubbing** — while paused, `seek()` positions active video elements and re-draws once their `seeked` event lands (`drawStill`).

## Export

`exportTimeline` (`src/lib/editor/export/exporter.ts`) renders the timeline to a downloadable file:

- Runs a **dedicated `PlaybackCore`** on an offscreen canvas sized to the project, so the preview stays free.
- **Video** comes from `canvas.captureStream(fps)`; **audio** is tapped from the core's `MediaStreamAudioDestinationNode`.
- **MediaRecorder** encodes WebM — `vp9,opus` preferred, falling back to `vp8,opus`, then generic `video/webm`, then `video/mp4` if the browser offers it.
- **Quality presets** set the video bitrate: low ≈ 2.5 Mbps, medium ≈ 6 Mbps, high ≈ 12 Mbps.
- The dialog shows progress, supports cancel, previews the result inline, and downloads `<project name>.webm`.

Known limitations:

- **Export runs at 1× playback speed** — a 60-second timeline takes about 60 seconds; keep the tab focused (background tabs throttle `requestAnimationFrame`).
- **Chrome omits the `Duration` header in MediaRecorder-produced WebM files.** The file plays correctly everywhere, but some players show an unknown duration until they finish buffering. This is a browser limitation, not a corrupt file; a WebCodecs-based offline exporter is the planned fix.

## Persistence

- **Project files** use the `.veproj.json` format (`version: 1`, plus a `savedAt` timestamp; see `serialization.ts`). `serializeDoc` strips object URLs — they are session-bound and can never persist.
- **Loading** hydrates every asset with an empty `url` and `missing: true`; clips whose media vanished entirely lose their `mediaId`. Offline assets render as "offline" in the media bin, and missing video shows black in the preview until relinked. Relinking is automatic when you re-import a file with a matching name, or manual via the relink button on each offline asset.
- **Autosave** writes the serialized doc to `localStorage` (key `web-video-editor:autosave:v1`) with an **800 ms debounce**, after every committed change — transient drag frames are skipped, and the final commit triggers exactly one save. Quota or serialization errors surface in the status bar ("Autosave off").
- **Restore** — on startup a valid autosave raises a banner: _Restore_ replaces the current doc (pushing the empty starter doc onto the undo stack) or _Discard_ clears the entry.

## Testing

```bash
bun run check          # full gate: format:check → lint → typecheck → test → build
bun run test           # vitest run (single pass)
bun run test:watch     # watch mode
bun run test:coverage  # v8 coverage + thresholds
bun run typecheck      # tsc --noEmit
bun run lint           # eslint
bun run format:check   # prettier check
```

The state core is deliberately pure, so it is tested in a plain Node environment (no browser needed): `commands` (validation, splitting, transitions), `store` (history, transient gestures), `snap`, `transition` (span/alpha math), `serialization` (round-trips, missing media), `persistence` (debounce, validity), `time` helpers, plus `menus` (menu structure + state resolution) and `workspace` (layout state, sanitization, persistence).

Current state: **293 tests across 26 files, all passing**. Coverage is enforced at 70/60/75/70 (statements/branches/functions/lines) over the pure state modules, and `menus.ts` and `workspace.ts` are at 100% across all metrics. [docs/testing.md](docs/testing.md) has the file-by-file inventory, the mocked browser harness, and the E2E battery.

## Menu bar and workspace

### Menu bar

The top menu bar mirrors Adobe Premiere Pro's menu structure (File · Edit · Clip · Sequence · Graphics · View · Window · Help), adapted to the features this editor has. Two design rules keep it honest:

- **No dead items.** Every visible entry maps to a real action (`src/lib/editor/menus.ts` defines the structure; `MenuBar.tsx` maps action ids to editor operations). Anything the MVP cannot perform is not rendered.
- **No fake shortcuts.** The shortcut column only lists keybindings that are actually wired in `useEditorKeyboard.ts`.

Item availability is computed from the editor context: Undo/Redo follow history depth, clip actions follow selection state (Split requires the playhead inside the selected clip; Mute/Audio Gain require an audio-bearing clip), the Snapping checkbox mirrors the toolbar magnet, and the Window checkboxes mirror panel visibility. The menu model is pure and locked down by `menus.test.ts`.

### Workspace panels

On screens ≥768px the shell is a resizable panel workspace (`react-resizable-panels` via the shadcn Resizable wrappers):

- **Resize** — drag any handle; keyboard resizing works out of the box (focus a handle, use arrow keys). Sizes persist to `localStorage` (debounced while dragging).
- **Collapse** — each panel header has a chevron; dragging a handle past the panel minimum also collapses. A collapsed panel becomes a slim strip with its rotated title — click it to expand again.
- **Show/hide** — the Window menu checkboxes close and reopen panels entirely.
- **Reset** — double-click a resize handle to reset its neighbor to the default size, or use Window › Reset Workspace Layout (enabled whenever the layout deviates from the default).

All layout state lives in `src/lib/editor/workspace.ts` (pure: defaults, clamping, sanitize-corrupt-data, injected storage) behind the `useWorkspaceStore` zustand wrapper, so a corrupt or hand-edited `localStorage` entry can never crash the editor. Below 768px the workspace is replaced by the original fixed stacked layout.

## Project structure

The full filesystem map lives in [`docs/structure.md`](docs/structure.md). High-level outline:

```text
src/
├── lib/editor/                  # state core (pure, unit-tested)
│   ├── types.ts                 # Doc, Project, Track, Clip, MediaAsset, TextStyle…
│   ├── constants.ts             # all tuning constants and limits
│   ├── factories.ts             # uid, create*, docDuration, finders, compatibility
│   ├── time.ts                  # clamp, formatTime(Timecode), frame stepping, rulerStep
│   ├── commands.ts              # 22 command variants, applyCommand(s), validation
│   ├── snap.ts                  # computeSnapPoints, applySnap, snapMove
│   ├── transition.ts            # getTransitionSpan, transitionAlphas, maxTransitionDuration
│   ├── links.ts                 # multi-selection + A/V link-group helpers
│   ├── clipboard.ts             # copy / cut / paste (module memory, outside undo)
│   ├── actions.ts               # multi-command UI actions (add media/text, group ops)
│   ├── menus.ts                 # menu bar model: structure, states, action ids
│   ├── workspace.ts             # panel layout state: bounds, sanitize, persist
│   ├── workspace-store.ts       # zustand wrapper over workspace.ts
│   ├── project-io.ts            # shared save / open / import-media helpers
│   ├── sample-media.ts          # bundled samples + idempotent filtering
│   ├── timeline-drop.ts         # drop-target geometry (drop-between-tracks)
│   ├── tracks.ts                # removes the tracks an edit leaves empty (prune)
│   ├── timeline-scroll.ts       # drag edge auto-scroll geometry (pure)
│   ├── store.ts                 # zustand store: history, transients, selection, playhead
│   ├── serialization.ts         # .veproj.json (v1): serialize/parse/hydrate
│   ├── persistence.ts           # debounced localStorage autosave + restore
│   ├── media/
│   │   ├── probe.ts             # importFile: probe, thumbnail, waveform peaks, hasAudio
│   │   └── elements.ts          # ClipMediaPool (per-clip elements + source nodes)
│   ├── playback/
│   │   ├── core.ts              # PlaybackCore: clock, pool, drift, Web Audio
│   │   ├── compositor.ts        # drawFrame: tracks, contain-fit, text, crossfades, opacity
│   │   ├── preview.ts           # preview engine singleton (attach/detach)
│   │   ├── engine-ref.ts        # PlaybackController ref shared by all UI
│   │   └── text-box.ts          # text-box measurement (preview drag outline)
│   ├── export/
│   │   └── exporter.ts          # MediaRecorder pipeline, downloadBlob
│   └── __tests__/               # 26 test files (293 tests); mocks/ = browser-mock harness
├── components/editor/
│   ├── EditorShell.tsx          # panel workspace layout, autosave lifecycle, restore banner
│   ├── MenuBar.tsx              # Premiere-style menu bar + shortcuts/about/gain dialogs
│   ├── PanelShell.tsx           # resizable/collapsible panel frame (header, strip)
│   ├── Toolbar.tsx              # history, edit tools, tracks, zoom, save/open, export
│   ├── MediaBin.tsx             # import, samples, relink, drag source
│   ├── PreviewPanel.tsx         # program monitor canvas + transport
│   ├── InspectorPanel.tsx       # clip properties / project settings
│   ├── StatusBar.tsx            # pinned footer: project info, autosave state
│   ├── ExportDialog.tsx         # quality, progress, cancel, preview, download
│   └── timeline/
│       ├── TimelinePanel.tsx    # track lanes, playhead, drop targets, zoom, track menu
│       ├── Ruler.tsx            # canvas time ruler + scrubbing
│       ├── ClipView.tsx         # move/trim gestures across lanes, snapping, fade overlays
│       └── Waveform.tsx         # per-clip waveform canvas
└── hooks/editor/
    └── useEditorKeyboard.ts     # global keyboard shortcuts
```

## Known limitations and roadmap

Limitations, all observable in the current code:

- **Selection is id-based** — `store.selections` holds clip ids (primary first); group operations expand A/V link groups, but there is no marquee/box selection on the timeline.
- **MediaRecorder duration quirk** — exported WebM files lack the `Duration` header in Chrome (playback works; metadata is missing).
- **Real-time export** — rendering happens at 1× speed; no offline/faster-than-realtime encode yet.
- **No clip speed/rate control**, no reverse, no keyframes for opacity, gain, or pan; gain is linear 0–2 (+6 dB max).
- **Ripple delete is explicit** — plain Delete leaves the gap; `Shift+Del` closes it. `removeTransition` leaves the overlap behind (harmless: the later clip wins visually).
- **Trim bounds** — video/audio clips are bounded by their source; images and text are unbounded (images have no intrinsic length; they default to 4 s).
- **Missing media is silent** — offline assets render black (video) or nothing (audio) until relinked.
- **Autosave depends on localStorage quota**; large projects with embedded thumbnails/waveforms can exceed it.

Roadmap candidates, roughly in order of impact:

1. WebCodecs-based offline export (fixes both the duration header and 1× render speed).
2. Clip speed/rate and time remapping.
3. More transitions (wipe, slide, dip-to-black) reusing the span/alpha model in `transition.ts`.
4. Keyframed audio gain and opacity, plus per-clip pan.
5. Marquee/box selection and track-level operations.
6. Track grouping and compound clips.

---

For the module-level technical reference — per-file exports, the undo/transient lifecycle, the audio graph, the crossfade model, and the invariant list — see [`docs/architecture.md`](docs/architecture.md). The whole set is indexed at [`docs/README.md`](docs/README.md).

# Web Video Editor

A browser-based multi-track video editor MVP: a minimal Premiere Pro / CapCut-style editing experience that runs entirely client-side. Import media, arrange clips on a timeline, add cross-dissolves and text overlays, animate properties with keyframes, re-time clips, mix and shape audio, preview in real time, and export to MP4. No uploads and no server-side processing: object URLs, canvas compositing, Web Audio, and WebCodecs do all of the work in the tab.

Built with Next.js 16, React 19, TypeScript, zustand 5, Tailwind CSS 4 + shadcn/ui, and Vitest.

## Features

- **Media import** — video, audio, and image files via the media bin (multi-select) or drag-and-drop; automatic duration/size probing, JPEG thumbnails, normalized waveform peaks, and audio-track detection.
- **Multi-track timeline** — move clips (including across compatible tracks, with the whole selection following), trim either edge, split at the playhead, duplicate, delete, and snapping to clip edges, the playhead, and timeline bounds. Add video/audio/text tracks from the `+` button in the timeline's corner cell (or the toolbar `+` and the menus) — new tracks stack per the convention text → video → audio, and `tracks[0]` renders on top.
- **Manageable layers** — each track header has a context menu (or double-click the name) to **rename**, **mute** or **delete** the layer; delete is disabled for the last remaining lane. A layer the edit leaves **empty is removed with it**, in the same undo step, so a lane never lingers with nothing on it (a lane that was already empty is kept, which is what makes "add a layer, then fill it" work). Dragging a clip near the top or bottom edge of the tracks **scrolls the timeline** so it can reach a lane that is off-screen, and dropping it on a lane of the wrong kind marks that lane, and the drop is rolled back whole — the clip returns to where it started rather than keeping the part of the gesture that happened to be legal.
- **Multi-selection + manual A/V linking** — plain click selects a clip (its link group), **Shift+click adds** another clip's group, **Ctrl+click toggles** it, **Ctrl+A** selects everything; every group op (move, delete, cut/copy/paste, split, duplicate) acts on the whole selection. **Drag a box (marquee)** on empty timeline space to select every clip it covers (Shift adds the covered groups, Ctrl toggles them), with edge auto-scroll while dragging. Select a video clip and an audio clip with Shift+click, then **right-click → Link** (or `Ctrl+L`) to bond them Premiere-style; `Ctrl+L` on a linked selection unlinks it again. A **Razor tool** (`C`) cuts a clip exactly where you click; **Shift+Delete ripple-deletes** the selection and closes the gap.
- **Markers** — press `M` to drop a marker at the playhead: on the primary selected clip when one is selected (source-anchored, so trims, speed changes and reversal keep it on the same media frame), otherwise on the sequence ruler. Markers take a name, one of eight colors and notes (double-click one or use Marker › Edit Selected Marker); `Shift+M` / `Ctrl+Shift+M` jump between markers, markers are snap targets for clip drags and trims, and `Delete` removes the selected one. Sequence markers live in `project.markers`, clip markers in `clip.markers` (source seconds); both persist in the project file.
- **A/V linked clips** — dropping a video that HAS audio places it as a linked pair: the video part on the video track and an audio-only twin on the audio track (waveform included). The pair selects, moves, splits, duplicates and deletes together, and the audio twin is the sole sound carrier (no double audio). **Right-click any clip** for the Premiere-style menu — Cut, Copy, Paste at playhead, Split, Duplicate, **Link / Unlink Audio/Video**, Delete, **Ripple Delete** — and after unlinking, each half is fully independent.
- **Drop-between-tracks** — drag media from the bin onto the middle of a row to drop it onto that track, or onto a row's edge (or the empty strip below the tracks) to insert a brand-new layer at exactly that z-position: a kind-colored insertion line with a `+ V2` / `+ A2` preview shows where the layer will land — the Premiere-style way to build stacked compositions (put one video above/below/between others in one gesture).
- **Cross-dissolve transitions** — per-clip `transitionOut` with real overlap; the compositor and audio mixer both ramp.
- **Text overlays** — text tracks and clips with font size, color, family, bold/italic, alignment, position, and shadow. **Drag the text directly in the program monitor** to reposition it (a dashed outline shows the box; one drag = one undo step; precise control stays in the Inspector's Position X/Y sliders).
- **Layer compositing** — per-clip **opacity** (0–100 %) that stacks with crossfade alphas: put a clip on a higher track, lower its opacity, and the track below shows through — the same model as Photoshop/Premiere layering.
- **Keyframes + Effect Controls**: animate opacity, position, scale, volume and the color set (exposure, contrast, saturation, brightness, hue) per clip. The Inspector has a Clip / Effect Controls tab split: a value slider, a keyframe diamond that adds/removes at the playhead, and a light graph whose dots drag in time. Each segment eases with its outgoing keyframe's interpolation (linear, ease in, ease out, ease in/out, Premiere's curves, picked from a segmented control in the graph), that same easing drives the exported gain schedule (an eased volume segment is sampled into short linear ramps, since the Web Audio API has no easing primitive), keyframe times are clip-local, splitting a clip redistributes its curves (every segment subdivides exactly at the cut, eased segments included, so both halves re-time the original), and every keyframe drag is one undo step.
- **Color**: the color set applies through the canvas filter stack in preview and export alike; a neutral clip skips the filter pass entirely. **Temperature/tint** (-100..100 each) grade white balance through one SVG matrix per graded clip that both render paths reference, so what you see is what exports; the monitor can show a **luma histogram + RGB balance** (scopes section, collapsible, off by default).
- **Speed and reverse**: per-clip speed (0.25×–4×) with an Inspector slider and an Alt-drag rate stretch on either clip edge (the source span stays fixed and the speed re-derives; a clip with a time remapping curve is exempt, see below), plus a reverse toggle for video. A rate stretch the command layer rejects applies nothing and says why. Reverse renders frame-accurately in the export and stepped in the preview; reversed audio is dropped. A reversed clip trims from both edges like a forward one (its head shows the span's high source end and its tail the low one, so each edge reveals the source on its own side rather than sliding the picture). Clips carry speed/reverse badges.
- **Time remapping**: a `timeScale` keyframe curve ramps a clip's speed without changing its timeline length (the source time each timeline second consumes is the curve's integral, so cuts, splits and the export's frame count stay put). Eased segments work here too, and the export samples them into the same curve instead of flattening them. The picture-only rows (time remapping, and the reverse switch next to it) are hidden for anything that carries no picture, which includes an A/V pair's audio twin even when it sits on a video track: a ramp there could only mute the pair. On a reversed clip the row mirrors its axis, so a dot marks the rate the engine applies at that timeline time and both the easing picker and the diamond target the keyframe the mirrored playhead sits nearest. A ramped clip plays stepped in the preview, renders frame-accurate in the export, and drops the audio of its whole link group (variable-rate audio has no resampler yet). While a curve exists it IS the rate, so the static Speed slider, the clip's speed badge and Alt-drag rate stretch are disabled (the static speed stays the no-curve fallback).
- **Audio control + shaping**: per-clip linear gain (0–2) and mute, per-track mute, waveforms, plus per-clip pan, a 3-band EQ (200 Hz / 1 kHz / 4 kHz), a compressor, a **Reduce noise** switch (a fixed broadband chain built into the preview mixer and the export mix from one shared builder), and **auto-ducking** that writes volume keyframes for music under dialogue (estimated from the waveform peaks, with a dialogue-source picker).
- **Synced preview playback** — audio-clock-driven master clock, per-clip media element pool, canvas compositor, drift correction.
- **MP4 export via WebCodecs**: offline, frame-accurate H.264 export through a pure frame plan: source frames are decoded (not element-seeked), the animated doc is composited per frame, audio is mixed offline and encoded as AAC (Opus where the browser has no AAC encoder, notably desktop Linux and Firefox), and the result plays with a correct duration header. Wall time tracks decode speed rather than the old realtime capture. Quality presets map to bitrates; progress, cancel, and in-dialog preview included. Needs a WebCodecs-capable browser (Chromium, Edge, Firefox 130+, Safari 26+).
- **Undo/redo** — up to 100 steps of whole-document snapshots; drag gestures collapse into a single undo entry.
- **Save/load project JSON** — `.veproj.json` files; media references survive, object URLs do not.
- **Autosave/restore** — debounced localStorage writes with a restore-or-discard banner on the next visit.
- **Premiere-style menu bar** — File · Edit · Clip · Sequence · Marker · Graphics · View · Window · Help, driven by a pure, unit-tested menu model; items whose preconditions are unmet render disabled (no dead entries).
- **Resizable workspace** — every panel (Media, Program Monitor, Inspector, Timeline) is user-resizable and collapsible; sizes, collapsed strips, and panel visibility persist across sessions. Window menu toggles panels, double-click a resize handle to reset its neighbor, and small screens fall back to a fixed stacked layout.

## Quick start

```bash
bun install
bun run dev
```

Open <http://localhost:3000> (or the preview URL shown by your workspace). For an instant demo, click **Load sample media** in the media bin — it imports the bundled samples from `public/samples/` (`sample-video.mp4`, `sample-audio.mp3`, `sample-image.png`) — then quick-add them to the timeline with the `+` button on each asset.

Use a current Chromium-based browser for the full feature set (WebCodecs + Web Audio + canvas rendering). Export additionally needs WebCodecs (Chromium, Edge, Firefox 130+, Safari 26+).

### Keyboard shortcuts

The map mirrors Adobe Premiere Pro's default keybindings (verified against Adobe's shortcut docs); app-specific extensions where the browser MVP cannot map 1:1 are marked.

| Key                        | Action                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| `V` / `C`                  | Selection tool / Razor tool (click a clip to cut it)               |
| `Space`                    | Play / pause                                                       |
| `J` / `K` / `L`            | Shuttle stop / stop / play (no reverse playback in the browser)    |
| `←` / `→`                  | Step 1 frame (`Shift`: 5 frames)                                   |
| `↑` / `↓`                  | Previous / next edit point (clip boundary)                         |
| `Home` / `End`             | Jump to start / end of timeline                                    |
| `S`                        | Toggle snapping                                                    |
| `Ctrl+K`                   | Add Edit — split selection (or all tracks) at the playhead         |
| `Delete` / `Backspace`     | Delete the selection (whole link groups)                           |
| `Shift+Delete`             | Ripple delete — delete AND close the gap                           |
| `Ctrl+X` / `Ctrl+C`        | Cut (copy + delete) / copy the selection (multi-clip aware)        |
| `Ctrl+V`                   | Paste the clipboard at the playhead                                |
| `Ctrl+A` / `Ctrl+Shift+A`  | Select all / deselect all                                          |
| `Shift+click`              | Add a clip's link group to the selection (multi-select)            |
| `Ctrl+click`               | Toggle a clip's link group in the selection                        |
| `Ctrl+L`                   | Link the selection — or unlink when it is already linked           |
| `D` / `Ctrl+Shift+/`       | Duplicate the selection (link group)                               |
| `M`                        | Add a marker at the playhead (clip marker when a clip is selected) |
| `Shift+M` / `Ctrl+Shift+M` | Go to next / previous marker                                       |
| `Shift+E`                  | Mute / unmute the selected clip's audio side                       |
| `G`                        | Audio Gain dialog                                                  |
| `T`                        | Add a text clip at the playhead (Premiere Type tool)               |
| `Ctrl+Z` / `Ctrl+Shift+Z`  | Undo / redo                                                        |
| `Ctrl+Y`                   | Redo                                                               |
| `Ctrl+S`                   | Save project JSON                                                  |
| `+` / `-`                  | Zoom timeline in / out                                             |
| `\`                        | Zoom the timeline to fit the whole sequence                        |

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
│   core.ts (PlaybackCore)     │   │   mp4.ts (WebCodecs/MP4)   │
│   compositor.ts · preview.ts │   │   (WebCodecs/MP4 render)   │
│   engine-ref.ts · media/*    │   │    of a dedicated core)    │
└──────────────────────────────┘   └────────────────────────────┘
```

- **UI** never mutates state directly. Every edit is a named `EditorCommand` dispatched via `store.apply(...)` (or as transient updates during drags).
- **Commands** validate input, clone the document, and return a new `Doc`. The store keeps a snapshot of the previous doc for undo.
- **The store** is the single source of truth. React components subscribe to slices of it; the playback engine reads the current doc via a `getDoc()` callback and reports the playhead back through the store, which flows to the views.
- **The engine** is framework-free and drives the preview only: `PlaybackCore` owns the audio clock, the media element pool, the Web Audio graph, and canvas rendering. Export is separate: it walks the pure frame plan and renders through WebCodecs (no playback core, no realtime constraint).

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
    "markers": [
      // sequence markers: `time` is timeline seconds; color defaults to green
      { "id": "marker_…", "time": 1.5, "name": "Cue", "color": "red", "notes": "…" },
    ],
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
            "temperature": 40, // -100..100 white balance, optional (0.6.0)
            "tint": -20, // -100..100 green/magenta, optional (0.6.0)
            "denoise": true, // broadband noise reduction switch, optional (0.6.0)
            "markers": [
              // clip markers: `time` is SOURCE seconds (same basis as inPoint)
              { "id": "marker_…", "time": 2.25, "name": "Beat", "color": "red", "notes": "…" },
            ],
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
- **Source position** is `clip.inPoint` — where playback starts inside the source media. A trimmed clip keeps `duration` on the timeline but moves `inPoint`; `inPoint + duration` never exceeds the source length for video/audio (images and text are unbounded). A reversed clip reads the same window backwards, so its head shows `inPoint + duration × speed` and its tail `inPoint`, and a trim moves the anchor on the side the edge gave material back to.
- **Track order is compositing z-order**: `tracks[0]` is the _topmost_ layer. The default project is `V1` (video) over `A1` (audio) at **1920×1080 (Full HD) @ 30fps**; new tracks are conventionally ordered text, then video, then audio. Dropping media between tracks (`addTrack` with `atIndex`) places the layer at the exact z-position the user pointed at — explicit placement skips the convention sort, and any order is legal (e.g. an audio layer between two video layers) because the array order is what renders.
- Compatibility rules: video/image material goes on `video` tracks, audio on `audio` tracks, text clips on `text` tracks.

## Command pattern

All mutations flow through 39 named commands in `src/lib/editor/commands.ts`, applied with `applyCommand(doc, command)` / `applyCommands(doc, commands[])`. Each command validates its input (throwing `EditorCommandError` on unknown ids, out-of-bounds trims, and so on) and returns a **new** doc — the input is never mutated.

| Command                | Description                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addMediaAsset`        | Register an imported media asset in the bin.                                                                                                                  |
| `removeMediaAsset`     | Remove an asset; clips keep a dangling `mediaId`.                                                                                                             |
| `relinkMedia`          | Patch an asset (usually a fresh `url`) and clear `missing`.                                                                                                   |
| `addTrack`             | Append a track and re-sort to the text/video/audio order — or, with `atIndex`, insert at that exact z-position without re-sorting (drop-between-tracks).      |
| `removeTrack`          | Remove a track (the last remaining track is protected).                                                                                                       |
| `renameTrack`          | Rename a track (empty names are ignored).                                                                                                                     |
| `toggleTrackMute`      | Flip a track's `muted` flag.                                                                                                                                  |
| `addClip`              | Add a clip to a track (kind-checked, clamped to source).                                                                                                      |
| `moveClip`             | Move a clip to a new track and/or `start` position.                                                                                                           |
| `trimClip`             | Set `start`, `inPoint`, and `duration` (bounds-checked) for the edge named by `edge` (`head`/`tail`, or `span` when the caller re-times a fixed source span). |
| `splitClip`            | Split a clip at a time into two adjacent clips; the right half starts a fresh link group (the group-split action re-links the right halves together).         |
| `deleteClip`           | Remove a clip from its track.                                                                                                                                 |
| `unlinkClip`           | Break the A/V link bond on every member of the group.                                                                                                         |
| `linkClips`            | Bond 2+ selected clips into ONE link group (merge-safe: groups that extend beyond the selection merge whole).                                                 |
| `setClipGain`          | Set linear gain, clamped to `GAIN_MIN..GAIN_MAX`.                                                                                                             |
| `setClipMuted`         | Set a clip's `muted` flag.                                                                                                                                    |
| `setClipOpacity`       | Set visual opacity, clamped to `OPACITY_MIN..OPACITY_MAX`; omitted at 1 when saved.                                                                           |
| `setTextContent`       | Change a text clip's content.                                                                                                                                 |
| `setTextStyle`         | Merge a partial `TextStyle` into a text clip.                                                                                                                 |
| `addTransition`        | Add a crossfade by pulling the next clip left to overlap.                                                                                                     |
| `removeTransition`     | Clear a clip's `transitionOut` (the overlap remains).                                                                                                         |
| `addSequenceMarker`    | Add a sequence marker (time-sorted; duplicate ids rejected).                                                                                                  |
| `moveSequenceMarker`   | Move a sequence marker and re-sort.                                                                                                                           |
| `updateSequenceMarker` | Patch a sequence marker's name/color/notes.                                                                                                                   |
| `deleteSequenceMarker` | Remove a sequence marker (the array collapses to absent when empty).                                                                                          |
| `addClipMarker`        | Add a source-anchored clip marker.                                                                                                                            |
| `moveClipMarker`       | Move a clip marker and re-sort.                                                                                                                               |
| `updateClipMarker`     | Patch a clip marker's name/color/notes.                                                                                                                       |
| `deleteClipMarker`     | Remove a clip marker (the array collapses to absent when empty).                                                                                              |
| `setProjectSettings`   | Patch project name/width/height/fps (clamped).                                                                                                                |

**Undo/redo.** The store pushes a whole-`Doc` snapshot onto `past` before each committed command; `undo` pops it and moves the current doc to `future`. Doc JSON is small (kilobytes), so full snapshots are cheap and make every command trivially reversible. The stack is capped at `HISTORY_LIMIT = 100` entries, and undo/redo drop a selection (clip or marker) whose target no longer exists in the restored doc.

**Transient gestures.** Timeline drags must not spam the history. A gesture calls `beginTransient()` (snapshot the base doc), applies every pointermove via `applyTransient()` (no history; invalid mid-drag states are swallowed), and finishes with `commitTransient()` — which pushes exactly one history entry if the doc actually changed — or `cancelTransient()` to restore the base. Result: one undo step per drag, regardless of how many frames it spanned.

## Playback engine

`PlaybackCore` (`src/lib/editor/playback/core.ts`) drives both preview and export:

- **Master clock** — the `AudioContext` clock when Web Audio is available (sample-accurate and drift-free); otherwise `performance.now()`. On `play()` the timeline time is anchored to the clock, and each `requestAnimationFrame` derives the playhead from the elapsed audio time.
- **Per-clip media pool** — `ClipMediaPool` gives every clip its own `HTMLVideoElement`/`HTMLAudioElement` parked in a hidden container, so two clips can reference the same asset simultaneously (after a split or across tracks).
- **Drift correction**: every frame the engine compares each active element's `currentTime` with the expected source time (`sourceTimeAt(clip, t - clip.start)`, the one mapping the preview, the plan and the exporter share, mirroring the span for reversed clips); drift over `DRIFT_THRESHOLD` (0.4 s) triggers a resync seek. Reversed and time-remapped clips are stepped instead: the element is parked and seeked every tick, because neither a backwards read nor a rate curve can be expressed as a constant `playbackRate`.
- **Web Audio graph**: each element feeds a `MediaElementAudioSourceNode` into a per-clip `GainNode`, all connected to a master `GainNode` that routes to `audio.destination` (speakers) and a `MediaStreamAudioDestinationNode` (`audioStream`, a capture destination no longer used by export; the exporter mixes in an `OfflineAudioContext` instead). Per-frame gain is `clip.gain × clip mute × track mute × crossfade alpha`, applied with a 20 ms ramp. Pan, EQ, the compressor and the denoise chain bake into that per-clip chain, which is rebuilt when any of them changes so an edit is audible immediately. Without Web Audio the engine falls back to element `volume`.
- **Compositor rules** (`compositor.ts`) — tracks composite bottom→top onto a black frame; video/image clips are drawn contain-fit (letterboxed, aspect preserved); text clips render styled, shadowed multi-line text; two overlapping clips crossfade with complementary alphas, otherwise the later clip simply wins visually; audio tracks draw nothing.
- **Scrubbing** — while paused, `seek()` positions active video elements and re-draws once their `seeked` event lands (`drawStill`).

## Export

`exportTimeline` (`src/lib/editor/export/mp4.ts`) renders the timeline to a downloadable MP4
(H.264 + AAC, or Opus audio where the browser cannot encode AAC), offline, with no MediaRecorder
involved:

- `export/offline.ts` builds a **pure frame plan**: `exportFrameTimes` quantizes the timeline to the
  project fps, `planVideoFrame` resolves each frame's draws (source timestamps honoring speed and
  reverse, crossfade alphas, keyframed opacity, color filter, transform), and `planAudioFrame`
  resolves the audible contributions with gain/pan and twin shadowing. Tests verify the plan in Node.
- **Video frames are decoded, not element-seeked.** Mediabunny's `VideoSampleSink` returns the
  source frame at an exact timestamp, which is what makes reverse and sub-second speed exact;the plan's composite goes onto an offscreen canvas (text clips through the same `drawTextClip` the preview uses) and into a Mediabunny `CanvasSource` (codec `avc`).
- **Audio** is mixed in one `OfflineAudioContext` render with the same graph topology as the preview
  (gain keyframes, pan, EQ, compressor, denoise, crossfade ramps), then encoded as an AAC track, or
  Opus when `AudioEncoder` cannot do AAC (desktop Linux, Firefox).
- **Quality presets** set the video bitrate: low ≈ 2.5 Mbps, medium ≈ 6 Mbps, high ≈ 12 Mbps.
- The dialog shows progress, supports cancel, previews the result inline, and downloads
  `<project name>.mp4`.

Known limitations:

- **Export requires WebCodecs** (Chromium, Edge, Firefox 130+, Safari 26+). The dialog disables
  itself and says why on older browsers.
- **HEVC and ProRes are not offered**: browser encoders for them are not reliably available. H.264
  video with AAC (or Opus) audio is the supported target.
- **Export wall time tracks source decode**: roughly realtime for 1080p H.264 decoded in software,
  faster where the browser decodes on the GPU. It is an offline render, not a realtime capture.
- **Large timelines buffer the MP4 in memory**: fine at MVP scale; a `StreamTarget` is the upgrade
  path when files grow past ~100 MB.

## Persistence

- **Project files** use the `.veproj.json` format (`version: 2`, plus a `savedAt` timestamp; see `serialization.ts`). `serializeDoc` strips object URLs (they are session-bound and can never persist) and the loader hydrates the clip's re-timing, shaping, keyframe and marker fields, clamping and sanitizing them on the way in. Version 1 files (pre-markers) still load; files from a newer app version are refused instead of loading partially.
- **Loading** hydrates every asset with an empty `url` and `missing: true`; clips whose media vanished entirely lose their `mediaId`. Offline assets render as "offline" in the media bin, and a frame that needs them paints **Media offline** over the monitor, naming the files it is missing, instead of showing silent black. Relinking is automatic when you re-import a file with a matching name (and for the bundled samples, which the app refetches itself on any load or restore), or manual via the relink button on each offline asset. Recovered samples are merged into the document itself, so a load or restore stays one undo step and the exporter keeps the source bytes it reads.
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

Current state: **864 tests across 53 files, all passing**. Coverage is enforced at 70/60/75/70 (statements/branches/functions/lines) over the pure state modules, and `menus.ts` and `workspace.ts` are at 100% across all metrics. [docs/testing.md](docs/testing.md) has the file-by-file inventory, the mocked browser harness, and the E2E battery.

## Menu bar and workspace

### Menu bar

The top menu bar mirrors Adobe Premiere Pro's menu structure (File · Edit · Clip · Sequence · Marker · Graphics · View · Window · Help), adapted to the features this editor has. Two design rules keep it honest:

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
│   ├── commands.ts              # command variants, applyCommand(s), validation
│   ├── snap.ts                  # computeSnapPoints, applySnap, snapMove
│   ├── keyframes.ts             # keyframe evaluation (linear + eased), sanitize/clamp, split redistribution
│   ├── bezier.ts                # pure cubic-bezier timing solver for the easing presets
│   ├── color.ts                 # shared ctx.filter builder + temperature/tint matrix + scope samplers
│   ├── ducking.ts               # auto-duck keyframe analysis from waveform peaks
│   ├── offline.ts               # offline-media detection for the monitor (pure)
│   ├── clip-gesture.ts          # pure gesture decisions: move/trim/rate-stretch
│   ├── marquee.ts               # box-selection rect math + group resolution
│   ├── markers.ts               # sequence/clip marker math, colors, navigation, selection
│   ├── transition.ts            # getTransitionSpan, transitionAlphas, maxTransitionDuration
│   ├── links.ts                 # multi-selection + A/V link-group helpers
│   ├── clipboard.ts             # copy / cut / paste (module memory, outside undo)
│   ├── actions.ts               # multi-command UI actions (add media/text, group ops)
│   ├── menus.ts                 # menu bar model: structure, states, action ids
│   ├── workspace.ts             # panel layout state: bounds, sanitize, persist
│   ├── workspace-store.ts       # zustand wrapper over workspace.ts
│   ├── project-io.ts            # shared save / open / import-media / sample helpers
│   ├── sample-media.ts          # bundled samples + load plan (fresh adds, offline relinks)
│   ├── timeline-drop.ts         # drop-target geometry (drop-between-tracks)
│   ├── tracks.ts                # removes the tracks an edit leaves empty (prune)
│   ├── timeline-scroll.ts       # drag edge auto-scroll geometry (pure)
│   ├── store.ts                 # zustand store: history, transients, selection, playhead
│   ├── serialization.ts         # .veproj.json (v2, v1 loads): serialize/parse/hydrate
│   ├── persistence.ts           # debounced localStorage autosave + restore
│   ├── media/
│   │   ├── probe.ts             # importFile: probe, thumbnail, waveform peaks, hasAudio
│   │   ├── relink.ts            # relinkPatchFrom: the patch fields a relink carries
│   │   └── elements.ts          # ClipMediaPool (per-clip elements + source nodes)
│   ├── playback/
│   │   ├── core.ts              # PlaybackCore: clock, pool, drift, Web Audio
│   │   ├── compositor.ts        # drawFrame: tracks, contain-fit, text, crossfades, opacity
│   │   ├── denoise.ts           # noise-reduction biquad chain (shared with the export mix)
│   │   ├── preview.ts           # preview engine singleton (attach/detach)
│   │   ├── engine-ref.ts        # PlaybackController ref shared by all UI
│   │   └── text-box.ts          # text-box measurement (preview drag outline)
│   ├── export/
│   │   ├── offline.ts           # pure frame/audio export plan (Node-testable)
│   │   └── mp4.ts               # WebCodecs MP4 pipeline, downloadBlob
│   └── __tests__/               # 53 test files (864 tests) incl. gate.test.ts in src/lib/; mocks/ = browser-mock harness
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
│   ├── effect-controls/
│   │   └── EffectControlsPanel.tsx # keyframes, graph, audio shaping, speed/reverse
│   └── timeline/
│       ├── TimelinePanel.tsx    # track lanes, playhead, drop targets, zoom, track menu
│       ├── Ruler.tsx            # canvas time ruler + scrubbing
│       ├── ClipView.tsx         # move/trim gestures across lanes, snapping, fade overlays
│       ├── SequenceMarkers.tsx  # ruler marker tabs, drag/select, edit/delete menu
│       ├── ClipMarkers.tsx      # clip marker tabs (source-anchored)
│       ├── MarkerDialog.tsx     # marker name/color/notes editor
│       └── Waveform.tsx         # per-clip waveform canvas
└── hooks/editor/
    └── useEditorKeyboard.ts     # global keyboard shortcuts
```

## Known limitations and roadmap

Limitations, all observable in the current code:

- **Selection is id-based** — `store.selections` holds clip ids (primary first); group operations expand A/V link groups and the marquee box selects whole groups, but there is no track targeting or select-by-lane on the timeline.
- **Export requires WebCodecs**: the MP4 pipeline replaced MediaRecorder/WebM, so very old browsers cannot export (playback still works). HEVC and ProRes are out of scope: no reliable browser encoders.
- **Keyframe easing is preset-only**: linear, easeIn, easeOut and easeInOut are offered; a free bezier handle editor is a later increment.
- **Reverse preview is stepped**, `<video>` cannot play backwards in realtime; the export is frame-accurate but playback shows a stepped approximation. Rate stretch on one half of a linked A/V pair does not re-time the twin (link groups still move/delete/split together).
- **Markers are editor-only**: they render in the timeline and never affect the export (no visual burn-in, no MP4 chapter metadata), and a clip marker that a trim moves out of the visible span is kept in the data but hidden until the clip is extended back. There are no marker spans or marker types.
- **Noise reduction is broadband only**: a fixed high-pass/low-pass/hiss-cut chain (native Web Audio biquads); spectral or learned noise reduction is out of scope. Gain is linear 0–2 (+6 dB max).
- **Ripple delete is explicit** — plain Delete leaves the gap; `Shift+Del` closes it. `removeTransition` leaves the overlap behind (harmless: the later clip wins visually).
- **Trim bounds** — video/audio clips are bounded by their source; images and text are unbounded (images have no intrinsic length; they default to 4 s).
- **Missing media is silent** — offline assets render black (video) or nothing (audio) until relinked.
- **Autosave depends on localStorage quota**; large projects with embedded thumbnails/waveforms can exceed it.

Roadmap candidates, roughly in order of impact (the full gap analysis against Premiere, with what
each release already closed, is in [`ROADMAP.md`](ROADMAP.md)):

1. More transitions: dip-to-black fits the existing span/alpha model in `transition.ts`; wipes, slides and pushes additionally need a spatial parameter (a mask or a position offset).
2. A free bezier handle editor on top of the easing presets shipped in 0.6.0.
3. Frame blending at speed-ramp discontinuities (0.6.0 ships the curves; ramps read the clamped source without blending).
4. LUT import (.cube) and vectorscope/waveform scopes beyond the two basic meters shipped in 0.6.0.
5. Track targeting and track-level operations (marquee and markers shipped).
6. Track grouping and compound clips.
7. A `StreamTarget` export path once files grow past the in-memory buffer.

---

For the module-level technical reference — per-file exports, the undo/transient lifecycle, the audio graph, the crossfade model, and the invariant list — see [`docs/architecture.md`](docs/architecture.md). The whole set is indexed at [`docs/README.md`](docs/README.md).

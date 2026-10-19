# Web Video Editor

A browser-based multi-track video editor MVP: a minimal Premiere Pro / CapCut-style editing experience that runs entirely client-side. Import media, arrange clips on a timeline, add transitions (cross-dissolve, dip to black, wipe, slide, push) and text overlays, animate properties with keyframes, re-time clips, mix and shape audio, preview in real time, and export to MP4. No uploads and no server-side processing: object URLs, canvas compositing, Web Audio, and WebCodecs do all of the work in the tab.

Built with Next.js 16, React 19, TypeScript, zustand 5, Tailwind CSS 4 + shadcn/ui, and Vitest.

## Features

- **Media import** — video, audio, and image files via the media bin (multi-select) or drag-and-drop; automatic duration/size probing, JPEG thumbnails, normalized waveform peaks, and audio-track detection.
- **Multi-track timeline** — move clips (including across compatible tracks, with the whole selection following), trim either edge, split at the playhead, duplicate, delete, and snapping to clip edges, the playhead, and timeline bounds. Add video/audio/text tracks from the `+` button in the timeline's corner cell (or the toolbar `+` and the menus) — new tracks stack per the convention text → video → audio, and `tracks[0]` renders on top.
- **Manageable layers** — each track header has a context menu (or double-click the name) to **rename**, **mute** or **delete** the layer; delete is disabled for the last remaining lane. A layer the edit leaves **empty is removed with it**, in the same undo step, so a lane never lingers with nothing on it (a lane that was already empty is kept, which is what makes "add a layer, then fill it" work). Dragging a clip near the top or bottom edge of the tracks **scrolls the timeline** so it can reach a lane that is off-screen, and dropping it on a lane of the wrong kind marks that lane, and the drop is rolled back whole — the clip returns to where it started rather than keeping the part of the gesture that happened to be legal.
- **Track targeting + select-by-lane**: every track is targeted by default; the header menu's **Target Track** toggles a lane (an untargeted lane dims its kind icon) and **Select Track Clips** selects the whole lane, expanding A/V link groups. Targeting steers lane-less placement (bin **quick-add**, **Add Text**) to the first targeted compatible lane, including a video's audio twin, and paste follows that same order once its original lane cannot be used, so a compatible original lane that is still targeted is kept; when no lane of that kind is targeted the old landing order still applies. A clip drag, a duplicate and a drop onto a compatible lane keep the lane the user pointed at, and targeting is session state, not saved in the project file.
- **Multi-selection + manual A/V linking** — plain click selects a clip (its link group), **Shift+click adds** another clip's group, **Ctrl+click toggles** it, **Ctrl+A** selects everything; every group op (move, delete, cut/copy/paste, split, duplicate) acts on the whole selection. **Drag a box (marquee)** on empty timeline space to select every clip it covers (Shift adds the covered groups, Ctrl toggles them), with edge auto-scroll while dragging. Select a video clip and an audio clip with Shift+click, then **right-click → Link** (or `Ctrl+L`) to bond them Premiere-style; `Ctrl+L` on a linked selection unlinks it again. A **Razor tool** (`C`) cuts a clip exactly where you click; **Shift+Delete ripple-deletes** the selection and closes the gap.
- **Markers** — press `M` to drop a marker at the playhead: on the primary selected clip when one is selected (source-anchored, so trims, speed changes and reversal keep it on the same media frame), otherwise on the sequence ruler. Markers take a name, one of eight colors and notes (double-click one or use Marker › Edit Selected Marker); `Shift+M` / `Ctrl+Shift+M` jump between markers, markers are snap targets for clip drags and trims, and `Delete` removes the selected one. Sequence markers live in `project.markers`, clip markers in `clip.markers` (source seconds); both persist in the project file.
- **A/V linked clips** — dropping a video that HAS audio places it as a linked pair: the video part on the video track and an audio-only twin on the audio track (waveform included). The pair selects, moves, splits, duplicates and deletes together, and the audio twin is the sole sound carrier (no double audio). **Right-click any clip** for the Premiere-style menu — Cut, Copy, Paste at playhead, Split, Duplicate, **Link / Unlink Audio/Video**, Delete, **Ripple Delete** — and after unlinking, each half is fully independent.
- **Drop-between-tracks** — drag media from the bin onto the middle of a row to drop it onto that track, or onto a row's edge (or the empty strip below the tracks) to insert a brand-new layer at exactly that z-position: a kind-colored insertion line with a `+ V2` / `+ A2` preview shows where the layer will land — the Premiere-style way to build stacked compositions (put one video above/below/between others in one gesture).
- **Insert / overwrite placement modes**. A sticky three-way toolbar control (`Place` / `Insert` / `Overwrite`, all in one segmented group) picks how a media drop lands in the middle of a lane: **Place** is today's plain drop and stays the default, **Insert** shifts every clip at or after the edit point right by the placed span (a straddler splits at the point and its right half moves, and link groups move as one unit, so an A/V pair stays in sync; a clip too close to the split headroom is left alone and the drop still commits) and **Overwrite** replaces the covered span (partial coverage trims to the window edge, interior coverage splits once and head-trims the right fragment, a sub-0.1 s remnant is deleted, and an unrepresentable cut refuses the WHOLE placement with one toast, so a mixed batch can never land half-applied). While you drag, the lane under the pointer wears an `Insert` / `Overwrite` badge; a drop onto a lane of the wrong kind refuses in the two new modes instead of silently relocating (which `Place` still does). One placement is one undo step, and the mode is session-only state, like the active tool.
- **Source monitor + three-point editing**. Clicking an asset in the media bin loads it into the **Source Monitor** panel (toggleable from the Window menu as one of the six workspace panels; a still shows the still itself), where you can play it and scrub it, then mark **In / Out** with `I` / `O` and place that marked span at the sequence playhead with `,` (insert) or `.` (overwrite), independent of the sticky placement-mode toggle above. One-sided marks leave the other end open, marks clamp to the asset, an inverted or sub-floor range refuses with one toast and places nothing, and images have no source window (their controls disable and they place 4 s). Source selection and marks are session state: they clear when a different asset is selected and when the project is replaced. The source time has one owner (the preview element's own callbacks write `sourcePlayhead`), so the readout, the marks and the placed range cannot disagree.
- **Transitions** — per-clip `transitionOut` with real overlap, picked per transition as cross-dissolve or dip to black in the Inspector; the compositor and audio mixer both ramp.
- **Text overlays** — text tracks and clips with font size, color, family, bold/italic, alignment, position, and shadow. **Drag the text directly in the program monitor** to reposition it (a dashed outline shows the box; one drag = one undo step; precise control stays in the Inspector's Position X/Y sliders).
- **Subtitles / captions** — import an SRT file to create timed caption cues on their own Captions track (malformed cues skip with a count, an empty file refuses). The **Captions** panel beside the timeline lists every cue with editable text and timing, click-to-seek, one-click creation at the playhead, and SRT download in start order. Captions burn into the MP4 exactly as the monitor shows.
- **Layer compositing** — per-clip **opacity** (0–100 %) that stacks with crossfade alphas: put a clip on a higher track, lower its opacity, and the track below shows through — the same model as Photoshop/Premiere layering.
- **Effects beyond opacity** — every clip carries an ordered effect stack edited in Effect Controls: **crop** (four sides, feather, zoom refill, keyframable), sixteen **blend modes** under Opacity, an eyedropper **chroma keyer** with despill, **track mattes** from any higher lane (luma/alpha, reversible), and **motion blur** that accumulates animated moves. A track eyeball hides video/text lanes from the composite. Preview and export render every effect identically.
- **Keyframes + Effect Controls**: animate opacity, position, scale, volume and the color set (exposure, contrast, saturation, brightness, hue) per clip. The Inspector has a Clip / Effect Controls tab split: a value slider, a keyframe diamond that adds/removes at the playhead, and a light graph whose dots drag in time. Each segment eases with its outgoing keyframe's interpolation (linear, ease in, ease out, ease in/out, Premiere's curves, picked from a segmented control that always sits under the property and edits the visible segment's start keyframe), the graph draws every segment's real bezier shape with the active segment's two handles draggable (a straight segment eases by dragging it), with a per-property default easing for newly authored keyframes, that same easing drives the exported gain schedule (an eased volume segment is sampled into short linear ramps, since the Web Audio API has no easing primitive), keyframe times are clip-local, splitting a clip redistributes its curves (every segment subdivides exactly at the cut, eased segments included, so both halves re-time the original), and every keyframe drag is one undo step.
- **Color**: the color set applies through the canvas filter stack in preview and export alike; a neutral clip skips the filter pass entirely. **Temperature/tint** (-100..100 each) grade white balance through one SVG matrix per graded clip that both render paths reference, so what you see is what exports; the monitor can show a **luma histogram, an RGB balance read, a waveform and a vectorscope** (scopes section, collapsible, off by default). **3D `.cube` LUT import** keeps each file once in a project-level library that clips reference by id: a 1D file applies as exact per-channel shapers in one shared SVG node, a 3D file runs a shared trilinear pixel pass in the preview and the export, and the library refuses an import that would push its base64 payloads past 3,000,000 characters rather than trip the autosave quota later.
- **Speed and reverse**: per-clip speed (0.25×–4×) with an Inspector slider and an Alt-drag rate stretch on either clip edge (the source span stays fixed and the speed re-derives; a clip with a time remapping curve is exempt, see below), plus a reverse toggle for video. A rate stretch the command layer rejects applies nothing and says why. Reverse renders frame-accurately in the export and stepped in the preview; reversed audio is dropped. Below the output frame rate BOTH renders blend neighbouring frames, so a slowed clip stops juddering in the file and in the monitor alike: the export decodes the pair and the monitor parks a second muted element on the partner read, and one shared weight function (frame-blend.ts) gives both the same blend. A reversed clip trims from both edges like a forward one (its head shows the span's high source end and its tail the low one, so each edge reveals the source on its own side rather than sliding the picture). Clips carry speed/reverse badges.
- **Time remapping**: a `timeScale` keyframe curve ramps a clip's speed without changing its timeline length (the source time each timeline second consumes is the curve's integral, so cuts, splits and the export's frame count stay put). Eased segments work here too, and the export samples them into the same curve instead of flattening them. The picture-only rows (time remapping, and the reverse switch next to it) are hidden for anything that carries no picture, which includes an A/V pair's audio twin even when it sits on a video track: a ramp there could only mute the pair. On a reversed clip the row mirrors its axis, so a dot marks the rate the engine applies at that timeline time, the curve is drawn mirrored, and the easing picker and the handles target the active segment's start keyframe on the mirrored axis (the diamond still targets the keyframe the mirrored playhead sits nearest). A ramped clip renders frame-accurate in the export and drops the audio of its whole link group (variable-rate audio has no resampler yet); wherever its read falls below the output frame rate both renders blend the frame pair, exactly as they do for a slowed clip. While a curve exists it IS the rate, so the static Speed slider, the clip's speed badge and Alt-drag rate stretch are disabled (the static speed stays the no-curve fallback).
- **Audio control + shaping**: per-clip linear gain (0–2) and mute, per-track mute, waveforms, plus per-clip pan, a 3-band EQ (200 Hz / 1 kHz / 4 kHz), a compressor, a **Reduce noise** switch (a fixed broadband chain built into the preview mixer and the export mix from one shared builder), and **auto-ducking** that writes volume keyframes for music under dialogue (estimated from the waveform peaks, with a dialogue-source picker).
- **Synced preview playback** — audio-clock-driven master clock, per-clip media element pool, canvas compositor, drift correction.
- **MP4 export via WebCodecs**: offline, frame-accurate H.264 export through a pure frame plan: source frames are decoded (not element-seeked), the animated doc is composited per frame, audio is mixed offline and encoded as AAC (Opus where the browser has no AAC encoder, notably desktop Linux and Firefox), and the result plays with a correct duration header. Wall time tracks decode speed rather than the old realtime capture. Quality presets map to bitrates; progress, cancel, and in-dialog preview included. Needs a WebCodecs-capable browser (Chromium, Edge, Firefox 130+, Safari 26+).
- **Undo/redo** — up to 100 steps of whole-document snapshots; drag gestures collapse into a single undo entry.
- **Save/load project JSON** — `.veproj.json` files; media references survive, object URLs do not.
- **Autosave/restore** — debounced localStorage writes with a restore-or-discard banner on the next visit.
- **Premiere-style menu bar** — File · Edit · Clip · Sequence · Marker · Graphics · View · Window · Help, driven by a pure, unit-tested menu model; items whose preconditions are unmet render disabled (no dead entries).
- **Resizable workspace**. Every panel (Media, Source Monitor, Program Monitor, Inspector, Timeline, Captions) is user-resizable and collapsible; sizes, collapsed strips, and panel visibility persist across sessions. Window menu toggles panels, double-click a resize handle to reset its neighbor, and small screens fall back to a fixed stacked layout.

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
| `I` / `O`                  | Mark source In / Out at the source monitor's playhead              |
| `,` / `.`                  | Insert / overwrite the marked source (whole asset when unmarked)   |
| `G`                        | Audio Gain dialog                                                  |
| `T`                        | Add a text clip at the playhead (Premiere Type tool)               |
| `Ctrl+Z` / `Ctrl+Shift+Z`  | Undo / redo                                                        |
| `Ctrl+Y`                   | Redo                                                               |
| `Ctrl+S`                   | Save project JSON                                                  |
| `+` / `-`                  | Zoom timeline in / out                                             |
| `\`                        | Zoom the timeline to fit the whole sequence                        |

Shortcuts are ignored while typing in inputs, textareas, selects, or content-editable elements (see `src/hooks/editor/useEditorKeyboard.ts`).

**Placing media, end to end.** There are two routes and they are independent:

1. **A bin drop onto a lane** follows the sticky **Place / Insert / Overwrite** toolbar control. Drag the
   asset onto the middle of a row to drop it there (a mode badge on the lane previews Insert or
   Overwrite), or onto a row edge / below the last row to create a new layer at that z-position (that
   path always means "create a track" and ignores the mode). Place is the default, so nothing becomes
   destructive without picking a mode; Insert and Overwrite are one click away and stay armed until you
   switch back.
2. **Three-point editing from the Source Monitor.** Click a bin row to load that asset into the Source
   Monitor (a still shows the still itself), scrub or play to the frame you want, press `I` and `O` to
   mark the in and out points, park the sequence playhead, then press `,` to insert the marked span
   there or `.` to overwrite with it. These keys ignore the toolbar control, and with no marks set they
   place the whole asset. Both routes apply as one undo step, so a single `Ctrl+Z` reverses a
   placement whatever moved with it.

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
    "luts": [
      // project LUT library: one entry per unique imported .cube (0.7.0);
      // `data` is base64 of the 8-bit RGB grid, `kind` picks 1d or 3d
      { "id": "lut_…", "name": "My Grade", "kind": "1d", "size": 2, "data": "AAAAAAD//w==" },
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
            "isCaption": true, // caption cue flag for SRT export, optional (0.8.5)
            "temperature": 40, // -100..100 white balance, optional (0.6.0)
            "tint": -20, // -100..100 green/magenta, optional (0.6.0)
            "lutId": "lut_…", // reference into the project's LUT library, optional (0.7.0)
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
- **Source position** is `clip.inPoint`: where playback starts inside the source media. A trimmed clip keeps `duration` on the timeline but moves `inPoint`; `inPoint + duration` never exceeds the source length for video/audio (images and text are unbounded). A reversed clip reads the same window backwards, so its head shows `inPoint + duration × speed` and its tail `inPoint`, and a trim moves the anchor on the side the edge gave material back to.
- **Track order is compositing z-order**: `tracks[0]` is the _topmost_ layer. The default project is `V1` (video) over `A1` (audio) at **1920×1080 (Full HD) @ 30fps**; new tracks are conventionally ordered text, then video, then audio. Dropping media between tracks (`addTrack` with `atIndex`) places the layer at the exact z-position the user pointed at — explicit placement skips the convention sort, and any order is legal (e.g. an audio layer between two video layers) because the array order is what renders.
- Compatibility rules: video/image material goes on `video` tracks, audio on `audio` tracks, text clips on `text` tracks.

## Command pattern

All mutations flow through 49 named commands in `src/lib/editor/commands.ts`, applied with `applyCommand(doc, command)` / `applyCommands(doc, commands[])`. Each command validates its input (throwing `EditorCommandError` on unknown ids, out-of-bounds trims, and so on) and returns a **new** doc. The input is never mutated.

| Command                | Description                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addMediaAsset`        | Register an imported media asset in the bin.                                                                                                                                                                              |
| `removeMediaAsset`     | Remove an asset; clips keep a dangling `mediaId`.                                                                                                                                                                         |
| `relinkMedia`          | Patch an asset (usually a fresh `url`) and clear `missing`.                                                                                                                                                               |
| `addTrack`             | Append a track and re-sort to the text/video/audio order, or, with `atIndex`, insert at that exact z-position without re-sorting (drop-between-tracks).                                                                   |
| `removeTrack`          | Remove a track (the last remaining track is protected).                                                                                                                                                                   |
| `renameTrack`          | Rename a track (empty names are ignored).                                                                                                                                                                                 |
| `toggleTrackMute`      | Flip a track's `muted` flag.                                                                                                                                                                                              |
| `addClip`              | Add a clip to a track (kind-checked, clamped to source).                                                                                                                                                                  |
| `moveClip`             | Move a clip to a new track and/or `start` position.                                                                                                                                                                       |
| `trimClip`             | Set `start`, `inPoint`, and `duration` (bounds-checked) for the edge named by `edge` (`head`/`tail`, or `span` when the caller re-times a fixed source span).                                                             |
| `splitClip`            | Split a clip at a time into two adjacent clips; the right half starts a fresh link group (the group-split action re-links the right halves together).                                                                     |
| `deleteClip`           | Remove a clip from its track.                                                                                                                                                                                             |
| `unlinkClip`           | Break the A/V link bond on every member of the group.                                                                                                                                                                     |
| `linkClips`            | Bond 2+ selected clips into ONE link group (merge-safe: groups that extend beyond the selection merge whole).                                                                                                             |
| `setClipGain`          | Set linear gain, clamped to `GAIN_MIN..GAIN_MAX`.                                                                                                                                                                         |
| `setClipMuted`         | Set a clip's `muted` flag.                                                                                                                                                                                                |
| `setClipOpacity`       | Set visual opacity, clamped to `OPACITY_MIN..OPACITY_MAX`; omitted at 1 when saved.                                                                                                                                       |
| `setClipKeyframes`     | Replace one property's keyframes (validated, sorted); an empty list clears that curve.                                                                                                                                    |
| `setKeyframeDefault`   | Set the project's default interpolation for one animatable property; linear collapses to absent.                                                                                                                          |
| `setClipSpeed`         | Set the clip's speed, clamped to `SPEED_MIN..SPEED_MAX`, shortening it so its source span stays in range.                                                                                                                 |
| `setClipReverse`       | Flip reverse playback (text clips refuse).                                                                                                                                                                                |
| `setClipPan`           | Set stereo pan, clamped to -1..1.                                                                                                                                                                                         |
| `setClipEq`            | Set the three EQ band gains in dB (each clamped to `EQ_DB_MIN..EQ_DB_MAX`), or clear the EQ with `null`.                                                                                                                  |
| `setClipCompressor`    | Enable or disable the clip's compressor.                                                                                                                                                                                  |
| `setClipDenoise`       | Enable or disable the clip's denoiser.                                                                                                                                                                                    |
| `setClipColorParams`   | Set temperature and tint (clamped); a neutral 0 collapses to absent.                                                                                                                                                      |
| `setTextContent`       | Change a text clip's content.                                                                                                                                                                                             |
| `setTextStyle`         | Merge a partial `TextStyle` into a text clip.                                                                                                                                                                             |
| `saveTextPreset`       | Save a named `TextStyle` into the project's preset library (empty, overlong and duplicate names rejected).                                                                                                                |
| `renameTextPreset`     | Rename a user preset (built-in ids and duplicate names rejected).                                                                                                                                                         |
| `deleteTextPreset`     | Remove a user preset (built-in ids rejected).                                                                                                                                                                             |
| `importCaptions`       | Stamp one flagged caption clip per cue on a first-free `Captions` track (one undo step); zero cues and hostile payloads refuse.                                                                                           |
| `addCaptionCue`        | Stamp a 2 s flagged caption clip on a text track at the given start.                                                                                                                                                      |
| `addTransition`        | Add a cross-dissolve or dip-to-black transition by pulling the next clip left to overlap. The type is optional: a new transition defaults to crossfade, and omitting it on an existing transition keeps its current type. |
| `removeTransition`     | Clear a clip's `transitionOut` (the overlap remains).                                                                                                                                                                     |
| `addSequenceMarker`    | Add a sequence marker (time-sorted; duplicate ids rejected).                                                                                                                                                              |
| `moveSequenceMarker`   | Move a sequence marker and re-sort.                                                                                                                                                                                       |
| `updateSequenceMarker` | Patch a sequence marker's name/color/notes.                                                                                                                                                                               |
| `deleteSequenceMarker` | Remove a sequence marker (the array collapses to absent when empty).                                                                                                                                                      |
| `addClipMarker`        | Add a source-anchored clip marker.                                                                                                                                                                                        |
| `moveClipMarker`       | Move a clip marker and re-sort.                                                                                                                                                                                           |
| `updateClipMarker`     | Patch a clip marker's name/color/notes.                                                                                                                                                                                   |
| `deleteClipMarker`     | Remove a clip marker (the array collapses to absent when empty).                                                                                                                                                          |
| `setProjectSettings`   | Patch project name/width/height/fps (clamped).                                                                                                                                                                            |
| `importProjectLut`     | Add a parsed `.cube` to the project's LUT library (one entry per unique import, referenced by `Clip.lutId`).                                                                                                              |
| `setClipLut`           | Assign a library LUT to a clip, or clear it with `null`.                                                                                                                                                                  |
| `setClipAnimStatic`    | Set an animated property's static value, clamped to its bounds; the default collapses to absent.                                                                                                                          |

**Undo/redo.** The store pushes a whole-`Doc` snapshot onto `past` before each committed command; `undo` pops it and moves the current doc to `future`. Doc JSON is small (kilobytes), so full snapshots are cheap and make every command trivially reversible. The stack is capped at `HISTORY_LIMIT = 100` entries, and undo/redo drop a selection (clip or marker) whose target no longer exists in the restored doc.

**Transient gestures.** Timeline drags must not spam the history. A gesture calls `beginTransient()` (snapshot the base doc), applies every pointermove via `applyTransient()` (no history; invalid mid-drag states are swallowed), and finishes with `commitTransient()` — which pushes exactly one history entry if the doc actually changed — or `cancelTransient()` to restore the base. Result: one undo step per drag, regardless of how many frames it spanned.

## Playback engine

`PlaybackCore` (`src/lib/editor/playback/core.ts`) drives both preview and export:

- **Master clock** — the `AudioContext` clock when Web Audio is available (sample-accurate and drift-free); otherwise `performance.now()`. On `play()` the timeline time is anchored to the clock, and each `requestAnimationFrame` derives the playhead from the elapsed audio time.
- **Per-clip media pool** — `ClipMediaPool` gives every clip its own `HTMLVideoElement`/`HTMLAudioElement` parked in a hidden container, so two clips can reference the same asset simultaneously (after a split or across tracks).
- **Drift correction**: every frame the engine compares each active element's `currentTime` with the expected source time (`sourceTimeAt(clip, t - clip.start)`, the one mapping the preview, the plan and the exporter share, mirroring the span for reversed clips); drift over `DRIFT_THRESHOLD` (0.4 s) triggers a resync seek. Reversed and time-remapped clips are stepped instead: the element is parked and seeked every tick, because neither a backwards read nor a rate curve can be expressed as a constant `playbackRate`.
- **Frame blending (both paths)**: a clip reading strictly below the source frame rate parks a second MUTED element on the partner read (`blendPartnerTime`), and the pair is composited through one shared canvas routine (`drawBlendedContain`) at a weight the two paths derive the same way from their decoder's own timestamps: the exporter from the sample timestamps it fetched, the preview from the presented frames its elements report through `requestVideoFrameCallback`. A browser without that API, a partner frame that has not decoded yet, and a stale or seeking element all fall back to the single stepped frame.
- **Web Audio graph**: each element feeds a `MediaElementAudioSourceNode` into a per-clip `GainNode`, all connected to a master `GainNode` that routes to `audio.destination` (speakers) and a `MediaStreamAudioDestinationNode` (`audioStream`, a capture destination no longer used by export; the exporter mixes in an `OfflineAudioContext` instead). Per-frame gain is `clip.gain × clip mute × track mute × crossfade alpha`, applied with a 20 ms ramp. Pan, EQ, the compressor and the denoise chain bake into that per-clip chain, which is rebuilt when any of them changes so an edit is audible immediately. Without Web Audio the engine falls back to element `volume`.
- **Compositor rules** (`compositor.ts`) — tracks composite bottom→top onto a black frame; video/image clips are drawn contain-fit (letterboxed, aspect preserved); text clips render styled, shadowed multi-line text; two overlapping clips crossfade with complementary alphas, otherwise the later clip simply wins visually; a sub-frame-rate draw composites its blend pair additively into a scratch canvas and puts the result down once (the exporter calls the same routine); audio tracks draw nothing.
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
  source frame at an exact timestamp, which is what makes reverse and sub-second speed exact; the plan's composite goes onto an offscreen canvas (text clips through the same `drawTextClip` and decoded frames through the same `drawContain` the preview uses) and into a Mediabunny `CanvasSource` (codec `avc`). A frame the plan marks `blendTime` also fetches the partner sample and draws the pair through `drawBlendedContain`.
- **Audio** is mixed in one `OfflineAudioContext` render with the same graph topology as the preview
  (gain keyframes, pan, EQ, compressor, denoise, crossfade ramps), then encoded as an AAC track, or
  Opus when `AudioEncoder` cannot do AAC (desktop Linux, Firefox).
- **Quality presets** set the video bitrate: low ≈ 2.5 Mbps, medium ≈ 6 Mbps, high ≈ 12 Mbps.
- The dialog shows progress, supports cancel, previews the result inline, and downloads
  `<project name>.mp4`.

Known limitations:

- **Export requires WebCodecs** (Chromium, Edge, Firefox 130+, Safari 26+). The dialog disables
  itself and says why on older browsers.
- **HEVC and ProRes are not offered.** ProRes has no browser encoder: no shipping browser exposes a
  ProRes `VideoEncoder` (mediabunny's compatibility guide, checked 2026-10-07). HEVC is a value call
  rather than a platform limit: an encoder exists and a probe could gate it safely, but H.264 at the
  shipped bitrates covers the upload path and the probe, the dialog option and the per-project
  even-dimension gating cost more than they return. H.264 video with AAC (or Opus) audio is the
  supported target.
- **Export wall time tracks source decode**: roughly realtime for 1080p H.264 decoded in software,
  faster where the browser decodes on the GPU. It is an offline render, not a realtime capture.
- **`Download` buffers the MP4 in memory**: `Export to file` streams it straight to disk and bounds the
  buffer, so use it for long timelines; the dialog's size estimate points you there past ~100 MB.

## Persistence

- **Project files** use the `.veproj.json` format (`version: 4`, plus a `savedAt` timestamp; see `serialization.ts`). `serializeDoc` strips object URLs (they are session-bound and can never persist) and the loader hydrates the clip's re-timing, shaping, keyframe and marker fields, clamping and sanitizing them on the way in. Versions 1, 2 and 3 still load; files from a newer app version are refused instead of loading partially. Version 3 added the project LUT library, whose entries are gated on the way in (a malformed entry, an oversized payload or a clip `lutId` naming no entry is dropped rather than trusted). A load that drops entries logs one warning naming the count.
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
bun run battery        # scripted UI battery (reuses a server already on :3000, else starts one; owns its browser session)
```

The state core is deliberately pure, so it is tested in a plain Node environment (no browser needed): `commands` (validation, splitting, transitions, effects), `store` (history, transient gestures), `snap`, `transition` (span/alpha math), `serialization` (round-trips, missing media), `persistence` (debounce, validity), `time` helpers, plus `menus` (menu structure + state resolution) and `workspace` (layout state, sanitization, persistence).

Current state: **1464 tests across 68 files, all passing**. Coverage is enforced at 70/60/75/70 (statements/branches/functions/lines) over the pure state modules, and `menus.ts` and `workspace.ts` are at 100% across all metrics. [docs/testing.md](docs/testing.md) has the file-by-file inventory, the mocked browser harness, and the E2E battery.

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
│   ├── lut.ts                   # .cube parse/encode, LUT library budget, trilinear 3D pixel pass
│   ├── frame-blend.ts           # sub-frame-rate blend math: partner read + pair weight (both paths)
│   ├── ducking.ts               # auto-duck keyframe analysis from waveform peaks
│   ├── offline.ts               # offline-media detection for the monitor (pure)
│   ├── clip-gesture.ts          # pure gesture decisions: move/trim/rate-stretch
│   ├── sequence-ops.ts          # insert/overwrite placement planner + source in/out ranges
│   ├── marquee.ts               # box-selection rect math + group resolution
│   ├── markers.ts               # sequence/clip marker math, colors, navigation, selection
│   ├── transition.ts            # getTransitionSpan, transitionAlphas, maxTransitionDuration
│   ├── effects.ts               # effect-stack math: order rule, sample derivation, crop/matte/blur geometry, blend set
│   ├── chroma-key.ts            # Ultra-Key-lite math: chroma distance, key ramp, despill, mask values
│   ├── links.ts                 # multi-selection + A/V link-group helpers
│   ├── clipboard.ts             # copy / cut / paste (module memory, outside undo)
│   ├── actions.ts               # multi-command UI actions (add media/text, group ops, placement)
│   ├── menus.ts                 # menu bar model: structure, states, action ids
│   ├── workspace.ts             # panel layout state: bounds, sanitize, persist
│   ├── workspace-store.ts       # zustand wrapper over workspace.ts
│   ├── project-io.ts            # shared save / open / import-media / sample helpers
│   ├── sample-media.ts          # bundled samples + load plan (fresh adds, offline relinks)
│   ├── timeline-drop.ts         # drop-target geometry (drop-between-tracks)
│   ├── tracks.ts                # removes the tracks an edit leaves empty (prune)
│   ├── timeline-scroll.ts       # drag edge auto-scroll geometry (pure)
│   ├── store.ts                 # zustand store: history, transients, selection, playhead
│   ├── serialization.ts         # .veproj.json (v3, v1/v2 load): serialize/parse/hydrate
│   ├── persistence.ts           # debounced localStorage autosave + restore
│   ├── media/
│   │   ├── probe.ts             # importFile: probe, thumbnail, waveform peaks, hasAudio
│   │   ├── relink.ts            # relinkPatchFrom: the patch fields a relink carries
│   │   └── elements.ts          # ClipMediaPool (per-clip elements, source nodes, blend partner)
│   ├── playback/
│   │   ├── core.ts              # PlaybackCore: clock, pool, drift, Web Audio, blend partner
│   │   ├── compositor.ts        # drawFrame: tracks, contain-fit, text, crossfades, blends, LUT pass
│   │   ├── denoise.ts           # noise-reduction biquad chain (shared with the export mix)
│   │   ├── preview.ts           # preview engine singleton (attach/detach)
│   │   ├── source-preview.ts    # source monitor element singleton (attach/detach)
│   │   ├── engine-ref.ts        # PlaybackController ref shared by all UI
│   │   └── text-box.ts          # text-box measurement (preview drag outline)
│   ├── export/
│   │   ├── offline.ts           # pure frame/audio export plan (Node-testable)
│   │   └── mp4.ts               # WebCodecs MP4 pipeline, downloadBlob
│   └── __tests__/               # 68 test files (1464 tests) incl. gate.test.ts in src/lib/; mocks/ = browser-mock harness
├── components/editor/
│   ├── EditorShell.tsx          # panel workspace layout, autosave lifecycle, restore banner
│   ├── MenuBar.tsx              # Premiere-style menu bar + shortcuts/about/gain dialogs
│   ├── PanelShell.tsx           # resizable/collapsible panel frame (header, strip)
│   ├── Toolbar.tsx              # history, edit tools, tracks, zoom, save/open, export
│   ├── MediaBin.tsx             # import, samples, relink, drag source, bin selection
│   ├── SourcePanel.tsx           # source monitor: preview, transport, mark In/Out
│   ├── PreviewPanel.tsx         # program monitor canvas + transport
│   ├── InspectorPanel.tsx       # clip properties / project settings
│   ├── StatusBar.tsx            # pinned footer: project info, autosave state
│   ├── ExportDialog.tsx         # quality, progress, cancel, preview, download
│   ├── effect-controls/
│   │   ├── EffectControlsPanel.tsx # keyframes, graph, audio shaping, speed/reverse
│   │   └── AppliedEffectsSection.tsx # effect stack list, picker, keyframe rows, eyedropper
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

- **Selection is id-based**: `store.selections` holds clip ids (primary first); group operations expand A/V link groups, the marquee box selects whole groups, and `Select Track Clips` takes a whole lane plus its link twins. Track targeting is session state: it steers lane-less placements (paste, quick-add, add text) but is not saved into the project file.
- **Export requires WebCodecs**: the MP4 pipeline replaced MediaRecorder/WebM, so very old browsers cannot export (playback still works). ProRes is out of scope because no shipping browser exposes a ProRes `VideoEncoder`; HEVC is left out on value grounds, not because a browser encoder is missing.
- **Keyframe curves are eased, not overshooting**: the presets (linear, easeIn, easeOut, easeInOut) plus free handle editing on any segment, with the control points clamped inside the unit square. There is no Hold interpolation, no spatial interpolation for position paths, and adjacent segments do not share a smooth joint (each side carries its own handle pair).
- **Reverse preview is stepped**, `<video>` cannot play backwards in realtime; the export is frame-accurate but playback shows a stepped approximation. Rate stretch on one half of a linked A/V pair does not re-time the twin (link groups still move/delete/split together).
- **Markers are editor-only**: they render in the timeline and never affect the export (no visual burn-in, no MP4 chapter metadata), and a clip marker that a trim moves out of the visible span is kept in the data but hidden until the clip is extended back. There are no marker spans or marker types.
- **A 3D LUT grades per pixel in JavaScript**: the pass runs at the source's resolution, so a
  multi-clip 4K timeline with 3D cubes is LUT-bound. Measured in this repo's headless Chromium (see
  the benchmark note in CHANGELOG 0.7.0): the pure pass costs about 81 ms per 1080p frame per clip and
  about 327 ms per 4K frame per clip, down from 101 ms and 410 ms before the red-axis table, and three
  graded 4K clips measured about 1.44 s per frame at the old rate (before decode and encode). Each
  clip's cube is decoded from its payload once per session and its red axis is resolved into a table
  once per grid, so the per-frame cost is the pass itself. A 1D cube has no such cost: it rides the
  shared SVG filter chain.
- **Noise reduction is broadband only**: a fixed high-pass/low-pass/hiss-cut chain (native Web Audio biquads); spectral or learned noise reduction is out of scope. Gain is linear 0–2 (+6 dB max).
- **Ripple delete is explicit** — plain Delete leaves the gap; `Shift+Del` closes it. `removeTransition` leaves the overlap behind (harmless: the later clip wins visually).
- **Trim bounds** — video/audio clips are bounded by their source; images and text are unbounded (images have no intrinsic length; they default to 4 s).
- **Missing media is silent** — offline assets render black (video) or nothing (audio) until relinked.
- **Autosave depends on localStorage quota**; large projects with embedded thumbnails/waveforms can exceed it.

Roadmap candidates, roughly in order of impact (the full gap analysis against Premiere, with what
each release already closed, is in [`ROADMAP.md`](ROADMAP.md)):

1. More transitions: dip-to-black fits the existing span/alpha model in `transition.ts`; wipes, slides and pushes additionally need a spatial parameter (a mask or a position offset).
2. Track grouping.

---

For the module-level technical reference — per-file exports, the undo/transient lifecycle, the audio graph, the crossfade model, and the invariant list — see [`docs/architecture.md`](docs/architecture.md). The whole set is indexed at [`docs/README.md`](docs/README.md).

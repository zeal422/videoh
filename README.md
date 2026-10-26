# videoh

A browser-based multi-track video editor. It runs entirely in the tab: no media uploads, no account, and no project database. Your footage stays on your machine. Object URLs, canvas compositing, Web Audio, and WebCodecs do the work.

Live site: <https://videoh.vercel.app>. Source: <https://github.com/zeal422/videoh>. License: [MIT](LICENSE).

The public site is a product page at `/`; the editor is at `/editor`. The site is public. The project is still pre-1.0, not a Premiere replacement. The core path works end to end: import media, cut it on a timeline, preview the result, and export an MP4. The limitations section below lists what is still missing.

Built with Next.js 16, React 19, TypeScript, zustand 5, Tailwind CSS 4, shadcn/ui, and Vitest.

## Features

- **Media import.** Video, audio, and image files come in through the media bin or drag and drop. Multi-select works in the bin. The app probes duration and size, makes JPEG thumbnails, normalizes waveform peaks, and detects audio tracks.
- **Multi-track timeline.** Move a whole selection across compatible tracks, trim either edge, split at the playhead, duplicate, delete, and snap to clip edges, the playhead, or timeline bounds. Add tracks from the `+` button in the timeline corner, the toolbar `+`, or the menus. New tracks follow the text, video, audio order, and `tracks[0]` renders on top.
- **Manageable layers.** Each track header has a context menu, or double-click the name, to rename, mute, or delete the layer. The last lane cannot be deleted. An edit that leaves a layer empty removes it in the same undo step, so a lane never lingers with nothing on it. A lane that was already empty stays, which is what makes "add a layer, then fill it" work. Drag a clip near the top or bottom of the tracks to scroll the timeline and reach an off-screen lane. A drop on the wrong kind of lane marks the lane and rolls the whole drop back, so the clip returns to where it started.
- **Track targeting and select-by-lane.** Every track is targeted by default. Target Track toggles a lane and dims its kind icon; Select Track Clips selects the whole lane and expands A/V link groups. Targeting steers bin quick-add, Add Text, and paste to the first targeted compatible lane, including a video's audio twin. Paste keeps its original lane when that lane is still targeted and compatible. A drag, a duplicate, or a drop onto a compatible lane keeps the lane you pointed at. Targeting is session state, not part of the project file. If no lane of that kind is targeted, the old landing order applies.
- **Compound clips.** Select clips on a video lane and choose Sequence > Create Compound Clip. The selection is replaced by one reusable container; double-click it to open the nested sequence, and use the breadcrumb to return. The container composites as a group, and nested audio mixes through its gain, mute, and volume.
- **Proxies.** A video source over 1920 px on its long edge can build a session-only lower-resolution proxy from the Media bin or the import prompt, and View > Use Proxies toggles it. The proxy preserves the source audio, and the export always reads the original file.
- **Multi-selection and manual A/V linking.** A plain click selects a clip and its link group. Shift+click adds another group; Ctrl+click toggles it; Ctrl+A selects everything. Group operations (move, delete, cut, copy, paste, split, duplicate) act on the whole selection. Drag a box on empty timeline space to select every clip it covers. Shift adds the covered groups, Ctrl toggles them, and the timeline auto-scrolls at the edges. To link, select a video clip and an audio clip with Shift+click, then right-click and choose Link, or press `Ctrl+L`. `Ctrl+L` on a linked selection unlinks it. The Razor tool (`C`) cuts a clip where you click. `Shift+Delete` ripple-deletes the selection and closes the gap.
- **Markers.** Press `M` to drop a marker at the playhead. It lands on the primary selected clip when there is one, source-anchored so trims, speed changes, and reversal keep it on the same media frame. Otherwise it goes on the sequence ruler. Markers have a name, one of eight colors, and notes; double-click one or use Marker › Edit Selected Marker. `Shift+M` and `Ctrl+Shift+M` jump between markers, markers are snap targets for clip drags and trims, and `Delete` removes the selected marker. Sequence markers live in `project.markers`; clip markers live in `clip.markers` in source seconds. Both persist in the project file.
- **A/V linked clips.** Dropping a video that has audio places a linked pair: the video part on the video track and an audio-only twin on the audio track, with its waveform. The pair selects, moves, splits, duplicates, and deletes together. The audio twin is the only sound carrier, so there is no double audio. Right-click any clip for the Premiere-style menu: Cut, Copy, Paste at playhead, Split, Duplicate, Link / Unlink Audio/Video, Delete, and Ripple Delete. After unlinking, each half is independent.
- **Drop between tracks.** Drag media from the bin onto the middle of a row to drop it on that track. Drag it onto a row edge, or the empty strip below the tracks, to insert a new layer at that z-position. A kind-colored insertion line with a `+ V2` or `+ A2` preview shows where the layer will land. This is the quickest way to put one video above, below, or between others in a single gesture.
- **Insert and overwrite placement.** A sticky three-way toolbar control (`Place`, `Insert`, `Overwrite`) picks how a media drop lands in the middle of a lane. Place is the plain drop and the default. Insert shifts every clip at or after the edit point right by the placed span. A straddler splits at the point, its right half moves, and link groups move as one unit so an A/V pair stays in sync. A clip too close to the split headroom is left alone, and the drop still commits. Overwrite replaces the covered span: partial coverage trims to the window edge, interior coverage splits once and head-trims the right fragment, and a remnant under 0.1 s is deleted. Overwrite is all-or-nothing: if a retained side cannot be represented, the whole placement is refused with one toast, so a mixed batch never lands half-applied. While you drag, the lane under the pointer shows an `Insert` or `Overwrite` badge. In those two modes, a drop on the wrong kind of lane is refused instead of silently relocating, which Place still does. One placement is one undo step, and the mode is session state like the active tool.
- **Source monitor and three-point editing.** Click an asset in the media bin to load it into the Source Monitor, one of the six workspace panels and toggleable from the Window menu. A still image appears in the monitor. Play or scrub to the frame you want, mark In and Out with `I` and `O`, then place that span at the sequence playhead with `,` for insert or `.` for overwrite. These keys ignore the toolbar placement mode. One-sided marks leave the other end open, marks clamp to the asset, and an inverted or sub-floor range refuses with one toast and places nothing. Images have no source window, so their controls disable and they place 4 s. Source selection and marks are session state: they clear when you select a different asset or replace the project. Only the preview element's callbacks write the source time, so the readout, the marks, and the placed range cannot disagree.
- **Transitions.** Each clip can carry a `transitionOut` with real overlap. Pick cross-dissolve, dip to black, wipe, slide, or push per transition in the Inspector; the spatial types add a direction picker, and wipes add an edge picker plus a feather slider. The compositor and audio mixer both ramp.
- **Text overlays.** Text tracks and clips support font size, color, family, bold, italic, alignment, position, and shadow. Drag text directly in the program monitor to reposition it. A dashed outline shows the box, one drag is one undo step, and the Inspector's Position X/Y sliders handle precise placement. Title presets store named styles and apply from the Inspector or the Add Text picker.
- **Subtitles and captions.** Import an SRT file to create timed caption cues on their own Captions track. Malformed cues are skipped with a count, and an empty file is refused. The Captions panel beside the timeline lists every cue with editable text and timing, click-to-seek, one-click creation at the playhead, and SRT/VTT download in start order. Captions burn into the MP4 exactly as the monitor shows them.
- **Layer compositing.** Per-clip opacity (0 to 100%) stacks with crossfade alphas. Put a clip on a higher track and lower its opacity, and the track below shows through. It is the same layering model as Photoshop or Premiere.
- **Effects beyond opacity.** Every clip has an ordered effect stack in Effect Controls. It includes crop with four sides, feather, zoom refill, and keyframes; Normal plus sixteen blend modes under Opacity; an eyedropper chroma keyer with despill; track mattes from any higher lane, in luma or alpha and reversible; and motion blur that accumulates animated moves. A track eyeball hides video and text lanes from the composite. Preview and export render every effect the same way.
- **Keyframes and Effect Controls.** Animate opacity, position, scale, volume, and the color set (exposure, contrast, saturation, brightness, hue) per clip. The Inspector splits into Clip and Effect Controls tabs. Each animated value has a slider, a keyframe diamond that adds or removes a key at the playhead, and a graph whose dots drag in time. Each segment eases with its outgoing keyframe's interpolation: linear, ease in, ease out, ease in/out, or one of Premiere's curves. The segmented control sits under the property and edits the visible segment's start keyframe. The graph draws every segment's real bezier shape, and the active segment's two handles are draggable; dragging a straight segment eases it. A per-property default easing applies to new keyframes. That easing also drives the exported gain schedule: an eased volume segment is sampled into short linear ramps because Web Audio has no easing primitive. Keyframe times are clip-local. Splitting a clip redistributes its curves exactly at the cut, eased segments included, so both halves re-time the original. Every keyframe drag is one undo step.
- **Color.** The color set runs through the canvas filter stack in preview and export. A neutral clip skips the filter pass. Temperature and tint (-100 to 100 each) grade white balance through one SVG matrix per graded clip that both render paths use, so the monitor matches the export. The monitor can show a luma histogram, an RGB balance read, a waveform, and a vectorscope; the scopes section is collapsible and off by default.
- **3D LUT import.** Each `.cube` file is stored once in a project-level library, and clips reference it by id. A 1D file applies as exact per-channel shapers in one shared SVG node. A 3D file runs a shared trilinear pixel pass in the preview and the export. The library refuses an import that would push its base64 payloads past 3,000,000 characters, so a large LUT cannot break the autosave quota later.
- **Speed and reverse.** Each clip has a speed from 0.25× to 4×, set by an Inspector slider or an Alt-drag rate stretch on either edge. The source span stays fixed and the speed re-derives. A clip with a time remapping curve is exempt. A reverse toggle handles video. If the command layer rejects a rate stretch, nothing is applied and the app says why. Reverse renders frame-accurately in the export and stepped in the preview; reversed audio is dropped. Below the output frame rate, both render paths blend neighboring frames, so a slowed clip stops juddering in the file and the monitor. The export decodes the pair, the monitor parks a second muted element on the partner read, and one shared weight function in `frame-blend.ts` gives both the same blend. A reversed clip trims from both edges like a forward one: its head shows the span's high source end and its tail the low one, so each edge reveals the source on its own side instead of sliding the picture. Clips carry speed and reverse badges.
- **Time remapping.** A `timeScale` keyframe curve ramps a clip's speed without changing its timeline length. The source time each timeline second consumes is the curve's integral, so cuts, splits, and the export's frame count stay put. Eased segments work here too, and the export samples them into the same curve instead of flattening them. Time remapping and the reverse switch are hidden for anything without a picture, including an A/V pair's audio twin even when it sits on a video track; a ramp there could only mute the pair. On a reversed clip the row mirrors its axis. A dot marks the rate the engine applies at that timeline time, the curve is drawn mirrored, and the easing picker and handles target the active segment's start keyframe on the mirrored axis. The diamond still targets the keyframe nearest the mirrored playhead. A ramped clip renders frame-accurately in the export and drops the audio of its whole link group, because variable-rate audio has no resampler yet. Where its read falls below the output frame rate, both render paths blend the frame pair as they do for a slowed clip. While a curve exists, it is the rate: the static Speed slider, the speed badge, and Alt-drag rate stretch are disabled. The static speed remains the no-curve fallback.
- **Audio control and shaping.** Each clip has linear gain from 0 to 2, mute, and pan. Each track can be muted. Waveforms are drawn per clip. There is a 3-band EQ at 200 Hz, 1 kHz, and 4 kHz, a compressor, a Reduce noise switch, and auto-ducking. Reduce noise is a fixed broadband chain shared by the preview mixer and the export mix. Auto-ducking writes volume keyframes for music under dialogue, estimated from waveform peaks, with a dialogue-source picker.
- **Synced preview playback.** Playback uses an audio-clock-driven master clock, a per-clip media element pool, a canvas compositor, and drift correction.
- **MP4 export through WebCodecs.** Export is offline and produces frame-accurate H.264. A pure frame plan resolves each frame; the exporter decodes source frames instead of seeking elements, composites the animated doc per frame, mixes audio offline, and encodes AAC, or Opus where the browser has no AAC encoder (notably desktop Linux and Firefox). The MP4 has a correct duration header. Wall time tracks decode speed, not realtime capture. Quality presets map to bitrates, and the dialog has progress, cancel, and an in-dialog preview. Export to file streams long renders straight to disk where the File System Access API is available. Export needs a WebCodecs-capable browser: Chromium, Edge, Firefox 130+, or Safari 26+.
- **Undo and redo.** Up to 100 steps of whole-document snapshots. A drag gesture collapses into one undo entry.
- **Save and load project JSON.** `.veproj.json` files preserve media references; object URLs do not survive.
- **Autosave and restore.** Debounced localStorage writes with a restore-or-discard banner on the next visit.
- **Premiere-style menu bar.** File, Edit, Clip, Sequence, Marker, Graphics, View, Window, and Help, driven by a pure, unit-tested menu model. Items whose preconditions are unmet render disabled, so there are no dead entries. A compact full screen button sits beside the version label.
- **Resizable workspace.** The Media, Source Monitor, Program Monitor, Inspector, Timeline, and Captions panels are resizable and collapsible. Sizes, collapsed strips, and panel visibility persist across sessions. The Window menu toggles panels, double-clicking a resize handle resets its neighbor, and small screens fall back to a fixed stacked layout.
- **Appearance palettes.** View > Appearance offers Default and thirteen tinted dark palettes, ordered by hue from Garnet to Orchid, in a two-column picker that scrolls on short windows. A selection applies through the CSS token layer and persists per browser under its own storage key, so Reset Workspace Layout cannot change it. Clip kinds, markers, the monitor, scopes, and the boot splash keep their fixed colors.

## Quick start

```bash
bun install
bun run dev
```

Open <http://localhost:3000/editor>, or the preview URL shown by your workspace. For a demo, click Load sample media in the media bin. It imports the bundled samples from `public/samples/`: `sample-video.mp4`, `sample-audio.mp3`, and `sample-image.png`. Then quick-add them to the timeline with the `+` button on each asset.

Use a current Chromium-based browser for the full feature set. Export also needs WebCodecs, which means Chromium, Edge, Firefox 130+, or Safari 26+.

### Keyboard shortcuts

The map follows Adobe Premiere Pro's default keybindings, checked against Adobe's shortcut docs. Where the browser cannot map a shortcut 1:1, the app-specific extension is marked.

| Key                        | Action                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| `V` / `C`                  | Selection tool / Razor tool (click a clip to cut it)               |
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

Shortcuts are ignored while typing in inputs, textareas, selects, or content-editable elements. A focused button also owns Space; see `src/hooks/editor/useEditorKeyboard.ts`.

**Placing media.** There are two routes, and they are independent:

1. **A bin drop onto a lane** follows the sticky Place / Insert / Overwrite toolbar control. Drag the
   asset onto the middle of a row to drop it there. A mode badge on the lane previews Insert or
   Overwrite. Drag onto a row edge or below the last row to create a new layer at that z-position. That
   path always means "create a track" and ignores the mode. Place is the default, so nothing becomes
   destructive without picking a mode. Insert and Overwrite are one click away and stay armed until you
   switch back.
2. **Three-point editing from the Source Monitor.** Click a bin row to load that asset into the Source
   Monitor; a still image shows in the monitor. Scrub or play to the frame you want, press `I` and `O`
   to mark the in and out points, park the sequence playhead, then press `,` to insert the marked span
   there or `.` to overwrite with it. These keys ignore the toolbar control, and with no marks set they
   place the whole asset. Both routes apply as one undo step, so a single `Ctrl+Z` reverses a placement
   whatever moved with it.

## Architecture

The editor has four layers and one strict direction: UI → command → store → view. The store keeps snapshot history for undo.

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
│   store.ts  : zustand store, whole-Doc snapshot history      │
│   commands.ts: validate + clone + apply (the only mutator)   │
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

- **UI** never mutates state directly. Every edit is a named `EditorCommand` dispatched through `store.apply(...)`, or a transient update during a drag.
- **Commands** validate input, clone the document, and return a new `Doc`. The store keeps a snapshot of the previous doc for undo.
- **The store** is the single source of truth. React components subscribe to slices of it. The playback engine reads the current doc through a `getDoc()` callback and reports the playhead back through the store, which flows to the views.
- **The engine** is framework-free and drives the preview. `PlaybackCore` owns the audio clock, the media element pool, the Web Audio graph, and canvas rendering. Export is separate: it walks the pure frame plan and renders through WebCodecs, with no playback core and no realtime constraint.

The module-by-module reference is in [`docs/architecture.md`](docs/architecture.md). The full documentation set, covering architecture, structure, flows, testing, the design system, and deployment, is indexed at [`docs/README.md`](docs/README.md).

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
            "linkId": "link_…", // A/V link group, shared by the pair's video part and audio twin
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
            "isCaption": true, // caption cue flag for SRT/VTT export, optional (0.8.5)
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
      "url": "blob:…", // object URL, never serialized
      "thumbnail": "data:image/jpeg…", // optional
      "waveformPeaks": [0, 0.42, "…"], // optional, 1000 buckets 0..1
      "missing": false, // true after loading a project until relinked
    },
  ],
}
```

Time model conventions:

- **Timeline position** is `clip.start`, in absolute seconds from the timeline origin. A clip ends at `clip.start + clip.duration`.
- **Source position** is `clip.inPoint`, where playback starts inside the source media. A trimmed clip keeps `duration` on the timeline but moves `inPoint`. The shared `sourceTimeAt(clip, local)` contract maps clip-local time to source time, including reverse mirroring and the `timeScale` curve integral (the static speed is the fallback). The consumed source span must fit the asset for a flat clip; an over-consuming ramp freezes on the last readable frame. A reversed clip reads that span backwards: its head shows `sourceTimeAt(clip, 0)` and its tail shows `sourceTimeAt(clip, clip.duration)`, and a trim moves the anchor on the side the edge gave material back to. Images and text are unbounded.
- **Track order is compositing z-order.** `tracks[0]` is the topmost layer. The default project is `V1` (video) over `A1` (audio) at 1920×1080 (Full HD) and 30fps. New tracks follow the convention of text, then video, then audio. Dropping media between tracks (`addTrack` with `atIndex`) places the layer at the exact z-position you pointed at. Explicit placement skips the convention sort, and any order is legal because the array order is what renders. An audio layer between two video layers is fine.
- Compatibility rules: video and image material goes on `video` tracks, audio goes on `audio` tracks, and text clips go on `text` tracks.

## Command pattern

All mutations flow through 57 named commands in `src/lib/editor/commands.ts`, applied with `applyCommand(doc, command)` or `applyCommands(doc, commands[])`. Each command validates its input and returns a new doc. The input is never mutated. Unknown ids, out-of-bounds trims, and similar errors throw `EditorCommandError`.

| Command                | Description                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addMediaAsset`        | Register an imported media asset in the bin.                                                                                                                                                                              |
| `removeMediaAsset`     | Remove an asset; clips keep a dangling `mediaId`.                                                                                                                                                                         |
| `relinkMedia`          | Patch an asset (usually a fresh `url`) and clear `missing`.                                                                                                                                                               |
| `addSequence`          | Register a compound sequence in the project (duplicate ids and project-id collisions rejected).                                                                                                                           |
| `createCompoundClip`   | Fold selected clips into a new compound sequence and place its container on a video track (cross-sequence, cycle, and depth guards).                                                                                      |
| `addTrack`             | Append a track and re-sort to the text/video/audio order, or, with `atIndex`, insert at that exact z-position without re-sorting (drop-between-tracks).                                                                   |
| `removeTrack`          | Remove a track (the last remaining track is protected).                                                                                                                                                                   |
| `renameTrack`          | Rename a track (empty names are ignored).                                                                                                                                                                                 |
| `toggleTrackMute`      | Flip a track's `muted` flag.                                                                                                                                                                                              |
| `setTrackVisible`      | Toggle a video or text track's visibility in the composite.                                                                                                                                                               |
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
| `setClipBlendMode`     | Set the clip's canvas blend mode, or clear it with `null` back to Normal.                                                                                                                                                 |
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
| `addEffect`            | Add a crop, chroma key, track matte, or motion blur entry to a clip's effect stack.                                                                                                                                       |
| `removeEffect`         | Remove one effect entry from a clip.                                                                                                                                                                                      |
| `setEffectEnabled`     | Enable or bypass one effect entry.                                                                                                                                                                                        |
| `resetEffect`          | Reset one effect entry's parameters to its defaults.                                                                                                                                                                      |
| `setEffectParams`      | Validate and clamp one effect entry's parameters (hostile types refuse).                                                                                                                                                  |
| `setEffectKeyframes`   | Replace one effect property's keyframes; an empty list clears that curve.                                                                                                                                                 |
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

**Undo and redo.** The store pushes a whole-`Doc` snapshot onto `past` before each committed command. `undo` pops it and moves the current doc to `future`. Doc JSON is small, so full snapshots are cheap and every command is easy to reverse. The stack is capped at `HISTORY_LIMIT = 100`. Undo or redo drops a selection whose clip or marker no longer exists in the restored doc.

**Transient gestures.** Timeline drags must not spam the history. A gesture calls `beginTransient()` to snapshot the base doc, applies every pointermove through `applyTransient()` with no history, and finishes with `commitTransient()` or `cancelTransient()`. `commitTransient()` pushes exactly one history entry if the doc actually changed. `cancelTransient()` restores the base. The result is one undo step per drag, no matter how many frames it spanned.

## Playback engine

`PlaybackCore` (`src/lib/editor/playback/core.ts`) drives the preview:

- **Master clock.** The `AudioContext` clock when Web Audio is available; it is sample-accurate and drift-free. Otherwise the engine uses `performance.now()`. On `play()` the timeline time is anchored to the clock, and each `requestAnimationFrame` derives the playhead from the elapsed audio time.
- **Per-clip media pool.** `ClipMediaPool` gives every clip its own `HTMLVideoElement` or `HTMLAudioElement` parked in a hidden container, so two clips can reference the same asset at once, after a split or across tracks.
- **Drift correction.** Every frame the engine compares each active element's `currentTime` with the expected source time from `sourceTimeAt(clip, t - clip.start)`, the one mapping the preview, the plan, and the exporter share, mirroring the span for reversed clips. Drift over `DRIFT_THRESHOLD` (0.4 s) triggers a resync seek. Reversed and time-remapped clips are stepped instead: the element is parked and seeked every tick, because neither a backwards read nor a rate curve can be expressed as a constant `playbackRate`.
- **Frame blending in both paths.** A clip reading strictly below the source frame rate parks a second muted element on the partner read through `blendPartnerTime`, and the pair is composited through one shared canvas routine, `drawBlendedContain`. The weight comes from each path's decoder timestamps: the exporter uses the sample timestamps it fetched, and the preview uses the presented frames its elements report through `requestVideoFrameCallback`. A browser without that API, a partner frame that has not decoded yet, and a stale or seeking element all fall back to the single stepped frame.
- **Web Audio graph.** Each element feeds a `MediaElementAudioSourceNode` into a per-clip `GainNode`, and all of them connect to a master `GainNode` that routes to `audio.destination` for speakers and a `MediaStreamAudioDestinationNode` (`audioStream`). That capture destination is no longer used by export; the exporter mixes in an `OfflineAudioContext` instead. Per-frame gain is `clip.gain × clip mute × track mute × crossfade alpha`, applied with a 20 ms ramp. Pan, EQ, the compressor, and the denoise chain are part of that per-clip chain, which is rebuilt when any of them changes so an edit is audible immediately. Without Web Audio the engine falls back to element `volume`.
- **Compositor rules.** `compositor.ts` composites tracks bottom to top onto a black frame. Video and image clips are drawn contain-fit, letterboxed with the aspect preserved. Text clips render styled, shadowed multi-line text. Two overlapping clips crossfade with complementary alphas; otherwise the later clip wins visually. A sub-frame-rate draw composites its blend pair additively into a scratch canvas and puts the result down once, and the exporter calls the same routine. Audio tracks draw nothing.
- **Scrubbing.** While paused, `seek()` positions active video elements and re-draws once their `seeked` event lands through `drawStill`.

## Export

`exportTimeline` (`src/lib/editor/export/mp4.ts`) renders the timeline to a downloadable MP4 offline. The video is H.264. Audio is AAC, or Opus where the browser cannot encode AAC. There is no MediaRecorder.

- `export/offline.ts` builds a pure frame plan. `exportFrameTimes` quantizes the timeline to the project fps. `planVideoFrame` resolves each frame's draws: source timestamps that honor speed and reverse, crossfade alphas, keyframed opacity, color filter, and transform. `planAudioFrame` resolves the audible contributions with gain, pan, and twin shadowing. Tests verify the plan in Node.
- **Video frames are decoded, not element-seeked.** Mediabunny's `VideoSampleSink` returns the source frame at an exact timestamp, which makes reverse and sub-second speed exact. The plan's composite goes onto an offscreen canvas, with text through the same `drawTextClip` and decoded frames through the same `drawContain` the preview uses, and into a Mediabunny `CanvasSource` with codec `avc`. A frame the plan marks `blendTime` also fetches the partner sample and draws the pair through `drawBlendedContain`.
- **Audio** is mixed in one `OfflineAudioContext` render with the same graph topology as the preview: gain keyframes, pan, EQ, compressor, denoise, and crossfade ramps. It is then encoded as an AAC track, or Opus when `AudioEncoder` cannot do AAC, which covers desktop Linux and Firefox.
- **Quality presets** set the video bitrate: low at about 2.5 Mbps, medium at about 6 Mbps, high at about 12 Mbps.
- The dialog shows progress, supports cancel, previews the result inline, and downloads `<project name>.mp4`.

Known limitations:

- **Export requires WebCodecs.** Chromium, Edge, Firefox 130+, and Safari 26+ qualify. The dialog disables itself and says why on older browsers.
- **HEVC and ProRes are not offered.** ProRes has no browser encoder; no shipping browser exposes a ProRes `VideoEncoder` (mediabunny's compatibility guide, checked 2026-10-07). HEVC is a judgment call rather than a platform limit. An encoder exists and a probe could gate it safely, but H.264 at the shipped bitrates covers the upload path, and the probe, the dialog option, and the per-project even-dimension gating cost more than they return. H.264 video with AAC or Opus audio is the supported target.
- **Export wall time tracks source decode.** It is roughly realtime for 1080p H.264 decoded in software and faster where the browser decodes on the GPU. This is an offline render, not a realtime capture.
- **`Download` buffers the MP4 in memory.** `Export to file` streams it straight to disk and bounds the buffer, so use it for long timelines. The dialog's size estimate points you there past about 100 MB.

## Persistence

- **Project files** use `.veproj.json` (`version: 4`, plus a `savedAt` timestamp; see `serialization.ts`). `serializeDoc` strips object URLs because they are session-bound and cannot persist. The loader hydrates the clip's re-timing, shaping, keyframe, and marker fields, clamping and sanitizing them on the way in. Versions 1, 2, and 3 still load; files from a newer app version are refused instead of loading partially. Version 3 added the project LUT library. Its entries are gated on the way in: a malformed entry, an oversized payload, or a clip `lutId` naming no entry is dropped rather than trusted. A load that drops entries logs one warning naming the count.
- **Loading** hydrates every asset with an empty `url` and `missing: true`; clips whose media vanished entirely lose their `mediaId`. Offline assets render as "offline" in the media bin. A frame that needs them paints Media offline over the monitor, naming the missing files, instead of showing silent black. Relinking is automatic when you re-import a file with a matching name. It also works for the bundled samples, which the app refetches on any load or restore, or manually through the relink button on each offline asset. Recovered samples are merged into the document itself, so a load or restore stays one undo step and the exporter keeps the source bytes it reads.
- **Autosave** writes the serialized doc to `localStorage` under `web-video-editor:autosave:v1`, with an 800 ms debounce, after every committed change. Transient drag frames are skipped, and the final commit triggers exactly one save. Quota or serialization errors surface in the status bar as "Autosave off".
- **Restore.** On startup a valid autosave raises a banner. Restore replaces the current doc and pushes the empty starter doc onto the undo stack. Discard clears the entry.

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

The pure state modules run in a plain Node environment with no browser. The browser-bound `persistence.ts`, `project-io.ts`, and `analytics.ts` helpers use mocked storage, File inputs, or mocked analytics APIs. The DOM-only persistence and project-io paths are covered by the battery; `analytics.ts` DOM paths are covered in jsdom. Tests cover `commands` (validation, splitting, transitions, effects), `store` (history, transient gestures), `snap`, `transition` (span and alpha math), `serialization` (round trips, missing media), `persistence` (debounce, validity), `time` helpers, `menus` (menu structure and state resolution), `workspace` (layout state, sanitization, persistence), the public pages, the SEO metadata, and the license.

The public site at `/` is a server-rendered hero and information page. It shares the editor's dark tokens but never imports the editor store or browser engines. `/editor` is the client-only editor boot. The public pages live under `src/app/(site)`. The sitemap and social image are route files in `src/app`, and the site constants live in `src/lib/seo.ts`.

Current state: **1603 tests across 77 files, all passing**. Coverage is enforced at 70/60/75/70 (statements/branches/functions/lines) over the Node-testable state modules. `menus.ts` and `workspace.ts` are at 100% across all metrics. [docs/testing.md](docs/testing.md) has the file-by-file inventory, the mocked browser harness, and the E2E battery.

## Menu bar and workspace

### Menu bar

The top menu bar follows Adobe Premiere Pro's menu structure, adapted to the features this editor has: File, Edit, Clip, Sequence, Marker, Graphics, View, Window, and Help. Two rules keep the menu honest:

- **No dead items.** Every visible entry maps to a real action. `src/lib/editor/menus.ts` defines the structure, and `MenuBar.tsx` maps action ids to editor operations. Anything the app cannot perform is not rendered.
- **No fake shortcuts.** The shortcut column only lists keybindings that are actually wired in `useEditorKeyboard.ts`.

Item availability comes from the editor context. Undo and Redo follow history depth. Clip actions follow selection state: Split requires the playhead inside the selected clip, and Mute or Audio Gain requires an audio-bearing clip. The Snapping checkbox mirrors the toolbar magnet, and the Window checkboxes mirror panel visibility. The menu model is pure and locked down by `menus.test.ts`.

### Workspace panels

On screens at least 768px wide, the shell is a resizable panel workspace using `react-resizable-panels` through the shadcn Resizable wrappers:

- **Resize.** Drag any handle. Keyboard resizing works out of the box: focus a handle and use the arrow keys. Sizes persist to `localStorage`, debounced while dragging.
- **Collapse.** Each panel header has a chevron. Dragging a handle past the panel minimum also collapses. A collapsed panel becomes a slim strip with its rotated title; click it to expand again.
- **Show and hide.** The Window menu checkboxes close and reopen panels entirely.
- **Reset.** Double-click a resize handle to reset its neighbor to the default size, or use Window › Reset Workspace Layout. It is enabled whenever the layout deviates from the default.

All layout state lives in `src/lib/editor/workspace.ts`, which is pure: defaults, clamping, sanitization, and injected storage. It sits behind the `useWorkspaceStore` zustand wrapper, so a corrupt or hand-edited `localStorage` entry cannot crash the editor. Below 768px the workspace is replaced by the original fixed stacked layout.

## Public site and license

The public site is part of the same Next.js app:

- `/` is the indexable hero with the product story, FAQ, screenshot, and CTAs.
- `/editor` is the editor. It is `noindex, follow` because its content is client-rendered.
- `/about`, `/privacy`, `/terms`, and `/contact` are public pages.
- `/sitemap.xml`, `/robots.txt`, and the Google Search Console verification file are served from the app and `public/`.
- The old access route is gone and returns 404.

The source is MIT licensed. See [LICENSE](LICENSE) and [CONTRIBUTING.md](CONTRIBUTING.md). Optional GoatCounter analytics use `NEXT_PUBLIC_GOATCOUNTER_URL`; leave it empty to disable analytics. See [docs/seo.md](docs/seo.md) for the measurement and Search Console notes.

## Project structure

The full filesystem map lives in [`docs/structure.md`](docs/structure.md). High-level outline:

```text
LICENSE                        # MIT license
CONTRIBUTING.md                # Bun setup, checks, contribution terms
docs/seo.md                    # search, analytics, and release checklist
public/google80671fa4533bcad3.html  # Search Console verification
public/screenshots/editor.png  # real editor screenshot for the hero
public/robots.txt              # allow all plus the sitemap URL
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
│   ├── serialization.ts         # .veproj.json (v4, v1..v3 load): serialize/parse/hydrate
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
│   └── __tests__/               # 77 test files (1603 tests) in src/lib/editor/__tests__; mocks/ = browser-mock harness
├── app/
│   ├── (site)/                  # public hero, About, Privacy, Terms, Contact, site layout
│   ├── editor/page.tsx          # server wrapper with noindex metadata around EditorBoot
│   ├── layout.tsx               # root metadata, Geist fonts, Toaster, GoatCounter
│   ├── sitemap.ts               # MetadataRoute.Sitemap from INDEXABLE_ROUTES
│   ├── opengraph-image.tsx      # 1200x630 social card
│   └── globals.css              # tokens, public-site keyframes, grain, editor scrollbars
├── lib/seo.ts                   # site constants, canonical, pageMetadata, JSON-LD
├── lib/analytics.ts             # GoatCounter events, click beacon, first-export marker
├── components/site/
│   ├── SiteHeader.tsx           # transparent favicon bars + wordmark, About, GitHub, tracked Open editor CTA
│   ├── SiteFooter.tsx           # public links, contact mailto, MIT license
│   ├── Hero.tsx                 # hero, screenshot, features, FAQ, final CTA
│   ├── TimelineHero.tsx         # CSS-only timeline strip with one rose playhead
│   ├── LegalPage.tsx            # shared legal page shell
│   ├── TrackedLink.tsx          # plain anchor that calls trackClick
│   └── GoatCounter.tsx          # optional page-view script
├── components/editor/
│   ├── EditorBoot.tsx           # client-only shell import, 3.2s preloader, retry/reload
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

These limitations are all observable in the current code:

- **Selection is id-based.** `store.selections` holds clip ids with the primary first. Group operations expand A/V link groups, the marquee box selects whole groups, and `Select Track Clips` takes a whole lane plus its link twins. Track targeting is session state: it steers lane-less placements (paste, quick-add, add text) but is not saved into the project file.
- **Export requires WebCodecs.** The MP4 pipeline replaced MediaRecorder and WebM, so very old browsers cannot export; playback still works. ProRes is out of scope because no shipping browser exposes a ProRes `VideoEncoder`. HEVC is left out on value grounds, not because a browser encoder is missing.
- **Keyframe curves are eased, not overshooting.** The presets are linear, easeIn, easeOut, and easeInOut, plus free handle editing on any segment, with control points clamped inside the unit square. There is no Hold interpolation, no spatial interpolation for position paths, and adjacent segments do not share a smooth joint; each side carries its own handle pair.
- **Reverse preview is stepped.** `<video>` cannot play backwards in realtime; the export is frame-accurate, but playback shows a stepped approximation. Rate stretch on one half of a linked A/V pair does not re-time the twin; link groups still move, delete, and split together.
- **Markers are editor-only.** They render in the timeline and never affect the export. There is no visual burn-in and no MP4 chapter metadata. A clip marker that a trim moves out of the visible span is kept in the data but hidden until the clip is extended back. There are no marker spans or marker types.
- **A 3D LUT grades per pixel in JavaScript.** The pass runs at the source's resolution, so a multi-clip 4K timeline with 3D cubes is limited by that pass. In this repo's headless Chromium, the pure pass costs about 81 ms per 1080p frame per clip and about 327 ms per 4K frame per clip, down from 101 ms and 410 ms before the red-axis table. Three graded 4K clips measured about 1.44 s per frame at the old rate, before decode and encode. See the benchmark note in CHANGELOG 0.7.0. Each clip's cube is decoded from its payload once per session, and its red axis is resolved into a table once per grid, so the per-frame cost is the pass itself. A 1D cube has no such cost; it rides the shared SVG filter chain.
- **Noise reduction is broadband only.** A fixed high-pass, low-pass, and hiss-cut chain uses native Web Audio biquads. Spectral or learned noise reduction is out of scope. Gain is linear from 0 to 2, with +6 dB max.
- **Ripple delete is explicit.** Plain Delete leaves the gap; `Shift+Del` closes it. `removeTransition` leaves the overlap behind, which is harmless because the later clip wins visually.
- **Trim bounds.** Video and audio clips are bounded by their source. Images and text are unbounded; images have no intrinsic length and default to 4 s.
- **Offline media is marked.** A frame that needs an offline asset paints a Media offline overlay naming the missing files, audio stays silent, and export refuses until the asset is relinked.
- **Autosave depends on localStorage quota.** Large projects with embedded thumbnails or waveforms can exceed it.

The full gap analysis against Premiere, including what each release has closed and the items deliberately left out, is in [`ROADMAP.md`](ROADMAP.md). It currently lists no open Tier 1 through Tier 3 items.

---

For the module-level technical reference, including per-file exports, the undo and transient lifecycle, the audio graph, the crossfade model, and the invariant list, see [`docs/architecture.md`](docs/architecture.md). The whole set is indexed at [`docs/README.md`](docs/README.md).

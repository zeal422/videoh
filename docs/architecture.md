# Architecture — Web Video Editor

Technical reference for the editor core. For the product overview, quick start, and feature tour,
read the [README](../README.md) first. Sibling docs:
[structure.md](structure.md) (filesystem map) · [flows.md](flows.md) (interaction contracts) ·
[testing.md](testing.md) (test strategy) · [design-system.md](design-system.md) (tokens & UI) ·
[deployment.md](deployment.md) (build & run). Everything below is verified against the source in
`src/lib/editor/` and `src/components/editor/`.

Contents:

1. [Layers and data flow](#layers-and-data-flow)
2. [Module reference](#module-reference)
3. [Undo/redo and transient gestures](#undoredo-and-transient-gestures)
4. [A/V link groups](#av-link-groups)
5. [Timeline z-order](#timeline-z-order)
6. [Audio graph](#audio-graph)
7. [The crossfade model](#the-crossfade-model)
8. [Invariants](#invariants)

## Layers and data flow

Four layers with a single direction of mutation:

```text
UI components ──EditorCommand──▶ store.apply() ──▶ applyCommand() ──▶ new Doc
     ▲                                                                 │
     │                                                                 ▼
UI re-render ◀── zustand subscription ◀── store.set({ doc, past }) ◀── snapshot
```

- Components dispatch commands; they never edit `doc` fields in place.
- `applyCommand` clones the doc, validates, mutates the clone, and returns it. The store snapshots
  the previous doc into `past` (bounded by `HISTORY_LIMIT`).
- The playback engine sits outside React: it reads the current doc through `getDoc()` on every frame
  and pushes time/playing state back into the store, which propagates to the views.
- Export instantiates a second, independent `PlaybackCore` bound to a frozen doc snapshot and an
  offscreen canvas.

## Module reference

All paths below are relative to `src/lib/editor/` unless stated otherwise.

### State core

| File                 | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts`           | Types: `TrackKind`, `MediaKind`, `TextStyle`, `Transition`, `Clip`, `Track`, `Project`, `MediaAsset`, `Doc`, `ResolvedMediaRef`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `constants.ts`       | `MIN_CLIP_DURATION` (0.1), `MIN_SPLIT_HEADROOM` (0.1), `GAIN_MIN`/`GAIN_MAX` (0/2), `OPACITY_MIN`/`OPACITY_MAX` (0/1), `TRANSITION_MIN`/`MAX` (0.1/4), `WAVEFORM_BUCKETS` (1000), `DEFAULT_IMAGE_DURATION`/`DEFAULT_TEXT_DURATION` (4), `PPS_MIN`/`PPS_MAX`/`PPS_DEFAULT` (10/400/80), `SNAP_THRESHOLD_PX` (8), `HISTORY_LIMIT` (100), `TRACK_HEADER_WIDTH` (160), `FRAME_STEPS` (5), project limits (`PROJECT_MIN_W..MAX_W` 64..3840, `PROJECT_MIN_H..MAX_H` 64..2160, `FPS_MIN..FPS_MAX` 1..60)                                                                         |
| `factories.ts`       | `uid(prefix?)`, `createDefaultTextStyle()`, `createTextClip(partial?)`, `createClip(partial?)`, `createTrack(kind, index?, partial?)`, `createProject()` (Full HD 1920×1080 @ 30fps), `createDoc()`, `createMediaAsset(partial)`, `docDuration(doc)`, `findClip`, `findTrack`, `findMedia`, `getClip`, `clipFitsTrack`, `firstCompatibleTrack`, `nextClipOnTrack`, `trackIndexOf`                                                                                                                                                                                         |
| `time.ts`            | `clamp(value, min, max)`, `formatTime(seconds)` (`m:ss.d`), `formatTimecode(seconds, fps)`, `timeToFrame`, `frameToTime`, `stepFrames`, `rulerStep(pxPerSec, minPx?)`                                                                                                                                                                                                                                                                                                                                                                                                     |
| `commands.ts`        | `class EditorCommandError`, type `EditorCommand` (22 variants), `applyCommand(doc, command)`, `applyCommands(doc, commands[])`, re-export of `docDuration`                                                                                                                                                                                                                                                                                                                                                                                                                |
| `snap.ts`            | `interface SnapOptions { excludeClipIds?, playhead?, includeTimelineEnd? }`, `computeSnapPoints(doc, opts?)`, `applySnap(target, points, thresholdSec)`, `snapMove(start, duration, points, thresholdSec)`                                                                                                                                                                                                                                                                                                                                                                |
| `transition.ts`      | `interface TransitionSpan { a, b, start, end, duration }`, `getTransitionSpan(a, b)`, `interface TransitionAlphas { aAlpha, bAlpha }`, `transitionAlphas(span, t)`, `maxTransitionDuration(a, b, aEnd)`                                                                                                                                                                                                                                                                                                                                                                   |
| `links.ts`           | `assetHasAudio(asset)`, `linkedClips(doc, clipId)`, `linkedAudioTwin(doc, clip)`, `hasLinkedAudioTwin(doc, clip)`, `audibleClipId(doc, clipId)`, `groupSelected(doc, selection, clip)`, `selectedLinkGroups(doc, selections)`, `clipIsSelected(doc, selections, clip)`, `distinctLinkGroupCount(doc, clipIds)`, `canLinkClips(doc, clipIds)`, `anySelectionLinked(doc, clipIds)`, `canSplitGroupAt(doc, clipId, at)`, `canSplitAnySelectedAt(doc, clipIds, at)`, `resolveSelectionGroups(doc, clipIds)` — the multi-selection and A/V group helpers every group op shares |
| `clipboard.ts`       | `copyClips(doc, clipIds)`, `commandsToCutClips(doc, clipIds)`, `commandsToPasteClips(doc, atTime)`, `hasClipboardContent()`, `clearClipboard()` — module-memory clipboard, deliberately outside undo/autosave (like an OS clipboard)                                                                                                                                                                                                                                                                                                                                      |
| `actions.ts`         | `commandsToAddMedia(doc, asset, start, trackId?)` (splits video+audio into a linked pair and creates missing tracks), `commandsToAddMediaInNewTrack(doc, asset, start, atIndex)`, `commandsToAddText(doc, start)`, `commandsToDeleteClip(s)`, `commandsToDuplicateClip(s)`, `commandsToSplitClipsAt`, `commandsToSplitAllAt`, `commandsToUnlinkClips`, `commandsToLinkClips`, `commandsToRippleDeleteClips`, `trackKindForMedia(kind)`, `newTrackId()`, `canDropClip()`                                                                                                   |
| `store.ts`           | `type AutosaveStatus`, `interface EditorState`, `useEditorStore` (zustand hook), `editorStore` (raw access for engine + tests), `isTransientActive()`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `serialization.ts`   | `SERIALIZATION_VERSION` (1), `PROJECT_FILE_EXTENSION` (`.veproj.json`), `SerializedMedia`, `SerializedDoc`, `class SerializationError`, `serializeDoc(doc, savedAt?)`, `parseSerializedDoc(text)`, `deserializeDoc(data)`, `projectFileName(name)`                                                                                                                                                                                                                                                                                                                        |
| `persistence.ts`     | `writeAutosave(doc)`, `readAutosave()`, `clearAutosave()`, `readValidAutosave()`, `initAutosave()`, `parseAutosave(json)` (localStorage key `web-video-editor:autosave:v1`, debounce 800 ms)                                                                                                                                                                                                                                                                                                                                                                              |
| `workspace.ts`       | Pure panel-layout state: `PanelId`, per-panel size bounds, `defaultWorkspace`, `sanitizeWorkspace`, `withHidden`/`withCollapsed`/`withSize`, injected-storage save/load                                                                                                                                                                                                                                                                                                                                                                                                   |
| `workspace-store.ts` | `useWorkspaceStore` — zustand wrapper: debounced size persistence, collapsed-size detection, layout reset                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `menus.ts`           | Pure menu model: `MENU_SPECS`, `MenuContext`, `buildMenus(ctx)`, `collectMenuActions` — 28 real action ids                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `project-io.ts`      | `downloadProjectJSON`, `loadProjectFile`, `importMediaFiles`, `pickFiles` — shared save/open/import helpers used by the toolbar, media bin, and menu bar                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `sample-media.ts`    | `SAMPLES` (`/samples/*`), `filterNewSamples(bin, samples)` — idempotent sample loading                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `timeline-drop.ts`   | `computeTrackDropTarget(yInRows, heights)`, `mediaKindFromDragEvent(e)`, `TRACK_DROP_EDGE_PX` (12) — pure drop-target geometry for drop-between-tracks                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Media

| File                | Exports                                                                                                                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media/probe.ts`    | `class MediaImportError`, `detectKind(file)` (MIME first, then extension map), `importFile(file)` → `Promise<MediaAsset>` (probes duration/size, JPEG thumbnail ≤160 px, `decodeAudioData` peaks + `hasAudio`), `computePeaks(buffer, buckets?)` (max-abs, normalized 0..1) |
| `media/elements.ts` | `class ClipMediaPool`: `get(clip, asset)` (one element per clip, recreated after relink), `getSourceNode(el, ctx)` (one `MediaElementAudioSourceNode` per element per context, `WeakMap`-cached), `pauseAll()`, `release(clipId)`, `dispose()`                              |

### Playback

| File                     | Exports                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playback/core.ts`       | `interface PlaybackCoreOptions { canvas, getDoc, onFrame?, onEnd?, onPlayingChange? }`, `class PlaybackCore`: `audioStream`, `currentTime`, `isPlaying`, `prepare()`, `play(from?)`, `pause()`, `toggle()`, `seek(t)`, `stepFrames(n)`, `setMasterVolume(v)`, `syncResolution()`, `dispose()`. Private `DRIFT_THRESHOLD = 0.12` |
| `playback/compositor.ts` | `type MediaResolver`, `interface DrawFrameInput { ctx, doc, time, resolve }`, `drawFrame(input)` — pure w.r.t. app state; media frames arrive via `resolve`; folds `clip.opacity` into every visual draw                                                                                                                        |
| `playback/preview.ts`    | `attachPreviewEngine(canvas)` → `PlaybackController` (app-wide singleton), `detachPreviewEngine()`, `refreshPausedPreview()`, `seekToEnd()`                                                                                                                                                                                     |
| `playback/engine-ref.ts` | `interface PlaybackController`, `playbackRef` (module-level ref used by all UI), `exportStateRef`                                                                                                                                                                                                                               |
| `playback/text-box.ts`   | `measureTextBox(clip, ctx, canvasW, canvasH)` — geometry twin of the compositor's text renderer (same font string, 1.2 line height, align/anchor semantics); powers the preview drag outline                                                                                                                                    |

### Export

| File                 | Exports                                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export/exporter.ts` | `interface ExportHandle { cancelled }`, `interface ExportResult { blob, mimeType, duration }`, `interface ExportOptions { onProgress?, quality? }`, `exportTimeline(doc, opts?, handle?)`, `downloadBlob(blob, filename)`. Private `BITRATES` (low 2.5 / medium 6 / high 12 Mbps) |

### UI components (`src/components/editor/`)

| File                                    | Exports                               | Responsibility                                                                     |
| --------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| `EditorShell.tsx`                       | `EditorShell`                         | Layout; starts autosave + restore banner; window `pointerup`/`blur` safety net     |
| `MenuBar.tsx`                           | `MenuBar`                             | Premiere-style menu bar; maps `menus.ts` action ids to editor operations           |
| `PanelShell.tsx`                        | `PanelShell`                          | Resizable/collapsible panel frame (header, actions, collapsed strip)               |
| `Toolbar.tsx`                           | `Toolbar`                             | Undo/redo, select/razor tools, split/duplicate/delete, add text/track, save/export |
| `MediaBin.tsx`                          | `MediaBin`                            | Multi-file import, "Load sample media", quick-add, drag source, relink, remove     |
| `PreviewPanel.tsx`                      | `PreviewPanel`                        | Attaches the preview engine; transport, time display, volume; text-drag overlay    |
| `InspectorPanel.tsx`                    | `InspectorPanel`                      | Selected-clip properties (timing, gain/mute, opacity, text style, transition)      |
| `StatusBar.tsx`                         | `StatusBar`                           | Pinned footer: project info, selection count, zoom, undo depth, autosave state     |
| `ExportDialog.tsx`                      | `ExportDialog`                        | Quality select, progress, cancel, result preview, download                         |
| `timeline/TimelinePanel.tsx`            | `TimelinePanel`, `TRACK_HEADER_WIDTH` | Track lanes, playhead, drop targets, zoom, add-track menu                          |
| `timeline/Ruler.tsx`                    | `Ruler`                               | Canvas ticks/labels, doubles as the scrub surface                                  |
| `timeline/ClipView.tsx`                 | `ClipView`                            | Pointer gestures (move/trim), context menu, link badge, fade overlays              |
| `timeline/Waveform.tsx`                 | `Waveform`                            | Draws the asset peak slice `[inPoint, inPoint + duration]`, DPR-aware              |
| `src/hooks/editor/useEditorKeyboard.ts` | `useEditorKeyboard(onSave)`           | Global shortcuts, skipped inside form fields                                       |

## Undo/redo and transient gestures

History is a pair of whole-`Doc` snapshot stacks (`past`, `future`) capped at `HISTORY_LIMIT = 100`.
Committed commands push; undo/redo pop between the stacks. Drag gestures wrap the same machinery so
that one gesture equals one history entry.

```text
 Committed command                      Drag gesture (transient)
 ────────────────────                   ─────────────────────────────────────────
 UI: store.apply(cmd)                   UI: beginTransient()
        │                                       │
 applyCommand(doc, cmd)                 transientBase = clone(doc)
 = clone → validate → mutate                    │
        │                               each pointermove:
 set({ doc: next,                       UI: applyTransient(cmd)
      past: past + [oldDoc],              = applyCommand(doc, cmd)   ← no history push
      future: [] })                         invalid mid-drag states are
        │                                   swallowed to keep the gesture smooth
 any later apply()                              │
 clears `future`                       pointerup:
                                               │
 undo():                                commitTransient()
   past.pop() → doc,                      changed? past + [transientBase]
   doc → future[0]                        transientBase = null   (1 undo entry)
 redo():                                        │
   future.shift() → doc,                cancelTransient()
   doc → past.push                        doc = transientBase (discard changes)
```

Details worth knowing:

- `commitTransient()` compares the base and current docs by JSON equality; a click-without-drag
  pushes nothing.
- The transient flag is module-level (`isTransientActive()`), cleared _before_ the final `set()` so
  the autosave subscription observes a settled state and schedules the save. This ordering was a real
  bug source (fixed before the initial commit).
- `EditorShell` listens for `window` `pointerup` and `blur` and commits any dangling gesture, so
  history can never stay open after pointer capture is lost.
- `undo`/`redo` drop the selection when the selected clip does not exist in the restored doc
  (`normalizeSelections` filters dangling ids, so deleting selected clips never leaves ghosts).
- `replaceDoc` (project load, autosave restore) pushes the previous doc onto `past` too, so even
  loading a project is undoable.

## A/V link groups

A video that carries audio is placed as **two clips sharing one `linkId`**: the video part on a video
track and an `audioOnly` twin on an audio track. The group is the unit of editing until it is
unlinked.

- **Data.** `Clip.linkId` bonds the pair; `Clip.audioOnly` marks the sound-only twin;
  `MediaAsset.hasAudio` records whether the source has a decodable audio track (probed at import,
  with a waveform-peaks fallback for legacy saves).
- **No double audio.** `PlaybackCore.computeGain` sets the video part's embedded audio gain to 0
  while its linked twin exists (`hasLinkedAudioTwin`, which never applies to the carrier itself). The
  video element keeps playing to feed compositor frames. Unlinking unmasks the embedded audio.
- **Group operations.** Delete, split, duplicate, cut/copy/paste, and move all expand the selection
  through `resolveSelectionGroups` and run as ONE undoable batch. `splitClip` gives the right halves a
  single fresh `linkId`, so a split pair stays paired.
- **Manual linking.** `linkClips` bonds any 2+ non-text clips from ≥2 distinct groups; the first
  existing group id wins so unselected partners stay bonded. `Ctrl+L` unlinks when the selection is
  already linked, otherwise links it.

## Timeline z-order

`tracks[0]` is the topmost compositing layer; the compositor draws last-to-first. Any array order is
render-legal.

- Conventional order is text → video → audio, applied by `addTrack` when no explicit position is
  given.
- `addTrack` with `atIndex` splices the track at an exact z-position and **skips** the convention
  sort — dropping media between tracks is explicit layering intent, so it wins.
- New tracks of a kind insert at the head of that kind's group (Premiere semantics: a newer `V2`
  stacks above `V1`).

## Audio graph

Built lazily by `PlaybackCore.ensureAudio()`; one graph serves preview and export. Element routing is
set up per clip on demand in `applyGain()`.

```text
HTMLVideoElement / HTMLAudioElement   (one per clip — ClipMediaPool)
        │
        ▼
MediaElementAudioSourceNode           (one per element per AudioContext)
        │
        ▼
GainNode  (per clip)                  gain = clip.gain × clip.muted × track.muted
        │                                    × crossfade alpha × (twin-shadowed ? 0 : 1)
        ▼
GainNode  (master)                    volume = preview master volume (0..1)
        ├──▶ AudioContext.destination                  (speakers — preview)
        └──▶ MediaStreamAudioDestinationNode           (export tap → MediaRecorder)
```

Fallbacks and edge cases:

- No `AudioContext` (or construction throws): the clock falls back to `performance.now()` and gain is
  applied via `element.volume`, clamped to 0..1 (so gain > 1 is only possible with Web Audio).
- Autoplay policy: `prepare()` creates/resumes the context and is called from user-gesture call
  chains (transport click, export start).
- The master volume ramp uses `setTargetAtTime` with a 20 ms time constant to avoid zipper noise.

## The crossfade model

One transition type exists: `crossfade`. The model is asymmetric and deliberately
render-time-tolerant:

1. **The transition lives on the outgoing clip.** `clipA.transitionOut = { type: 'crossfade', duration }`
   means "dissolve from A into whatever follows A on the same track."
2. **Overlap is real, not virtual.** `addTransition` pulls the next clip left so its head overlaps A's
   tail by exactly the (clamped) duration: `b.start = a.start + a.duration - duration`. The duration is
   clamped to `TRANSITION_MIN..TRANSITION_MAX` and to `maxTransitionDuration(a, b, aEnd)`.
3. **The effective duration is clamped at render time.** `getTransitionSpan(a, b)` computes
   `overlap = a.end - b.start` and uses `min(requested, overlap)`; if the overlap disappears there is
   no transition, and later moves/trims shorten it instead of breaking it.
4. **Rendering.** Over `[b.start, b.start + effectiveDuration]`, `transitionAlphas(span, t)` yields
   linear complementary alphas (`aAlpha = 1 - p`, `bAlpha = p`); both are fully opaque outside the span.
5. **Audio follows the same math.** `computeGain` multiplies the outgoing gain by `1 - p` and the
   incoming gain by `p` inside the same span, so the video dissolve and audio ramp stay in sync.
6. **`removeTransition` only clears the flag.** The next clip keeps its overlap; visually the later clip
   wins during the overlap, which keeps undo semantics predictable.

Splitting interacts correctly: `splitClip` moves the outgoing clip's `transitionOut` to the right-hand
fragment and clears it on the left fragment.

## Invariants

Rules the codebase relies on; new code must preserve them.

1. **Commands never mutate the input doc.** `applyCommand`/`applyCommands` `structuredClone` first;
   every mutation happens on the clone.
2. **All times are seconds (floats).** No frames, no milliseconds anywhere in the model; frame
   conversion exists only in `time.ts` helpers.
3. **Timeline position is `start + duration`; source position is `inPoint`.** For video/audio,
   `inPoint >= 0` and `inPoint + duration <= asset.duration`; images and text are unbounded.
4. **`tracks[0]` is the topmost compositing layer.** The compositor draws last-to-first; `addTrack`
   re-sorts to text → video → audio unless an explicit `atIndex` is given.
5. **Clips keep their `mediaId` after asset removal.** Missing media is a render/UI concern
   (`missing: true`, relink flow), never a silent clip edit.
6. **Object URLs are never serialized.** `serializeDoc` strips `url`; `deserializeDoc` hydrates assets
   with `url: ''` and `missing: true`.
7. **`MIN_CLIP_DURATION` (0.1 s) is the floor.** `addClip`/`trimClip` reject shorter durations;
   `deserializeDoc` clamps hydrated clips to at least 0.05 s rather than dropping data.
8. **Splits need headroom.** `splitClip` requires `at` to be at least `MIN_SPLIT_HEADROOM` (0.1 s)
   inside both edges.
9. **Gain is linear and clamped** to `GAIN_MIN..GAIN_MAX` (0..2); **opacity is clamped** to
   `OPACITY_MIN..OPACITY_MAX` (0..1) and omitted at 1 to keep saved files clean.
10. **History is whole-doc snapshots, capped at `HISTORY_LIMIT` (100).** Anything undoable must live
    inside `Doc`; playhead, zoom, selection, and snap line are deliberately non-undoable.
11. **At most one transient gesture may be active.** `beginTransient` overwrites `transientBase`;
    window-level `pointerup`/`blur` guarantee the gesture is committed or cancelled.
12. **The last track cannot be removed** (`removeTrack` throws when one track remains).
13. **Track compatibility is enforced at the command layer**: video/image on `video` tracks, audio on
    `audio` tracks, text clips on `text` tracks (`clipFitsTrack`). `audioOnly` twins of video assets
    are the exception that admits them to `audio` tracks.
14. **A link group edits as one unit.** Every group operation resolves the union of link groups and
    commits a single history entry; `splitClip` re-pairs right halves with a fresh `linkId`.
15. **The store is the single source of truth.** The engine reads via `getDoc()` and never holds a
    stale doc reference; export binds to an explicit doc snapshot on purpose.
16. **Serialization validates before trusting.** `deserializeDoc` coerces unknown fields to defaults,
    drops non-finite numbers, and raises `SerializationError` for a wrong `version` or missing
    `project.tracks` rather than producing a half-broken doc.

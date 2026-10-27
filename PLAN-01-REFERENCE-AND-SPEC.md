# PLAN 01: Reference, spec, and filmstrip spike

Status: done
Depends on: [PLAN-EDITOR-PARITY.md](PLAN-EDITOR-PARITY.md)
Release: none
Goal: turn the local reference into a testable scope, freeze the geometry, and prove the filmstrip
approach before any product code is written.

## Scope

This plan produces decisions and evidence, not shipped UI. It adds a temporary local spike script
under `.design/editor-parity/`, a committed `.gitignore` entry, and the committed
`e2e/fixtures/editor-parity.veproj.json` fixture. It does not change the editor's behavior.

Deliverables:

1. The reference image saved locally and excluded from git.
2. A row-by-row element inventory with current file evidence.
3. A geometry contract for every later plan.
4. A deterministic demo-project fixture built from bundled samples.
5. A filmstrip spike with a go/no-go verdict and measured numbers.
6. A repeatable screenshot and narrow-width comparison procedure.

## Non-goals

- No production component, store, command, or serialization change.
- No version bump, changelog entry, or public screenshot update.
- No new media assets.
- No pixel-perfect recreation of the reference's brand or footage.

## 1. Local reference

The image is AI-generated from the owner's prompt. It is internal and must not be published.

Tasks:

- Create `.design/editor-parity/` at the repo root.
- Copy the owner-provided image to `.design/editor-parity/editor-target.png`.
- Add `.design/` to `.gitignore` if it is not already ignored.
- Committed artifacts: the plan docs, the `.gitignore` change, and
  `e2e/fixtures/editor-parity.veproj.json`. Do not commit `.design/editor-parity/` (the image, its
  README, and the spike script) or the spike screenshot. The fixture is a required committed test
  input, not a local-only artifact.
- Put the temporary spike script at `.design/editor-parity/spike.ts` so the ignore rule covers it.
  It is local-only and is deleted with the directory in Plan 07.
- Record in this file: the actual dimensions (the supplied file is 1586x992), SHA-256, source
  (owner prompt, AI-generated), date added, and the retirement rule.
- Add a local `README.md` beside the image that says it is not a shipped asset and must be deleted
  at the final plan. The README stays untracked with the image.
- Verify `git status --short` does not show the image and
  `git ls-files --error-unmatch .design/editor-parity/editor-target.png` exits nonzero. If either
  check fails, stop and fix the ignore rule.

Retirement rule: Plan 07 deletes `.design/editor-parity/` after the real
`public/screenshots/editor.png` capture passes review. If the local folder is removed earlier by
accident, the plan docs and the owner still hold the intent; do not substitute a stock image.

Recorded provenance:

- Dimensions: 1586x992.
- SHA-256: `feb5a439014967a10e99b2bb26fb9f6ec709cd208b0ec740ee0a7e3dfa126066`.
- Source: owner-supplied AI-generated image, added 2026-10-27.
- Local README: `.design/editor-parity/README.md` (untracked).

## 2. Element inventory

Expand the orchestrator's one-page map into a row-by-row checklist. Every row must name:

- the region and element;
- the reference behavior, including what is visible only at the target width;
- the current behavior with a file and line reference verified by opening the file;
- the classification: exists, restyle, new behavior, or out of scope;
- the owning plan;
- the proof method: unit test, mocked browser test, static source lock, browser check, or manual
  visual check.

Regions to cover, at minimum:

- Menu bar: wordmark, nine menus, full-screen button, version.
- Toolbar: history, tools, placement modes, edit actions, text, add track, snap, zoom, project name,
  save/open, export.
- Media bin: heading, import, sample button, cards, thumbnails, metadata, hover actions.
- Program monitor: canvas, empty state, offline state, scopes, transport, time, volume.
- Inspector: tab strip, Clip summary, Timing, Opacity, Blend, Audio, Color, Transition, Effect
  Controls, Speed, keyframe graph.
- Timeline: panel header, add-track control, ruler, playhead, snap guide, track headers, video and
  audio rows, clip label, linked badge, waveform, trim handles, context menu, scrollbars.
- Status bar: project name, format, duration, selection, track counts, autosave.
- Panel frame: headers, chevrons, handles, collapsed strips, default shares.
- Responsive behavior: 1600x1000, 1280x800, 1024x768 narrow desktop, 390x844 mobile.

The inventory is the source of truth for "exact". If an element is not in the inventory, Plan 07
cannot claim it was missed or delivered.

To keep the hand-written list from silently missing a control, enumerate every interactive element in
the rendered editor (buttons, links, inputs, sliders, menu items) and reconcile the names and count
against the table. A name in the DOM with no row is an inventory gap; a row with no DOM element is an
out-of-scope or unmounted item, and must say which.

### Inventory method

Verified on 2026-10-27 at 1600x1000 with `e2e/fixtures/editor-parity.veproj.json` loaded. Source and
Captions were visible for the control count, then hidden for the capture. The DOM exposed 74 visible
interactive controls plus 47 menu items across 9 menus. The region rows below group the 74 controls
and list every label in each group. The 47 menu items have their own labeled manifest after the
region table. A label in the DOM with no row is an inventory gap.

### Region inventory

| Region / element                                  | Reference behavior                                                                               | Current behavior (file:line)                                                                                                                                                | Class                             | Owner  | Proof                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------ | ----------------------------------------------------------------- |
| Menu bar: wordmark                                | Compact `videoh` at the far left, before File                                                    | No wordmark; the menu triggers start at the left edge (`MenuBar.tsx:606-629`)                                                                                               | New behavior                      | 02     | Render test, browser visibility at 1600 and 390                   |
| Menu bar: nine menus                              | File, Edit, Clip, Sequence, Marker, Graphics, View, Window, Help                                 | Same nine triggers (`menus.ts:190-557`, `MenuBar.tsx:606-629`)                                                                                                              | Exists                            | 02     | `menus.test.ts`, browser open each menu                           |
| Menu bar: 47 menu items                           | Reference menus are closed; no item is visible to compare                                        | 47 item/checkbox rows, all mapped to a real action, no dead rows (`menus.ts:190-557`); labeled manifest below                                                               | Exists                            | 02     | `menus.test.ts`, open each menu and check enabled/disabled states |
| Menu bar: full screen                             | Present at the top right                                                                         | Present (`MenuBar.tsx:686`)                                                                                                                                                 | Exists                            | 02     | Render test, browser toggle                                       |
| Menu bar: version                                 | `v0.11.0` at the top right                                                                       | Present (`MenuBar.tsx:704`)                                                                                                                                                 | Exists                            | 02     | Render test                                                       |
| Toolbar: project name                             | Center field, full project name                                                                  | Center field (`Toolbar.tsx:353-366`); truncates to `Editor` at 1024                                                                                                         | Restyle                           | 02     | Render test, browser at 1600, 1280, 1024                          |
| Toolbar: history                                  | Undo and redo arrows                                                                             | Undo/redo buttons (`Toolbar.tsx:166-180`)                                                                                                                                   | Exists                            | 02     | Render test, browser undo/redo                                    |
| Toolbar: tools                                    | Selection and razor; the epic adds ripple, slip, Pen                                             | Select/razor only (`Toolbar.tsx:184-196`)                                                                                                                                   | New behavior                      | 06     | Render test, shortcut test, browser                               |
| Toolbar: placement                                | Place, Insert, Overwrite, grouped and sticky                                                     | Same three buttons (`Toolbar.tsx:200-232`)                                                                                                                                  | Exists                            | 02     | Render test, browser                                              |
| Toolbar: edit actions                             | Split, duplicate, delete                                                                         | Same three buttons (`Toolbar.tsx:236-254`)                                                                                                                                  | Exists                            | 02     | Render test, browser                                              |
| Toolbar: text                                     | Add text and preset menu                                                                         | Present (`Toolbar.tsx:258-306`)                                                                                                                                             | Exists                            | 02     | Render test, browser                                              |
| Toolbar: add track                                | Plus button with video/audio/text menu                                                           | Present (`Toolbar.tsx:307-329`)                                                                                                                                             | Exists                            | 02     | Render test, browser                                              |
| Toolbar: snap and zoom                            | Magnet, zoom out, zoom in                                                                        | Present (`Toolbar.tsx:333-351`)                                                                                                                                             | Exists                            | 02     | Render test, browser                                              |
| Toolbar: project IO                               | Save, open, export                                                                               | Present (`Toolbar.tsx:368-398`)                                                                                                                                             | Exists                            | 02     | Render test, browser save/open/export                             |
| Media bin: heading and actions                    | MEDIA heading, Import, Load sample media                                                         | Present (`MediaBin.tsx:136-180`)                                                                                                                                            | Exists                            | 02     | Render test, browser                                              |
| Media bin: cards                                  | Wider card, larger 64x40 thumbnail, name, kind, duration                                         | 40px square thumbnail, name, kind, duration (`MediaBin.tsx:240-297`); names truncate at 1024                                                                                | Restyle                           | 02     | Render test, browser at all four widths                           |
| Media bin: hover actions                          | Add to timeline, remove from bin                                                                 | Present (`MediaBin.tsx:293-297`)                                                                                                                                            | Exists                            | 02     | Render test, browser hover                                        |
| Media bin: selection and offline                  | Selected card, offline styling                                                                   | Present (`MediaBin.tsx:240`, `PreviewPanel.tsx:279-292`)                                                                                                                    | Exists                            | 02     | Render test, browser                                              |
| Program monitor: canvas                           | Large 16:9 canvas, fit to the panel                                                              | Present (`PreviewPanel.tsx:237-255`)                                                                                                                                        | Exists                            | 02     | Render test, browser                                              |
| Program monitor: empty state                      | Import or press T prompt                                                                         | Present (`PreviewPanel.tsx:272-278`)                                                                                                                                        | Exists                            | 02     | Render test                                                       |
| Program monitor: offline state                    | Media offline overlay                                                                            | Present (`PreviewPanel.tsx:279-292`)                                                                                                                                        | Exists                            | 02     | Render test, browser                                              |
| Program monitor: scopes                           | SCOPES strip with toggle                                                                         | Present (`PreviewPanel.tsx:298`, `ScopesPanel.tsx:148`)                                                                                                                     | Exists                            | 02     | Render test, browser                                              |
| Program monitor: transport                        | Go to start, previous frame, play/pause, next frame, go to end                                   | Present (`PreviewPanel.tsx:302-345`)                                                                                                                                        | Exists                            | 02     | Render test, browser                                              |
| Program monitor: time                             | Padded `00:02.7 / 00:18.0`                                                                       | Compact `0:02.7 / 0:18.0` (`PreviewPanel.tsx:347-352`, `formatTime`)                                                                                                        | Restyle                           | 02     | Render test, browser at 1600                                      |
| Program monitor: master volume                    | Slider at the right of the transport                                                             | Present (`PreviewPanel.tsx:354-364`)                                                                                                                                        | Exists                            | 02     | Render test, browser                                              |
| Inspector: tabs                                   | Clip and Effect Controls                                                                         | Present (`InspectorPanel.tsx:75-95`)                                                                                                                                        | Exists                            | 02     | Render test, browser                                              |
| Inspector: clip summary                           | File name, source, dimensions, track, trim, linked hint                                          | Present (`InspectorPanel.tsx:163-247`)                                                                                                                                      | Exists                            | 02     | Render test, browser                                              |
| Inspector: Timing                                 | Start and duration fields                                                                        | Present (`InspectorPanel.tsx:247`)                                                                                                                                          | Exists                            | 02     | Render test, browser                                              |
| Inspector: Opacity and Blend                      | Opacity slider, blend mode select                                                                | Present (`InspectorPanel.tsx:289-352`)                                                                                                                                      | Exists                            | 02     | Render test, browser                                              |
| Inspector: Audio                                  | Volume summary and graph in dB                                                                   | Linear gain controls only; no dB graph (`InspectorPanel.tsx:474-535`)                                                                                                       | New behavior                      | 04     | Unit and mocked browser tests                                     |
| Inspector: Color grade                            | Temperature, tint, LUT                                                                           | Present (`InspectorPanel.tsx:353-473`)                                                                                                                                      | Exists                            | 02     | Render test, browser                                              |
| Inspector: Transition out                         | Type, direction, duration, remove                                                                | Present (`InspectorPanel.tsx:535-743`)                                                                                                                                      | Exists                            | 02     | Render test, browser                                              |
| Inspector: Effect Controls, speed, keyframe graph | Full property stack with keyframes                                                               | Present (`EffectControlsPanel.tsx:144`)                                                                                                                                     | Exists                            | 04, 06 | Render and mocked browser tests                                   |
| Inspector: project settings                       | Width, height, frame rate when nothing is selected                                               | Present (`InspectorPanel.tsx:1062`)                                                                                                                                         | Exists                            | 02     | Render test                                                       |
| Timeline: panel header and add track              | Header, add-track plus, collapse chevron                                                         | Present (`TimelinePanel.tsx:697-698`, `PanelShell.tsx:34-152`)                                                                                                              | Exists                            | 02     | Render test, browser                                              |
| Timeline: ruler                                   | Padded `mm:ss` labels, no decimal                                                                | Compact `formatTime` labels (`Ruler.tsx:10-110`)                                                                                                                            | Restyle                           | 02     | Render test, browser                                              |
| Timeline: playhead and scrub                      | Red playhead, drag to scrub, snap guide                                                          | Present (`Ruler.tsx:87`, `TimelinePanel.tsx:717-735`)                                                                                                                       | Exists                            | 02     | Render test, browser                                              |
| Timeline: track headers                           | 168px, kind icon, short name, eye/mute, no clip count                                            | 160px, kind icon, name, clip count, eye/mute (`TimelinePanel.tsx:72-76`, `:994-1106`; `constants.ts:80`)                                                                    | Restyle                           | 02     | Render test, browser at all widths                                |
| Timeline: track controls                          | Eye for visual tracks, mute for audio, target icon in the header                                 | Eye/mute; target stays in the context menu (`TimelinePanel.tsx:1045-1106`), a recorded deviation                                                                            | Restyle                           | 02     | Render test, browser                                              |
| Timeline: M/S/lock                                | Mute, solo, lock on every track header                                                           | Absent; only eye/mute and the context-menu target (`TimelinePanel.tsx:994-1106`)                                                                                            | New behavior                      | 05     | Unit, mocked browser, render tests                                |
| Timeline: video and audio rows                    | Five video and four audio rows at 44/40px                                                        | Five video and four audio rows at 64/56px (`TimelinePanel.tsx:72-76`, `:797-840`)                                                                                           | Restyle                           | 02     | Render test, browser                                              |
| Timeline: clips                                   | Filmstrip frames, label, linked badge, speed/transition badges, trim handles                     | Color block, label, badges, trim handles (`ClipView.tsx:774-906`)                                                                                                           | New behavior                      | 03     | Planner and mocked browser tests                                  |
| Timeline: waveform rule                           | Linked video half clean; solo video keeps waveform; audio keeps waveform                         | Waveform on any audio-bearing asset (`ClipView.tsx:819`, `Waveform.tsx:11`)                                                                                                 | New behavior                      | 03     | Render test                                                       |
| Timeline: volume envelope                         | Line and draggable dots on audio clips                                                           | Absent                                                                                                                                                                      | New behavior                      | 04     | Planner and mocked browser tests                                  |
| Timeline: markers                                 | Sequence marker at the playhead, clip markers                                                    | Present (`SequenceMarkers.tsx`, `ClipMarkers.tsx`)                                                                                                                          | Exists                            | 02     | Render test, browser                                              |
| Timeline: context menus                           | Clip and track context menus, target track                                                       | Present (`ClipView.tsx:919-965`, `TimelinePanel.tsx:1071-1106`)                                                                                                             | Exists                            | 02     | Render test, browser                                              |
| Timeline: scrollbars                              | Horizontal and vertical scroll when the content exceeds the panel                                | Present (`TimelinePanel.tsx:659`)                                                                                                                                           | Exists                            | 02     | Browser at 1280, 1024                                             |
| Timeline: ripple, slip, Pen                       | Real tools with mode, shortcut, cursor, behavior                                                 | Absent (`EditorTool` is select/razor)                                                                                                                                       | New behavior                      | 06     | Planner, gesture, shortcut, browser tests                         |
| Status bar: project, format, duration             | Project name, format, timeline duration                                                          | Present (`StatusBar.tsx:9-56`)                                                                                                                                              | Exists                            | 02     | Render test                                                       |
| Status bar: selection                             | `Selected clip 00:00–00:04.2` plus `4.2s`                                                        | `Selected clip 0:00.0–0:04.2`, no duration (`StatusBar.tsx:40-53`)                                                                                                          | Restyle                           | 02     | Render test                                                       |
| Status bar: track counts                          | Five video and four audio counts, text tracks omitted                                            | Absent (`StatusBar.tsx:40-53`)                                                                                                                                              | New behavior                      | 02     | Render test                                                       |
| Status bar: px/s and undo steps                   | Not shown                                                                                        | Visible (`StatusBar.tsx:51-52`)                                                                                                                                             | Restyle                           | 02     | Render test, browser                                              |
| Status bar: autosave                              | Autosave indicator and clock                                                                     | Present (`StatusBar.tsx:53-76`)                                                                                                                                             | Exists                            | 02     | Render test                                                       |
| Panel frame: headers, chevrons, handles           | Collapsible headers and double-click reset                                                       | Present (`PanelShell.tsx:34-152`)                                                                                                                                           | Exists                            | 02     | Render test, browser                                              |
| Panel frame: collapsed strips                     | Slim strip with a restore chevron                                                                | Present (`PanelShell.tsx:118`, `COLLAPSED_SIZE_PCT`)                                                                                                                        | Exists                            | 02     | Render test, browser                                              |
| Panel frame: default shares                       | Media 24%, inspector 26%, timeline 50%                                                           | Media 20%, inspector 26%, timeline 38% (`workspace.ts:45-56`)                                                                                                               | Restyle                           | 02     | Unit sanitizer/reset tests, browser                               |
| Panel frame: panel tree                           | Media in the upper row; inspector full height on the right; timeline spans the lower left/center | Media is a full-height root column; timeline is inside the main column and starts at the media edge; inspector is top-right with captions below (`EditorShell.tsx:368-545`) | Restyle                           | 02     | Browser at 1600                                                   |
| Panel frame: Source monitor                       | Hidden for the demo                                                                              | Visible by default; hidden through workspace state (`EditorShell.tsx:411-429`)                                                                                              | Exists                            | 02     | Browser                                                           |
| Panel frame: Captions panel                       | Not shown in the reference                                                                       | Visible by default (`CaptionsPanel.tsx:83-320`, `EditorShell.tsx:521-539`); hidden for the demo through workspace state                                                     | Out of scope, hidden for the demo | 02     | Browser                                                           |
| Responsive: 1600x1000                             | Target proportions and density                                                                   | Baseline capture: media full height, timeline starts at the media edge, audio tracks below the fold                                                                         | Restyle                           | 02     | Browser screenshot                                                |
| Responsive: 1280x800                              | No clipped toolbar or status bar; narrow timeline                                                | Toolbar fits; media names and project name truncate; audio tracks below the fold                                                                                            | Restyle                           | 02     | Browser screenshot                                                |
| Responsive: 1024x768                              | Track headers and clip labels readable; narrow timeline                                          | Project name and media names truncate; inspector narrow; timeline scrolls                                                                                                   | Restyle                           | 02     | Browser screenshot                                                |
| Responsive: 390x844                               | Existing compact layout still works                                                              | Compact layout, horizontal toolbar scroll, preview redraws after a seek; audio tracks below the fold                                                                        | Restyle                           | 02     | Browser screenshot                                                |

### Menu item manifest

This is the reconciliation for the 47-item count. `menus.test.ts` asserts presence, label, action id,
and enabled/checked state for every row. The browser check opens the menu and runs the action with
the preconditions needed to enable it. The action-level tests named in the owning plan cover the
behavior itself. A row with no action, or an action with no row, is a defect.

| #   | Menu     | Item                       | Action                    | Proof                                                         |
| --- | -------- | -------------------------- | ------------------------- | ------------------------------------------------------------- |
| 1   | File     | New Project                | `file.newProject`         | `menus.test.ts`; browser with the File menu open              |
| 2   | File     | Open Project…              | `file.openProject`        | `menus.test.ts`; browser file picker                          |
| 3   | File     | Import Media…              | `file.importMedia`        | `menus.test.ts`; browser file picker                          |
| 4   | File     | Save Project               | `file.saveProject`        | `menus.test.ts`; browser save/download                        |
| 5   | File     | Export Media…              | `file.exportMedia`        | `menus.test.ts`; browser export dialog                        |
| 6   | Edit     | Undo                       | `edit.undo`               | `menus.test.ts`; browser after an edit                        |
| 7   | Edit     | Redo                       | `edit.redo`               | `menus.test.ts`; browser after an undo                        |
| 8   | Edit     | Select All                 | `edit.selectAll`          | `menus.test.ts`; browser with clips                           |
| 9   | Edit     | Deselect All               | `edit.deselectAll`        | `menus.test.ts`; browser with a selection                     |
| 10  | Clip     | Split at Playhead          | `clip.split`              | `menus.test.ts`; browser with a selected clip at the playhead |
| 11  | Clip     | Duplicate                  | `clip.duplicate`          | `menus.test.ts`; browser with a selection                     |
| 12  | Clip     | Delete                     | `clip.delete`             | `menus.test.ts`; browser with a selection                     |
| 13  | Clip     | Ripple Delete              | `clip.rippleDelete`       | `menus.test.ts`; browser with a selection                     |
| 14  | Clip     | Cut                        | `clip.cut`                | `menus.test.ts`; browser with a selection                     |
| 15  | Clip     | Copy                       | `clip.copy`               | `menus.test.ts`; browser with a selection                     |
| 16  | Clip     | Paste at Playhead          | `clip.paste`              | `menus.test.ts`; browser after a copy                         |
| 17  | Clip     | Link                       | `clip.link`               | `menus.test.ts`; browser with two clips selected              |
| 18  | Clip     | Unlink Audio/Video         | `clip.unlink`             | `menus.test.ts`; browser with a linked pair selected          |
| 19  | Clip     | Mute                       | `clip.toggleMute`         | `menus.test.ts`; browser with an audio clip selected          |
| 20  | Clip     | Audio Gain…                | `clip.audioGain`          | `menus.test.ts`; browser with an audio clip selected          |
| 21  | Sequence | Add Video Track            | `sequence.addVideoTrack`  | `menus.test.ts`; browser add-track menu                       |
| 22  | Sequence | Add Audio Track            | `sequence.addAudioTrack`  | `menus.test.ts`; browser add-track menu                       |
| 23  | Sequence | Add Text Track             | `sequence.addTextTrack`   | `menus.test.ts`; browser add-track menu                       |
| 24  | Sequence | Create Compound Clip       | `sequence.createCompound` | `menus.test.ts`; browser with a selection                     |
| 25  | Sequence | Sequence Settings…         | `sequence.settings`       | `menus.test.ts`; browser dialog                               |
| 26  | Marker   | Add Marker                 | `marker.add`              | `menus.test.ts`; browser with a clip or the project root      |
| 27  | Marker   | Edit Selected Marker…      | `marker.edit`             | `menus.test.ts`; browser with a selected marker               |
| 28  | Marker   | Delete Selected Marker     | `marker.delete`           | `menus.test.ts`; browser with a selected marker               |
| 29  | Marker   | Go to Next Marker          | `marker.next`             | `menus.test.ts`; browser with a marker                        |
| 30  | Marker   | Go to Previous Marker      | `marker.previous`         | `menus.test.ts`; browser with a marker                        |
| 31  | Graphics | New Text Layer at Playhead | `graphics.newText`        | `menus.test.ts`; browser text layer                           |
| 32  | View     | Zoom In                    | `view.zoomIn`             | `menus.test.ts`; browser timeline zoom                        |
| 33  | View     | Zoom Out                   | `view.zoomOut`            | `menus.test.ts`; browser timeline zoom                        |
| 34  | View     | Zoom to Fit Sequence       | `view.zoomFit`            | `menus.test.ts`; browser timeline zoom                        |
| 35  | View     | Snapping                   | `view.toggleSnap`         | `menus.test.ts`; browser snap toggle and check state          |
| 36  | View     | Use Proxies                | `view.useProxies`         | `menus.test.ts`; browser check state                          |
| 37  | View     | Appearance…                | `view.appearance`         | `menus.test.ts`; browser dialog                               |
| 38  | Window   | Media                      | `window.toggleMedia`      | `menus.test.ts`; browser check state                          |
| 39  | Window   | Program Monitor            | `window.togglePreview`    | `menus.test.ts`; browser check state                          |
| 40  | Window   | Source Monitor             | `window.toggleSource`     | `menus.test.ts`; browser check state                          |
| 41  | Window   | Inspector                  | `window.toggleInspector`  | `menus.test.ts`; browser check state                          |
| 42  | Window   | Timeline                   | `window.toggleTimeline`   | `menus.test.ts`; browser check state                          |
| 43  | Window   | Captions                   | `window.toggleCaptions`   | `menus.test.ts`; browser check state                          |
| 44  | Window   | Reset Workspace Layout     | `window.resetLayout`      | `menus.test.ts`; browser reset                                |
| 45  | Help     | What's new in 0.11.0…      | `help.releaseNotes`       | `menus.test.ts`; browser dialog                               |
| 46  | Help     | Keyboard Shortcuts…        | `help.shortcuts`          | `menus.test.ts`; browser dialog                               |
| 47  | Help     | About videoh               | `help.about`              | `menus.test.ts`; browser dialog                               |

## 3. Geometry contract

Freeze the dimensions that Plan 03 and Plan 04 depend on. Plan 02 may adjust a value only with a
recorded visual reason and an update to this table. Any change must update every dependent plan.

Initial target values, to be verified against the reference:

| Item                    | Initial target                                                            | Current source                                                                                     |
| ----------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Target viewport         | 1600x1000                                                                 | Hero capture size; reference file is 1586x992                                                      |
| Narrow desktop viewport | 1024x768                                                                  | Owner-visible narrow check                                                                         |
| Mobile viewport         | 390x844                                                                   | Existing compact layout                                                                            |
| Video track height      | 44px                                                                      | 64px in `TimelinePanel.tsx`                                                                        |
| Audio track height      | 40px                                                                      | 56px in `TimelinePanel.tsx`                                                                        |
| Text track height       | 36px                                                                      | 44px in `TimelinePanel.tsx`                                                                        |
| Track header width      | 168px                                                                     | 160px in `constants.ts`; 168 fits the working controls                                             |
| Media panel default     | 24%                                                                       | 20% in `workspace.ts`                                                                              |
| Inspector panel default | 26%                                                                       | 26% in `workspace.ts`                                                                              |
| Timeline panel default  | 50%                                                                       | 38% in `workspace.ts`                                                                              |
| Panel header height     | 28px                                                                      | 28px in `PanelShell.tsx`                                                                           |
| Source monitor          | hidden for the demo                                                       | Visible by default; hide through the workspace                                                     |
| Captions panel          | hidden for the demo                                                       | Visible by default; hide through the workspace                                                     |
| Panel tree              | media in the upper row; inspector full height; timeline lower left/center | Media is a full-height root column; timeline is inside the main column (`EditorShell.tsx:368-545`) |

Measured from the reference at 1586x992, scaled to the 1600x1000 capture target:

| Item                | Reference measurement                              | Contract            | Note                                                                                          |
| ------------------- | -------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| Media panel         | Right edge 335px, 21.1% of width                   | 24%                 | Deliberately wider for the larger cards and hover actions; record the final value in Plan 02. |
| Inspector panel     | Left edge 1275px, width 311px, 19.6% of full width | 26% of its group    | The 26% is a share of the upper row, not the full viewport.                                   |
| Timeline panel      | Top edge 560px, height 432px, 43.5%                | 50%                 | Deliberately taller so nine rows fit at 44/40px.                                              |
| Video track height  | About 44px                                         | 44px                | Matches.                                                                                      |
| Audio track height  | About 40px                                         | 40px                | Matches.                                                                                      |
| Track header width  | About 168px                                        | 168px               | Matches.                                                                                      |
| Panel header height | 28px                                               | 28px                | Matches.                                                                                      |
| Source monitor      | Hidden                                             | Hidden for the demo | Hide through workspace state, not a default change.                                           |
| Captions panel      | Not present                                        | Hidden for the demo | Hide through workspace state, not a default change.                                           |

The current panel tree does not match the reference tree even though the timeline is about 80% wide
in both. Plan 02 must move media into the upper row and the inspector to the full-height right column,
so the timeline can span the lower left/center. That is recorded as a Plan 02 work item, not an open
question. `PANEL_BOUNDS` values are group-relative: after the move, the media default is about 32% of
the media+preview upper row to hit the 24% full-viewport target (`24 / 0.74`), while the inspector
stays a root share at 26.

Plan 02 confirmed the frozen values in the browser on 2026-10-27: 44/40/36px rows, 168px header,
media 376px (23.5% of 1600), inspector 414px (25.9%), and timeline 443px (49.7% of the content
height). No value moved, so this table stands. The panel tree is now media/source/preview over
timeline/captions on the left, with the inspector as the full-height right column.

The Source monitor stays visible by default. The demo project hides it through the existing
workspace state, exactly as a user would. Do not change the default workspace just to make the
screenshot easier.

The geometry contract covers the editor frame only. It does not freeze the final hero project's
content.

## 4. Demo project fixture

The reference's footage is not ours. The parity fixture uses only:

- `public/samples/sample-video.mp4`
- `public/samples/sample-audio.mp3`
- `public/samples/sample-image.png`

The current hero screenshot's night-city image is not a bundled sample. Do not assume it is in the
repo. The parity fixture uses `sample-image.png` (a cyan gradient) unless the owner supplies an owned
replacement. If the hero capture no longer uses the Unsplash night-city image, remove that credit
from `docs/design-system.md`; do not carry a false attribution forward.

Requirements:

- Five video tracks and four audio tracks, in the same visual density as the reference.
- At least one linked A/V pair, one video clip with no linked audio twin (a solo video), one image
  clip, one audio clip with volume keyframes, one transition, and one marker. Keep the demo to five
  video and four audio tracks; do not add a text track that changes the target's track count.
- Deterministic names, order, clips, and playhead position.
- Record the fixed screenshot playhead, zoom, and selection in section 6 before capture. Plan 07
  reuses those values.
- No external URLs, no new media, no generated images.
- Use a serialized `.veproj.json` fixture at `e2e/fixtures/editor-parity.veproj.json`. Its media
  entries use the bundled sample names and hydrate from `/samples/*`. Do not store object URLs or
  File handles.
- Reusable by the screenshot procedure and the battery. Keep it under `e2e/fixtures/`, not in
  `public/`. Do not replace the existing battery sample flow; use a dedicated step or a separate
  session for the fixture.
- If hydration cannot resolve a sample by name, fix the fixture. Do not add a builder-script
  fallback.
- The fixture must not depend on the user's workspace localStorage.

The fixture is also the acceptance surface for Plans 03, 04, 05, and 06. If the fixture cannot show a
feature, the feature cannot be judged.

## 5. Filmstrip spike

This is the only part of the plan that touches code. It is a temporary spike, not a shipped
component. Timebox it to 90 minutes.

Questions to answer:

- How long does the first 12-frame strip take for a 4-second clip trimmed from the 6-second
  `sample-video.mp4`?
- How long does a cached redraw take after zoom changes in the same width bucket?
- Does seeking while the preview is playing cause a long task or a dropped frame?
- How much memory does a 20-strip cache hold at 4096x44?
- Do reverse, speed, and trim produce the expected source frames?
- Does the approach work in the project's current browser targets?

Method:

- A hidden `HTMLVideoElement` with `preload="auto"`, `muted`, and `playsInline`.
- Seek to the sampled source times, await `seeked`, draw into an offscreen canvas, and compose one
  strip canvas.
- Use `sourceTimeAt(clip, local)` for the sample times. Do not use raw `inPoint + fraction`, which
  is wrong for speed, reverse, and time remapping.
- Record first-strip time, cached redraw time, long tasks over 50ms, memory, and console errors.
  Measure memory as canvas pixel bytes (`width * height * 4` per strip) plus a recorded heap delta
  from the browser's performance panel. `performance.memory` is not portable; record the method and
  environment, not just a number.
- Measure the 20-strip memory case at the target video track height, 44px, and the Plan 03 maximum
  strip width, 4096px. That is 20 * 4096 * 44 * 4 = 14,417,920 bytes, about 14.4MB. If the spike runs
  on the current 64px track height, record that separately as an observation; it is not the pass/fail
  number.
- Run at 100 px/s and 400 px/s, with one forward clip, one reversed clip, one trimmed clip, and
  one static-speed clip.
- Static-speed case: `inPoint = 0`, `speed = 0.5`, `duration = 4`, 12 frames. Expected source
  seconds follow `(i + 0.5) / 6` for `i = 0..11`, from `0.0833` to `1.9167` in steps of `0.1667`.
  A result that equals the local time instead of `local * 0.5` is a failure. Record the actual
  source times beside the expected ones. This is the static-speed case; the time-remap curve is
  covered by Plan 03's planner tests.
- The 12-frame run is a fixed performance probe, not the planner's frame count. At 100px/s the
  4-second clip is 400px wide and Plan 03 requests 6 frames; at 400px/s it requests 24. Record the
  12-frame probe for comparability and the planner-count timing at 400px/s.
- Take a browser screenshot of the spike result.

Go/no-go thresholds:

| Measure                      | Pass                                  | Fallback if it fails                 |
| ---------------------------- | ------------------------------------- | ------------------------------------ |
| First strip, 12-frame probe  | 2.5s or less for a 4-second clip      | Coarse per-asset sheet, fewer frames |
| Cached redraw                | 50ms or less                          | Keep the previous strip until idle   |
| Playback long task           | No task over 100ms while seeking      | Pause generation during playback     |
| Memory, 20 strips at 4096x44 | 20MB or less                          | Lower the pixel budget or cache cap  |
| Source correctness           | Trim, reverse, and speed frames match | Fix the mapping before Plan 03       |

If the simple seek approach fails, the plan records the chosen fallback and updates Plan 03 before
it starts. Do not proceed on optimism.

## Spike results

Fill this table during execution. The values are evidence, not unit-test thresholds.

| Measure                      | Result                                                                                                            | Pass? | Notes                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser and OS               | Chrome 151.0.0.0, Linux x86_64, 28 logical cores, 32GB device memory, DPR 1                                       | n/a   | `agent-browser` headed session at 1600x1000                                                                                                            |
| First strip, 12-frame probe  | 782.2ms for a 4-second clip at 4096x44                                                                            | Yes   | 12 frames from `sample-video.mp4`; threshold 2.5s                                                                                                      |
| Cached redraw                | 0.195ms average, 3.7ms max over 20 redraws                                                                        | Yes   | Same width bucket, cached strip drawn to the display canvas                                                                                            |
| Longest playback task        | 0ms; 0 long tasks reported                                                                                        | Yes   | Preview video playing while the hidden video sought 12 frames                                                                                          |
| Memory, 20 strips at 4096x44 | 14,417,920 bytes, 13.75MB                                                                                         | Yes   | Pixel bytes = 20 * 4096 * 44 * 4. `performance.memory` returned an empty object, so no heap delta was available; pixel bytes are the pass/fail number. |
| Source correctness           | All four clips match their expected source times                                                                  | Yes   | Max mapping error 0; max seek error 6.7e-7s; 12 distinct frame hashes per clip                                                                         |
| Verdict and chosen approach  | Go. Sequential seek with one hidden video element per asset, an offscreen canvas strip, and a runtime-only cache. | Yes   | The fallback is not needed. The 24-frame planner timing at 400px/s was 1529.7ms, recorded as an observation.                                           |

The 12-frame run is the performance probe. The 24-frame planner-count run at 400px/s is an
observation, not a second gate.

### Source time log

Frame centers are `(i + 0.5) / 12 * duration`. All values are seconds. The expected values are
computed independently from the clip formula, not read back from `sourceTimeAt`.

| Clip         | Clip setup                                             | Expected source times                                                                                  | Actual seek times                                                                                      |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Forward      | `inPoint=1`, `duration=4`, `speed=1`                   | 1.166667, 1.5, 1.833333, 2.166667, 2.5, 2.833333, 3.166667, 3.5, 3.833333, 4.166667, 4.5, 4.833333     | 1.166666, 1.5, 1.833333, 2.166666, 2.5, 2.833333, 3.166666, 3.5, 3.833333, 4.166666, 4.5, 4.833333     |
| Reversed     | `inPoint=0.5`, `duration=4`, `speed=1`, `reverse=true` | 4.333333, 4, 3.666667, 3.333333, 3, 2.666667, 2.333333, 2, 1.666667, 1.333333, 1, 0.666667             | 4.333333, 4, 3.666666, 3.333333, 3, 2.666666, 2.333333, 2, 1.666666, 1.333333, 1, 0.666666             |
| Trimmed      | `inPoint=2`, `duration=4`, `speed=1`                   | 2.166667, 2.5, 2.833333, 3.166667, 3.5, 3.833333, 4.166667, 4.5, 4.833333, 5.166667, 5.5, 5.833333     | 2.166666, 2.5, 2.833333, 3.166666, 3.5, 3.833333, 4.166666, 4.5, 4.833333, 5.166666, 5.5, 5.833333     |
| Static speed | `inPoint=0`, `duration=4`, `speed=0.5`                 | 0.083333, 0.25, 0.416667, 0.583333, 0.75, 0.916667, 1.083333, 1.25, 1.416667, 1.583333, 1.75, 1.916667 | 0.083333, 0.25, 0.416666, 0.583333, 0.75, 0.916666, 1.083333, 1.25, 1.416666, 1.583333, 1.75, 1.916666 |

Static speed must match `(i + 0.5) / 6`, not the local time. The maximum difference from the local
time was 1.916667s, so the clip is not reading local time. The full JSON result is local-only at
`.design/editor-parity/spike-results.json`.

## 6. Screenshot and comparison procedure

The reference and the real editor use different content, so this is a region checklist, not a pixel
diff. The reference file is 1586x992; the capture target is 1600x1000, matching the existing hero
asset. Scale the reference for side-by-side viewing; do not compare pixels across the two sizes.

Recorded capture settings (verified on 2026-10-27; reuse them in Plan 07):

- Playhead: 2.7s. At 30fps this is frame 83. Click the ruler at 2.7s, then step once to make the
  compact formatter read `0:02.7`.
- Zoom: 57 px/s. From the fresh 80 px/s default, click Zoom out once. Do not choose a new zoom at
  capture time.
- Selection: `clip-brand-video-1`, the V1 linked video at 0.00-4.20. Select it with
  `[data-testid="clip-clip-brand-video-1"]`.
- Workspace: Source and Captions hidden through the Window menu. Close the release-notes dialog and
  discard the autosave restore banner if it appears.

Procedure:

1. Check whether a dev server is already running on port 3000. Never start a duplicate.
2. Start `bun run dev` only if the port is free. If the agent started it, stop it when done.
3. Launch `agent-browser` with a unique session and `--headed` for visual work.
4. Set the viewport to 1600x1000.
5. Load `e2e/fixtures/editor-parity.veproj.json` through the existing hidden project input
   (`input[type=file][accept=".json,application/json"]`) and wait for the fixture's project name in
   the toolbar or status bar, or the project-loaded toast. Hide Source and Captions through the
   Window menu. Close the release-notes dialog. Discard any autosave restore banner.
6. Pause playback. Click Zoom out once from the fresh 80 px/s default, select the fixed clip, and set
   the fixed playhead. Do not choose new values at capture time.
7. Wait for fonts and a stable editor selector before capturing. Hide the Next.js dev-tools portal
   with a temporary style (`nextjs-portal { display: none !important; }`); this is a capture-only
   style, not a product change. Before Plan 03 the filmstrip marker does not exist; after Plan 03,
   wait for `data-filmstrips-ready` on the timeline root. The marker is set only when every mounted
   strip has settled, including the poster fallback.
8. Capture the editor only, not the browser chrome.
9. Compare each inventory region against the reference. Record pass, gap, or owner plan.
10. Repeat at 1280x800, 1024x768, and 390x844 mobile. After each viewport change, reassert the
    playhead or step one frame so the preview redraws. A viewport change alone left the mobile canvas
    black until the next seek.
11. Close the browser session. Stop the dev server only if the agent started it.

The comparison sheet is a Markdown table in this plan or a separate local note. It is not a
committed image.

### Comparison sheet

Captures are local-only under `.design/editor-parity/`:
`capture-1600.png`, `capture-1280.png`, `capture-1024.png`, `capture-390.png`.

| Region          | Reference                                                          | 1600x1000                                                                  | 1280x800                                       | 1024x768                                         | 390x844                                               | Result                                                                                                |
| --------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Menu bar        | Wordmark, nine menus, full screen, version                         | Menus, full screen, version; no wordmark                                   | Same                                           | Same                                             | Compact menu bar, horizontal scroll                   | Gap: wordmark (02)                                                                                    |
| Toolbar         | Grouped controls, project name, IO, export                         | Controls and project name fit; no ripple/slip/Pen                          | Project name fits; media names truncate        | Project name truncates to `Editor`; controls fit | Horizontal scroll                                     | Gap: tools (06), narrow density (02)                                                                  |
| Media bin       | Wider cards, 64x40 images, name, kind, duration                    | 40px images, full names                                                    | Full names                                     | Names truncate                                   | Hidden in compact layout                              | Gap: cards (02)                                                                                       |
| Program monitor | 16:9 canvas, scopes, padded time, volume                           | Canvas, scopes, compact time, volume                                       | Same                                           | Same                                             | Canvas redraws after a seek; scopes and transport fit | Gap: padded time (02); procedure note for mobile redraw                                               |
| Inspector       | Clip tab, full-height panel, dB volume graph                       | Clip tab, summary, timing, opacity, blend, color; audio below the fold     | Same, shorter                                  | Same, narrow                                     | Hidden in compact layout                              | Gap: dB graph (04), full height (02)                                                                  |
| Timeline        | Nine rows, 44/40px, filmstrips, envelopes, M/S/lock, padded ruler  | Four video rows visible, audio below the fold; color blocks; compact ruler | Three video rows visible; audio below the fold | Two video rows visible; narrow                   | Five video rows scroll; audio below the fold          | Gap: heights and 50% timeline (02), filmstrips (03), envelopes (04), M/S/lock (05), ruler format (02) |
| Status bar      | Selection range plus duration, track counts, autosave              | Range without duration, px/s, undo steps, autosave                         | Same                                           | Same                                             | Project name, format, autosave                        | Gap: duration, counts, debug removal (02)                                                             |
| Panel frame     | Media upper row, inspector full height, lower left/center timeline | Media full height; timeline starts at the media edge; inspector top-right  | Same                                           | Same                                             | Compact layout                                        | Gap: panel tree (02)                                                                                  |
| Overall         | Direction and density                                              | Baseline captured                                                          | Baseline captured                              | Baseline captured                                | Baseline captured                                     | Plan 02 owns the geometry gaps; Plans 03 to 06 own the feature gaps.                                  |

## 7. Flakiness review

Before this plan is marked done, check:

- Verified: the image is ignored, `git status --short` does not show it, and
  `git ls-files --error-unmatch` fails for it. The fixture is present, not ignored, and ready for the
  owner's commit. The proof-section checks are the source of truth for both.
- Verified: every inventory claim cites a file that was opened, not a grep hit alone. The live DOM
  exposed 74 visible controls plus 47 menu items across 9 menus.
- Verified: the geometry table includes the measured reference values and the panel-tree task.
- Verified: the fixture parses through `parseSerializedDoc`, has 5 video and 4 audio tracks, 19
  clips, 18.0s duration, two linked A/V pairs, one solo video, one image clip, one transition, one
  volume curve, and one marker. Every media source window fits its asset, and the only overlap is
  backed by `transitionOut`. The owner has committed the fixture; `git ls-files` now lists it.
- Verified: the fixture hydrates all three bundled samples in the browser and shows 9 tracks.
- Verified: the spike verdict is numeric and has a fallback. All five gates pass.
- Verified: no production file changed. The working tree adds `.gitignore`, the plan docs, and the
  fixture. `.design/` is local-only.
- Verified: the browser session is closed and the dev server is stopped. Port 3000 is free.

## Proof

This plan is proven by artifacts and decisions, not by product tests.

- Pass: `git status --short` shows no reference image.
- Pass: `git ls-files --error-unmatch .design/editor-parity/editor-target.png` exits nonzero, so the
  image is not tracked. `git status --short` alone cannot prove this.
- Pass: `git check-ignore -v .design/editor-parity/editor-target.png` confirms the ignore rule at
  `.gitignore:52`.
- Pass: `git check-ignore -v e2e/fixtures/editor-parity.veproj.json` exits nonzero, so the fixture
  is not ignored. It is tracked after the owner's commit:
  `git ls-files --error-unmatch e2e/fixtures/editor-parity.veproj.json` succeeds.
- Pass: `sha256sum .design/editor-parity/editor-target.png` is
  `feb5a439014967a10e99b2bb26fb9f6ec709cd208b0ec740ee0a7e3dfa126066`, matching the recorded hash.
- Pass: the inventory table has a row for every visible region and control, with 74 live controls
  reconciled. The 47-item menu manifest matches `MENU_SPECS` exactly: 5 File, 4 Edit, 11 Clip,
  5 Sequence, 5 Marker, 1 Graphics, 6 View, 7 Window, 3 Help, and every action id matches.
- Pass: the spike log records forward, reversed, trimmed, and static-speed source times, the
  expected values, the measured numbers, and the chosen approach. The verdict is go.
- Pass: the browser comparison sheet records the target, narrow, and mobile results, including the
  panel-tree gap now owned by Plan 02.
- Pass at close: `bun run check` is green. 77 test files, 1,603 tests, 11 routes, production build
  included. The plan changes `.gitignore` and adds the fixture even though it does not change product
  code.

## Acceptance criteria

- Met: the reference is local, ignored, and documented with provenance and a retirement rule.
- Met: the inventory classifies every visible element and leaves no "figure it out later" row.
- Met: the geometry contract is frozen and referenced by Plans 02, 03, 04, and 05.
- Met: the demo fixture exists at `e2e/fixtures/editor-parity.veproj.json` and is tracked after the
  owner's commit; `.design/` remains local-only.
- Met: the filmstrip spike has a go verdict with numbers, including the static-speed source frames,
  and a fallback.
- Met: the screenshot procedure is repeatable, records the fixed settings, and uses selector waits
  rather than fixed sleeps.
- Met: Plan 02 can start without an open product question. The panel-tree move is recorded in Plan 02.

## Risks

- **Spike variance.** Browser and disk speed vary. Record the environment and treat the numbers as
  evidence, not a contract.
- **Reference ambiguity.** The image does not show every hover, menu, or narrow state. Resolve those
  by the app's existing behavior, not by guessing a new one.
- **Fixture drift.** The fixture may not match the reference's density. Add duplicated clips rather
  than new media.
- **Scope pressure.** If the inventory reveals a new feature not in the plan index, stop and update
  the orchestrator before coding it.

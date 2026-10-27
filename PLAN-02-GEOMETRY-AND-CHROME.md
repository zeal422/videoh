# PLAN 02: Geometry and chrome

Status: implemented, awaiting commit
Depends on: [PLAN 01](PLAN-01-REFERENCE-AND-SPEC.md)
Release: internal commit, no version bump
Goal: make the editor frame, panel proportions, track rows, media cards, and status bar match the
reference without adding new timeline behavior.

## Scope

This plan changes presentation and geometry only. It does not change the project document, the
command layer, serialization, playback, or export.

Work items:

1. Track and header geometry.
2. Panel default shares and panel tree.
3. Menu bar wordmark.
4. Toolbar density and grouping.
5. Media bin cards.
6. Status bar content.
7. Transport time format.
8. Responsive behavior.
9. Documentation of the new geometry.

## Non-goals

- No filmstrip, volume envelope, solo, lock, or new tool behavior. Those belong to Plans 03 to 06.
- No new icons that do nothing.
- No change to the default visibility of the Source panel. The demo hides it through workspace
  state.
- No redesign of the public site.

## Current state to verify before editing

Open these files and record the exact values before changing them:

- `src/components/editor/timeline/TimelinePanel.tsx`: `TRACK_HEIGHT`, ruler height, drop and
  marquee math.
- `src/lib/editor/constants.ts`: `TRACK_HEADER_WIDTH`.
- `src/lib/editor/workspace.ts`: `PANEL_BOUNDS` defaults and sanitizer.
- `src/components/editor/MenuBar.tsx`: menubar root, right-side full-screen and version.
- `src/components/editor/Toolbar.tsx`: tool groups, separators, project name, IO buttons.
- `src/components/editor/MediaBin.tsx`: item size, thumbnail, metadata, hover actions.
- `src/components/editor/StatusBar.tsx`: left and right groups.
- `src/components/editor/PreviewPanel.tsx`: transport time and volume visibility.
- `src/components/editor/PanelShell.tsx`: header height, collapse strips.
- `src/components/editor/timeline/TimelinePanel.tsx`: `TrackHeader`.

## 1. Track and header geometry

Initial contract from Plan 01:

| Item               | Target |
| ------------------ | ------ |
| Video track height | 44px   |
| Audio track height | 40px   |
| Text track height  | 36px   |
| Header width       | 168px  |

The exact values may move only with a recorded visual reason. If they move, update Plan 01 and every
plan that depends on them.

Implementation notes:

- `TRACK_HEIGHT` is used by lane boxes, drop resolution, marquee selection, auto-scroll, clip
  heights, waveform heights, and the below-rows strip. Change the constant, then run the full
  timeline suite before touching the visuals.
- `TRACK_HEADER_WIDTH` is used by the ruler origin, click-to-time math, drop indicators, playhead
  position, zoom-to-fit, and scroll calculations. Change it in one place and follow every caller.
- The clip label, linked badge, speed badge, transition badge, trim handles, and waveform must stay
  legible at 40 to 44px. If a 44px video row cannot hold the label and a filmstrip later, use 48px
  and record why.
- The header is 168px. It fits the working controls now (kind icon, name, eye/mute) at 24px hit
  targets and leaves room for Plan 05's solo/lock without a second width change. The reference's
  narrower header cannot hold those controls at accessible sizes; 168 is a deliberate deviation
  recorded in Plan 01 and the decision log.
- Do not shrink text below the existing 10 to 11px scale.

Header controls after this plan:

- Kind icon, colored by kind.
- Track name, editable through the existing double-click and menu.
- Visibility eye for video and text tracks. Audio tracks keep the mute control.
- Mute speaker for all tracks, matching the current behavior.
- No clip count. It is debug density the reference does not show.
- No header target button. Keep the existing context-menu `Target Track` checkbox.
- Solo and lock are deliberately absent until Plan 05. Do not reserve dead space or draw disabled
  icons.

## 2. Panel default shares

Initial contract:

| Panel     | Full-viewport target | Stored group share                       |
| --------- | -------------------- | ---------------------------------------- |
| Media     | 24%                  | About 32% of the media+preview upper row |
| Inspector | 26%                  | 26% of the root group                    |
| Timeline  | 50%                  | 50% of the left workspace height         |

Update `PANEL_BOUNDS` defaults. Existing users keep their persisted workspace. The sanitizer and
reset-layout tests must still pass. The Source panel keeps its current default and visibility.

### Panel tree

The reference's proportions come partly from the panel tree, not only from the percentage values:

- Media sits in the upper row, not as a full-height root column.
- The inspector is a full-height right column.
- The timeline spans the lower left/center, under the media panel, and ends at the inspector edge.
- Captions are not shown in the reference. Hide them for the demo and hero capture through workspace
  state; do not change the default visibility.

The current tree is media at the root left, the timeline inside the main column, and the inspector in
the upper row with captions below it (`EditorShell.tsx:368-545`). Move the media panel into the upper
row and the inspector to the root right column, then let the timeline fill the lower left/center.
Keep the existing resizable, collapsible, and reset behavior. This is presentation only; do not
change `Doc`, commands, playback, or export.

`PANEL_BOUNDS` values are shares of their own panel group, not always shares of the full viewport:

- Inspector 26 is a root share, so it stays 26% of the full width.
- Media 24 is a full-viewport target. Inside the media+preview upper row it is about 32% of that row
  when the inspector is 26% (`24 / 0.74`). Set the stored default to the group share, then measure
  the result at 1600x1000.
- Timeline 50 is a vertical share of the left workspace, unchanged by the horizontal move.
- Preview fills the remaining upper-row width.

Check that:

- The demo workspace with Source and Captions hidden gives the media, preview, inspector, and
  timeline proportions in the reference. A fresh workspace still shows Source, so its preview is
  slightly smaller than the reference; do not claim otherwise.
- Reset Workspace Layout restores the new defaults.
- The panels still fit at 1280x800 without clipping.
- The collapse strips and double-click reset still work.

## 3. Menu bar wordmark

Add a compact `videoh` wordmark at the far left of the menu bar, before the File menu.

Rules:

- It is not a menu trigger. It must not be inside the `role="menubar"` element's keyboard model.
- It links to `/` so the editor has a way back to the public site. Use a plain anchor; do not
  import a site component into the editor.
- Hide it below the width where it would force the menus to scroll. The File through Help menus
  keep priority.
- The full-screen button and version stay pinned at the right edge.
- The existing `py-0` and `overflow-y-hidden` menubar lock must survive.

Add a render test for the wordmark and its link. Lock the responsive hiding with the exact class and
a browser visibility check at 1600 and 390; jsdom cannot evaluate media queries. Add a static lock
that the menubar root still has its no-scroll classes.

## 4. Toolbar density and grouping

Match the reference's grouping with the tools that already work:

- History: undo, redo.
- Selection: select, razor.
- Placement: Place, Insert, Overwrite.
- Edit: split, duplicate, delete.
- Material: text, add track.
- View: snap, zoom out, zoom in.
- Center: project name.
- Right: save, open, export.

Rules:

- Keep the existing tooltips on the bottom side.
- Keep the horizontal scroll behavior at narrow widths.
- Keep the placement group non-shrinking.
- Do not add ripple, slip, or Pen icons yet. Plan 06 adds them with their behavior.
- Use the same button height and icon size throughout. Do not create a second toolbar style.

Implemented density: tool buttons and the add-track icon are 32px (`size-8`), group separators use
`mx-0.5`, and the Export label appears at `xl` and above. At 1024 the project-name input keeps its
full text at 192px and the toolbar does not overflow; the status bar carries the full project name at
every width.

## 5. Media bin cards

The reference uses a wider card with a larger thumbnail. Use the existing `asset.thumbnail`, which
is a JPEG capped at 160px wide. At 64x40 CSS pixels, the source is 2.5x wide, enough for a 2x display.
Use 64x40 and do not generate a second thumbnail size.

Card layout:

- Thumbnail on the left, 64x40, rounded, `object-cover`.
- File name on the first line, truncated.
- Kind and duration or dimensions on the second line, muted.
- Keep the proxy status text.
- Keep the hover actions: add to timeline, remove, build proxy, relink.
- Keep the selected source-asset ring and the offline styling.
- The import and sample buttons stay at the top.

Add a render test for the card markup and the hover-action labels. Add a static lock for the
thumbnail size class so a future pass cannot silently shrink it.

## 6. Status bar content

Target left side:

- Project name.
- Resolution and fps.
- Timeline duration.

Target right side:

- `N clips selected` when more than one clip is selected. Keep the existing multi-selection count.
- Selected clip range when exactly one clip is selected. Format it as `00:00–00:04.2` with an en
  dash, matching the current status bar, and append the duration (`4.2s`). Trim a trailing `.0` from
  an exact endpoint, but keep one decimal otherwise.
- Video track count and audio track count. Count video and audio only; omit text tracks from the
  footer. The demo fixture has no text track, and the reference reports only these two kinds.
- Autosave indicator.

Remove the visible `px/s` and `undo steps` from the footer. They are debug information the reference
does not show. Do not add a new place for them unless the user asks.

Rules:

- Track counts are derived from the active sequence, not the root project, so compound sequences
  report the tracks the user is editing.
- Use singular and plural correctly.
- Hide the track counts below `xl` with `hidden xl:inline`. The autosave indicator stays visible at
  every width; it has no responsive hide.
- Keep the safe-area padding.

Add render tests for multi-selection counts, the single-clip range and duration, track counts,
singular/plural, compound sequences, the text-track omission, and the `hidden xl:inline` class.

## 7. Time formats

The reference shows `00:02.7 / 00:18.0` in the transport and `00:00`, `00:01`, ... on the ruler. The
current `formatTime` returns `0:02.7`, and it is used by the ruler, status bar, markers, and tooltips.

Do not change `formatTime` globally.

- Add a transport-only formatter that pads minutes and seconds to two digits and keeps one decimal.
  Use it only in `PreviewPanel`.
- Add a ruler-only formatter that pads minutes and seconds to two digits with no decimal. Use it only
  in `Ruler.tsx`.
- The status bar's timeline duration, markers, and inspector keep the compact `formatTime` format. The
  selected clip range uses its own formatter in section 6.

Rules:

- The transport shows `00:00.0` at zero.
- The total duration uses the same format.
- The transport always uses total minutes: 61 minutes is `61:01.2`, never `1:01:01.2`. This keeps
  the battery's `step_frames` and `playhead_seconds` parsers correct.
- The ruler shows `00:00`, `00:01`, and so on. Under an hour use `mm:ss`; at or over an hour use
  `h:mm:ss`. Test the boundary.
- Add unit tests for zero, under one minute, over one minute, over an hour, and an exact minute.
- Add render tests that the transport and ruler use their new formats and the other surfaces keep
  the compact format.
- Update the two `time_display_is '0:01.'` prefixes in BOTH `e2e/battery.sh` and
  `e2e/battery.timing.sh` to `'00:01.'` in the same change. Run the `f10` marker step as a prefix
  battery proof, not only `bun run check`.

## 8. Responsive behavior

Verify:

- 1600x1000: the target composition.
- 1280x800: no clipped toolbar or status bar; the wordmark hides if needed.
- 1024x768: track headers and clip labels remain readable; the timeline is narrow.
- 390x844: the existing compact layout still works; the media and inspector panels keep their
  current mobile behavior.

The reference is a desktop composition. Mobile parity is not a goal, but no regression is allowed.

## 9. Docs

Update:

- `docs/design-system.md`: track heights, header width, panel defaults, wordmark, status bar, media
  cards, transport and ruler time.
- `docs/architecture.md` if it records panel geometry.
- `docs/structure.md` if file structure changes.
- `README.md` only if a user-facing feature description changes.
- `public/screenshots/editor.png` is not updated in this plan. It is updated in Plan 03 with the
  filmstrip release.

If this plan adds or removes tests, update the test counts and inventory rows in `README.md`,
`docs/testing.md`, `docs/structure.md`, and `AGENTS.md`. `docs-drift.test.ts` is the lock. This is
required even though the plan has no version bump.

No version bump. No changelog entry.

## Tests and proof

Unit and render tests:

- `workspace.test.ts`: new defaults, sanitizer clamp, reset layout.
- `timeline-panel-ui.test.tsx`: lane geometry, drop resolution, marquee, ruler, auto-scroll, clip
  heights, below-rows strip.
- `editor-shell-ui.render.test.tsx`: panel mounts and reset behavior.
- `media-pool.test.ts` or a new media-bin render test: card markup, thumbnail size, hover actions.
- `preview-layout.test.ts`: transport time format and volume visibility.
- A `time` test for the two-digit ruler formatter, plus a static lock that `Ruler.tsx` uses it.
- `menubar.test.tsx`: wordmark, right-side controls, no-scroll lock.
- A status-bar render test for multi-selection counts, track counts, pluralization, text-track
  omission, and the selected clip range plus duration format, including the en dash. Assert the
  `hidden xl:inline` class.

Static locks:

- Track height constants have the target values.
- Header width has the target value.
- Media thumbnail size class.
- Wordmark present and not a menu trigger.
- Transport formatter used only in the transport.
- Ruler formatter used only in the ruler.

Browser proof:

- Screenshot at 1600x1000 with the Plan 01 fixture.
- Screenshot at 1280x800.
- Screenshot at 1024x768.
- Mobile check at 390x844.
- Wordmark visible at 1600 and hidden at 390, asserted by a visibility check, not only by a class.
- Prefix battery run for the `f10` marker step, after updating both battery scripts.
- Console clean.
- Existing editor flows still work: select, move, trim, split, delete, undo, zoom, drop media.

Flakiness controls:

- Do not assert pixel widths in jsdom. Assert the constants, classes, and structure.
- Do not use fixed sleeps for layout. Wait on a selector or the next frame.
- The screenshots are region checks, not pixel diffs.
- If a height or width change breaks a test, fix the math or the test's intent. Do not relax the
  assertion.

## Implementation record

Implemented on 2026-10-27 on `updates`, uncommitted.

Measured at 1600x1000 with `e2e/fixtures/editor-parity.veproj.json`, Source and Captions hidden:

| Region          | Measurement                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------- |
| Media           | 376x443 at x=0, 23.5% of the viewport                                                       |
| Program Monitor | 798x443 beside it                                                                           |
| Inspector       | 414x892 at x=1186, full height, 25.9% of the viewport                                       |
| Timeline        | 1180x443 at x=0, y=529, spanning under media and ending at the inspector                    |
| Track rows      | 44, 44, 44, 44, 44, 40, 40, 40, 40 px                                                       |
| Track header    | 168px                                                                                       |
| Media thumbnail | 64x40 CSS px                                                                                |
| Transport       | `00:02.7 / 00:18.0`                                                                         |
| Status bar      | `Selected clip 00:00–00:04.2 (4.2s)` and `5 video tracks · 4 audio tracks`, no px/s or undo |

Responsive checks: 1280x800 keeps the counts visible and fits the toolbar; 1024x768 hides the track
counts, keeps the full project name in a 192px input, and makes Export icon-only; 390x844 keeps the
compact layout, hides the wordmark and track counts, and redraws the preview after the playhead is
reasserted. Collapsing media, source, and inspector shows their strips, expanding restores them, and
Reset Workspace Layout restores media 32, inspector 26, timeline 50. Reset also unhides panels,
which is existing workspace behavior, so the demo hide is re-applied after a reset.

The 15-step prefix battery passed 15/15, including both f10 marker steps. The panel-tree move
shortened the media panel, so two battery steps now scroll their media targets into view before
clicking: `f01b` scrolls to Remove, and `f02_add` scrolls to each card's Add button. The counts use
DOM queries rather than visible-only accessibility refs. Both battery scripts carry the same change.

`bun run check` is green: 78 test files, 1,632 tests, 11 routes, production build. The console is
clean at every width.

Review fixes: upper-row sizes are not persisted while the preview is hidden, so its removal cannot
overwrite media/source with the forced/normalized values; the ruler labels only whole-second ticks;
and the transport, range, and duration formatters derive integer tenths from the clamped total, so
2.3, 10.1, and 59.9 no longer drop a tenth. Tests cover all three. The panel guard is a static source
lock because `react-resizable-panels` never fires `onLayout` in jsdom; the browser proof verifies the
runtime behavior (saved sizes stayed 32/24 while the preview was hidden and restored to 32/24 on
return).

## Acceptance criteria

- The editor frame at 1600x1000 with the demo workspace (Source and Captions hidden) matches the
  reference's proportions and density, including the media upper row, the full-height inspector, and
  the lower left/center timeline.
- Track rows and headers fit at 168px without clipped labels or dead icons.
- The media cards use the 64x40 thumbnail and keep every action.
- The status bar shows multi-selection and single-clip ranges, video/audio track counts (text
  omitted), and no px/s or undo steps.
- The transport uses the padded total-minutes format, the ruler uses the padded no-decimal format,
  and the rest of the app keeps the compact format.
- The two `time_display_is` prefixes in both battery scripts are updated, and the f10 prefix battery
  passes.
- The wordmark is present, links home, and hides before it crowds the menus.
- Existing tests pass with updated constants, not weakened assertions.
- No `Doc`, command, serialization, playback, or export change.
- `bun run check` is green.
- Browser proof at all four widths is recorded.

## Risks

- **Geometry math.** The header width and row heights touch many calculations. Mitigation: change
  the constants first, run the timeline suite, then adjust visuals.
- **Header crowding.** 168px fits the working controls at 24px hit targets with a short name. Do not
  shrink below 24px or reintroduce the clip count/target button. Record the final width in Plan 01.
- **Wordmark menu pressure.** Mitigation: hide it below the breakpoint and keep the menu scroll.
- **Media thumbnail sharpness.** 160px source at 64px CSS is 2.5x, enough for a 2x display. Do not
  generate a larger thumbnail; revisit only if the project's thumbnail cap changes.
- **Status bar loss of debug data.** The user can inspect undo depth through behavior, not a
  number. If this is a problem, add a tooltip rather than visible text.

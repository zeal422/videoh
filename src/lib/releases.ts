/**
 * src/lib/releases.ts, the hand-curated release notes behind the welcome
 * modal (Help > What's new, and the once-per-version auto-open after editor boot).
 *
 * Kept separate from CHANGELOG.md on purpose: the changelog is the full
 * record for maintainers, this is the short story for users. Distill at
 * release time, in the same commit as the version bump, and releases.test.ts
 * fails the gate when releases[0] falls behind package.json.
 *
 * Latest first. Keep highlights to four short lines a user can scan in a
 * modal: what it does, not how it works.
 */

export interface ReleaseNotes {
  /** Semver string as shown in the UI, matching package.json's version. */
  version: string
  /** Release date, ISO yyyy-mm-dd. */
  date: string
  /** Four or more one-line highlights, most notable first. */
  highlights: string[]
}

export const releases: ReleaseNotes[] = [
  {
    version: '0.19.6',
    date: '2026-11-09',
    highlights: [
      'Unused declarations are removed from the editor state core, playback, and export layers',
      'An unused panel header prop is gone, leaving a smaller internal UI surface',
      'No editor command, project format, export, UI, or analytics behavior changes',
      'The full test suite stays green at 2,223 tests',
    ],
  },
  {
    version: '0.19.5',
    date: '2026-11-09',
    highlights: [
      'The security audit is clean: the last 15 dev-only advisories are gone',
      'Bun moves to 1.4.4, and no runtime dependency or editor behavior changes',
      'Deployments install Bun explicitly with a frozen lockfile, so a dependency mismatch fails the build instead of drifting',
      'Existing projects, media, and analytics behave exactly as before',
      'The full test suite and both 70-step batteries stay green',
    ],
  },
  {
    version: '0.19.4',
    date: '2026-11-07',
    highlights: [
      'The full Content Security Policy is enforced in production, covering media, blob workers, and the editor',
      'Development keeps a narrow policy so HMR and the dev overlay stay clean',
      'Dev tooling moves to eslint 9.39.5, eslint-config-next 16.4.5, Vitest 5.1, jsdom 30.1.3, and Tailwind 4.3.5',
      'The security audit shrinks from 62 entries to 15, and every remaining copy is dev-only',
      'No editor feature, project format, or analytics contract changed',
    ],
  },
  {
    version: '0.19.3',
    date: '2026-11-06',
    highlights: [
      'Project files with clips or markers beyond the 24-hour timeline limit load with a clear migration warning instead of breaking the timeline',
      'Thumbnail, waveform, gain, and transition data from a project file are validated, so a crafted file cannot make the browser contact another host',
      'The editor no longer loads third-party analytics JavaScript; page views and export events use privacy-friendly beacons',
      'A visible analytics opt-out sits in the site footer and privacy page, and the editor Help menu links to it',
      'Next.js moves to 16.4.5, and every response now sends frame, content-type, and referrer protections',
    ],
  },
  {
    version: '0.19.2',
    date: '2026-11-05',
    highlights: [
      'A user pause lands on the last presented frame and drops the stale still frame before repainting the paused frame',
      'A seek that keeps reporting seeking for more than two seconds stops being skipped, and the engine retries',
      'Play warmup refuses a tracked but stale frame, so the clock cannot start on an old picture',
      'Paused seek tracking is cleared at every stop and before a paused seek, so a landed seek cannot leak into the next play',
      'A deferred WebCodecs pause frame paints when it arrives',
    ],
  },
  {
    version: '0.19.1',
    date: '2026-11-04',
    highlights: [
      'A damaged audio section recovers in place instead of pausing the monitor and skipping six seconds',
      'A repeated audio decode failure mutes that clip and keeps the picture playing',
      'A damaged video section skips to the next verified keyframe instead of stopping with "Damaged media"',
      'The skipped-media notice clears once playback passes the skipped range',
    ],
  },
  {
    version: '0.19.0',
    date: '2026-11-04',
    highlights: [
      'Panels close and reopen from their header menu or the Window menu; there is no collapsed strip',
      'The Program Monitor has a real header, so it closes and restores like every other panel',
      'Closing the last panel in a row gives that height to the other row, and closing all six shows a recovery prompt',
      'Saved layouts from before 0.19.0 load with collapse ignored and their panel sizes preserved',
    ],
  },
  {
    version: '0.18.0',
    date: '2026-11-01',
    highlights: [
      'Scrubbing keeps the last good frame with WebCodecs instead of clearing the monitor to black',
      'An unlinked video clip keeps its filmstrip, and audio tracks and audio-only clips keep their waveform',
      'New audio tracks go below and new video tracks above; dragging into a gap creates a track at that boundary',
      'The Pen reaches the full clip height, and Inspector keyframes drag vertically and the graph resizes',
      'Filmstrips cache source frames, so a split reuses them, and only the visible part of a long clip is generated at layout density',
      'The landing page shows a fresh 0.18.0 capture of the Climbing-Vlog project with filmstrips, two audio tracks, and the Effect Controls inspector',
      '"Load sample media" is gone; the UI battery now imports committed fixtures through the media bin',
    ],
  },
  {
    version: '0.17.0',
    date: '2026-10-31',
    highlights: [
      'The landing page has a new angled timeline hero, feature strip, product showcase, gradient tools band, and privacy panel',
      'The FAQ now follows privacy with an honest analytics answer, and the CTA closes the page',
      'The footer uses the real contact email, a 2026 VectorMedia credit, and the local-media promise',
      'The page keeps the real editor screenshot and the local-first story without claiming "no tracking"',
      'The SEO description, sitemap date, and structured FAQ are updated for the new page',
    ],
  },
  {
    version: '0.16.4',
    date: '2026-10-31',
    highlights: [
      'Damaged video now skips to the next decodable keyframe and tells you what it skipped, instead of leaving the monitor black',
      'Audio-only clips decode as audio, so linked audio no longer fails on a damaged video GOP',
      'Pressing play after a paused seek no longer re-seeks the element, removing the short black and silent gap',
      'The timeline zooms down to 1 px/s, enough to fit a 15-minute sequence, and Zoom In still steps at the new floor',
      'Recovery is bounded to three attempts, shows a persistent notice, and clears on Dismiss or a seek outside the damaged range',
    ],
  },
  {
    version: '0.16.3',
    date: '2026-10-29',
    highlights: [
      'The volume graph plots its dots on the same dB axis as the curve, so a unity keyframe sits on the 0 dB line',
      'Ctrl/Meta shortcuts no longer fall through to tool keys, and the toolbar waits for a live gesture before switching tools',
      'Hiding the Program Monitor after collapsing Media no longer leaves a ghost strip or a dead chevron',
      "Relinked media validates its patch and native file handle, so a project file cannot overwrite an asset's identity or install a broken source",
      'A locked drop destination reports the lock and rolls the whole drag back, and time readouts no longer undercount a computed tenth',
    ],
  },
  {
    version: '0.16.2',
    date: '2026-10-29',
    highlights: [
      'The Inspector now sits above the timeline instead of spanning the full editor height, so the bottom row spans the full width; the timeline fills it and only gives up width while Captions is open',
      'Clip and Effect Controls scroll inside the Inspector, so every section stays reachable on a shorter window',
      'The Inspector keeps its left resize handle, collapse strip, persisted width, and Window menu toggle; panel sizes and Reset Workspace Layout behave as before',
      'A panel alone in its row no longer offers collapse, so hiding Captions before collapsing the Timeline cannot throw; a persisted collapse clears when a panel becomes solo',
      'Short sequences now paint the ruler and track lanes all the way to the timeline right edge instead of ending in a black strip',
      'The public hero is recaptured at 1600x1000 with the new stacked layout, the nine-track parity demo, and the opacity graph visible',
    ],
  },
  {
    version: '0.16.1',
    date: '2026-10-28',
    highlights: [
      'The public hero is a fresh 1600x1000 capture of the full parity demo: nine tracks, filmstrips, linked audio, volume automation, opacity keyframes, and the Pen active',
      'The end-to-end UI battery grows to 66 steps and now exercises ripple trim, slip, and the keyframe Pen in a real browser',
      'Ripple trim is verified to shift only later clips on the same track, leaving linked partners on other tracks in place',
      'The 0.16.0 editing, render, and export paths pass the final release gate; no editing behavior changed in this patch',
    ],
  },
  {
    version: '0.16.0',
    date: '2026-10-28',
    highlights: [
      'The Pen (P) edits automation on the selected clip: volume on audio, opacity on picture',
      'Click the curve to add a point, drag a dot to change time and value, and Alt-click or Delete to remove, with one undo per gesture',
      'One generalized envelope draws volume in dB or opacity as a percentage, and a solo video keeps its volume dots directly draggable',
      'The Pen never moves or trims a clip, refuses locked lanes, cancels cleanly on pointercancel, and keeps the clip body selectable',
    ],
  },
  {
    version: '0.15.0',
    date: '2026-10-27',
    highlights: [
      'Ripple Trim (B) trims a clip edge and shifts every later clip on the same track, closing or opening the gap while preserving an existing transition overlap',
      'Slip (Y) drags a clip body to change which part of its source it shows without moving the clip or changing its duration, with a live in/out readout',
      'Both tools commit one undo entry per gesture, refuse locked lanes before a drag starts, and cancel cleanly on pointercancel',
      'Ripple trim is same-track by decision: linked partners on other tracks stay put, and the toolbar tooltip says so',
    ],
  },
  {
    version: '0.14.0',
    date: '2026-10-27',
    highlights: [
      'Track solo is real audio monitoring: audio lanes show M and S, and while any audio track is soloed only the non-muted soloed audio lanes are audible',
      'Track lock is enforced by the command layer: a locked lane refuses moves, trims, splits, deletes, pastes, effects, property edits, keyframes, markers, and the volume envelope',
      'Preview, the offline export plan, and the MP4 mix read one shared audibility rule, including solo inside compounds and a solo video keeping its embedded audio only while no audio lane is soloed',
      'Solo and lock serialize, autosave, undo, and redo; a locked lane still selects, inspects, plays, and unlocks, and linked-group and media edits refuse when a locked member would be touched',
    ],
  },
  {
    version: '0.13.0',
    date: '2026-10-27',
    highlights: [
      'Audio clips draw a white volume envelope over the waveform: drag keyframe dots, double-click the line to add a point, Alt-click or Delete to remove one, and nudge with the arrow keys',
      'The envelope stays on the clip that carries the sound: the audio twin of a linked pair, or a solo video with embedded audio; a muted clip dims but keeps its curve editable',
      'The Clip tab replaces the linear Audio section with a dB Volume summary: current level, mute, static gain, and the same shared keyframe graph',
      'Volume storage stays linear; the UI reads dB from -inf at the -60 dB floor to +6 dB, and the preview and export gain schedules read the same curve',
      'One undo entry per drag, double-click add, and keyboard delete; auto-duck curves render and remain editable',
    ],
  },
  {
    version: '0.12.0',
    date: '2026-10-27',
    highlights: [
      'The editor frame matches the reference: media over source and preview, a full-height inspector, 44/40/36 track rows, a denser toolbar, and a selection-and-track-count status bar',
      'Video clips draw sampled source frames from the window they actually show, so trim, speed, reverse, and time remapping change the picture',
      'Image clips show the image itself, and a linked video half stays clean while its audio twin carries the waveform',
      'Filmstrips are runtime-only and bounded: a 4096px cap, a 16MP LRU cache, and no strip data in the project file',
      'A 140ms debounce reuses a strip on a move or a small zoom, while a one-hour clip still asks for one 4096px backing canvas',
    ],
  },
  {
    version: '0.11.0',
    date: '2026-10-25',
    highlights: [
      'videoh is now public: a new hero page at / and the editor at /editor, with no password screen',
      'About, Privacy, Terms, and Contact pages plus the MIT license',
      'Search metadata, sitemap, robots.txt, structured data, and the Search Console verification file',
      'Privacy-friendly GoatCounter analytics for page views, CTA clicks, and successful exports',
      'A public design pass with a display serif, cinematic timeline strip, and a real editor screenshot',
    ],
  },
  {
    version: '0.10.3',
    date: '2026-10-25',
    highlights: [
      'Toolbar tooltips now open below their buttons instead of covering the menu bar',
      'Placement, text preset, add track, and standard toolbar buttons share the same downward placement',
      'A static test locks the requested bottom side on every toolbar tooltip',
      'The placement control no longer clips Overwrite at narrow desktop widths',
      'The README and About dialog describe the editor as pre-1.0 instead of an MVP',
    ],
  },
  {
    version: '0.10.2',
    date: '2026-10-24',
    highlights: [
      'The menu bar adds a compact Full screen button beside the version label',
      'The button enters and exits browser fullscreen and follows Escape or any external exit',
      'Focused buttons own Space, so the fullscreen button activates natively instead of toggling playback',
      'Rejected requests and missing APIs report through the existing Action failed toast',
    ],
  },
  {
    version: '0.10.1',
    date: '2026-10-24',
    highlights: [
      'View > Appearance adds ten palettes: Garnet, Blush, Ember, Honey, Olive, Lagoon, Ocean, Steel, Indigo, and Orchid',
      'The picker is a two-column grid in a scrollable dialog, so all fourteen choices fit short windows',
      'Every palette still changes only the 17 chrome tokens; clip kinds, markers, the monitor, scopes, and the splash stay fixed',
      'Existing palettes and saved choices keep working, and the same contrast and token locks cover every block',
    ],
  },
  {
    version: '0.10.0',
    date: '2026-10-24',
    highlights: [
      'View > Appearance offers curated dark palettes: Default, Midnight, Forest, and Plum',
      'A selection applies immediately through the CSS token layer and persists per browser',
      'The palette lives under its own storage key, so Reset Workspace Layout cannot change it',
      'Clip kinds, markers, the monitor, scopes, and the boot splash keep their fixed colours',
      'Destructive toast text now uses a declared foreground token instead of inheriting the page text colour',
    ],
  },
  {
    version: '0.9.2',
    date: '2026-10-23',
    highlights: [
      'The boot screen is a 10x10 ripple grid: one seamless center-out wave per 1.6s cycle, no restarts, with the lit color traveling the full hue wheel',
      'The lit color travels the full hue wheel every three pulses',
      'Reduced motion keeps a static dim grid instead of the animation',
      'A failed chunk load shows a retry instead of hanging on the splash',
      'No progress bar: the boot import reports no progress, so a counter would be theater',
    ],
  },
  {
    version: '0.9.1',
    date: '2026-10-23',
    highlights: [
      'Sequence Settings opens a real dialog with the project name, frame size, and frame rate',
      'OK applies everything as one undo step, Cancel discards the draft',
      'All menus align flush left, including Mute and the View and Window toggles',
      'Toggle rows announce their state to screen readers again',
    ],
  },
  {
    version: '0.9.0',
    date: '2026-10-22',
    highlights: [
      'The 63-step battery polls for readiness instead of sleeping: an artifact-leg run takes about 7 minutes instead of about 8, a dev-leg run about 8 instead of about 10',
      'Export completion polls every 0.25s under the same 120-second deadline, and frame reads wait for the presented video frame',
      'Frame stepping dispatches in-page with a delivery lock, so a missed keypress fails its step instead of testing the wrong frame',
      'Same steps with the same assertions, verified green on the dev server and the shipped build',
    ],
  },
  {
    version: '0.8.9',
    date: '2026-10-21',
    highlights: [
      'Captions download as WebVTT as well as SRT: a Download VTT button writes the same cue list with proper headers and timestamps',
      'The same collector, ordering, and range checks feed both formats, so the two files cannot disagree',
      'Out-of-range captions refuse with a format-neutral message on either download path',
      'The battery downloads and checks both formats, in the dev run and against the shipped build',
    ],
  },
  {
    version: '0.8.8',
    date: '2026-10-20',
    highlights: [
      'Static motion-blur clips preview and export much faster: static windows render once instead of up to 8 times',
      'Animated blur is untouched, moving clips still accumulate the full shutter window',
      'Bypass output matches the existing single-sample path; residual rounding differences are accepted and unmeasured',
      'Preview and export decide through one shared helper, so the two paths cannot drift apart',
    ],
  },
  {
    version: '0.8.7',
    date: '2026-10-20',
    highlights: [
      'Cue seeks and New Cue land the playhead on the cue, including from inside a compound sequence',
      'A seek issued at the same moment as a path change now survives, so the playhead lands where you asked',
      'Deleting a compound container or undoing keeps the playhead instead of parking it at zero',
      'The program monitor follows every seek, so the frame shown always matches the playhead time',
    ],
  },
  {
    version: '0.8.6',
    date: '2026-10-18',
    highlights: [
      'Effects beyond opacity: crop, blend modes, chroma key, track matte and motion blur on every clip through an ordered effect stack',
      'Crop with feather and zoom refill, sixteen canvas blend modes under Opacity, and an eyedropper chroma keyer with despill',
      'Track mattes from any higher lane with luma or alpha compositing, plus motion blur that accumulates your animated moves',
      'Preview and export render every effect identically, and files stay at v4 with old projects opening unchanged',
    ],
  },
  {
    version: '0.8.5',
    date: '2026-10-17',
    highlights: [
      'Subtitles and captions: import an SRT file to create timed caption cues on their own Captions track',
      'A Captions panel lists every cue with editable text and timing, click-to-seek, and one-click cue creation at the playhead',
      'Export the cues back to SRT in start order, or leave them burned into the MP4 exactly as the monitor shows',
      'Files stay at v4 with old projects opening unchanged, and imported cues arrive styled bottom-centered',
    ],
  },
  {
    version: '0.8.4',
    date: '2026-10-15',
    highlights: [
      'Wipe, slide and push transitions: each transition picks from five types in the Inspector, with direction, wipe edge and feather width controls',
      'A wipe reveals the next picture from any edge (hard or feathered), a slide moves it over the current one, and a push moves both together',
      'Preview and export render the spatial moves identically through one shared geometry function, at full opacity in both',
      'Files stay at v4 with old projects opening unchanged, and switching type preserves duration, direction and edge settings',
    ],
  },
  {
    version: '0.8.3',
    date: '2026-10-14',
    highlights: [
      'Title presets: save any text style as a named preset and reuse it across clips, with Title, Subtitle, Lower third and Caption built in',
      'Apply a preset from the Inspector, or pick one straight from the Add Text button so a new title is born styled',
      'Presets travel with the project file: they round-trip on save and load, and older projects open with an empty library',
      'Saving or renaming to an existing name is refused, and the built-in presets cannot be renamed or deleted',
    ],
  },
  {
    version: '0.8.2',
    date: '2026-10-14',
    highlights: [
      'Dip to black: each transition picks Cross dissolve or Dip to black in the Inspector, beside the unchanged duration slider',
      'The pair blacks out at the midpoint while lower tracks show through, the same layering a crossfade uses',
      'Preview and export render the dip identically through the one shared alpha function',
      'Project files keep working: dips round-trip, and unknown transition types read as cross dissolves',
    ],
  },
  {
    version: '0.8.1',
    date: '2026-10-12',
    highlights: [
      'Compound clips: select clips and create one reusable unit that replaces them in place, then double-click to open and edit it',
      'A compound renders as a group, so its opacity, transform and grade apply once to the whole nested result, in the preview and the export alike',
      'Nested audio plays through every enclosing container, whose gain, mute and volume curve apply once to the nested mix',
      'A breadcrumb shows the open sequence and jumps back to the parent; a compound can contain another compound, and a cycle is refused',
    ],
  },
  {
    version: '0.8.0',
    date: '2026-10-12',
    highlights: [
      'Export to file streams the MP4 straight to disk, so a long export no longer has to fit in memory',
      'The export dialog estimates the file size and points you to Export to file once it grows past 100 MB',
      'Proxies: build a lighter preview copy of a heavy source and toggle View > Use Proxies for smoother playback, while the export still reads the original',
      'The Media bin shows proxy status and builds one on demand, and toggling proxies reroutes the monitors without losing your place',
    ],
  },
  {
    version: '0.7.3',
    date: '2026-10-10',
    highlights: [
      'Collapsing the Source Monitor now really collapses it: the panel shrinks to a thin strip instead of keeping its full width',
      'Both the Source Monitor and the Inspector can be collapsed at once, with the Program Monitor filling the space between them',
      'A refused collapse no longer leaves a ghost strip or reopens a panel at its maximum size',
      'The workspace layout no longer fights you when two panels are collapsed together',
    ],
  },
  {
    version: '0.7.2',
    date: '2026-10-09',
    highlights: [
      'Insert and overwrite placement: the toolbar switches between Place, Insert and Overwrite, so a drop can shift or replace what is already there',
      'Three-point editing: click a clip in the Media bin, mark In and Out with I and O, then press , (insert) or . (overwrite) to place that span at the playhead',
      'The new Source Monitor shows the selected asset with its own preview, transport and marked window',
      'Insert and overwrite are link-group aware, and one Ctrl+Z undoes a whole placement',
    ],
  },
  {
    version: '0.7.1',
    date: '2026-10-08',
    highlights: [
      'Target any lane: Target Track in the track header menu steers paste, quick-add and Add Text to the first targeted compatible lane',
      'An untargeted lane dims its kind icon; every track starts targeted, and the choice is session state only',
      'Select Track Clips takes a whole lane at once, expanding A/V link groups so both halves come along',
      "Pastes keep the clip's own lane while that lane is still targeted, so a duplicate lands where it came from",
    ],
  },
  {
    version: '0.7.0',
    date: '2026-10-07',
    highlights: [
      'Grade a clip with a .cube LUT: the project keeps one copy of each file, and many clips can share it',
      '1D LUTs apply as exact per-channel shapers; 3D LUTs run through one shared pixel pass in the preview and the export',
      'The monitor scopes gain a waveform and a vectorscope beside the luma histogram and the RGB-balance read',
      'Below the output frame rate both renders blend neighbouring frames, so a slowed or ramped clip stops juddering in the monitor and in the exported file alike',
    ],
  },
  {
    version: '0.6.4',
    date: '2026-10-06',
    highlights: [
      "The Effect Controls graph draws each keyframe segment's real bezier curve",
      'Shape any segment by dragging its two handles, or nudge them with the arrow keys',
      'Per-property default easing: set it on a row and every new keyframe of that property starts with it',
      'The easing picker edits the segment you see, and it is available on every property row',
    ],
  },
  {
    version: '0.6.3',
    date: '2026-10-04',
    highlights: [
      'A video clip with no audio twin now exports its own sound instead of going silent, exactly like the preview',
      "Manually linked clips keep every member's audio in the export, matching the preview",
      'One shared audibility rule feeds the preview, the export plan and the export mix, so they cannot drift apart',
      'Small fixes: auto-ducking skips silent dialogue faster and keyframe dots nudge on the shared frame grid',
    ],
  },
  {
    version: '0.6.2',
    date: '2026-10-04',
    highlights: [
      "Changing one half of a linked A/V pair's speed drops the pair's audio instead of playing out of step",
      'Clips whose media stops resolving stop playing instead of ghosting on, and return when the asset comes back',
      'Linking clips for convenience no longer mutes them at different speeds, and a music clip merged into a pair keeps its own sound',
      'Export refuses offline or dangling media based on the clips it will render, not the whole bin',
      'Auto-ducking no longer dips the music for dialogue that cannot play',
    ],
  },
  {
    version: '0.6.1',
    date: '2026-10-01',
    highlights: [
      'Trims on reversed and time-remapped clips keep the exact frames through head, tail, split and rate stretch',
      'Playback cleans up after deletes and relinks: no clip keeps playing in the background and no audio chain goes stale',
      'Export is honest: it refuses offline media, releases the encoder on cancel, and matches the preview for EQ and eased volume',
      'Speed and time remapping controls report the rate the engine applies, and the keyframe dots nudge with arrow keys',
    ],
  },
  {
    version: '0.6.0',
    date: '2026-09-29',
    highlights: [
      'Keyframe easing: easeIn, easeOut and easeInOut on any keyframe, picked in the Effect Controls graph',
      'Speed curves: keyframe the time scale inside a clip for true time remapping (audio under a ramp is dropped)',
      'Temperature and tint sliders grade the preview and the export through one shared color matrix',
      'Scopes in the monitor: a luma histogram and an RGB balance meter, collapsible and off by default',
      'A Reduce noise switch cleans broadband hiss in the preview and the export',
    ],
  },
  {
    version: '0.5.6',
    date: '2026-09-28',
    highlights: [
      'A welcome modal greets you after login with what changed in the last five versions, once per release',
      "Help > What's new opens the same notes any time",
      'The menu bar shows the running version at its right edge',
      'The version blocks stagger in with a reduced-motion-safe slide and fade',
    ],
  },
  {
    version: '0.5.5',
    date: '2026-09-27',
    highlights: [
      'Markers on the timeline and on clips: M adds, Shift+M / Ctrl+Shift+M navigate, and markers are snap targets',
      'One pointer owns a drag: a second finger can no longer commit, steer or cancel a gesture it did not start',
      'Project files are version 2: sequence and clip markers serialize, and v1 files still load',
      'A marker dialog edits name, one of eight colors and notes',
    ],
  },
  {
    version: '0.5.4',
    date: '2026-09-27',
    highlights: [
      'Marquee (box) selection: drag on empty lane space to select, with shift to add and ctrl to toggle',
      'Edge auto-scroll while dragging the box or a clip across the timeline',
      'A click on empty space still deselects; the razor tool ignores the box',
      'The hit math lives in pure marquee.ts, so it is unit-tested and coverage-gated',
    ],
  },
  {
    version: '0.5.3',
    date: '2026-09-23',
    highlights: [
      'Offline media is detected per frame and relinked without losing your edits',
      'The monitor says "Media offline" with the file names and a relink hint instead of a silent black frame',
      'Restore and project loads are hardened against stale or partial saves',
      'A restore or load is one undo step again',
    ],
  },
  {
    version: '0.5.2',
    date: '2026-09-22',
    highlights: [
      'Scrubbing no longer blacks out the preview: a seek in flight is left alone to finish',
      'The drift corrector waits above the worst-case seek latency before re-seeking',
      'Restored sessions play after relinking: missing assets are skipped, not phantom elements',
      'Scrubbing on the ruler pauses playback first, like Premiere, and restores it on play',
    ],
  },
]

/** The version the running app greets with: the top of the list. */
export const CURRENT_VERSION = releases[0].version

/** The notes for one version, or undefined when unknown (future/removed). */
export function releaseByVersion(version: string): ReleaseNotes | undefined {
  return releases.find((r) => r.version === version)
}

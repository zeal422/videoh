/**
 * src/lib/releases.ts, the hand-curated release notes behind the welcome
 * modal (Help > What's new, and the once-per-version auto-open after login).
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

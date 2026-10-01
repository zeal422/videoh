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

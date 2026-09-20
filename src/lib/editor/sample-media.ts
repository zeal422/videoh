/**
 * Bundled demo assets for the "Load sample media" affordance.
 *
 * Loading must be IDEMPOTENT: pressing the button twice must not create
 * duplicate bin entries. `filterNewSamples` keeps only samples whose file
 * name is not already present in the media bin (names are how imports map
 * onto existing assets — see `importMediaFiles`' relink matching), so a
 * second press becomes a no-op with a friendly toast instead of 3 clones.
 */
export interface SampleFile {
  path: string
  name: string
}

export const SAMPLES: SampleFile[] = [
  { path: '/samples/sample-video.mp4', name: 'sample-video.mp4' },
  { path: '/samples/sample-audio.mp3', name: 'sample-audio.mp3' },
  { path: '/samples/sample-image.png', name: 'sample-image.png' },
]

/** Keep only samples whose `name` is not already among `existingNames`. */
export function filterNewSamples<T extends { name: string }>(
  samples: readonly T[],
  existingNames: Iterable<string>,
): T[] {
  const existing = new Set(existingNames)
  return samples.filter((sample) => !existing.has(sample.name))
}

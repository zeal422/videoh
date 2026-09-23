/**
 * Bundled demo assets for the "Load sample media" affordance.
 *
 * The app serves these files itself (`/samples/*`), which makes them the one
 * kind of media whose bytes are still reachable after a reload. Every asset
 * hydrates offline when a project loads or an autosaved session is restored,
 * so `planSampleLoad` reports two things: samples to ADD (not in the bin yet)
 * and samples to RELINK (in the bin but offline). A sample already in the bin
 * and online is skipped, so pressing the button twice still never duplicates
 * and a restored session can bring its own samples back without a file picker.
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

export interface SampleLoadPlan {
  /** Not in the bin yet: importing adds them as new assets. */
  fresh: SampleFile[]
  /** In the bin but offline: importing relinks them in place (name match). */
  relink: SampleFile[]
}

/** Splits the bundled samples by what the bin needs. Pure; never mutates input. */
export function planSampleLoad(
  media: readonly { name: string; missing?: boolean }[],
): SampleLoadPlan {
  const byName = new Map(media.map((m) => [m.name, m]))
  const plan: SampleLoadPlan = { fresh: [], relink: [] }
  for (const sample of SAMPLES) {
    const existing = byName.get(sample.name)
    if (!existing) plan.fresh.push(sample)
    else if (existing.missing) plan.relink.push(sample)
  }
  return plan
}

export type SampleImportAction = 'add' | 'relink' | 'skip'

/**
 * What importing ONE already-fetched sample must do against the CURRENT bin.
 *
 * The fetched bytes are fixed; the bin is not. A second press, a restore that
 * lands mid-flight, or any other overlap can bring the same sample in while
 * this import is still probing, and importing it again would leave a twin
 * asset with the same name (two rows, one set of bytes). Ask this immediately
 * before writing and the answer closes that window.
 */
export function sampleImportAction(
  media: readonly { name: string; missing?: boolean }[],
  name: string,
): SampleImportAction {
  const plan = planSampleLoad(media)
  if (plan.relink.some((s) => s.name === name)) return 'relink'
  if (plan.fresh.some((s) => s.name === name)) return 'add'
  return 'skip'
}

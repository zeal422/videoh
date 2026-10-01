import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  DENOISE_CORNER_Q_DB,
  DENOISE_HISS_DB,
  DENOISE_HISS_HZ,
  DENOISE_HISS_Q,
  DENOISE_HIGHPASS_HZ,
  DENOISE_LOWPASS_HZ,
} from '../constants'
import { denoiseFilters } from '../playback/denoise'

/**
 * The noise-reduction chain is three fixed native biquads with no app-side DSP,
 * so what is worth locking is its SHAPE: the node types, the band parameters
 * both render paths read from the shared constants, and the fact that every
 * caller gets nodes of its own (the preview mixer and an export can be live at
 * the same time, and a shared node cannot be wired into two graphs).
 */

interface FakeBiquad {
  type: string
  frequency: { value: number }
  Q: { value: number }
  gain: { value: number }
}

/** Minimal BaseAudioContext stand-in: the builder only creates biquad filters. */
function fakeContext(): { ctx: BaseAudioContext; made: FakeBiquad[] } {
  const made: FakeBiquad[] = []
  const ctx = {
    createBiquadFilter() {
      const node: FakeBiquad = {
        type: '',
        frequency: { value: 0 },
        Q: { value: 0 },
        gain: { value: 0 },
      }
      made.push(node)
      return node
    },
  } as unknown as BaseAudioContext
  return { ctx, made }
}

describe('denoiseFilters', () => {
  it('builds the rumble high-pass, the hiss low-pass and the hiss cut, in order', () => {
    const { ctx, made } = fakeContext()
    const filters = denoiseFilters(ctx)

    expect(filters).toHaveLength(3)
    expect(made.map((f) => f.type)).toEqual(['highpass', 'lowpass', 'peaking'])
    expect(made[0].frequency.value).toBe(DENOISE_HIGHPASS_HZ)
    expect(made[1].frequency.value).toBe(DENOISE_LOWPASS_HZ)
    // Both corners read Q in dB, so the shared Butterworth value is what keeps
    // the voice band flat. The response test measures the band; these pin the
    // exact value so a steeper-corner tweak cannot slip past it.
    expect(made[0].Q.value).toBe(DENOISE_CORNER_Q_DB)
    expect(made[1].Q.value).toBe(DENOISE_CORNER_Q_DB)
    expect(made[2].frequency.value).toBe(DENOISE_HISS_HZ)
    expect(made[2].Q.value).toBe(DENOISE_HISS_Q)
    expect(made[2].gain.value).toBe(DENOISE_HISS_DB)
  })

  it('keeps the voice band open: corners ordered, the hiss cut inside it', () => {
    const { ctx, made } = fakeContext()
    denoiseFilters(ctx)
    const [highpass, lowpass, hiss] = made

    expect(highpass.frequency.value).toBeLessThan(lowpass.frequency.value)
    expect(hiss.frequency.value).toBeGreaterThan(highpass.frequency.value)
    expect(hiss.frequency.value).toBeLessThan(lowpass.frequency.value)
    // The cut only ever attenuates: this is a denoiser, not a presence boost.
    expect(hiss.gain.value).toBeLessThan(0)
  })

  it('hands every caller its own nodes', () => {
    const { ctx, made } = fakeContext()
    const first = denoiseFilters(ctx)
    const second = denoiseFilters(ctx)

    expect(made).toHaveLength(6)
    for (const [i, node] of first.entries()) expect(node).not.toBe(second[i])
  })

  it('is the single source of the chain for both render paths (static lock)', () => {
    const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
    const core = read('src/lib/editor/playback/core.ts')
    const mp4 = read('src/lib/editor/export/mp4.ts')

    expect(core).toMatch(/denoiseFilters\(this\.audio\)/)
    expect(mp4).toMatch(/denoiseFilters\(offline\)/)
    // Both gate it on the clip's own flag: a clip without denoise keeps the
    // chain it had before 0.6.0.
    expect(core).toMatch(/if \(clip\.denoise\)/)
    expect(mp4).toMatch(/if \(clip\.denoise\)/)
    // Neither path hand-rolls the filters again (the pre-0.6.0 shape this
    // replaced was two copies of the same three-node chain).
    expect(core).not.toMatch(/type = 'highpass'/)
    expect(mp4).not.toMatch(/type = 'highpass'/)
  })
})

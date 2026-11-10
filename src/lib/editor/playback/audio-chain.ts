import { EQ_DB_MAX, EQ_DB_MIN, EQ_HIGH_HZ, EQ_LOW_HZ, EQ_MID_HZ } from '../constants'
import { clamp } from '../time'
import type { Clip } from '../types'
import { denoiseFilters } from './denoise'

/**
 * The shared per-clip audio shaping chain (0.20.0): EQ, denoise, panner,
 * compressor. Both engines build through this one function, so preview and
 * export cannot drift apart:
 *
 *   source -> EQ (3 biquads)? -> denoise (3 biquads)? -> panner? -> compressor?
 *
 * The panner ALWAYS exists when the context supports it, including pan 0, and
 * it sits BEFORE the compressor. Chrome's `DynamicsCompressorNode` outputs two
 * channels from a mono input, so a panner after the compressor would see
 * stereo at pan 0 and apply identity instead of the equal-power split. Putting
 * the panner first preserves the mono center split; the compressor then sees
 * the panned signal, which can change gain reduction (documented in the
 * release notes and the behavior matrix).
 *
 * The caller owns the returned nodes and connects `head` to its gain node.
 * `nodes` is the release list for chain teardown.
 */
export interface AudioChain {
  head: AudioNode
  nodes: AudioNode[]
}

/**
 * `clamp` propagates NaN, and Web Audio would accept it as a parameter value.
 * A missing or NaN input has no meaningful side, so use the neutral value
 * (pan center, 0 dB); infinities still clamp to the finite edge.
 */
function clampAudioValue(value: number, min: number, max: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0
  return clamp(value, min, max)
}

export function buildAudioChain(ctx: BaseAudioContext, source: AudioNode, clip: Clip): AudioChain {
  const nodes: AudioNode[] = []
  let head = source

  // Three-band EQ (low shelf / mid peak / high shelf) when configured.
  if (clip.eq) {
    const low = ctx.createBiquadFilter()
    low.type = 'lowshelf'
    low.frequency.value = EQ_LOW_HZ
    low.gain.value = clampAudioValue(clip.eq.low, EQ_DB_MIN, EQ_DB_MAX)
    const mid = ctx.createBiquadFilter()
    mid.type = 'peaking'
    mid.frequency.value = EQ_MID_HZ
    mid.Q.value = 1
    mid.gain.value = clampAudioValue(clip.eq.mid, EQ_DB_MIN, EQ_DB_MAX)
    const high = ctx.createBiquadFilter()
    high.type = 'highshelf'
    high.frequency.value = EQ_HIGH_HZ
    high.gain.value = clampAudioValue(clip.eq.high, EQ_DB_MIN, EQ_DB_MAX)
    head.connect(low)
    low.connect(mid)
    mid.connect(high)
    head = high
    nodes.push(low, mid, high)
  }

  if (clip.denoise) {
    for (const filter of denoiseFilters(ctx)) {
      head.connect(filter)
      head = filter
      nodes.push(filter)
    }
  }

  // Always create the panner when the context supports it: pan 0 is the
  // equal-power center split for mono sources, not a no-op. A context without
  // `createStereoPanner` intentionally omits the panner, so preview and export
  // use the chain they can build.
  if ('createStereoPanner' in ctx) {
    const panner = ctx.createStereoPanner()
    panner.pan.value = clampAudioValue(clip.pan ?? 0, -1, 1)
    head.connect(panner)
    head = panner
    nodes.push(panner)
  }

  if (clip.compressor) {
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -24
    comp.knee.value = 12
    comp.ratio.value = 4
    comp.attack.value = 0.005
    comp.release.value = 0.18
    head.connect(comp)
    head = comp
    nodes.push(comp)
  }

  return { head, nodes }
}

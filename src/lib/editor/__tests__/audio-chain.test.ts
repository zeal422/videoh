import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { EQ_HIGH_HZ, EQ_LOW_HZ, EQ_MID_HZ } from '../constants'
import { createClip } from '../factories'
import { buildAudioChain } from '../playback/audio-chain'
import type { Clip } from '../types'
import {
  FakeAudioContext,
  FakeAudioNode,
  FakeBiquadFilterNode,
  FakeDynamicsCompressorNode,
  FakeStereoPannerNode,
} from './mocks/browser-mocks'

/**
 * The shared audio shaping builder (0.20.0): EQ, denoise, panner, compressor,
 * in that order. Preview and export both call it, so the routing assertions
 * below read the mock graph's real `connect` edges, not just creation order.
 */

function chainFor(partial: Partial<Clip>) {
  const ctx = new FakeAudioContext()
  const source = new FakeAudioNode()
  const clip = createClip({ mediaId: 'media', start: 0, duration: 4, ...partial })
  const chain = buildAudioChain(
    ctx as unknown as BaseAudioContext,
    source as unknown as AudioNode,
    clip,
  )
  return { ctx, source, clip, chain }
}

describe('buildAudioChain — routing', () => {
  it('flat shaping is a panner only, at pan 0', () => {
    const { source, chain } = chainFor({})
    expect(chain.nodes).toHaveLength(1)
    const panner = chain.nodes[0] as unknown as FakeStereoPannerNode
    expect(panner).toBeInstanceOf(FakeStereoPannerNode)
    expect(panner.pan.value).toBe(0)
    expect(chain.head).toBe(panner)
    expect(source.connections).toEqual([panner])
    expect(panner.inputs).toEqual([source])
  })

  it('EQ only: source -> low -> mid -> high -> panner', () => {
    const { source, chain } = chainFor({ eq: { low: 6, mid: -3, high: 12 } })
    expect(chain.nodes).toHaveLength(4)
    const [low, mid, high, panner] = chain.nodes as unknown as FakeBiquadFilterNode[]
    expect(low.type).toBe('lowshelf')
    expect(low.frequency.value).toBe(EQ_LOW_HZ)
    expect(low.gain.value).toBe(6)
    expect(mid.type).toBe('peaking')
    expect(mid.frequency.value).toBe(EQ_MID_HZ)
    expect(mid.Q.value).toBe(1)
    expect(mid.gain.value).toBe(-3)
    expect(high.type).toBe('highshelf')
    expect(high.frequency.value).toBe(EQ_HIGH_HZ)
    expect(high.gain.value).toBe(12)

    expect(source.connections).toEqual([low])
    expect(low.connections).toEqual([mid])
    expect(mid.connections).toEqual([high])
    expect(high.connections).toEqual([panner])
    expect(chain.head).toBe(panner)
  })

  it('denoise only: source -> high-pass -> low-pass -> hiss cut -> panner', () => {
    const { source, chain } = chainFor({ denoise: true })
    expect(chain.nodes).toHaveLength(4)
    const [highpass, lowpass, hiss, panner] = chain.nodes as unknown as FakeBiquadFilterNode[]
    expect([highpass.type, lowpass.type, hiss.type]).toEqual(['highpass', 'lowpass', 'peaking'])

    expect(source.connections).toEqual([highpass])
    expect(highpass.connections).toEqual([lowpass])
    expect(lowpass.connections).toEqual([hiss])
    expect(hiss.connections).toEqual([panner])
    expect(chain.head).toBe(panner)
  })

  it('compressor only: source -> panner -> compressor, head is the compressor', () => {
    const { source, chain } = chainFor({ compressor: true })
    expect(chain.nodes).toHaveLength(2)
    const [panner, comp] = chain.nodes as unknown as [
      FakeStereoPannerNode,
      FakeDynamicsCompressorNode,
    ]
    expect(panner).toBeInstanceOf(FakeStereoPannerNode)
    expect(comp).toBeInstanceOf(FakeDynamicsCompressorNode)

    expect(source.connections).toEqual([panner])
    expect(panner.connections).toEqual([comp])
    expect((comp as FakeDynamicsCompressorNode).threshold.value).toBe(-24)
    expect((comp as FakeDynamicsCompressorNode).ratio.value).toBe(4)
    expect(chain.head).toBe(comp)
  })

  it('all shaping: the panner receives the denoise tail and feeds the compressor', () => {
    const { source, chain } = chainFor({
      eq: { low: 1, mid: 2, high: 3 },
      denoise: true,
      compressor: true,
      pan: 0.5,
    })
    expect(chain.nodes).toHaveLength(8)
    const [low, mid, high, highpass, lowpass, hiss, panner, comp] = chain.nodes as unknown as (
      FakeBiquadFilterNode | FakeStereoPannerNode | FakeDynamicsCompressorNode
    )[]

    expect(source.connections).toEqual([low])
    expect(low.connections).toEqual([mid])
    expect(mid.connections).toEqual([high])
    expect(high.connections).toEqual([highpass])
    expect(highpass.connections).toEqual([lowpass])
    expect(lowpass.connections).toEqual([hiss])
    expect(hiss.connections).toEqual([panner])
    expect(panner.inputs).toEqual([hiss])
    expect(panner.connections).toEqual([comp])
    expect(chain.head).toBe(comp)
    expect((panner as FakeStereoPannerNode).pan.value).toBe(0.5)
  })

  it('clamps pan and EQ gains at the trust boundary', () => {
    const pan = (value: number) =>
      (chainFor({ pan: value }).chain.nodes[0] as unknown as FakeStereoPannerNode).pan.value
    expect(pan(9)).toBe(1)
    expect(pan(-9)).toBe(-1)
    expect(pan(Infinity)).toBe(1)
    expect(pan(-Infinity)).toBe(-1)
    expect(pan(Number.NaN)).toBe(0)

    const eq = (low: number, mid: number, high: number) =>
      chainFor({ eq: { low, mid, high } }).chain.nodes as unknown as FakeBiquadFilterNode[]
    const [low, mid] = eq(999, -999, 0)
    expect(low.gain.value).toBe(24)
    expect(mid.gain.value).toBe(-24)
    const [infLow, negInfMid] = eq(Infinity, -Infinity, 0)
    expect(infLow.gain.value).toBe(24)
    expect(negInfMid.gain.value).toBe(-24)
    const [nanLow, nanMid, nanHigh] = eq(Number.NaN, Number.NaN, Number.NaN)
    expect([nanLow.gain.value, nanMid.gain.value, nanHigh.gain.value]).toEqual([0, 0, 0])
  })
})

describe('mono pan oracle', () => {
  /**
   * Web Audio's equal-power stereo panner maps pan p in [-1, 1] to
   * x = (p + 1) / 2 and gains cos(x*pi/2) / sin(x*pi/2). The mocked nodes do
   * not implement the gain math, so this pins the SPEC values the new order
   * relies on: pan 0 is the -3 dB center split, and a pan just off zero is
   * effectively identical (no audible discontinuity at the node boundary).
   */
  const gains = (pan: number): [number, number] => {
    const x = (pan + 1) / 2
    return [Math.cos((x * Math.PI) / 2), Math.sin((x * Math.PI) / 2)]
  }

  it('pan 0 is cos(pi/4) left and sin(pi/4) right', () => {
    const [left, right] = gains(0)
    expect(left).toBeCloseTo(Math.cos(Math.PI / 4), 12)
    expect(right).toBeCloseTo(Math.sin(Math.PI / 4), 12)
    expect(left).toBeCloseTo(right, 12)
  })

  it('pan 0.0001 stays within 1e-4 of pan 0', () => {
    const [left0, right0] = gains(0)
    const [left1, right1] = gains(0.0001)
    expect(Math.abs(left0 - left1)).toBeLessThan(1e-4)
    expect(Math.abs(right0 - right1)).toBeLessThan(1e-4)
  })
})

describe('shared-builder static locks', () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

  it('both engines import the one builder and build no shaping nodes inline', () => {
    const core = read('src/lib/editor/playback/core.ts')
    const mp4 = read('src/lib/editor/export/mp4.ts')

    expect(core).toMatch(/from '\.\/audio-chain'/)
    expect(mp4).toMatch(/from '\.\.\/playback\/audio-chain'/)
    for (const source of [core, mp4]) {
      expect(source).not.toMatch(
        /createBiquadFilter|createDynamicsCompressor|createStereoPanner|denoiseFilters/,
      )
    }
  })
})

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DENOISE_HISS_DB,
  DENOISE_HISS_HZ,
  DENOISE_LOWPASS_HZ,
  DENOISE_HIGHPASS_HZ,
} from '../constants'
import { denoiseFilters } from '../playback/denoise'
/**
 * The MEASURABLE half of the denoise feature: white noise in, per-band energy
 * out. There is no real OfflineAudioContext in Node, so this renders the chain
 * through a faithful IIR stand-in: the same biquad coefficient formulas the Web
 * Audio spec defines for highpass/lowpass/peaking, applied sample by sample.
 * That proves the SEQUENCE of bands the builder produces attenuates what it
 * should and preserves what it should, which is the numeric criterion this
 * feature is judged on; final audibility stays a manual check.
 *
 * Q CONVENTION: the spec reads `Q` as DECIBELS for lowpass/highpass and as a
 * linear quality factor for peaking, so `makeChain` converts the two corner
 * filters the way the browser does. Modeling all three with a linear Q would
 * hide a corner resonance the browser actually applies.
 *
 * The builder's own shape (node types, parameters, per-caller nodes) is locked
 * in denoise.test.ts; this file locks what that shape DOES to a signal.
 */

const SAMPLE_RATE = 48000

/** One Web Audio biquad, sample by sample, spec coefficient formulas. */
class Biquad {
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0
  private b: number[] = []
  private a: number[] = []

  constructor(type: 'highpass' | 'lowpass' | 'peaking', f0: number, Q: number, gainDb = 0) {
    const w0 = (2 * Math.PI * f0) / SAMPLE_RATE
    const c = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * Q)
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number
    if (type === 'highpass') {
      b0 = (1 + c) / 2
      b1 = -(1 + c)
      b2 = (1 + c) / 2
      a0 = 1 + alpha
      a1 = -2 * c
      a2 = 1 - alpha
    } else if (type === 'lowpass') {
      b0 = (1 - c) / 2
      b1 = 1 - c
      b2 = (1 - c) / 2
      a0 = 1 + alpha
      a1 = -2 * c
      a2 = 1 - alpha
    } else {
      const A = 10 ** (gainDb / 40)
      b0 = 1 + alpha * A
      b1 = -2 * c
      b2 = 1 - alpha * A
      a0 = 1 + alpha / A
      a1 = -2 * c
      a2 = 1 - alpha / A
    }
    this.b = [b0 / a0, b1 / a0, b2 / a0]
    this.a = [a1 / a0, a2 / a0]
  }

  process(x: number): number {
    const y =
      this.b[0] * x +
      this.b[1] * this.x1 +
      this.b[2] * this.x2 -
      this.a[0] * this.y1 -
      this.a[1] * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }
}

/** The chain exactly as the export mixer would wire it: head -> f0 -> f1 -> f2. */
function makeChain(): (x: number) => number {
  // The builder's parameters come from the shared constants; this stand-in
  // re-derives the same three stages with the spec formulas the real nodes
  // implement, so the numbers below measure the actual Web Audio response.
  const { ctx, made } = fakeContext()
  const filters = denoiseFilters(ctx)
  expect(filters).toHaveLength(3)
  const [hp, lp, hiss] = made
  expect(hp.type).toBe('highpass')
  expect(lp.type).toBe('lowpass')
  expect(hiss.type).toBe('peaking')
  // dB -> linear for the two corner filters; the peaking filter's Q is linear.
  const linearQ = (db: number) => 10 ** (db / 20)
  const chain = [
    new Biquad('highpass', hp.frequency.value, linearQ(hp.Q.value)),
    new Biquad('lowpass', lp.frequency.value, linearQ(lp.Q.value)),
    new Biquad('peaking', hiss.frequency.value, hiss.Q.value, hiss.gain.value),
  ]
  return (x: number) => chain.reduce((v, f) => f.process(v), x)
}

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

/** Deterministic pseudorandom in [-1, 1] (xorshift), so the test never flakes. */
function whiteNoise(samples: number, seed = 0x9e3779b9): number[] {
  let s = seed >>> 0
  const out: number[] = []
  for (let i = 0; i < samples; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    out.push((s / 0xffffffff) * 2 - 1)
  }
  return out
}

/**
 * RMS energy of the band [lo, hi) via a single-complex-pole DFT (Goertzel),
 * which is exact enough for band comparisons and O(n) per band.
 */
function bandEnergy(signal: number[], lo: number, hi: number): number {
  let power = 0
  for (let f = Math.ceil(lo); f < Math.min(hi, SAMPLE_RATE / 2); f += 10) {
    const w = (2 * Math.PI * f) / SAMPLE_RATE
    const coeff = 2 * Math.cos(w)
    let s1 = 0
    let s2 = 0
    for (const x of signal) {
      const s0 = x + coeff * s1 - s2
      s2 = s1
      s1 = s0
    }
    power += s1 * s1 + s2 * s2 - coeff * s1 * s2
  }
  return Math.sqrt(power)
}

describe('denoise chain response (white noise in, band energy out)', () => {
  let noise: number[]
  let processed: number[]

  beforeEach(() => {
    noise = whiteNoise(SAMPLE_RATE) // 1 s, warmup included
    const chain = makeChain()
    processed = noise.map(chain)
    // Drop the filter warmup from every measurement.
    noise = noise.slice(4000)
    processed = processed.slice(4000)
  })

  afterEach(() => {
    // nothing to tear down: pure DSP, no globals touched
  })

  it('attenuates the rumble band below the high-pass corner', () => {
    const before = bandEnergy(noise, 20, DENOISE_HIGHPASS_HZ)
    const after = bandEnergy(processed, 20, DENOISE_HIGHPASS_HZ)
    expect(after).toBeLessThan(before * 0.5)
  })

  it('never boosts the voice fundamental band (100-250 Hz)', () => {
    const before = bandEnergy(noise, 100, 250)
    const after = bandEnergy(processed, 100, 250)
    // A corner Q above linear 0.7071 rings the passband, so a db-vs-linear Q
    // mix-up shows up here as a boost. The Butterworth corner only attenuates.
    const ratio = after / before
    expect(ratio).toBeLessThanOrEqual(1.0)
    expect(ratio).toBeGreaterThan(0.84)
  })

  it('keeps the speech band roughly preserved', () => {
    const before = bandEnergy(noise, 300, 3400)
    const after = bandEnergy(processed, 300, 3400)
    // "Roughly preserved": within 1.5 dB of unity, never boosted.
    const ratio = after / before
    expect(ratio).toBeGreaterThan(0.84)
    expect(ratio).toBeLessThanOrEqual(1.0)
  })

  it('cuts the hiss band by about the peaking gain and nothing wider', () => {
    const around = 1200
    const beforeHiss = bandEnergy(noise, DENOISE_HISS_HZ - around, DENOISE_HISS_HZ + around)
    const afterHiss = bandEnergy(processed, DENOISE_HISS_HZ - around, DENOISE_HISS_HZ + around)
    // The peaking cut alone promises -6 dB at center; integrated over the band
    // it lands between -6 and -3 dB. A low-pass also contributes here, so the
    // floor is generous: the criterion is "measurably cut", not "flat".
    const dropDb = 20 * Math.log10(afterHiss / beforeHiss)
    expect(dropDb).toBeLessThanOrEqual(-3)
    expect(dropDb).toBeGreaterThanOrEqual(-10)

    // A band the chain does not target (mid speech) must NOT drop that much:
    // this is what separates denoise from a volume knob.
    const beforeMid = bandEnergy(noise, 500, 1500)
    const afterMid = bandEnergy(processed, 500, 1500)
    expect(afterMid).toBeGreaterThan(beforeMid * 0.5)
  })

  it('attenuates the top octave the hiss low-pass owns', () => {
    const before = bandEnergy(noise, DENOISE_LOWPASS_HZ, 22000)
    const after = bandEnergy(processed, DENOISE_LOWPASS_HZ, 22000)
    expect(after).toBeLessThan(before * 0.5)
  })
})

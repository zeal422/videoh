import { describe, expect, it } from 'vitest'

import { compoundClipViolations, shapeClipViolations } from '../clip-invariants'
import { createClip, createDefaultTextStyle, createShapeClip } from '../factories'
import type { Clip } from '../types'

const SHAPE_FIELDS: [string, Partial<Clip>][] = [
  ['mediaId', { mediaId: 'media_a' }],
  ['text', { text: 'Hello' }],
  ['style', { style: createDefaultTextStyle() }],
  ['isCaption', { isCaption: true }],
  ['sequenceId', { sequenceId: 'seq_a' }],
  ['audioOnly', { audioOnly: true }],
  ['linkId', { linkId: 'link_a' }],
  ['speed', { speed: 2 }],
  ['reverse', { reverse: true }],
  ['lutId', { lutId: 'lut_a' }],
  ['keyframes.timeScale', { keyframes: { timeScale: [{ time: 0, value: 1 }] } }],
]

const COMPOUND_FIELDS: [string, Partial<Clip>][] = [
  ['mediaId', { mediaId: 'media_a' }],
  ['text', { text: 'Hello' }],
  ['audioOnly', { audioOnly: true }],
  ['speed', { speed: 2 }],
  ['reverse', { reverse: true }],
  ['keyframes.timeScale', { keyframes: { timeScale: [{ time: 0, value: 1 }] } }],
]

describe('shapeClipViolations', () => {
  it('accepts a plain shape clip', () => {
    expect(shapeClipViolations(createShapeClip({ id: 'shape_a' }))).toBeNull()
  })

  it.each(SHAPE_FIELDS)('flags %s', (field, patch) => {
    expect(shapeClipViolations({ ...createShapeClip({ id: 'shape_a' }), ...patch })).toEqual([
      field,
    ])
  })

  it('reports every incompatible field, not just the first', () => {
    const clip: Clip = {
      ...createShapeClip({ id: 'shape_a' }),
      mediaId: 'media_a',
      linkId: 'link_a',
      speed: 2,
    }
    expect(shapeClipViolations(clip)).toEqual(['mediaId', 'linkId', 'speed'])
  })

  it('ignores a clip that is not a shape', () => {
    expect(shapeClipViolations(createClip({ id: 'clip_a' }))).toBeNull()
  })
})

describe('compoundClipViolations', () => {
  const compound = () => createClip({ id: 'compound_a', sequenceId: 'seq_a' })

  it('accepts a plain compound clip', () => {
    expect(compoundClipViolations(compound())).toBeNull()
  })

  it.each(COMPOUND_FIELDS)('flags %s', (field, patch) => {
    expect(compoundClipViolations({ ...compound(), ...patch })).toEqual([field])
  })

  it('ignores a clip that is not a compound', () => {
    expect(compoundClipViolations(createClip({ id: 'clip_a' }))).toBeNull()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import { uid } from '../factories'

afterEach(() => {
  vi.unstubAllGlobals()
})

const HEX_0_TO_15 = '000102030405060708090a0b0c0d0e0f'

function bytes(): Uint8Array {
  return Uint8Array.from({ length: 16 }, (_, i) => i)
}

describe('uid randomness fallbacks', () => {
  it('prefers randomUUID when the platform provides it', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'fixed-uuid' })
    expect(uid('clip')).toBe('clip_fixed-uuid')
  })

  it('uses 16 random bytes as hex when randomUUID is missing', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (target: Uint8Array) => {
        target.set(bytes())
        return target
      },
    })
    expect(uid('clip')).toBe(`clip_${HEX_0_TO_15}`)
  })

  it('falls back to the weak id when neither API is present', () => {
    vi.stubGlobal('crypto', {})
    expect(uid('link')).toMatch(/^link_[0-9a-z]+-[0-9a-z]+$/)
  })

  it('falls back to the weak id when there is no crypto global', () => {
    vi.stubGlobal('crypto', undefined)
    expect(uid('track')).toMatch(/^track_[0-9a-z]+-[0-9a-z]+$/)
  })

  it('falls through a throwing randomUUID to getRandomValues', () => {
    const getRandomValues = vi.fn((target: Uint8Array) => {
      target.set(bytes())
      return target
    })
    vi.stubGlobal('crypto', {
      randomUUID: () => {
        throw new Error('randomUUID unavailable')
      },
      getRandomValues,
    })
    expect(uid('clip')).toBe(`clip_${HEX_0_TO_15}`)
    expect(getRandomValues).toHaveBeenCalledTimes(1)
  })

  it('falls back to the weak id when getRandomValues throws (preservation)', () => {
    // Preservation, not a red proof: HEAD's uid never called getRandomValues,
    // so this case already passed before the fallback chain existed. It locks
    // the new catch path against a regression.
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('getRandomValues unavailable')
      },
    })
    expect(uid('clip')).toMatch(/^clip_[0-9a-z]+-[0-9a-z]+$/)
  })
})

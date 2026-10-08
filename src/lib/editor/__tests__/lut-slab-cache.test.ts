import { describe, expect, it } from 'vitest'
import { applyLut3dToRgba, slabCacheStats } from '../lut'

/**
 * The red-slab cache policy. The cache lives at module scope, and vitest runs
 * this file in its own module instance, so it starts COLD: the entry counts
 * below are exact. The numbers: a 33-cube's slab is 33*33*3*256 doubles
 * (6,690,816 bytes), a 65-cube's is 25,958,400, and the cache budget is
 * 64 MB. Grid CONTENT is irrelevant to the cache (the key is grid IDENTITY),
 * so empty grids keep the allocations small while three calls with three
 * distinct arrays are three distinct cache entries.
 */

const slabBytes = (size: number) => size * size * 3 * 256 * 8

function gradeOnce(size: number): Uint8ClampedArray {
  const grid = new Uint8ClampedArray(size * size * size * 3)
  const data = new Uint8ClampedArray(4 * 4)
  applyLut3dToRgba(data, grid, size)
  return grid
}

describe('red-slab cache policy', () => {
  it('keeps three distinct grids resident and evicts by bytes, oldest first', () => {
    // The scenario the entry-count bound got wrong: three clips, each graded
    // with a different 33-cube, are composited in the same frame. Every slab
    // must stay resident; under a two-entry cap the third grid evicted the
    // first, so every frame rebuilt all three tables.
    const a = gradeOnce(33)
    const b = gradeOnce(33)
    const c = gradeOnce(33)
    expect(a).not.toBe(b)
    expect(b).not.toBe(c)
    expect(slabCacheStats()).toEqual({ entries: 3, bytes: 3 * slabBytes(33) })

    // Room is measured in BYTES, so a 65-cube (26 MB) still fits beside them
    // (46,030,848 of 67,108,864 bytes: no eviction at all).
    gradeOnce(65)
    expect(slabCacheStats()).toEqual({ entries: 4, bytes: 3 * slabBytes(33) + slabBytes(65) })

    // ... and a 33-cube fits beside that pair too (4*33 + 65 = 52,721,664
    // bytes: still no eviction).
    gradeOnce(33)
    expect(slabCacheStats()).toEqual({ entries: 5, bytes: 4 * slabBytes(33) + slabBytes(65) })

    // A fifth table crosses the budget (78,680,064 bytes): the OLDEST tables
    // go, just ENOUGH of them to fit (two 33-cubes get it to 65,298,432, which
    // is under 67,108,864, so the third stays), and the recently used slabs
    // survive.
    gradeOnce(65)
    expect(slabCacheStats()).toEqual({ entries: 4, bytes: 2 * slabBytes(33) + 2 * slabBytes(65) })

    // A size over the per-table cap never reaches the cache at all: the pass
    // falls back to the plain trilinear loop instead.
    gradeOnce(74)
    expect(slabCacheStats()).toEqual({ entries: 4, bytes: 2 * slabBytes(33) + 2 * slabBytes(65) })
  })

  it('re-grades of a resident grid add nothing to the cache', () => {
    const resident = gradeOnce(65)
    const before = slabCacheStats()
    for (let i = 0; i < 5; i++) applyLut3dToRgba(new Uint8ClampedArray(16), resident, 65)
    expect(slabCacheStats()).toEqual(before)
  })
})

import { describe, expect, it } from 'vitest'
import {
  LUT_LIBRARY_MAX_CHARS,
  LUT_MAX_SIZE_1D,
  LUT_MAX_SIZE_3D,
  LutError,
  applyLut3dToRgba,
  base64ToBytes,
  bytesToBase64,
  decodeLutGrid,
  findLut,
  lutBudgetMessage,
  lutGridByteLength,
  lutLibraryChars,
  lutShaperValues,
  parseCube,
  parseCubeLut,
} from '../lut'
import type { ProjectLut } from '../types'

/**
 * `.cube` LUT import: the parser, the compact 8-bit base64 storage, the library
 * budget guard and the two render-facing readers. All pure, so everything but
 * the pixel round-trip is checked directly here instead of through the UI.
 */

/** An identity cube of the given size, in `.cube` row order (red fastest). */
function identityCube(size: number): string {
  const rows: string[] = [`LUT_3D_SIZE ${size}`]
  const last = size - 1
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        rows.push(`${(r / last).toFixed(6)} ${(g / last).toFixed(6)} ${(b / last).toFixed(6)}`)
      }
    }
  }
  return rows.join('\n')
}

/** An identity cube that swaps the red and blue outputs for every input. */
function swapRedBlueCube(): string {
  const rows = ['LUT_3D_SIZE 2']
  for (let b = 0; b < 2; b++) {
    for (let g = 0; g < 2; g++) {
      for (let r = 0; r < 2; r++) rows.push(`${b} ${g} ${r}`)
    }
  }
  return rows.join('\n')
}

describe('parseCube', () => {
  it('reads LUT_3D_SIZE and its rows in red-fastest order', () => {
    const cube = parseCube(identityCube(2))
    expect(cube.kind).toBe('3d')
    expect(cube.size).toBe(2)
    expect(cube.values).toHaveLength(8 * 3)
    // Row 0 is the black corner, row 1 moves red only (red varies fastest).
    expect(cube.values.slice(0, 3)).toEqual([0, 0, 0])
    expect(cube.values.slice(3, 6)).toEqual([1, 0, 0])
    expect(cube.values.slice(6, 9)).toEqual([0, 1, 0])
  })

  it('routes LUT_1D_SIZE to the shaper kind', () => {
    const cube = parseCube('LUT_1D_SIZE 3\n0 0 0\n0.5 0.25 0.75\n1 1 1')
    expect(cube.kind).toBe('1d')
    expect(cube.size).toBe(3)
    expect(cube.values).toEqual([0, 0, 0, 0.5, 0.25, 0.75, 1, 1, 1])
  })

  it('skips comments, blank lines and a TITLE', () => {
    const cube = parseCube(
      [
        '# a comment',
        'TITLE "warm day"',
        'LUT_3D_SIZE 2',
        '',
        '0 0 0',
        '1 0 0 # trailing comment',
        '0 1 0',
        '1 1 0',
        '0 0 1',
        '1 0 1',
        '0 1 1',
        '1 1 1',
      ].join('\r\n'),
    )
    expect(cube.title).toBe('warm day')
    expect(cube.values).toHaveLength(24)
  })

  it('normalizes DOMAIN_MIN/DOMAIN_MAX into 0..1 and clamps the rest', () => {
    const cube = parseCube(
      ['LUT_1D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 2 2 2', '0 0 0', '2 1 3'].join('\n'),
    )
    expect(cube.values.slice(3, 6)).toEqual([1, 0.5, 1])
  })

  it('rejects a malformed table (wrong row count)', () => {
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1')).toThrow(LutError)
    expect(() => parseCube('LUT_1D_SIZE 3\n0 0 0\n1 1 1')).toThrow(/expected 3 rows, found 2/)
  })

  it('rejects a row that is not three finite numbers', () => {
    expect(() => parseCube('LUT_1D_SIZE 2\n0 0 0\n0 0')).toThrow(LutError)
    expect(() => parseCube('LUT_1D_SIZE 2\n0 0 0\n0 0 nope')).toThrow(LutError)
  })

  it('rejects a file with no size declaration or conflicting ones', () => {
    expect(() => parseCube('0 0 0\n1 1 1')).toThrow(/LUT_3D_SIZE or LUT_1D_SIZE/)
    expect(() => parseCube('LUT_1D_SIZE 2\nLUT_3D_SIZE 2\n0 0 0\n1 1 1')).toThrow(/Conflicting/)
  })

  it('rejects a size outside the supported bounds', () => {
    expect(() => parseCube('LUT_1D_SIZE 1\n0 0 0')).toThrow(LutError)
    expect(() => parseCube(`LUT_1D_SIZE ${LUT_MAX_SIZE_1D + 1}\n0 0 0`)).toThrow(LutError)
    expect(() => parseCube(`LUT_3D_SIZE ${LUT_MAX_SIZE_3D + 1}\n0 0 0`)).toThrow(LutError)
  })

  it('rejects an inverted domain', () => {
    expect(() =>
      parseCube('LUT_1D_SIZE 2\nDOMAIN_MIN 1 1 1\nDOMAIN_MAX 0 0 0\n0 0 0\n1 1 1'),
    ).toThrow(LutError)
  })
})

describe('base64 storage', () => {
  it('round-trips every byte value and length class', () => {
    for (const bytes of [
      new Uint8Array([]),
      new Uint8Array([0]),
      new Uint8Array([255, 0]),
      new Uint8Array([1, 2, 3]),
      new Uint8Array([0, 127, 128, 255, 64, 32, 7]),
    ]) {
      const text = bytesToBase64(bytes)
      expect(base64ToBytes(text)).toEqual(bytes)
    }
  })

  it('rejects text that is not base64', () => {
    expect(base64ToBytes('AAAAA')).toBeNull()
    expect(base64ToBytes('AA*A')).toBeNull()
    expect(base64ToBytes('=AAA')).toBeNull()
  })

  it('rejects padding anywhere but the tail of the payload', () => {
    // A third-position '=' with no trailing '=' leaves the final quad half
    // padded. Decoding it anyway would hand the renderer silent garbage, so the
    // codec refuses the payload instead.
    expect(base64ToBytes('AB=C')).toBeNull()
    // Padding inside a non-final quad is malformed for the same reason: the
    // payload cannot have a gap in the middle.
    expect(base64ToBytes('AA==AAAA')).toBeNull()
    expect(base64ToBytes('AAA=AAAA')).toBeNull()
    // '=' in the first two positions of a quad was never encodable at all.
    expect(base64ToBytes('A=AA')).toBeNull()
    // And the legal padded tails still decode.
    expect(Array.from(base64ToBytes('AA==') ?? [])).toEqual([0])
    expect(Array.from(base64ToBytes('AAA=') ?? [])).toEqual([0, 0])
  })

  it('stores a parsed cube compactly and decodes it back to the same grid', () => {
    const lut = parseCubeLut(identityCube(2), { id: 'lut_test', name: 'Identity' })
    expect(lut.kind).toBe('3d')
    expect(lut.size).toBe(2)
    expect(lut.id).toBe('lut_test')
    expect(lut.name).toBe('Identity')
    expect(lut.data.length).toBe(32)
    expect(base64ToBytes(lut.data)!.length).toBe(lutGridByteLength('3d', 2))
    const grid = decodeLutGrid(lut)
    expect(Array.from(grid)).toEqual([
      0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 0, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255,
      255,
    ])
  })

  it('names an unnamed import from the file TITLE', () => {
    const lut = parseCubeLut(`TITLE "evening"\n${identityCube(2)}`, { id: 'lut_t' })
    expect(lut.name).toBe('evening')
  })

  it('measures the library and the grid byte length', () => {
    expect(lutGridByteLength('1d', 3)).toBe(9)
    expect(lutGridByteLength('3d', 33)).toBe(33 * 33 * 33 * 3)
    const a: ProjectLut = { id: 'a', name: 'a', kind: '1d', size: 2, data: 'AAAA' }
    const b: ProjectLut = { id: 'b', name: 'b', kind: '1d', size: 2, data: 'AAAAAAAA' }
    expect(lutLibraryChars([a, b])).toBe(12)
    expect(lutLibraryChars([])).toBe(0)
  })
})

describe('LUT library budget', () => {
  it('passes at or under the limit', () => {
    expect(lutBudgetMessage(0, LUT_LIBRARY_MAX_CHARS)).toBeNull()
    expect(lutBudgetMessage(LUT_LIBRARY_MAX_CHARS - 1, 1)).toBeNull()
  })

  it('refuses one character over, naming both sizes', () => {
    const message = lutBudgetMessage(0, LUT_LIBRARY_MAX_CHARS + 1)
    expect(message).not.toBeNull()
    expect(message).toMatch(/3,000,001/)
    expect(message).toMatch(/3,000,000/)
  })

  it('names the current and projected totals when a second import overflows', () => {
    const message = lutBudgetMessage(2_999_990, 20)
    expect(message).toMatch(/2,999,990/)
    expect(message).toMatch(/3,000,010/)
  })
})

describe('LUT render readers', () => {
  it('resolves a library entry by id and ignores a dangling reference', () => {
    const lut = parseCubeLut(identityCube(2), { id: 'lut_a' })
    expect(findLut([lut], 'lut_a')).toBe(lut)
    expect(findLut([lut], 'lut_missing')).toBeUndefined()
    expect(findLut(undefined, 'lut_a')).toBeUndefined()
    expect(findLut([lut], undefined)).toBeUndefined()
  })

  it('emits feComponentTransfer tableValues from a 1D shaper', () => {
    const lut = parseCubeLut('LUT_1D_SIZE 3\n0 0.5 1\n0.5 0 0.5\n1 1 0', { id: 'lut_1d' })
    const shapers = lutShaperValues(lut)
    expect(shapers).not.toBeNull()
    expect(shapers!.r.split(' ')).toHaveLength(3)
    // 0.5 lands on byte 128, which is 128/255 = 0.5020.
    expect(shapers!.r.split(' ')).toEqual(['0.0000', '0.5020', '1.0000'])
    expect(shapers!.g.split(' ')).toEqual(['0.5020', '0.0000', '1.0000'])
    expect(shapers!.b.split(' ')).toEqual(['1.0000', '0.5020', '0.0000'])
    // A cube has no separable shaper: it must never be approximated as one.
    expect(lutShaperValues(parseCubeLut(identityCube(2)))).toBeNull()
  })

  it('leaves pixels untouched through an identity cube and preserves alpha', () => {
    const lut = parseCubeLut(identityCube(2))
    const grid = decodeLutGrid(lut)
    const data = new Uint8ClampedArray([0, 0, 0, 128, 255, 255, 255, 7, 10, 20, 30, 255])
    applyLut3dToRgba(data, grid, lut.size)
    expect(Array.from(data)).toEqual([0, 0, 0, 128, 255, 255, 255, 7, 10, 20, 30, 255])
  })

  it('applies a non-separable cube (a red/blue swap) exactly', () => {
    const lut = parseCubeLut(swapRedBlueCube())
    const grid = decodeLutGrid(lut)
    const data = new Uint8ClampedArray([10, 20, 30, 255, 200, 100, 50, 255])
    applyLut3dToRgba(data, grid, lut.size)
    expect(Array.from(data)).toEqual([30, 20, 10, 255, 50, 100, 200, 255])
  })

  it('resolves the red axis without changing a single pixel', () => {
    // The pass resolves the red axis up front (one interpolated slab per input
    // red byte) and blends the other two, falling back to the eight-corner loop
    // when that table would be too large. Both routes must agree with an
    // independent trilinear reference derived from the .cube layout (red
    // varying fastest), byte for byte: a fast path that grades different pixels
    // is not a fast path. Size 74 is over the table cap on purpose, so the
    // fallback is covered too.
    const reference = (data: Uint8ClampedArray, grid: Uint8ClampedArray, size: number) => {
      const last = size - 1
      const at = (r: number, g: number, b: number, c: number) =>
        grid[(b * size * size + g * size + r) * 3 + c]
      const out = new Uint8ClampedArray(data.length)
      for (let i = 0; i < data.length; i += 4) {
        const rv = (data[i] / 255) * last
        const gv = (data[i + 1] / 255) * last
        const bv = (data[i + 2] / 255) * last
        const r0 = Math.floor(rv)
        const g0 = Math.floor(gv)
        const b0 = Math.floor(bv)
        const r1 = Math.min(r0 + 1, last)
        const g1 = Math.min(g0 + 1, last)
        const b1 = Math.min(b0 + 1, last)
        const fr = rv - r0
        const fg = gv - g0
        const fb = bv - b0
        // Alpha is carried through untouched, like the pass documents.
        out[i + 3] = data[i + 3]
        for (let c = 0; c < 3; c++) {
          const c00 = at(r0, g0, b0, c) + (at(r1, g0, b0, c) - at(r0, g0, b0, c)) * fr
          const c10 = at(r0, g1, b0, c) + (at(r1, g1, b0, c) - at(r0, g1, b0, c)) * fr
          const c01 = at(r0, g0, b1, c) + (at(r1, g0, b1, c) - at(r0, g0, b1, c)) * fr
          const c11 = at(r0, g1, b1, c) + (at(r1, g1, b1, c) - at(r0, g1, b1, c)) * fr
          const c0 = c00 + (c10 - c00) * fg
          const c1 = c01 + (c11 - c01) * fg
          out[i + c] = c0 + (c1 - c0) * fb
        }
      }
      return out
    }
    let seed = 12345
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (const size of [2, 5, 33, 74]) {
      const grid = new Uint8ClampedArray(size * size * size * 3)
      for (let i = 0; i < grid.length; i++) grid[i] = Math.floor(rnd() * 256)
      const data = new Uint8ClampedArray(4 * 300)
      for (let i = 0; i < data.length; i++) data[i] = Math.floor(rnd() * 256)
      const expected = reference(data, grid, size)
      applyLut3dToRgba(data, grid, size)
      expect(Array.from(data), `size ${size}`).toEqual(Array.from(expected))
    }
  })

  it('decodes a payload once and hands the SAME grid to every later render', () => {
    // The grid cache lives at module scope, so a preview frame or an exported
    // frame that follows another one must not re-decode the payload (a 65-cube
    // is 275k entries). Identity is the proof: a re-decode would allocate.
    const lut = parseCubeLut(identityCube(3), { id: 'lut_memo' })
    const first = decodeLutGrid(lut)
    expect(decodeLutGrid(lut)).toBe(first)
    expect(decodeLutGrid({ ...lut, id: 'lut_memo_copy' })).toBe(first)
    // A DIFFERENT payload is a different grid, cached under its own key.
    const other = decodeLutGrid(parseCubeLut(swapRedBlueCube(), { id: 'lut_other' }))
    expect(other).not.toBe(first)
    expect(decodeLutGrid(lut)).toBe(first)
  })

  it('applies two cube sizes in one session without cross-talk', () => {
    // The per-size lookups are rebuilt inside every pass, so a size applied
    // after another one must use its OWN corner offsets: a shared table would
    // read the wrong cube. Both sizes run twice, in both orders.
    const big = parseCubeLut(identityCube(4))
    const small = parseCubeLut(identityCube(2))
    const pixels = () => new Uint8ClampedArray([40, 90, 200, 255, 7, 250, 128, 255])
    const expected = Array.from(pixels())
    for (const lut of [big, small, small, big]) {
      const data = pixels()
      applyLut3dToRgba(data, decodeLutGrid(lut), lut.size)
      expect(Array.from(data)).toEqual(expected)
    }
  })
})

import { uid } from './factories'
import { clamp } from './time'
import type { LutKind, ProjectLut } from './types'

/**
 * `.cube` LUT import, pure (browser-free) so the parser, the storage codec, the
 * library budget and the pixel maths all run in plain Node.
 *
 * Two paths, deliberately split (a 3D cube is NOT separable, so a per-channel
 * table cannot stand in for one):
 *
 * - `1d` (`LUT_1D_SIZE`): three per-channel tables. `lutShaperValues` hands
 *   them to one SVG `feComponentTransfer`, which is exact and rides the shared
 *   filter string, so the preview and the export cannot drift.
 * - `3d` (`LUT_3D_SIZE`): a general function of three inputs. It has to leave
 *   the shared-filter architecture and run a per-frame pixel pass
 *   (`applyLut3dToRgba`), which BOTH render paths call.
 *
 * Storage is base64 of an 8-bit RGB grid, which is what keeps a 33-cube at
 * about 144 KB in the project file instead of roughly 1 MB of JSON decimals.
 */

/** Entries per axis bounds. A cube above 128 would be hundreds of MB decoded. */
export const LUT_MAX_SIZE_1D = 4096
export const LUT_MAX_SIZE_3D = 128

/**
 * The library's total base64 budget, in characters.
 *
 * No file in this repo states a localStorage quota, so this is a deliberate
 * assumption: about 2.25 MB of binary against the ~5 MB browsers typically
 * give, enough for one 65-cube at 16-bit or about twenty 33-cubes at 8-bit.
 * An import that would cross it is REFUSED (never warned-and-proceeded, never
 * silently downsampled), because a proceed that later trips the quota costs
 * crash recovery.
 */
export const LUT_LIBRARY_MAX_CHARS = 3_000_000

/** Thrown when a `.cube` file cannot be read. */
export class LutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LutError'
  }
}

/** A parsed `.cube`: its kind, its size and rgb triples normalized to 0..1. */
export interface CubeLut {
  kind: LutKind
  size: number
  /** File order (red varying fastest for a cube), each channel 0..1. */
  values: number[]
  title?: string
}

/** Bytes a library entry's grid occupies for a kind/size pair. */
export function lutGridByteLength(kind: LutKind, size: number): number {
  return kind === '1d' ? size * 3 : size * size * size * 3
}

/**
 * Reads `.cube` text into raw values.
 *
 * Handles `TITLE`, `#` comments, `LUT_1D_SIZE`/`LUT_3D_SIZE`, `DOMAIN_MIN`/
 * `DOMAIN_MAX` and blank lines (CRLF included), and rejects anything it cannot
 * read exactly: a missing or conflicting size, a size outside the supported
 * bounds, an inverted domain, a row that is not three finite numbers, or a row
 * count that does not match the declared size.
 */
export function parseCube(text: string): CubeLut {
  let declared: { kind: LutKind; size: number } | null = null
  let title: string | undefined
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  const values: number[] = []

  const lines = text.split('\n')
  for (const rawLine of lines) {
    // A comment runs to the end of the line, so it is stripped before tokens.
    const line = rawLine.replace(/\r$/, '').split('#')[0].trim()
    if (line === '') continue

    const titleMatch = /^TITLE\s+"?(.*?)"?$/.exec(line)
    if (titleMatch) {
      title = titleMatch[1]
      continue
    }

    const sizeMatch = /^(LUT_1D_SIZE|LUT_3D_SIZE)\s+(\S+)$/.exec(line)
    if (sizeMatch) {
      const kind: LutKind = sizeMatch[1] === 'LUT_1D_SIZE' ? '1d' : '3d'
      const size = Number(sizeMatch[2])
      const max = kind === '1d' ? LUT_MAX_SIZE_1D : LUT_MAX_SIZE_3D
      if (declared && declared.kind !== kind) {
        throw new LutError('Conflicting LUT_1D_SIZE and LUT_3D_SIZE declarations')
      }
      if (!Number.isInteger(size) || size < 2 || size > max) {
        throw new LutError(`${sizeMatch[1]} must be an integer in 2..${max}`)
      }
      declared = { kind, size }
      continue
    }

    const domainMatch = /^(DOMAIN_MIN|DOMAIN_MAX)\s+(\S+)\s+(\S+)\s+(\S+)$/.exec(line)
    if (domainMatch) {
      const triple: [number, number, number] = [
        Number(domainMatch[2]),
        Number(domainMatch[3]),
        Number(domainMatch[4]),
      ]
      if (!triple.every((v) => Number.isFinite(v))) {
        throw new LutError(`${domainMatch[1]} must be three numbers`)
      }
      if (domainMatch[1] === 'DOMAIN_MIN') domainMin = triple
      else domainMax = triple
      continue
    }

    const tokens = line.split(/\s+/)
    if (tokens.length !== 3) {
      throw new LutError(`LUT row must be three numbers, found "${line}"`)
    }
    const row: [number, number, number] = [Number(tokens[0]), Number(tokens[1]), Number(tokens[2])]
    if (!row.every((v) => Number.isFinite(v))) {
      throw new LutError(`LUT row must be three numbers, found "${line}"`)
    }
    for (let c = 0; c < 3; c++) {
      const span = domainMax[c] - domainMin[c]
      if (span <= 0) throw new LutError('DOMAIN_MAX must be greater than DOMAIN_MIN')
      values.push(clamp((row[c] - domainMin[c]) / span, 0, 1))
    }
  }

  if (!declared) {
    throw new LutError('A .cube file must declare LUT_3D_SIZE or LUT_1D_SIZE')
  }
  const expectedRows =
    declared.kind === '1d' ? declared.size : declared.size * declared.size * declared.size
  const foundRows = values.length / 3
  if (foundRows !== expectedRows) {
    throw new LutError(
      `LUT table expected ${expectedRows} rows, found ${foundRows} (LUT_${declared.kind === '1d' ? '1D' : '3D'}_SIZE ${declared.size})`,
    )
  }
  return { kind: declared.kind, size: declared.size, values, ...(title ? { title } : {}) }
}

/**
 * Parses `.cube` text into a library entry, quantizing the grid to 8 bits.
 *
 * 8 bits costs nothing visible: both render paths end up on a
 * `Uint8ClampedArray` canvas buffer, which cannot show more precision anyway.
 */
export function parseCubeLut(text: string, opts: { id?: string; name?: string } = {}): ProjectLut {
  const cube = parseCube(text)
  const bytes = new Uint8Array(lutGridByteLength(cube.kind, cube.size))
  for (let i = 0; i < cube.values.length; i++) {
    bytes[i] = Math.round(cube.values[i] * 255)
  }
  return {
    id: opts.id ?? uid('lut'),
    name: opts.name?.trim() || cube.title?.trim() || 'LUT',
    kind: cube.kind,
    size: cube.size,
    data: bytesToBase64(bytes),
  }
}

/** Total base64 characters the library currently holds. */
export function lutLibraryChars(luts: ProjectLut[]): number {
  let total = 0
  for (const lut of luts) total += lut.data.length
  return total
}

/**
 * The refusal message for an import that would cross the library budget, or
 * null when it fits. The message names both sizes so a user can see what to
 * remove; the import command turns it into an `EditorCommandError`.
 */
export function lutBudgetMessage(current: number, incoming: number): string | null {
  const projected = current + incoming
  if (projected <= LUT_LIBRARY_MAX_CHARS) return null
  return (
    `LUT library is full: it holds ${formatChars(current)} characters and this import adds ` +
    `${formatChars(incoming)}, reaching ${formatChars(projected)} of ${formatChars(LUT_LIBRARY_MAX_CHARS)}. ` +
    `Remove a LUT from the project or import a smaller .cube.`
  )
}

/** The library entry a clip's `lutId` names, or undefined for a dangling id. */
export function findLut(
  luts: ProjectLut[] | undefined,
  lutId: string | undefined,
): ProjectLut | undefined {
  if (!lutId || !luts) return undefined
  return luts.find((lut) => lut.id === lutId)
}

// ————— base64 (browser-free; btoa/atob would need a binary-safe wrapper) —————

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const B64_INDEX = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64_CHARS.length; i++) table[B64_CHARS.charCodeAt(i)] = i
  return table
})()

/** Standard base64 of a byte array (padded, no line breaks). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    out += B64_CHARS[b0 >> 2]
    out += B64_CHARS[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]
    out += i + 1 < bytes.length ? B64_CHARS[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] : '='
    out += i + 2 < bytes.length ? B64_CHARS[b2 & 63] : '='
  }
  return out
}

/** Decodes standard base64, or null when the text is not valid base64. */
export function base64ToBytes(text: string): Uint8Array | null {
  const len = text.length
  if (len === 0) return new Uint8Array(0)
  if (len % 4 !== 0) return null
  let padding = 0
  if (text.charCodeAt(len - 1) === 61) padding++
  if (text.charCodeAt(len - 2) === 61) padding++
  // Padding is legal at the END of the payload only. A '=' anywhere outside
  // that tail is malformed: a padded non-final quad, or a third-position '='
  // left unpadded, would otherwise decode to silent garbage and hand a corrupt
  // table to the renderer (the codec's whole job is to reject corruption).
  for (let i = 0; i < len - padding; i++) {
    if (text.charCodeAt(i) === 61) return null
  }
  const out = new Uint8Array((len / 4) * 3 - padding)
  let o = 0
  for (let i = 0; i < len; i += 4) {
    const va = decodeChar(text.charCodeAt(i))
    const vb = decodeChar(text.charCodeAt(i + 1))
    const vc = text.charCodeAt(i + 2) === 61 ? 0 : decodeChar(text.charCodeAt(i + 2))
    const vd = text.charCodeAt(i + 3) === 61 ? 0 : decodeChar(text.charCodeAt(i + 3))
    if (va < 0 || vb < 0 || vc < 0 || vd < 0) return null
    const triple = (va << 18) | (vb << 12) | (vc << 6) | vd
    if (o < out.length) out[o++] = (triple >> 16) & 255
    if (o < out.length) out[o++] = (triple >> 8) & 255
    if (o < out.length) out[o++] = triple & 255
  }
  return out
}

function decodeChar(code: number): number {
  return code < 128 ? B64_INDEX[code] : -1
}

function formatChars(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// ————— decoded grids (memoized: a 65-cube is 275k entries) —————

const gridCache = new Map<string, Uint8ClampedArray>()
const GRID_CACHE_LIMIT = 4

/**
 * The 8-bit rgb grid of a library entry, decoded on demand.
 *
 * Memoized by the encoded payload (which is the whole grid), so a per-frame
 * render pass never decodes the same cube twice. A malformed payload decodes to
 * an empty grid, which `applyLut3dToRgba` then ignores.
 *
 * The cache lives at module scope, so it survives every render: a preview frame
 * or an exported frame that follows another one decodes nothing.
 */
export function decodeLutGrid(lut: ProjectLut): Uint8ClampedArray {
  const cached = gridCache.get(lut.data)
  if (cached) return cached
  const bytes = base64ToBytes(lut.data) ?? new Uint8Array(0)
  const expected = lutGridByteLength(lut.kind, lut.size)
  const grid = bytes.length === expected ? new Uint8ClampedArray(bytes) : new Uint8ClampedArray(0)
  if (gridCache.size >= GRID_CACHE_LIMIT) {
    const oldest = gridCache.keys().next().value
    if (oldest !== undefined) gridCache.delete(oldest)
  }
  gridCache.set(lut.data, grid)
  return grid
}

/**
 * The red-resolved slab table of a grid: one fully interpolated red axis per
 * possible INPUT red byte, laid out [input red][blue][green][channel].
 *
 * A decoded grid is immutable, so grid identity is the cache key and every frame
 * after the first reuses the table (what makes an export pay for it once rather
 * than per frame). It costs 256 * size^2 * 3 doubles: about 6.7 MB for a 33-cube
 * and 26 MB for a 65-cube. A grid whose table would exceed SLAB_MAX_BYTES falls
 * back to the plain trilinear loop, so a huge cube costs time instead of an
 * allocation that would dwarf the frames it grades.
 *
 * Finished tables are kept under a BYTE budget (SLAB_CACHE_BYTES, 64 MB: any
 * two 65-cube tables, or four 33-cubes beside one), not an entry count: an
 * entry cap either wastes that headroom or, on a timeline compositing three
 * clips with three distinct cubes in one frame, evicts a table every frame
 * and rebuilds it forever.
 */
const SLAB_CACHE_BYTES = 64 * 1024 * 1024
const SLAB_MAX_BYTES = 32 * 1024 * 1024
const slabCache = new Map<Uint8ClampedArray, { size: number; bytes: number; slab: Float64Array }>()

/**
 * Resident slab-cache accounting, for the cache-policy regression test. No
 * render path reads this.
 */
export function slabCacheStats(): { entries: number; bytes: number } {
  let bytes = 0
  for (const entry of slabCache.values()) bytes += entry.bytes
  return { entries: slabCache.size, bytes }
}

function redSlabs(
  grid: Uint8ClampedArray,
  size: number,
  planeStride: number,
  low: Uint16Array,
  frac: Float64Array,
): Float64Array | null {
  if (planeStride * 256 * 8 > SLAB_MAX_BYTES) return null
  const hit = slabCache.get(grid)
  if (hit && hit.size === size) return hit.slab
  const slab = new Float64Array(planeStride * 256)
  const last = size - 1
  const rowStride = size * 3
  for (let v = 0; v < 256; v++) {
    // The same low/frac entries the pixel loop uses, in the same form, so the
    // resolved red values are the exact operands the inline lerp produced.
    const r0 = low[v]
    const r1 = r0 < last ? r0 + 1 : last
    const fr = frac[v]
    const plane = v * planeStride
    for (let b = 0; b < size; b++) {
      const gridPlane = b * planeStride
      const slabPlane = plane + b * rowStride
      for (let g = 0; g < size; g++) {
        const q = gridPlane + g * rowStride
        const s = slabPlane + g * 3
        for (let c = 0; c < 3; c++) {
          const a = grid[q + r0 * 3 + c]
          slab[s + c] = a + (grid[q + r1 * 3 + c] - a) * fr
        }
      }
    }
  }
  // The budget is BYTES, not entries: the slabs are 6.7 MB (33-cube) to 26 MB
  // (65-cube) each, so an entry-count cap evicts a table the timeline may
  // still need. Compositing three clips with three distinct cubes in one frame
  // is exactly three entries; under the old two-entry cap every frame rebuilt
  // all three tables. Eviction is FIFO over the Map's insertion order (the
  // oldest tables go first), just enough of them to fit.
  slabCache.set(grid, { size, bytes: slab.byteLength, slab })
  let total = 0
  for (const entry of slabCache.values()) total += entry.bytes
  while (total > SLAB_CACHE_BYTES && slabCache.size > 1) {
    const oldest = slabCache.keys().next().value
    if (oldest === undefined) break
    total -= slabCache.get(oldest)!.bytes
    slabCache.delete(oldest)
  }
  return slab
}

/**
 * Applies a 3D cube to RGBA pixels IN PLACE, trilinearly interpolated between
 * the eight surrounding grid corners. Alpha is untouched.
 *
 * The grid is a general function of three inputs: a red output that moves when
 * green moves at fixed red is expressible here and is NOT expressible as three
 * per-channel tables, which is why a cube never takes the shaper path.
 *
 * The small lookups below are rebuilt per call on purpose: measured against a
 * 33-cube at 1080p and 4K in Chromium (see the benchmark note in CHANGELOG
 * 0.7.0), a per-size memo of them moved the per-frame pass by less than the
 * run-to-run noise, so caching them would be bookkeeping with no measured
 * return. The GRID, which is the big allocation, is decoded once and reused
 * (`decodeLutGrid`).
 *
 * The RED AXIS is different, because one input red byte has exactly one
 * resolution of that axis: `redSlabs` precomputes the red lerp for all 256
 * input values once per grid, which turns the pixel loop's trilinear blend over
 * eight corners into a bilinear blend over four. Same arithmetic, same operand
 * order, so the output is bit-identical; it is roughly half the per-pixel work,
 * which is where a 4K frame's pass spends its time.
 */
export function applyLut3dToRgba(
  data: Uint8ClampedArray,
  grid: Uint8ClampedArray,
  size: number,
): void {
  if (size < 2 || grid.length < size * size * size * 3) return
  const last = size - 1
  const planeStride = size * size * 3
  // The buffer holds 8-bit integers, so the `(v / 255) * last` split is
  // memoized once per value instead of recomputed per channel per pixel. The
  // table carries the exact floats the inline form produced, so the output is
  // unchanged. It only lifts the divides and floors out of the pixel loop,
  // which is what keeps a 1080p frame's pass inside a preview frame's budget.
  const low = new Uint16Array(256)
  const frac = new Float64Array(256)
  for (let v = 0; v < 256; v++) {
    const scaled = (v / 255) * last
    const floor = Math.floor(scaled)
    low[v] = floor
    frac[v] = scaled - floor
  }
  // The eight corner offsets are table lookups as well (the clamped partner
  // included), so the pixel loop is indexing plus the trilinear blend.
  const rOff = new Int32Array(size)
  const r1Off = new Int32Array(size)
  const gRow = new Int32Array(size)
  const g1Row = new Int32Array(size)
  const bPlane = new Int32Array(size)
  const b1Plane = new Int32Array(size)
  for (let n = 0; n < size; n++) {
    const n1 = n < last ? n + 1 : last
    rOff[n] = n * 3
    r1Off[n] = n1 * 3
    gRow[n] = size * n * 3
    g1Row[n] = size * n1 * 3
    bPlane[n] = n * planeStride
    b1Plane[n] = n1 * planeStride
  }
  const slab = redSlabs(grid, size, planeStride, low, frac)
  if (slab) {
    // One red slab (blue-major, green-minor) holds the whole red axis resolved,
    // so the pixel loop only has the green and blue lerps left. The offsets are
    // keyed by the INPUT byte, so no per-pixel index lookup survives.
    const sBase = new Int32Array(256)
    const sGreen = new Int32Array(256)
    const sGreen1 = new Int32Array(256)
    const sBlue = new Int32Array(256)
    const sBlue1 = new Int32Array(256)
    for (let v = 0; v < 256; v++) {
      const n = low[v]
      const n1 = n < last ? n + 1 : last
      sBase[v] = v * planeStride
      sGreen[v] = n * 3
      sGreen1[v] = n1 * 3
      sBlue[v] = n * size * 3
      sBlue1[v] = n1 * size * 3
    }
    for (let i = 0; i < data.length; i += 4) {
      const v = sBase[data[i]]
      const gLo = sGreen[data[i + 1]]
      const gHi = sGreen1[data[i + 1]]
      const bLo = sBlue[data[i + 2]]
      const bHi = sBlue1[data[i + 2]]
      const fg = frac[data[i + 1]]
      const fb = frac[data[i + 2]]
      // The four corner pairs of the red slab, in the SAME order and with the
      // same operand order the trilinear loop below uses: green first at blue
      // low, green at blue high, then blue. Bit-identical output, half the work.
      const i00 = v + bLo + gLo
      const i01 = v + bLo + gHi
      const i10 = v + bHi + gLo
      const i11 = v + bHi + gHi
      for (let c = 0; c < 3; c++) {
        const c0 = slab[i00 + c] + (slab[i01 + c] - slab[i00 + c]) * fg
        const c1 = slab[i10 + c] + (slab[i11 + c] - slab[i10 + c]) * fg
        data[i + c] = c0 + (c1 - c0) * fb
      }
    }
    return
  }
  for (let i = 0; i < data.length; i += 4) {
    const rv = data[i]
    const gv = data[i + 1]
    const bv = data[i + 2]
    const r0 = low[rv]
    const g0 = low[gv]
    const b0 = low[bv]
    const fr = frac[rv]
    const fg = frac[gv]
    const fb = frac[bv]
    // Each corner is addressed from its OWN clamped coordinate pair. Deriving
    // them by adding a stride to the low corner would read past the grid (into
    // NaN) whenever a coordinate already sits on the last sample, which is
    // every pixel of a fully saturated channel.
    const row0 = gRow[g0]
    const row1 = g1Row[g0]
    const plane0 = bPlane[b0]
    const plane1 = b1Plane[b0]
    const i000 = rOff[r0] + row0 + plane0
    const i100 = r1Off[r0] + row0 + plane0
    const i010 = rOff[r0] + row1 + plane0
    const i110 = r1Off[r0] + row1 + plane0
    const i001 = rOff[r0] + row0 + plane1
    const i101 = r1Off[r0] + row0 + plane1
    const i011 = rOff[r0] + row1 + plane1
    const i111 = r1Off[r0] + row1 + plane1
    for (let c = 0; c < 3; c++) {
      const c00 = grid[i000 + c] + (grid[i100 + c] - grid[i000 + c]) * fr
      const c10 = grid[i010 + c] + (grid[i110 + c] - grid[i010 + c]) * fr
      const c01 = grid[i001 + c] + (grid[i101 + c] - grid[i001 + c]) * fr
      const c11 = grid[i011 + c] + (grid[i111 + c] - grid[i011 + c]) * fr
      const c0 = c00 + (c10 - c00) * fg
      const c1 = c01 + (c11 - c01) * fg
      data[i + c] = c0 + (c1 - c0) * fb
    }
  }
}

/**
 * The three `feComponentTransfer` `tableValues` strings for a 1D shaper, or
 * null for anything else.
 *
 * The samples ARE the table: SVG interpolates linearly between entries exactly
 * the way the `.cube` spec defines a 1D LUT, so this is lossless and needs no
 * resampling.
 */
export function lutShaperValues(lut: ProjectLut): { r: string; g: string; b: string } | null {
  if (lut.kind !== '1d' || lut.size < 2) return null
  const grid = decodeLutGrid(lut)
  if (grid.length < lut.size * 3) return null
  const channel = (offset: number) => {
    const parts: string[] = []
    for (let i = 0; i < lut.size; i++) parts.push((grid[i * 3 + offset] / 255).toFixed(4))
    return parts.join(' ')
  }
  return { r: channel(0), g: channel(1), b: channel(2) }
}

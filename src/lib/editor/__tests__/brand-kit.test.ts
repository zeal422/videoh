import { describe, expect, it } from 'vitest'

import { applyCommand } from '../commands'
import {
  brandColorValue,
  nextBrandColorName,
  sanitizeBrandColorName,
  sanitizeBrandKit,
} from '../brand-kit'
import { BRAND_COLORS_MAX } from '../constants'
import { createDoc } from '../factories'
import type { BrandColor, Doc } from '../types'

function color(partial: Partial<BrandColor> = {}): BrandColor {
  return { id: 'brand_one', name: 'Ink', value: '#112233', ...partial }
}

function docWithKit(): Doc {
  const doc = createDoc()
  doc.project.brandKit = { colors: [color()] }
  return doc
}

describe('brand kit model (0.26.0)', () => {
  it('accepts only strict hex colors, normalized to lowercase', () => {
    expect(brandColorValue('#AABBCC')).toBe('#aabbcc')
    expect(brandColorValue('#abc')).toBeUndefined()
    expect(brandColorValue('rgb(1,2,3)')).toBeUndefined()
    expect(brandColorValue('url(javascript:alert(1))')).toBeUndefined()
    expect(brandColorValue('var(--brand)')).toBeUndefined()
    expect(brandColorValue(12)).toBeUndefined()
  })

  it('trims and caps names and rejects control characters', () => {
    expect(sanitizeBrandColorName('  Ink  ')).toBe('Ink')
    expect(sanitizeBrandColorName('')).toBeUndefined()
    expect(sanitizeBrandColorName('x'.repeat(49))).toBeUndefined()
    expect(sanitizeBrandColorName('bad\u0001name')).toBeUndefined()
  })

  it('generates the next free color name', () => {
    expect(nextBrandColorName([])).toBe('Color 1')
    expect(nextBrandColorName([color({ name: 'Color 1' })])).toBe('Color 2')
  })

  it('hydrates leniently: invalid, duplicate, and oversized entries drop', () => {
    const { kit, dropped } = sanitizeBrandKit({
      colors: [
        color(),
        color({ id: 'brand_two', value: '#112233' }),
        color({ id: 'brand_three', value: 'rgb(0,0,0)' }),
        color({ id: 'brand_one', value: '#445566' }),
        ...Array.from({ length: BRAND_COLORS_MAX + 3 }, (_, i) =>
          color({ id: `brand_${i}`, value: `#0000${String(i).padStart(2, '0')}` }),
        ),
      ],
      fontFamilies: ['Arial, sans-serif', 'arial, sans-serif', 42, 'bad;family'],
    })
    expect(kit).toBeDefined()
    expect(kit!.colors).toHaveLength(BRAND_COLORS_MAX)
    expect(kit!.colors.every((entry) => /^#[0-9a-f]{6}$/.test(entry.value))).toBe(true)
    expect(kit!.fontFamilies).toEqual(['Arial, sans-serif'])
    expect(dropped).toBeGreaterThan(0)
  })

  it('drops an empty kit entirely', () => {
    expect(sanitizeBrandKit({ colors: [] }).kit).toBeUndefined()
    expect(sanitizeBrandKit(null).kit).toBeUndefined()
    expect(sanitizeBrandKit({ colors: 'nope' }).kit).toBeUndefined()
  })

  it('adds a color once and refuses duplicate ids or values', () => {
    const next = applyCommand(createDoc(), { type: 'addBrandColor', color: color() })
    expect(next.project.brandKit!.colors).toEqual([color()])
    expect(() => applyCommand(next, { type: 'addBrandColor', color: color() })).toThrow(
      /already exists/,
    )
    expect(() =>
      applyCommand(next, {
        type: 'addBrandColor',
        color: color({ id: 'brand_two', value: '#112233' }),
      }),
    ).toThrow(/already in the brand kit/)
  })

  it('refuses an invalid color and a full palette', () => {
    expect(() =>
      applyCommand(createDoc(), {
        type: 'addBrandColor',
        color: color({ value: 'javascript:alert(1)' }),
      }),
    ).toThrow(/Invalid brand color/)
    let doc = createDoc()
    for (let i = 0; i < BRAND_COLORS_MAX; i++) {
      doc = applyCommand(doc, {
        type: 'addBrandColor',
        color: color({
          id: `brand_${i}`,
          name: `C${i}`,
          value: `#0000${String(i).padStart(2, '0')}`,
        }),
      })
    }
    expect(() =>
      applyCommand(doc, {
        type: 'addBrandColor',
        color: color({ id: 'brand_overflow', name: 'Overflow', value: '#ffffff' }),
      }),
    ).toThrow(/at most/)
  })

  it('renames and removes colors, deleting the kit when it empties', () => {
    const renamed = applyCommand(docWithKit(), {
      type: 'renameBrandColor',
      colorId: 'brand_one',
      name: ' Deep ink ',
    })
    expect(renamed.project.brandKit!.colors[0].name).toBe('Deep ink')
    const removed = applyCommand(renamed, { type: 'removeBrandColor', colorId: 'brand_one' })
    expect(removed.project.brandKit).toBeUndefined()
  })

  it('adds and removes font references, including a missing family', () => {
    const withFont = applyCommand(createDoc(), {
      type: 'addBrandFont',
      family: 'videoh-font-missing',
    })
    expect(withFont.project.brandKit!.fontFamilies).toEqual(['videoh-font-missing'])
    expect(() =>
      applyCommand(withFont, { type: 'addBrandFont', family: 'VIDEOH-FONT-MISSING' }),
    ).toThrow(/already in the brand kit/)
    const removed = applyCommand(withFont, {
      type: 'removeBrandFont',
      family: 'videoh-font-missing',
    })
    expect(removed.project.brandKit).toBeUndefined()
  })

  it('refuses a malformed font reference', () => {
    expect(() => applyCommand(createDoc(), { type: 'addBrandFont', family: 'bad;family' })).toThrow(
      /Invalid brand font family/,
    )
    expect(() =>
      applyCommand(docWithKit(), {
        type: 'removeBrandFont',
        family: 42 as never,
      }),
    ).toThrow(/Unknown brand font/)
  })
})

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..', '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

const COPYRIGHT = 'Copyright (c) 2026 VectorMedia (also known as VectorMediaGR and zeal422)'

/**
 * License locks: the MIT claim appears in the same change as the file, the
 * package metadata, the docs, and the footer link. GitHub detection is an
 * owner-pending check after the push, not something this suite can prove.
 */
describe('MIT license', () => {
  it('ships the full MIT text with the confirmed copyright line', () => {
    expect(existsSync(join(ROOT, 'LICENSE'))).toBe(true)
    const license = read('LICENSE')
    expect(license).toContain('MIT License')
    expect(license).toContain('Permission is hereby granted, free of charge')
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
    expect(license).toContain(COPYRIGHT)
  })

  it('declares the MIT license in package.json and keeps the package private', () => {
    const pkg = JSON.parse(read('package.json')) as { license?: string; private?: boolean }
    expect(pkg.license).toBe('MIT')
    expect(pkg.private).toBe(true)
  })

  it('links the license from the README, CONTRIBUTING, and the public footer', () => {
    expect(read('README.md')).toMatch(/\[[^\]]*MIT[^\]]*\]\([^)]*LICENSE[^)]*\)/i)
    expect(read('CONTRIBUTING.md')).toMatch(/MIT/)
    const footer = read('src/components/site/SiteFooter.tsx')
    expect(footer).toContain('LICENSE_URL')
    expect(footer).toContain('MIT')
    expect(read('src/lib/seo.ts')).toContain(
      "LICENSE_URL = 'https://github.com/zeal422/videoh/blob/main/LICENSE'",
    )
  })
})

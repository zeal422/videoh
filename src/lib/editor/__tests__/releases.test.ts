import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CURRENT_VERSION, releases, releaseByVersion } from '../../releases'

/**
 * releases.test.ts, the welcome-modal notes cannot silently rot.
 *
 * releases.ts is hand-curated, which makes it the one file that drifts the
 * moment a release bumps package.json without distilling its notes. The lock
 * below fails bun run check until the notes exist for the new version, the
 * same contract docs-drift.test.ts enforces for the docs' test counts.
 */

const ROOT = resolve(__dirname, '..', '..', '..', '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }

describe('releases (welcome modal data)', () => {
  it('the newest release is the running version from package.json', () => {
    expect(releases[0].version).toBe(pkg.version)
    expect(CURRENT_VERSION).toBe(pkg.version)
  })

  it('keeps the last five versions for the modal and orders them newest first', () => {
    expect(releases.length).toBeGreaterThanOrEqual(5)
    for (let i = 1; i < releases.length; i++) {
      const prev = releases[i - 1].version.split('.').map(Number)
      const cur = releases[i].version.split('.').map(Number)
      expect(prev[0] * 1_000_000 + prev[1] * 1_000 + prev[2]).toBeGreaterThan(
        cur[0] * 1_000_000 + cur[1] * 1_000 + cur[2],
      )
    }
  })

  it('every release carries at least four nonempty highlights and an ISO date', () => {
    for (const r of releases) {
      expect(r.highlights.length).toBeGreaterThanOrEqual(4)
      for (const h of r.highlights) expect(h.trim().length).toBeGreaterThan(0)
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('releaseByVersion resolves a known version and misses an unknown one', () => {
    expect(releaseByVersion(pkg.version)?.highlights.length).toBeGreaterThanOrEqual(4)
    expect(releaseByVersion('9.9.9')).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/**
 * docs-drift.test.ts — locks the documentation's test-count claims to reality.
 *
 * testing.md's own convention: "When you add a test file or change the totals,
 * update this table and the test-count references in the README." This test
 * enforces that mechanically:
 *
 * - Repo-wide headline claims ("N tests", "N test files", "N tests across
 *   N files") must exactly match the real suite on disk.
 * - Scoped directory-tree comments ("N test files (M tests)") describe a
 *   subdirectory, not the repo, so they are only checked to be INTERNALLY
 *   consistent (files <= tests) and to not accidentally equal a stale
 *   repo-wide total. They cannot be validated against disk without parsing
 *   the tree layout they annotate.
 * - Every row of testing.md's per-file inventory table must name a real test
 *   file with that file's real case count, one row per file. The headline
 *   total alone would hide a row that drifted, and a row that loses its cells
 *   (two rows collapsed onto one line) drops both files from the table while
 *   still summing to the same total.
 * - Any line in those docs that mentions the battery and names a step count
 *   must name the real `step` count in e2e/battery.sh. That count has drifted
 *   twice (28 claimed for a 29-step run, 42 for 44) and no other lock sees it.
 */

const ROOT = resolve(__dirname, '..', '..', '..', '..')
const DOCS = ['README.md', 'docs/testing.md', 'docs/structure.md', 'AGENTS.md'] as const

/** Every test file the suite actually runs (vitest include: any src .test.ts or .test.tsx). */
function realTestFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (/\.test\.tsx?$/.test(entry.name)) out.push(p)
    }
  }
  walk(join(ROOT, 'src'))
  return out.sort()
}

/** Count the it/test declarations in one test file (line-anchored, comments excluded). */
function countCases(file: string): number {
  const src = readFileSync(file, 'utf8')
  return (src.match(/^\s*(?:it|test)\s*\(/gm) ?? []).length
}

/**
 * Validate one doc's repo-wide headline claims. Returns null when the doc is
 * consistent, or a short failure description when it is not.
 */
function checkHeadline(doc: string, files: string[], total: number): string | null {
  const text = readFileSync(join(ROOT, doc), 'utf8')
  // "N tests across N files" (README headline) — the strongest claim.
  for (const m of text.matchAll(/(\d+)\s+tests across (\d+)\s+files/g)) {
    if (Number(m[1]) !== total || Number(m[2]) !== files.length)
      return `${doc}: "${m[0]}" != ${total} tests across ${files.length} files`
  }
  // "Inventory — N files, N tests" (testing.md heading).
  for (const m of text.matchAll(/(\d+)\s+files?,\s*(\d+)\s+tests\b/g)) {
    if (Number(m[1]) !== files.length || Number(m[2]) !== total)
      return `${doc}: "${m[0]}" != ${files.length} files, ${total} tests`
  }
  // Bare "N tests" / "N test files": scoped directory-tree pairs are stripped
  // first (parenthetical and comma forms); what remains must be repo-wide.
  const withoutScoped = text
    .replace(/\d+\s+test files?\s*\(\d+\s+tests?\)/g, '')
    .replace(/\d+\s+test files?,\s*\d+\s+tests?/g, '')
    .replace(/\(\d+\s+tests?\)/g, '')
  for (const m of withoutScoped.matchAll(/(\d+)\s+tests\b/g)) {
    if (Number(m[1]) !== total) return `${doc}: "${m[1]} tests" != ${total} tests`
  }
  for (const m of withoutScoped.matchAll(/(\d+)\s+test files\b/g)) {
    if (Number(m[1]) !== files.length) return `${doc}: "${m[1]} test files" != ${files.length}`
  }
  return null
}

/**
 * Validate scoped directory-tree counts ("N test files (M tests)"). These
 * describe a subdirectory: `src/lib/editor/__tests__` (the gate test lives in
 * `src/lib/` and is listed separately in the same line). Where the doc names
 * the directory, the claim is checked EXACTLY against a real directory count;
 * unnamed claims fall back to the internal-sanity range.
 */
function checkScoped(doc: string, files: string[], total: number): string | null {
  const text = readFileSync(join(ROOT, doc), 'utf8')
  const patterns = [
    /(\d+)\s+test files\s*\((\d+)\s+tests\)/g,
    /(\d+)\s+test files,\s*(\d+)\s+tests/g,
  ]
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const n = Number(m[1])
      const t = Number(m[2])
      if (n <= 0) return `${doc}: scoped "${m[0]}" has no files`
      if (t < n || t > total) return `${doc}: scoped "${m[0]}" out of range (repo total ${total})`
    }
  }
  // Exact check for the one scoped claim shape this repo uses: a directory
  // count for src/lib/editor/__tests__ with the gate test listed separately.
  // Count the directory from disk so the claim cannot drift.
  const dir = join(ROOT, 'src', 'lib', 'editor', '__tests__')
  const dirFiles = readdirSync(dir).filter((f) => /\.test\.tsx?$/.test(f))
  const dirTests = dirFiles.reduce(
    (sum, f) =>
      sum + (readFileSync(join(dir, f), 'utf8').match(/^\s*(?:it|test)\s*\(/gm) ?? []).length,
    0,
  )
  if (text.includes('gate.test.ts')) {
    // Claims of the form "N test files (M tests) + gate.test.ts": N and M must
    // equal the directory totals, and the combined claim must be <= repo total.
    if (!dirTests && dirFiles.length === 0) return `${doc}: editor __tests__ dir empty?`
    for (const m of text.matchAll(
      /(\d+)\s+test files[ ,]+\((\d+)\s+tests?\)\s*\+\s*src\/lib\/gate\.test\.ts/g,
    )) {
      if (Number(m[1]) !== dirFiles.length || Number(m[2]) !== dirTests) {
        return `${doc}: "${m[0]}" != ${dirFiles.length} files / ${dirTests} tests in src/lib/editor/__tests__`
      }
    }
    for (const m of text.matchAll(
      /(\d+)\s+test files,\s*(\d+)\s+tests\s*\(see testing\.md; \+ gate\.test\.ts/g,
    )) {
      if (Number(m[1]) !== dirFiles.length || Number(m[2]) !== dirTests) {
        return `${doc}: "${m[0]}" != ${dirFiles.length} files / ${dirTests} tests in src/lib/editor/__tests__`
      }
    }
  }
  // The README tree line names the SAME directory but counts the REPO:
  // "N test files (M tests) incl. gate.test.ts in src/lib/". N and M must
  // equal the repo-wide totals, or a stale count hides behind the scoped
  // shape (checkHeadline strips "N test files (M tests)" before its bare
  // checks, so without this pattern such a line is never validated).
  for (const m of text.matchAll(
    /(\d+)\s+test files\s*\((\d+)\s+tests?\)\s*incl\.\s*gate\.test\.ts/g,
  )) {
    if (Number(m[1]) !== files.length || Number(m[2]) !== total) {
      return `${doc}: "${m[0]}" != ${files.length} files / ${total} tests repo-wide (incl. gate.test.ts)`
    }
  }
  return null
}

/**
 * Validate the per-file inventory table in testing.md: one row per real test
 * file, a numeric count that matches `countCases`, and no malformed rows. Rows
 * are read by their cell shape ('' | file | tests | focus | ''), so a row whose
 * cells were merged onto another line fails BOTH as a malformed row and as two
 * missing files.
 */
function checkTestingTableRows(files: string[]): string[] {
  const doc = 'docs/testing.md'
  const text = readFileSync(join(ROOT, doc), 'utf8')
  const byName = new Map(files.map((f) => [basename(f), f]))
  const seen = new Set<string>()
  const problems: string[] = []
  text.split('\n').forEach((line, i) => {
    const at = `${doc}:${i + 1}`
    if (!line.startsWith('|')) return
    const cells = line.split('|').map((c) => c.trim())
    // '' | file | tests | focus | ''.
    if (cells.length !== 5) {
      problems.push(`${at} table row has ${cells.length - 2} cells, expected 3`)
      return
    }
    // ONLY the header and the |---| separator may carry a first cell that is not
    // a backticked filename, and each must match WHOLE: matching on the first
    // cell alone would also skip a decoy data row whose filename cell reads
    // "File", and a partial separator (dash cells plus a junk one) would slip
    // through the dash check on its way to the same silent skip.
    const head = cells[1]
    if (head === 'File' && cells[2] === 'Tests' && cells[3] === 'Focus') return
    if (cells.slice(1, -1).every((c) => /^:?-{3,}:?$/.test(c))) return
    const file = /^`([^`]+)`$/.exec(head)?.[1]
    if (!file) {
      problems.push(`${at} row "${head}" has no backticked test filename`)
      return
    }
    const claimed = Number(cells[2])
    if (!Number.isInteger(claimed)) {
      problems.push(`${at} "${file}" has no numeric count ("${cells[2]}")`)
      return
    }
    const real = byName.get(file)
    if (!real) {
      problems.push(`${at} "${file}" matches no test file on disk`)
      return
    }
    if (seen.has(file)) problems.push(`${at} "${file}" is listed twice`)
    seen.add(file)
    const actual = countCases(real)
    if (claimed !== actual) problems.push(`${at} "${file}" claims ${claimed}, suite has ${actual}`)
  })
  for (const f of files) {
    if (!seen.has(basename(f))) problems.push(`${doc}: no inventory row for ${basename(f)}`)
  }
  return problems
}

/**
 * Battery step-count claims: a doc line that mentions the battery and names a
 * step count must name the real one. Lines are matched individually so an
 * unrelated "N steps" (e.g. an undo-depth line) cannot false-positive the lock.
 */
function checkBatterySteps(): string | null {
  const script = readFileSync(join(ROOT, 'e2e', 'battery.sh'), 'utf8')
  const real = (script.match(/^step /gm) ?? []).length
  if (real === 0) return 'e2e/battery.sh registers no steps'
  for (const doc of DOCS) {
    const lines = readFileSync(join(ROOT, doc), 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!/battery/i.test(lines[i])) continue
      for (const m of lines[i].matchAll(/(\d+)[- ]steps?\b/g)) {
        if (Number(m[1]) !== real) {
          return `${doc}:${i + 1}: "${m[0]}" != ${real} steps in e2e/battery.sh`
        }
      }
    }
  }
  return null
}

/**
 * The coverage-scope sentence in testing.md must name every module in
 * vitest.config.ts's coverage include list. Nothing else locks it: the text
 * coverage table hides 100% files in agent environments (Vitest's skipFull
 * default), and the per-file inventory covers test files, not source modules.
 * The sentence had silently dropped `ease-segment` while the include list and
 * the report both measured it.
 */
function checkCoverageScope(): string | null {
  const cfg = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
  const block = cfg.match(/coverage:\s*\{[\s\S]*?include:\s*\[([\s\S]*?)\]/)?.[1]
  if (!block) return 'vitest.config.ts: no coverage include list'
  const modules = [...block.matchAll(/'([^']+)'/g)].map((m) => basename(m[1], '.ts'))
  const doc = readFileSync(join(ROOT, 'docs/testing.md'), 'utf8')
  const start = doc.indexOf('state modules only:')
  if (start < 0) return 'docs/testing.md: no coverage-scope sentence'
  const end = doc.indexOf('\n\n', start)
  const scope = doc.slice(start, end < 0 ? undefined : end)
  const missing = modules.filter((m) => !scope.includes(`\`${m}\``))
  if (missing.length > 0) return `docs/testing.md: coverage sentence omits ${missing.join(', ')}`
  return null
}

describe('docs test-count claims match the real suite', () => {
  const files = realTestFiles()
  const total = files.reduce((sum, f) => sum + countCases(f), 0)

  it('the suite is non-empty (the lock must not vacuously pass)', () => {
    expect(files.length).toBeGreaterThan(0)
    expect(total).toBeGreaterThan(0)
  })

  it('every doc headline test count matches the suite', () => {
    // NOTE: this file must NOT generate its tests in a loop (no `for (...) it(`).
    // A loop-generated test count would make the static counter below disagree
    // with vitest, and the lock would fight itself.
    expect(DOCS.map((doc) => checkHeadline(doc, files, total)).filter((f) => f !== null)).toEqual(
      [],
    )
  })

  it('every doc scoped directory count is internally consistent', () => {
    expect(DOCS.map((doc) => checkScoped(doc, files, total)).filter((f) => f !== null)).toEqual([])
  })

  it('every per-file row in the testing.md inventory matches its suite', () => {
    expect(checkTestingTableRows(files)).toEqual([])
  })

  it('every battery step-count claim matches e2e/battery.sh', () => {
    expect(checkBatterySteps()).toBeNull()
  })

  it('the testing.md coverage sentence names every included module', () => {
    expect(checkCoverageScope()).toBeNull()
  })
})

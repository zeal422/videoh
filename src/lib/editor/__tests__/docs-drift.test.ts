import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { COMMAND_BOUNDARY_CASES } from './command-boundary-cases'

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
 *   subdirectory, not the repo, so unnamed claims are only checked to be
 *   INTERNALLY consistent (files <= tests) and to not accidentally equal a
 *   stale repo-wide total. Claims on a line that names the editor test directory
 *   are checked exactly against disk, and the README tree line is required to
 *   exist with its count.
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

/**
 * Tables imported by a test file for a `for ... of` loop that declares one
 * `it` per row. The source scan cannot see an imported array's length, so a
 * new loop table must be registered here; an unregistered one fails the gate
 * loudly instead of silently undercounting the suite.
 */
const IMPORTED_LOOP_TABLES: Record<string, number> = {
  COMMAND_BOUNDARY_CASES: COMMAND_BOUNDARY_CASES.length,
}

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
  return countCasesFromSource(readFileSync(file, 'utf8'), file)
}

/**
 * Count the it/test declarations in one source. `it.each` with an inline table
 * counts its rows; a variable-backed table resolves the const array in the
 * same file. An unresolvable table throws, so the drift gate fails loudly in
 * the undercount direction, never silently.
 */
function countCasesFromSource(src: string, file = 'source'): number {
  return (
    (src.match(/^\s*(?:it|test)\s*\(/gm) ?? []).length +
    countEachRows(src, file) +
    countLoopRows(src, file)
  )
}

/**
 * Count `it.each`/`test.each` table rows: each subsequent single-line array
 * element is one case, up to the closing bracket line. Multi-line rows do
 * not exist in this repo; if one appears it is missed and the drift gate
 * fails loudly in the undercount direction, never silently.
 */
function countEachRows(src: string, file: string): number {
  const lines = src.split('\n')
  let rows = 0
  for (let i = 0; i < lines.length; i++) {
    const inline = /^\s*(?:it|test)\.each\(\[\s*$/.test(lines[i] ?? '')
    const variable = inline
      ? null
      : /^\s*(?:it|test)\.each\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(lines[i] ?? '')
    if (!inline && !variable) continue
    if (inline) {
      const line = lines[i] ?? ''
      rows += countArrayRows(src, lines, i, line.lastIndexOf('['))
      continue
    }
    const name = variable![1]!
    const declaration = new RegExp(`^\\s*const\\s+${name}\\b[^=\\n]*=\\s*\\[\\s*$`)
    const starts = lines.flatMap((line, index) => (declaration.test(line) ? [index] : []))
    if (starts.length === 0) {
      throw new Error(`${file}:${i + 1} it.each table "${name}" cannot be resolved`)
    }
    if (starts.length > 1) {
      // Two same-named tables in different describe scopes are not
      // distinguishable by this line scan. Fail instead of charging rows from
      // the wrong declaration.
      throw new Error(
        `${file}:${i + 1} it.each table "${name}" is ambiguous (${starts.length} declarations)`,
      )
    }
    rows += countArrayRows(src, lines, starts[0]!, (lines[starts[0]!] ?? '').lastIndexOf('['))
  }
  return rows
}

/** Global source offset of one line and column. */
function sourceOffset(lines: string[], line: number, column: number): number {
  let offset = 0
  for (let i = 0; i < line; i++) offset += (lines[i]?.length ?? 0) + 1
  return offset + column
}

/** Keywords after which a slash starts a regular expression, not division. */
const REGEX_AFTER_KEYWORDS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
])

/**
 * True when a slash starts a regular expression rather than division. The
 * previous significant token decides: a value-ending token (identifier, number,
 * string, closing bracket) means division, while an operator, opening bracket,
 * comma, or a regex-allowing keyword means an expression may start here.
 */
function regexAllowedAfter(src: string, at: number): boolean {
  let i = at - 1
  while (i >= 0 && /\s/.test(src[i]!)) i -= 1
  if (i < 0) return true
  const ch = src[i]!
  if (!/[A-Za-z0-9_$]/.test(ch)) return !/[)\]}"'`]/.test(ch)
  let end = i
  while (i >= 0 && /[A-Za-z0-9_$]/.test(src[i]!)) i -= 1
  return REGEX_AFTER_KEYWORDS.has(src.slice(i + 1, end + 1))
}

/** Consume a regular expression starting at `start`; returns its closing slash. */
function consumeRegex(src: string, start: number): number {
  let inClass = false
  let escaped = false
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '[') {
      inClass = true
      continue
    }
    if (ch === ']') {
      inClass = false
      continue
    }
    if (ch === '/' && !inClass) return i
    if (ch === '\n') break
  }
  throw new Error('countArrayElements: unterminated regular expression')
}

/** Count the top-level elements of the array literal starting at `start`. */
function countArrayElements(src: string, start: number): number {
  if (src[start] !== '[') throw new Error('countArrayElements: expected an array literal')
  let depth = 0
  let elements = 0
  let hasContent = false
  let string: string | null = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = start + 1; index < src.length; index++) {
    const ch = src[index]!
    const next = src[index + 1]
    if (lineComment) {
      if (ch === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false
        index += 1
      }
      continue
    }
    if (string !== null) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === string) string = null
      continue
    }
    if (ch === '/' && next === '/') {
      lineComment = true
      index += 1
      continue
    }
    if (ch === '/' && next === '*') {
      blockComment = true
      index += 1
      continue
    }
    if (ch === '/' && regexAllowedAfter(src, index)) {
      index = consumeRegex(src, index)
      hasContent = true
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      string = ch
      hasContent = true
      continue
    }
    if (ch === '[' || ch === '{' || ch === '(') {
      depth += 1
      if (depth === 1) hasContent = true
      continue
    }
    if (ch === ']' || ch === '}' || ch === ')') {
      if (depth === 0 && ch === ']') {
        if (hasContent) elements += 1
        return elements
      }
      if (depth === 0) throw new Error('countArrayElements: unbalanced array literal')
      depth -= 1
      continue
    }
    if (ch === ',' && depth === 0) {
      if (hasContent) elements += 1
      hasContent = false
      continue
    }
    if (!/\s/.test(ch)) hasContent = true
  }
  throw new Error('countArrayElements: unterminated array literal')
}

/** Count the top-level elements of the array literal on a source line. */
function countArrayRows(src: string, lines: string[], line: number, column: number): number {
  if (column < 0) throw new Error('countArrayRows: the table has no array literal')
  return countArrayElements(src, sourceOffset(lines, line, column))
}

/**
 * Count cases generated by `for (const ... of TABLE) { it(...) }`. The plain
 * scan counts each declaration in the loop once, so this adds
 * `declarations * (TABLE.length - 1)`. A table declared in the same source is
 * read from its rows; an imported one comes from `IMPORTED_LOOP_TABLES`.
 */
function countLoopRows(src: string, file: string): number {
  const lines = src.split('\n')
  let extra = 0
  for (let i = 0; i < lines.length; i++) {
    const loop = /^\s*for\s*\(\s*const\s+.*?\bof\s+([A-Za-z_$][\w$]*)\s*\)\s*\{/.exec(
      lines[i] ?? '',
    )
    if (!loop) continue
    const declarations = loopBodyTestDeclarations(lines, i)
    if (declarations === 0) continue
    const name = loop[1]!
    const declaration = new RegExp(`^\\s*const\\s+${name}\\b[^=\\n]*=\\s*\\[\\s*$`)
    const starts = lines.flatMap((line, index) => (declaration.test(line) ? [index] : []))
    let length: number | undefined
    if (starts.length === 1) {
      length = countArrayRows(src, lines, starts[0]!, (lines[starts[0]!] ?? '').lastIndexOf('['))
    } else if (starts.length > 1) {
      throw new Error(`${file}:${i + 1} loop table "${name}" is ambiguous`)
    } else {
      length = IMPORTED_LOOP_TABLES[name]
      if (length === undefined) {
        throw new Error(`${file}:${i + 1} loop table "${name}" cannot be resolved`)
      }
    }
    extra += declarations * Math.max(0, length - 1)
  }
  return extra
}

/** Count it/test declarations in a loop body, up to its matching indent. */
function loopBodyTestDeclarations(lines: string[], start: number): number {
  const indent = (lines[start]?.match(/^\s*/) ?? [''])[0].length
  let declarations = 0
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j] ?? ''
    if (line.trim() === '}' && (line.match(/^\s*/) ?? [''])[0].length === indent) break
    if (/^\s*(?:it|test)\s*\(/.test(line)) declarations += 1
  }
  return declarations
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
 * describe a subdirectory: `src/lib/editor/__tests__`. Where the doc names the
 * directory on the same line, the claim is checked EXACTLY against a real
 * directory count; unnamed claims fall back to the internal-sanity range. The
 * README tree line is required to exist with its count, so deleting it cannot
 * turn the exact check into a no-op.
 */
function checkScoped(doc: string, total: number, textOverride?: string): string | null {
  const text = textOverride ?? readFileSync(join(ROOT, doc), 'utf8')
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
  // Gate-independent exact check for the one scoped claim shape this repo
  // uses: a directory count for src/lib/editor/__tests__ on the same line as
  // the `__tests__/` tree path. Count the directory from disk so the claim
  // cannot drift, and do not gate the check on any particular test filename.
  const dir = join(ROOT, 'src', 'lib', 'editor', '__tests__')
  const dirFiles = readdirSync(dir).filter((f) => /\.test\.tsx?$/.test(f))
  const dirTests = dirFiles.reduce((sum, f) => sum + countCases(join(dir, f)), 0)
  if (!dirTests && dirFiles.length === 0) return `${doc}: editor __tests__ dir empty?`
  if (doc === 'README.md') {
    const treeLines = text
      .split('\n')
      .filter((line) => line.includes('__tests__/') && line.includes('src/lib/editor/__tests__'))
    if (treeLines.length !== 1) {
      return `${doc}: expected one editor __tests__ tree line, found ${treeLines.length}`
    }
    const m = treeLines[0].match(/(\d+)\s+test files?\s*\((\d+)\s+tests?\)/)
    if (!m) return `${doc}: editor __tests__ tree line is missing its test count`
    if (Number(m[1]) !== dirFiles.length || Number(m[2]) !== dirTests) {
      return `${doc}: "${m[0]}" != ${dirFiles.length} files / ${dirTests} tests in src/lib/editor/__tests__`
    }
  }
  for (const line of text.split('\n')) {
    if (!line.includes('__tests__/')) continue
    for (const m of line.matchAll(/(\d+)\s+test files?\s*\((\d+)\s+tests?\)/g)) {
      if (Number(m[1]) !== dirFiles.length || Number(m[2]) !== dirTests) {
        return `${doc}: "${m[0]}" != ${dirFiles.length} files / ${dirTests} tests in src/lib/editor/__tests__`
      }
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
function coverageModulePaths(): string[] | null {
  const cfg = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
  const block = cfg.match(/coverage:\s*\{[\s\S]*?include:\s*\[([\s\S]*?)\]/)?.[1]
  if (!block) return null
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

function checkCoverageScope(): string | null {
  const paths = coverageModulePaths()
  if (!paths) return 'vitest.config.ts: no coverage include list'
  const modules = paths.map((path) => basename(path, '.ts'))
  const doc = readFileSync(join(ROOT, 'docs/testing.md'), 'utf8')
  const start = doc.indexOf('state modules only:')
  if (start < 0) return 'docs/testing.md: no coverage-scope sentence'
  const end = doc.indexOf('\n\n', start)
  const scope = doc.slice(start, end < 0 ? undefined : end)
  const missing = modules.filter((m) => !scope.includes(`\`${m}\``))
  if (missing.length > 0) return `docs/testing.md: coverage sentence omits ${missing.join(', ')}`
  return null
}

/**
 * The residual register is the release gate's record of every uncovered branch.
 * Lock its count, keys, module names, source lines, and reason prefix so a
 * coverage change cannot leave a stale register behind without a failure.
 */
const RESIDUAL_REGISTER_COUNT = 243

interface ResidualRow {
  file: string
  line: number
  col: number
  type: string
  path: number
  reason: string
}

function residualRows(): ResidualRow[] {
  const doc = readFileSync(join(ROOT, 'docs/testing.md'), 'utf8')
  const start = doc.indexOf('## Coverage residual register')
  if (start < 0) return []
  return [
    ...doc
      .slice(start)
      .matchAll(/^- `([^`]+)` line (\d+), col (\d+), ([\w-]+), path (\d+): (.+)$/gm),
  ].map((row) => ({
    file: row[1]!,
    line: Number(row[2]),
    col: Number(row[3]),
    type: row[4]!,
    path: Number(row[5]),
    reason: row[6]!,
  }))
}

function checkResidualRegister(): string | null {
  const paths = coverageModulePaths()
  if (!paths) return 'vitest.config.ts: no coverage include list'
  const sources = new Map<string, string>()
  for (const path of paths) {
    const name = basename(path)
    if (sources.has(name)) return `vitest.config.ts: duplicate source basename ${name}`
    sources.set(name, join(ROOT, path))
  }
  const rows = residualRows()
  if (rows.length !== RESIDUAL_REGISTER_COUNT) {
    return `docs/testing.md: residual register has ${rows.length} entries, expected ${RESIDUAL_REGISTER_COUNT}`
  }
  const keys = new Set<string>()
  for (const row of rows) {
    const key = `${row.file}:${row.line}:${row.col}:${row.type}:${row.path}`
    if (keys.has(key)) return `docs/testing.md: duplicate residual entry ${key}`
    keys.add(key)
    if (!/^(?:class-b|class-c|not prioritized):/.test(row.reason)) {
      return `docs/testing.md: residual entry ${key} has no class reason`
    }
    const source = sources.get(row.file)
    if (!source) return `docs/testing.md: residual entry ${key} names an unknown module`
    const sourceLines = readFileSync(source, 'utf8').split('\n').length
    if (row.line < 1 || row.line > sourceLines) {
      return `docs/testing.md: residual entry ${key} is outside ${row.file}`
    }
  }
  return null
}

interface CoverageBranchMap {
  type: string
  loc: { start: { line: number; column: number } }
}

function checkResidualCoverage(): string | null {
  if (process.env.COVERAGE_GATE !== '1') return null
  let raw: string
  try {
    raw = readFileSync(join(ROOT, 'coverage/coverage-final.json'), 'utf8')
  } catch {
    return 'docs/testing.md: coverage gate is set but coverage-final.json is missing'
  }
  const coverage = JSON.parse(raw) as Record<
    string,
    { b: Record<string, number[]>; branchMap: Record<string, CoverageBranchMap> }
  >
  const uncovered = new Set<string>()
  for (const [file, data] of Object.entries(coverage)) {
    const name = basename(file)
    for (const [id, counts] of Object.entries(data.b)) {
      const branch = data.branchMap[id]
      for (let index = 0; index < counts.length; index += 1) {
        if (counts[index] !== 0) continue
        uncovered.add(
          `${name}:${branch.loc.start.line}:${branch.loc.start.column}:${branch.type}:${index}`,
        )
      }
    }
  }
  const register = new Set(
    residualRows().map((row) => `${row.file}:${row.line}:${row.col}:${row.type}:${row.path}`),
  )
  const missing = [...uncovered].filter((key) => !register.has(key))
  const extra = [...register].filter((key) => !uncovered.has(key))
  if (uncovered.size !== register.size || missing.length > 0 || extra.length > 0) {
    return `docs/testing.md: residual register ${register.size} entries, coverage has ${uncovered.size}; missing ${missing.length} [${missing.join(', ')}], extra ${extra.length} [${extra.join(', ')}]`
  }
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

  it('every doc scoped directory count is internally consistent and the README tree line exists', () => {
    expect(DOCS.map((doc) => checkScoped(doc, total)).filter((f) => f !== null)).toEqual([])

    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    const withoutTree = readme
      .split('\n')
      .filter((line) => !line.includes('__tests__/'))
      .join('\n')
    expect(checkScoped('README.md', total, withoutTree)).toContain(
      'expected one editor __tests__ tree line',
    )
  })

  it('expands variable-backed it.each tables instead of undercounting them', () => {
    // clip-invariants.test.ts has 5 plain cases plus 17 table rows across two
    // const-backed tables. The old counter saw only the 5 plain cases.
    const clip = join(ROOT, 'src/lib/editor/__tests__/clip-invariants.test.ts')
    expect(countCases(clip)).toBe(22)
  })

  it('rejects an ambiguous variable-backed it.each table instead of picking one', () => {
    const source = [
      'const CASES = [',
      "  ['a'],",
      ']',
      'describe("one", () => {',
      '  const CASES = [',
      "    ['b'],",
      "    ['c'],",
      '  ]',
      '  it.each(CASES)("case %s", () => {})',
      '})',
    ].join('\n')
    expect(() => countCasesFromSource(source, 'synthetic')).toThrow(/ambiguous/)
  })

  it('expands for-of tables across row forms and test declarations', () => {
    const loop = (rows: string[], declarations = 1) =>
      [
        'const CASES = [',
        ...rows,
        ']',
        'for (const [name] of CASES) {',
        ...Array.from({ length: declarations }, () => '  it("case", () => {})'),
        '}',
      ].join('\n')
    // Tuple, scalar, and object rows all count as one element each.
    expect(countCasesFromSource(loop(["  ['a'],", "  ['b'],", "  ['c'],"]), 'synthetic')).toBe(3)
    expect(countCasesFromSource(loop(["  'a',", "  'b',", "  'c',"]), 'synthetic')).toBe(3)
    expect(
      countCasesFromSource(loop(['  { name: "a" },', '  { name: "b" },'], 2), 'synthetic'),
    ).toBe(4)

    const unresolved = ['for (const [name] of UNKNOWN) {', '  it(name, () => {})', '}'].join('\n')
    expect(() => countCasesFromSource(unresolved, 'synthetic')).toThrow(/cannot be resolved/)
  })

  it('does not split a row on a comma inside a regular expression', () => {
    const source = [
      'const CASES = [',
      '  /,/,',
      '  /x,y/,',
      ']',
      'it.each(CASES)("case %s", () => {})',
    ].join('\n')
    expect(countCasesFromSource(source, 'synthetic')).toBe(2)
  })

  it('every per-file row and residual entry in testing.md matches its source', () => {
    expect(checkTestingTableRows(files)).toEqual([])
    expect(checkResidualRegister()).toBeNull()
    expect(checkResidualCoverage()).toBeNull()
  })

  it('every battery step-count claim matches e2e/battery.sh', () => {
    expect(checkBatterySteps()).toBeNull()
  })

  it('the testing.md coverage sentence names every included module', () => {
    expect(checkCoverageScope()).toBeNull()
  })
})

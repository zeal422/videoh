import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..', '..', '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/**
 * Public-surface locks: the password gate is gone, the editor boots only at
 * /editor, and no public component reaches into the editor state or browser
 * engines. The broad scan builds its needles from fragments so this file
 * cannot satisfy the scan by naming what it looks for.
 */
const GATE = ['ga', 'te'].join('')
const BANNED = [
  ['GATE', '_PASSWORD'].join(''),
  ['GATE', '_SECRET'].join(''),
  ['videoh', '_', GATE].join(''),
  ['videoh', '_', GATE, '_tries'].join(''),
  ['/', GATE].join(''),
  ['/api/', GATE, '-login'].join(''),
  ['src/', 'proxy.ts'].join(''),
  ['src/lib/', GATE, '.ts'].join(''),
  ['src/lib/', GATE, '-env.ts'].join(''),
  ['src/lib/', GATE, '.test.ts'].join(''),
  [GATE, '/page.tsx'].join(''),
  ['api/', GATE, '-login'].join(''),
  ['access', ' ', GATE].join(''),
  ['access', '-', GATE].join(''),
  ['password', ' ', GATE].join(''),
  [GATE, ' login'].join(''),
  [GATE, '-login'].join(''),
  [GATE, ' page'].join(''),
  [GATE, ' password'].join(''),
  [GATE, ' is active'].join(''),
  [GATE, ' is open'].join(''),
  ['This editor is private'].join(''),
]

const EXCLUDED = new Set([
  'CHANGELOG.md',
  'src/lib/editor/__tests__/docs-drift.test.ts',
  'src/lib/editor/__tests__/public-surface.test.ts',
])

const EXCLUDED_PREFIXES = [
  'node_modules/',
  '.next/',
  'coverage/',
  '.git/',
  'tool-results/',
  'results-',
  'results.',
]

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.mp4',
  '.mp3',
  '.wav',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
])

function isLocalEnvFile(path: string): boolean {
  const name = basename(path)
  if (name === '.env.example') return false
  return name === '.env' || name.startsWith('.env.')
}

function currentSurface(): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return listed
    .split('\n')
    .filter(Boolean)
    .filter((path) => !EXCLUDED.has(path))
    .filter((path) => !/^PLAN-.*\.md$/.test(path))
    .filter((path) => !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)))
    .filter((path) => !isLocalEnvFile(path))
    .filter((path) => {
      if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return false
      try {
        return statSync(join(ROOT, path)).isFile()
      } catch {
        return false
      }
    })
}

describe('gate removal and route split', () => {
  it('removes every gate entry point and the old root page', () => {
    for (const path of [
      'src/proxy.ts',
      'src/lib/gate.ts',
      'src/lib/gate-env.ts',
      'src/lib/gate.test.ts',
      'src/app/gate/page.tsx',
      'src/app/api/gate-login/route.ts',
      'src/app/page.tsx',
    ]) {
      expect(existsSync(join(ROOT, path)), path).toBe(false)
    }
  })

  it('boots the editor only from the editor route', () => {
    const sitePage = read('src/app/(site)/page.tsx')
    expect(sitePage).not.toContain('Preloader')
    expect(sitePage).not.toContain('EditorShell')

    const boot = read('src/components/editor/EditorBoot.tsx')
    expect(boot.startsWith("'use client'")).toBe(true)
    expect(boot).toContain("import { Preloader } from '@/components/editor/Preloader'")
    expect(boot).toContain('MIN_SHOW_MS = 3200')
    expect(boot).toContain('window.location.reload()')

    const editorPage = read('src/app/editor/page.tsx')
    expect(editorPage).toContain("import { EditorBoot } from '@/components/editor/EditorBoot'")
    expect(editorPage).toContain('<EditorBoot />')
    expect(editorPage).toContain('index: false')
    expect(editorPage).toContain("path: '/editor'")
  })

  it('keeps the public site free of editor state and browser-engine imports', () => {
    const surface = currentSurface().filter(
      (path) => path.startsWith('src/components/site/') || path.startsWith('src/app/(site)/'),
    )
    expect(surface.length).toBeGreaterThan(0)
    const forbidden = [
      '@/lib/editor/store',
      '@/components/editor',
      '@/lib/editor/media',
      '@/lib/editor/playback',
      '@/lib/editor/export',
    ]
    const problems: string[] = []
    for (const path of surface) {
      const source = readFileSync(join(ROOT, path), 'utf8')
      for (const needle of forbidden) {
        if (source.includes(needle)) problems.push(`${path}: imports ${needle}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('replaces the conditional docs-drift branch with an exact directory check', () => {
    const source = read('src/lib/editor/__tests__/docs-drift.test.ts')
    expect(source).not.toContain(['gate', '.test.ts'].join(''))
    expect(source).not.toContain(['gate', '.test'].join(''))
    expect(source).toContain('src/lib/editor/__tests__')
    expect(source.toLowerCase()).toContain('gate-independent')
  })

  it('leaves no gate marker anywhere in the current surface', () => {
    const problems: string[] = []
    for (const path of currentSurface()) {
      const source = readFileSync(join(ROOT, path), 'utf8')
      for (const needle of BANNED) {
        if (source.includes(needle)) problems.push(`${path}: contains ${needle}`)
      }
    }
    expect(problems).toEqual([])
  })
})

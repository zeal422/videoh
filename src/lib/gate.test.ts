import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initGateEnv, resetGateEnvCache, resolveGateEnv } from './gate-env'
import {
  SESSION_TTL_MS,
  sessionKey,
  THROTTLE_BASE_DELAY_MS,
  THROTTLE_FREE_TRIES,
  THROTTLE_MAX_DELAY_MS,
  THROTTLE_RESET_MS,
  nextDelayMs,
  signSession,
  signThrottle,
  verifyPassword,
  verifySession,
  verifyThrottle,
} from './gate'

const SECRET = 'correct horse battery staple'
const NOW = 1_700_000_000_000

// The two env materials: GATE_SECRET (random) and GATE_PASSWORD (human).
const GATE_SECRET = 'a-random-machine-generated-string'
const GATE_PASSWORD = SECRET
const KEY = sessionKey(GATE_SECRET, GATE_PASSWORD)

describe('session key derivation (0.4.2)', () => {
  it('signs and verifies through the derived key', () => {
    const cookie = signSession(NOW + SESSION_TTL_MS, KEY)
    expect(verifySession(cookie, NOW, KEY)).toBe(true)
  })

  it('rejects a cookie signed with the RAW password — the old 0.4.0 scheme', () => {
    // A pre-0.4.2 cookie (or any cookie minted without the secret) must not
    // verify: that is the offline-cracking hole this closes.
    const legacyCookie = signSession(NOW + SESSION_TTL_MS, GATE_PASSWORD)
    expect(verifySession(legacyCookie, NOW, KEY)).toBe(false)
    // and the reverse: a new-scheme cookie means nothing to the raw password
    const cookie = signSession(NOW + SESSION_TTL_MS, KEY)
    expect(verifySession(cookie, NOW, GATE_PASSWORD)).toBe(false)
  })

  it('needs BOTH materials: secret alone or password alone mint nothing', () => {
    const cookie = signSession(NOW + SESSION_TTL_MS, KEY)
    expect(verifySession(cookie, NOW, sessionKey('wrong-secret', GATE_PASSWORD))).toBe(false)
    expect(verifySession(cookie, NOW, sessionKey(GATE_SECRET, 'wrong-password'))).toBe(false)
  })

  it('rotating the password still invalidates every live session', () => {
    const cookie = signSession(NOW + SESSION_TTL_MS, KEY)
    const rotatedKey = sessionKey(GATE_SECRET, 'new password')
    expect(verifySession(cookie, NOW, rotatedKey)).toBe(false)
  })

  it('derives deterministically and differs per material', () => {
    expect(sessionKey(GATE_SECRET, GATE_PASSWORD)).toBe(KEY)
    expect(sessionKey(GATE_SECRET, GATE_PASSWORD)).not.toBe(
      sessionKey('other-secret', GATE_PASSWORD),
    )
  })
})

describe('gate env resolution', () => {
  it('gate open when the password is unset (secret irrelevant)', () => {
    expect(resolveGateEnv({})).toBeNull()
    expect(resolveGateEnv({ GATE_SECRET: 'x' })).toBeNull()
  })

  it('normal operation when both are set', () => {
    const gate = resolveGateEnv({ GATE_PASSWORD: 'pw', GATE_SECRET: 'sec', NODE_ENV: 'production' })
    expect(gate).toEqual({
      password: 'pw',
      signingKey: sessionKey('sec', 'pw'),
      secretMissing: false,
    })
  })

  it('production REQUIRES the secret — throws, never silently downgrades', () => {
    expect(() => resolveGateEnv({ GATE_PASSWORD: 'pw', NODE_ENV: 'production' })).toThrowError(
      /GATE_SECRET is required in production/,
    )
  })

  it('dev without the secret falls back to password-only signing and flags it', () => {
    const gate = resolveGateEnv({ GATE_PASSWORD: 'pw', NODE_ENV: 'development' })
    expect(gate).not.toBeNull()
    expect(gate!.secretMissing).toBe(true)
    expect(gate!.signingKey).toBe(sessionKey('pw', 'pw'))
  })
})

describe('gate env init (cached at process level)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    resetGateEnvCache()
  })

  it('memoizes: later env changes do NOT flip an already-resolved gate', () => {
    // Env vars are process-wide; a re-resolve per request would let one
    // request see a different gate than the next. The first resolution wins.
    vi.stubEnv('GATE_PASSWORD', 'pw')
    vi.stubEnv('GATE_SECRET', 'sec')
    vi.stubEnv('NODE_ENV', 'development')
    const first = initGateEnv()
    vi.stubEnv('GATE_PASSWORD', 'other')
    const second = initGateEnv()
    expect(second).toBe(first)
    expect(second!.password).toBe('pw')
  })

  it('caches the gate-open result too', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const open = initGateEnv()
    expect(open).toBeNull()
    vi.stubEnv('GATE_PASSWORD', 'late')
    expect(initGateEnv()).toBeNull()
  })

  it('warns about the dev fallback ONCE per process, not per request', () => {
    vi.stubEnv('GATE_PASSWORD', 'pw')
    vi.stubEnv('NODE_ENV', 'development')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (let i = 0; i < 5; i++) resolveGateEnv(process.env)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('gate sessions', () => {
  it('accepts a freshly signed session and one still inside its TTL', () => {
    const cookie = signSession(NOW + SESSION_TTL_MS, KEY)
    expect(verifySession(cookie, NOW, KEY)).toBe(true)
    expect(verifySession(cookie, NOW + SESSION_TTL_MS - 1000, KEY)).toBe(true)
  })

  it('rejects an expired session', () => {
    const cookie = signSession(NOW + 1000, KEY)
    expect(verifySession(cookie, NOW + 1001, KEY)).toBe(false)
  })

  it('rejects tampered payloads, wrong keys, and garbage', () => {
    const cookie = signSession(NOW + SESSION_TTL_MS, KEY)
    const [payload, sig] = cookie.split('.')
    const farther = signSession(NOW + 10 * SESSION_TTL_MS, KEY).split('.')[0]
    expect(verifySession(`${farther}.${sig}`, NOW, KEY)).toBe(false) // payload swapped
    expect(verifySession(cookie, NOW, sessionKey('k', 'x'))).toBe(false) // wrong key
    expect(verifySession('not-a-token', NOW, KEY)).toBe(false)
    expect(verifySession(undefined, NOW, KEY)).toBe(false)
    expect(verifySession(`${payload}.${'0'.repeat(64)}`, NOW, KEY)).toBe(false)
  })
})

describe('gate password check', () => {
  it('accepts the right password and rejects everything else', () => {
    expect(verifyPassword(SECRET, SECRET)).toBe(true)
    expect(verifyPassword('wrong', SECRET)).toBe(false)
    expect(verifyPassword('', SECRET)).toBe(false)
  })
})

describe('gate throttle', () => {
  it('round-trips the counter through the signed cookie', () => {
    const cookie = signThrottle(2, NOW, SECRET)
    expect(verifyThrottle(cookie, SECRET)).toEqual({ count: 2, lastFailMs: NOW })
  })

  it('reads tampered or malformed cookies as fresh', () => {
    expect(verifyThrottle(undefined, SECRET)).toEqual({ count: 0, lastFailMs: 0 })
    expect(verifyThrottle('junk', SECRET)).toEqual({ count: 0, lastFailMs: 0 })
    const cookie = signThrottle(9, NOW, SECRET)
    const [payload, sig] = cookie.split('.')
    expect(verifyThrottle(`${'5' + payload.slice(1)}.${sig}`, SECRET)).toEqual({
      count: 0,
      lastFailMs: 0,
    }) // count swapped
    expect(verifyThrottle(cookie, 'other password')).toEqual({ count: 0, lastFailMs: 0 })
  })

  it('gives the first three failures no delay', () => {
    for (let count = 1; count <= THROTTLE_FREE_TRIES; count++) {
      expect(nextDelayMs({ count, lastFailMs: NOW }, NOW)).toBe(0)
    }
  })

  it('doubles the delay after the free tries and caps it', () => {
    expect(nextDelayMs({ count: THROTTLE_FREE_TRIES + 1, lastFailMs: NOW }, NOW)).toBe(
      THROTTLE_BASE_DELAY_MS,
    )
    expect(nextDelayMs({ count: THROTTLE_FREE_TRIES + 2, lastFailMs: NOW }, NOW)).toBe(
      THROTTLE_BASE_DELAY_MS * 2,
    )
    expect(nextDelayMs({ count: 100, lastFailMs: NOW }, NOW)).toBe(THROTTLE_MAX_DELAY_MS)
  })

  it('clears the ramp after a quiet period', () => {
    const state = { count: 10, lastFailMs: NOW }
    expect(nextDelayMs(state, NOW + THROTTLE_RESET_MS + 1)).toBe(0)
  })

  it('does not delay a first-ever failure', () => {
    expect(nextDelayMs({ count: 0, lastFailMs: 0 }, NOW)).toBe(0)
  })
})

describe('gate proxy bypass surface (static wiring lock)', () => {
  const proxy = readFileSync(join(process.cwd(), 'src/proxy.ts'), 'utf8')

  it('matches public paths EXACTLY — no prefix startsWith that a sibling route could ride', () => {
    // `startsWith('/icon')` once meant a hypothetical /icon-admin route would
    // have skipped the gate silently. The bypass set must stay a Set with an
    // exact `has()` check.
    expect(proxy).toMatch(/PUBLIC_PATHS = new Set\(/)
    expect(proxy).toMatch(/PUBLIC_PATHS\.has\(pathname\)/)
    // `.startsWith(` with the call dot: prose may mention startsWith, code may not.
    expect(proxy).not.toMatch(/\.startsWith\(/)
    expect(proxy).not.toMatch(/PUBLIC_PREFIXES/)
  })

  it('keeps the two login routes public and nothing else', () => {
    expect(proxy).toMatch(/'\/gate'/)
    expect(proxy).toMatch(/'\/api\/gate-login'/)
    expect(proxy).toMatch(/'\/_next\/webpack-hmr'/)
  })
})

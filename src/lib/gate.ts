/**
 * src/lib/gate.ts — password gate primitives (pure, Node-crypto only).
 *
 * The gate keeps strangers out of a publicly deployed instance. Three pieces:
 *
 * - `signSession` / `verifySession` — a compact `expiry.signature` token in an
 *   HttpOnly cookie. The HMAC key is DERIVED from two materials:
 *   `sessionKey(GATE_SECRET, password)` = HMAC(secret, password). Neither
 *   value alone can mint or verify a cookie, and a stolen cookie cannot be
 *   brute-forced for the password (the attacker lacks the secret) — while
 *   rotating the password still invalidates every live session at once.
 * - `verifyPassword` — constant-time comparison, so response timing does not
 *   leak how much of a guess was right.
 * - `nextDelayMs` — the cookie-based throttle ramp: 3 fast tries, then doubling
 *   pauses. The failure count lives in a second signed cookie
 *   (`signThrottle`/`verifyThrottle`) so a tampered cookie simply reads as
 *   "fresh" instead of crashing the request.
 *
 * Pure module: everything takes explicit inputs (now, secret) and returns
 * plain data so the unit tests need no mocking. `src/proxy.ts` wires it to
 * cookies and the request pipeline.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Session cookie name. Holds `<expiryMs>.<hex signature>`. */
export const SESSION_COOKIE = 'videoh_gate'
/** Failure-counter cookie name. Holds `<count>.<hex signature>`. */
export const THROTTLE_COOKIE = 'videoh_gate_tries'

/** How long a correct login stays valid. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours

/** Attempts allowed before the ramp starts delaying. */
export const THROTTLE_FREE_TRIES = 3

/**
 * The session-cookie HMAC key, derived from BOTH materials: the independent
 * `GATE_SECRET` (random, machine-generated) and the `GATE_PASSWORD` (human).
 * A cookie signed under this key proves the holder knew both — so a leaked
 * cookie cannot be used to crack the password offline, and the password alone
 * cannot mint cookies if the secret leaks in some other way.
 */
export function sessionKey(secret: string, password: string): string {
  return createHmac('sha256', secret).update(`gate-session:${password}`).digest('hex')
}

/** Base delay once the ramp engages; doubles per additional failure. */
export const THROTTLE_BASE_DELAY_MS = 15_000
/** Ceiling so a typo flood cannot pin the gate closed forever. */
export const THROTTLE_MAX_DELAY_MS = 15 * 60_000
/** Failures are forgotten after this long since the last one. */
export const THROTTLE_RESET_MS = 15 * 60_000

function hmac(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('hex')
}

/**
 * Sign `<expiryMs>` into a session cookie value. `signingKey` must be the
 * output of `sessionKey(GATE_SECRET, GATE_PASSWORD)` — never the raw password.
 */
export function signSession(expiresAtMs: number, signingKey: string): string {
  const payload = String(expiresAtMs)
  return `${payload}.${hmac(payload, signingKey)}`
}

/** Verify a session cookie. Returns true only if the signature matches AND the expiry is in the future. */
export function verifySession(
  cookie: string | undefined,
  nowMs: number,
  signingKey: string,
): boolean {
  if (!cookie) return false
  const dot = cookie.lastIndexOf('.')
  if (dot <= 0) return false
  const payload = cookie.slice(0, dot)
  const sig = cookie.slice(dot + 1)
  if (!/\d+$/.test(payload) || !/^[0-9a-f]{64}$/.test(sig)) return false
  const expected = hmac(payload, signingKey)
  const a = Buffer.from(sig, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false
  return Number(payload) > nowMs
}

/** Constant-time password check; both sides are hashed first so lengths cannot leak. */
export function verifyPassword(candidate: string, password: string): boolean {
  const a = createHmac('sha256', 'gate-pw').update(candidate).digest()
  const b = createHmac('sha256', 'gate-pw').update(password).digest()
  return timingSafeEqual(a, b)
}

/** Sign the failure counter with the password; returns the full cookie value. */
export function signThrottle(count: number, lastFailMs: number, secret: string): string {
  const payload = `${count}.${lastFailMs}`
  return `${payload}.${hmac(payload, secret)}`
}

export interface ThrottleState {
  count: number
  lastFailMs: number
}

/**
 * Parse the throttle cookie. Any tampering, truncation, or format drift reads
 * as "no failures recorded" — the ramp errs open because the password is the
 * real defence and the cookie must never break a legitimate login.
 */
export function verifyThrottle(cookie: string | undefined, secret: string): ThrottleState {
  if (!cookie) return { count: 0, lastFailMs: 0 }
  const cut = cookie.lastIndexOf('.')
  if (cut <= 0) return { count: 0, lastFailMs: 0 }
  const payload = cookie.slice(0, cut)
  const sig = cookie.slice(cut + 1)
  const m = /^(\d+)\.(\d+)$/.exec(payload)
  if (!m || !/^[0-9a-f]{64}$/.test(sig)) return { count: 0, lastFailMs: 0 }
  const expected = hmac(payload, secret)
  const a = Buffer.from(sig, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { count: 0, lastFailMs: 0 }
  return { count: Number(m[1]), lastFailMs: Number(m[2]) }
}

/**
 * Wait time before attempt `count + 1` (count = failures so far), 0 when the
 * counter is stale. 0,1,2 fails are free; fail 4 waits 15s, 5 waits 30s, …
 * capped at 15 minutes; a quiet 15 minutes clears the counter entirely.
 */
export function nextDelayMs(state: ThrottleState, nowMs: number): number {
  if (state.count === 0 || nowMs - state.lastFailMs > THROTTLE_RESET_MS) return 0
  const extra = Math.max(0, state.count - THROTTLE_FREE_TRIES)
  if (extra === 0) return 0
  return Math.min(THROTTLE_BASE_DELAY_MS * 2 ** (extra - 1), THROTTLE_MAX_DELAY_MS)
}

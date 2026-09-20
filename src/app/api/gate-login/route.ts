/**
 * POST /api/gate-login — checks the password and sets the session cookie.
 *
 * Separated from the /gate page so the page stays a server component with no
 * server actions; the form is a plain HTML form POST (no JS needed to log in).
 * On success it clears the throttle cookie, sets the session cookie, and
 * redirects to `/`. On failure it re-serves /gate with an error flag.
 *
 * All redirects use relative `Location` values: the browser stays on whatever
 * host it came in on. Absolute URLs built from nextUrl normalise the origin
 * (e.g. 127.0.0.1 → localhost behind the standalone server or a reverse
 * proxy), which strands the fresh cookie on the wrong host and re-fires the
 * gate right after a correct login.
 *
 * The throttle ramp lives here: each failed attempt bumps a signed counter
 * cookie, and when `nextDelayMs` says a delay is due, the request is refused
 * WITHOUT even comparing the password, until the delay elapses.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  THROTTLE_COOKIE,
  THROTTLE_RESET_MS,
  nextDelayMs,
  signSession,
  signThrottle,
  verifyPassword,
  verifyThrottle,
} from '@/lib/gate'
import { initGateEnv } from '@/lib/gate-env'

function gateRedirect(error: boolean): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { location: error ? '/gate?e=1' : '/gate' },
  })
}

export async function POST(request: NextRequest) {
  const gate = initGateEnv()
  if (!gate) return gateRedirect(false)

  const form = await request.formData()
  const password = String(form.get('password') ?? '')

  const now = Date.now()
  const state = verifyThrottle(request.cookies.get(THROTTLE_COOKIE)?.value, gate.signingKey)

  const delay = nextDelayMs(state, now)
  if (delay > 0 && now - state.lastFailMs < delay) {
    // Still inside the penalty window: refuse without evaluating the password.
    return new NextResponse(null, {
      status: 303,
      headers: {
        location: '/gate?e=1',
        'retry-after': String(Math.ceil((delay - (now - state.lastFailMs)) / 1000)),
      },
    })
  }

  if (!verifyPassword(password, gate.password)) {
    const count = state.count + 1
    const res = gateRedirect(true)
    res.cookies.set(THROTTLE_COOKIE, signThrottle(count, now, gate.signingKey), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: Math.ceil(THROTTLE_RESET_MS / 1000),
      path: '/',
    })
    return res
  }

  const res = new NextResponse(null, {
    status: 303,
    headers: { location: '/' },
  })
  res.cookies.set(SESSION_COOKIE, signSession(now + SESSION_TTL_MS, gate.signingKey), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.ceil(SESSION_TTL_MS / 1000),
    path: '/',
  })
  res.cookies.delete(THROTTLE_COOKIE)
  return res
}

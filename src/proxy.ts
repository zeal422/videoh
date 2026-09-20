/**
 * src/proxy.ts — the password gate (Next 16's renamed middleware convention).
 *
 * Every request funnels through here. A visitor with a valid session cookie
 * sails through; anyone else is redirected to /gate — the only route allowed
 * past the check, because it is what serves the password form. The app's
 * bundle, page, and assets are never sent to an unauthenticated client.
 *
 * Allowed through without a session: EXACTLY `/gate` and `/api/gate-login`
 * (the two routes that make the login work), plus Next's dev hot-reload
 * endpoint. Static assets need no entry here — the matcher below already
 * excludes `_next/static`, `_next/image`, `favicon.ico`, and `icon.svg` before
 * the proxy runs, and exact paths are the point: a `startsWith('/icon')`
 * prefix once meant a hypothetical `/icon-admin` route would have skipped the
 * gate silently. Everything else — including `/` and every chunk — requires
 * the cookie.
 *
 * When GATE_PASSWORD is unset the gate is open. That is deliberate: a
 * checkout/dev environment without the variable configured must not turn
 * into a mystery outage; the gate only exists where the operator set a
 * password.
 */

import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/lib/gate'
import { initGateEnv } from '@/lib/gate-env'

const PUBLIC_PATHS = new Set([
  '/gate',
  '/api/gate-login',
  // Next 16 dev server hot reload (Turbopack HMR); production never requests it.
  '/_next/webpack-hmr',
])

export function proxy(request: NextRequest) {
  const gate = initGateEnv()
  if (!gate) return NextResponse.next()

  const { pathname } = request.nextUrl
  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next()
  }

  const ok = verifySession(request.cookies.get(SESSION_COOKIE)?.value, Date.now(), gate.signingKey)

  if (ok) return NextResponse.next()

  const url = request.nextUrl.clone()
  url.pathname = '/gate'
  url.search = ''
  return NextResponse.redirect(url)
}

export const config = {
  matcher: [
    // Everything except Next's internals that never need the gate and are
    // requested before cookies exist (fonts live under /_next/static).
    '/((?!_next/static|_next/image|favicon.ico|icon.svg).*)',
  ],
}

import type { NextConfig } from 'next'

/**
 * Enforced on every response. `frame-ancestors` is the modern frame guard;
 * `X-Frame-Options: DENY` keeps older browsers covered, and the rest are the
 * low-risk static protections that need no per-route tuning.
 */
const SAFE_SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Content-Security-Policy',
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
]

/** The GoatCounter endpoint origin, when configured and parseable. */
function goatcounterOrigin(): string | undefined {
  const url = process.env.NEXT_PUBLIC_GOATCOUNTER_URL?.trim()
  if (!url) return undefined
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/**
 * The full policy ships Report-Only in production first. Enforcing it in the
 * same release would turn an unnoticed violation into a broken editor.
 */
function reportOnlyPolicy(): string {
  const connect = ["'self'", 'blob:']
  const origin = goatcounterOrigin()
  if (origin) connect.push(origin)
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "font-src 'self'",
    "worker-src 'self'",
    `connect-src ${connect.join(' ')}`,
    "frame-src 'none'",
    "manifest-src 'self'",
  ].join('; ')
}

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    const headers = [...SAFE_SECURITY_HEADERS]
    // Preview deployments are the only ones that must stay out of search.
    if (process.env.VERCEL_ENV === 'preview') {
      headers.push({ key: 'X-Robots-Tag', value: 'noindex, nofollow' })
    }
    // `next dev` and tests keep a clean console; the standalone artifact runs
    // with NODE_ENV=production, so the artifact battery exercises the policy.
    if (process.env.NODE_ENV === 'production') {
      headers.push({ key: 'Content-Security-Policy-Report-Only', value: reportOnlyPolicy() })
    }
    return [{ source: '/:path*', headers }]
  },
}

export default nextConfig

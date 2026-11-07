import type { NextConfig } from 'next'

/**
 * Always-on static protections. The CSP is added once in `headers()`: the full
 * policy in production and the narrow policy in development and test.
 */
const SAFE_SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
]

const NARROW_CONTENT_SECURITY_POLICY = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'"

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
 * The full resource policy. Production enforces it; development and test keep
 * the narrow policy so HMR and the dev overlay are not blocked.
 */
function fullContentSecurityPolicy(): string {
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
    "worker-src 'self' blob:",
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
    headers.push({
      key: 'Content-Security-Policy',
      value:
        process.env.NODE_ENV === 'production'
          ? fullContentSecurityPolicy()
          : NARROW_CONTENT_SECURITY_POLICY,
    })
    return [{ source: '/:path*', headers }]
  },
}

export default nextConfig

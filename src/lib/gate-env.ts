/**
 * src/lib/gate-env.ts — reads the gate's two environment materials.
 *
 * - `GATE_PASSWORD` — the human credential, used ONLY to authenticate logins.
 * - `GATE_SECRET`   — an independent random string (`openssl rand -base64 32`),
 *   mixed into the session-cookie HMAC key so a stolen cookie cannot be
 *   brute-forced for the password offline.
 *
 * Behaviour matrix:
 * - password unset            → gate is open (null); a checkout without the
 *   variable must not turn into a mystery outage.
 * - password set, secret set  → normal operation (production and dev alike).
 * - password set, secret UNSET:
 *     - production → refuse to boot. A production gate silently deriving its
 *       key from the password alone would reopen the offline-cracking hole
 *       this module exists to close; failing loudly beats failing quietly.
 *     - dev → sign with the password only, and say so once in the console.
 *       Local friction (every contributor forced to generate a secret before
 *       `bun run dev` works) buys nothing at 127.0.0.1.
 *
 * Server-only. `initGateEnv()` resolves ONCE at process init and both
 * request paths (`src/proxy.ts`, the login route) read the cached result —
 * so a production misconfiguration throws at boot, not on some user's first
 * request. `resolveGateEnv()` remains exported as the pure resolver the
 * tests (and the init call) use.
 */
import { sessionKey } from './gate'

export interface GateEnv {
  /** The human credential; authenticate logins with this only. */
  password: string
  /** The HMAC key material for session cookies: `sessionKey(secret, password)`. */
  signingKey: string
  /** True when the running env lacked GATE_SECRET (dev fallback, warned). */
  secretMissing: boolean
}

/** The dev-fallback warning must fire once per process, not per request. */
let warnedSecretMissing = false

export function resolveGateEnv(env: {
  GATE_PASSWORD?: string
  GATE_SECRET?: string
  NODE_ENV?: string
}): GateEnv | null {
  const password = env.GATE_PASSWORD
  if (!password) return null

  const secret = env.GATE_SECRET
  if (!secret) {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'GATE_SECRET is required in production: set it to a random value ' +
          '(openssl rand -base64 32) so session cookies cannot be used to ' +
          'brute-force GATE_PASSWORD offline.',
      )
    }
    if (!warnedSecretMissing) {
      warnedSecretMissing = true
      console.warn(
        '[gate] GATE_SECRET is not set; falling back to password-only session ' +
          'signing. Fine for local dev — set GATE_SECRET in any real deployment.',
      )
    }
    return { password, signingKey: sessionKey(password, password), secretMissing: true }
  }

  return { password, signingKey: sessionKey(secret, password), secretMissing: false }
}

let cached: GateEnv | null | undefined

/**
 * Resolve once per process; every request path reads this memoized result.
 * Throws at init in production when GATE_SECRET is missing. Takes no
 * arguments on purpose: the env is process-wide state, not a per-call choice.
 */
export function initGateEnv(): GateEnv | null {
  // `??=` would re-resolve forever when the cached value is null (gate open):
  // null is a *valid* resolution here, so only undefined means "not yet run".
  if (cached === undefined) cached = resolveGateEnv(process.env)
  return cached
}

/** Test hook: forget the memoized resolution (and the warn-once flag). */
export function resetGateEnvCache(): void {
  cached = undefined
  warnedSecretMissing = false
}

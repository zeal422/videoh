/**
 * Browser-bound analytics for GoatCounter.
 *
 * Delivery is a beacon: no third-party script runs in the app's origin, so
 * nothing external can read `localStorage` or the in-memory project. The
 * endpoint is optional: when NEXT_PUBLIC_GOATCOUNTER_URL is empty, every entry
 * point returns before building a URL or touching the first-export marker.
 *
 * The sender still prefers `window.goatcounter.count` when another page has
 * loaded the script (the partial and alternative deployments), but the
 * recommended deployment has no script and every event takes the beacon path.
 * There is no retry queue: with no script to become ready, a failed beacon
 * would only leave a timer that can never flush.
 */

export interface TrackEventOptions {
  noSession?: boolean
}

type GoatCounterOptions = { path: string; event?: boolean; no_session?: boolean }

interface GoatCounterApi {
  count?: (options: GoatCounterOptions) => void
}

export const FIRST_EXPORT_KEY = 'videoh:first-export'
export const ANALYTICS_OPT_OUT_KEY = 'skipgc'
export const ANALYTICS_OPT_OUT_EVENT = 'videoh:analytics-opt-out'

let firstExportGuard = false

function endpoint(): string {
  return process.env.NEXT_PUBLIC_GOATCOUNTER_URL?.trim() ?? ''
}

function siteApi(): GoatCounterApi | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { goatcounter?: GoatCounterApi }).goatcounter
}

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

/** True when this browser opted out through the footer control or its alias. */
export function isAnalyticsOptedOut(): boolean {
  try {
    return storage()?.getItem(ANALYTICS_OPT_OUT_KEY) === 't'
  } catch {
    return false
  }
}

/**
 * Writes the same origin-scoped `skipgc` flag GoatCounter's own toggle used.
 * Returns false when storage is unavailable, the write throws, or the value
 * cannot be read back. The caller decides whether to announce success.
 */
export function setAnalyticsOptedOut(disabled: boolean): boolean {
  const store = storage()
  if (!store) return false
  try {
    if (disabled) store.setItem(ANALYTICS_OPT_OUT_KEY, 't')
    else store.removeItem(ANALYTICS_OPT_OUT_KEY)
    const persisted = store.getItem(ANALYTICS_OPT_OUT_KEY)
    if (disabled ? persisted !== 't' : persisted !== null) return false
  } catch {
    return false
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(ANALYTICS_OPT_OUT_EVENT))
  }
  return true
}

function analyticsAllowed(): boolean {
  return endpoint() !== '' && !isAnalyticsOptedOut()
}

function hasFirstExportMarker(): boolean {
  try {
    return storage()?.getItem(FIRST_EXPORT_KEY) != null
  } catch {
    return false
  }
}

function writeFirstExportMarker(): void {
  try {
    storage()?.setItem(FIRST_EXPORT_KEY, '1')
  } catch {
    // Blocked storage is documented: the module guard still prevents a
    // duplicate while this page is alive, and a reload may retry.
  }
}

function clearFirstExportMarker(): void {
  try {
    storage()?.removeItem(FIRST_EXPORT_KEY)
  } catch {
    // Same boundary as the write path.
  }
}

function rejectFirstExport(): void {
  clearFirstExportMarker()
  firstExportGuard = false
}

function sendNow(name: string, event: boolean, noSession: boolean): boolean {
  const api = siteApi()
  if (!api || typeof api.count !== 'function') return false
  try {
    api.count({
      path: name,
      event,
      no_session: noSession,
    })
    return true
  } catch {
    return false
  }
}

function buildBeaconUrl(name: string, event: boolean, noSession: boolean): string {
  const target = endpoint()
  const params = new URLSearchParams({
    p: name,
    ...(event ? { e: 'true' } : {}),
    ...(noSession ? { no_session: 'true' } : {}),
    r: document.referrer,
    t: document.title,
    s: String(window.screen.width),
    b: String(botFlag()),
    q: window.location.search,
    rnd: randomId(),
  })
  return `${target}${target.includes('?') ? '&' : '?'}${params.toString()}`
}

function sendBeacon(name: string, event: boolean, noSession: boolean): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false
  try {
    return navigator.sendBeacon(buildBeaconUrl(name, event, noSession))
  } catch {
    return false
  }
}

/** Script API first (when present), then one beacon. A failure drops the event. */
function deliver(name: string, event: boolean, noSession: boolean): boolean {
  if (sendNow(name, event, noSession)) return true
  return sendBeacon(name, event, noSession)
}

/**
 * Sends one page view. The caller owns visit deduplication: a page view is a
 * navigation event, not something a re-render may repeat.
 */
export function trackPageView(pathname: string): void {
  if (!analyticsAllowed()) return
  deliver(pathname, false, false)
}

export function trackEvent(name: string, options: TrackEventOptions = {}): void {
  if (!analyticsAllowed()) return
  deliver(name, true, options.noSession ?? false)
}

export function trackClick(name: string): void {
  if (!analyticsAllowed()) return
  deliver(name, true, false)
}

function botFlag(): number {
  const win = window as Window & {
    callPhantom?: unknown
    _phantom?: unknown
    phantom?: unknown
    __nightmare?: unknown
  }
  if (win.callPhantom || win._phantom || win.phantom) return 150
  if (win.__nightmare) return 151
  const doc = document as Document & {
    __selenium_unwrapped?: unknown
    __webdriver_evaluate?: unknown
    __driver_evaluate?: unknown
  }
  if (doc.__selenium_unwrapped || doc.__webdriver_evaluate || doc.__driver_evaluate) return 152
  if (navigator.webdriver) return 153
  return 0
}

function randomId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 5; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

export function trackExportSuccess(): void {
  if (!analyticsAllowed()) return
  if (!hasFirstExportMarker() && !firstExportGuard) {
    firstExportGuard = true
    writeFirstExportMarker()
    // A failed beacon clears the marker: with no script there is no retry
    // queue, so leaving it set would claim an event that never left the page.
    if (!deliver('first-export', true, true)) rejectFirstExport()
  }
  deliver('export-success', true, true)
}

/** Clear module state between tests. Production code never calls this. */
export function resetAnalyticsForTests(): void {
  firstExportGuard = false
}

/**
 * Browser-bound analytics for GoatCounter.
 *
 * Page views come from the external script. Custom events and navigation
 * clicks come from this module. The endpoint is optional: when
 * NEXT_PUBLIC_GOATCOUNTER_URL is empty, every entry point returns before
 * queueing, starting timers, or setting the first-export marker.
 *
 * Delivery is best effort. A queued event is removed when count() returns
 * without throwing. GoatCounter exposes no acknowledgement, so that means
 * handed off, not confirmed delivered. Each queued event expires
 * RETRY_WINDOW_MS after it entered the queue; a newer event does not inherit
 * an older event's deadline.
 */

export interface TrackEventOptions {
  noSession?: boolean
}

type GoatCounterOptions = { path: string; event?: boolean; no_session?: boolean }

interface GoatCounterApi {
  count?: (options: GoatCounterOptions) => void
  url?: (options: GoatCounterOptions) => string
}

interface EventPayload {
  name: string
  noSession: boolean
  firstExport: boolean
}

interface QueuedEvent extends EventPayload {
  queuedAt: number
}

export const FIRST_EXPORT_KEY = 'videoh:first-export'
const READY_EVENT = 'videoh:analytics-ready'
const RETRY_INTERVAL_MS = 250
const RETRY_WINDOW_MS = 5000
const MAX_QUEUE = 20

let queue: QueuedEvent[] = []
let timer: ReturnType<typeof setInterval> | null = null
let firstExportGuard = false
let readyListener: (() => void) | null = null

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

function sendNow(event: EventPayload): boolean {
  const api = siteApi()
  if (!api || typeof api.count !== 'function') return false
  try {
    api.count({
      path: event.name,
      event: true,
      no_session: event.noSession,
    })
    return true
  } catch {
    return false
  }
}

function ensureReadyListener(): void {
  if (readyListener || typeof window === 'undefined') return
  readyListener = () => flushQueue()
  window.addEventListener(READY_EVENT, readyListener)
}

function ensureTimer(): void {
  if (timer !== null || typeof window === 'undefined') return
  timer = setInterval(flushQueue, RETRY_INTERVAL_MS)
}

function stopTimer(): void {
  if (timer === null) return
  clearInterval(timer)
  timer = null
}

function enqueue(event: EventPayload): boolean {
  ensureReadyListener()
  if (event.firstExport && queue.some((item) => item.firstExport)) return false
  if (queue.length >= MAX_QUEUE) {
    const generic = queue.findIndex((item) => !item.firstExport)
    if (generic < 0) return false
    queue.splice(generic, 1)
  }
  queue.push({ ...event, queuedAt: Date.now() })
  ensureTimer()
  return true
}

function flushQueue(): void {
  if (typeof window === 'undefined' || queue.length === 0) {
    stopTimer()
    return
  }
  const now = Date.now()
  let droppedFirstExport = false
  for (let i = 0; i < queue.length;) {
    if (now - queue[i].queuedAt < RETRY_WINDOW_MS) {
      i += 1
      continue
    }
    const dropped = queue[i]
    queue.splice(i, 1)
    if (dropped.firstExport) droppedFirstExport = true
  }
  if (droppedFirstExport) rejectFirstExport()
  if (queue.length === 0) {
    stopTimer()
    return
  }
  const api = siteApi()
  if (!api || typeof api.count !== 'function') return
  for (let i = 0; i < queue.length;) {
    const event = queue[i]
    if (sendNow(event)) {
      queue.splice(i, 1)
      continue
    }
    if (event.firstExport) {
      queue.splice(i, 1)
      rejectFirstExport()
      continue
    }
    i += 1
  }
  if (queue.length === 0) stopTimer()
}

export function trackEvent(name: string, options: TrackEventOptions = {}): void {
  if (!endpoint()) return
  const event: EventPayload = {
    name,
    noSession: options.noSession ?? false,
    firstExport: false,
  }
  if (sendNow(event)) return
  enqueue(event)
}

export function trackClick(name: string): void {
  const target = endpoint()
  if (!target) return
  const api = siteApi()
  if (api && typeof api.count === 'function') {
    try {
      api.count({ path: name, event: true })
      return
    } catch {
      // Fall through to the beacon so navigation still carries the click.
    }
  }
  const beaconUrl = buildBeaconUrl(api, name, target)
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      if (navigator.sendBeacon(beaconUrl)) return
    } catch {
      // Fall through to the queue.
    }
  }
  enqueue({ name, noSession: false, firstExport: false })
}

function buildBeaconUrl(api: GoatCounterApi | undefined, name: string, target: string): string {
  if (api && typeof api.url === 'function') {
    try {
      const url = api.url({ path: name, event: true })
      if (url) return url
    } catch {
      // Fall back to the documented field mapping.
    }
  }
  const params = new URLSearchParams({
    p: name,
    e: 'true',
    r: document.referrer,
    t: document.title,
    s: String(window.screen.width),
    b: String(botFlag()),
    q: window.location.search,
    rnd: randomId(),
  })
  return `${target}${target.includes('?') ? '&' : '?'}${params.toString()}`
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
  if (!endpoint()) return
  if (!hasFirstExportMarker() && !firstExportGuard) {
    firstExportGuard = true
    writeFirstExportMarker()
    const event: EventPayload = { name: 'first-export', noSession: true, firstExport: true }
    if (!sendNow(event)) {
      if (siteApi() && typeof siteApi()?.count === 'function') {
        rejectFirstExport()
      } else if (!enqueue(event)) {
        rejectFirstExport()
      }
    }
  }
  trackEvent('export-success', { noSession: true })
}

/** Clear module state between tests. Production code never calls this. */
export function resetAnalyticsForTests(): void {
  stopTimer()
  queue = []
  firstExportGuard = false
  if (readyListener && typeof window !== 'undefined') {
    window.removeEventListener(READY_EVENT, readyListener)
  }
  readyListener = null
}

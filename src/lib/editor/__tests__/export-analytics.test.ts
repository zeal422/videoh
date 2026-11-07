// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ANALYTICS_OPT_OUT_KEY,
  FIRST_EXPORT_KEY,
  resetAnalyticsForTests,
  trackClick,
  trackEvent,
  trackExportSuccess,
  trackPageView,
} from '@/lib/analytics'

const ENDPOINT = 'https://videoh.goatcounter.com/count'

type CountOptions = { path: string; event?: boolean; no_session?: boolean }
type GoatCounter = {
  count?: (options: CountOptions) => void
}

function installGoatCounter(api: GoatCounter) {
  ;(window as Window & { goatcounter?: GoatCounter }).goatcounter = api
}

function installBeacon(result = true) {
  const beacon = vi.fn((_url: string) => result)
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon })
  return beacon
}

function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('NEXT_PUBLIC_GOATCOUNTER_URL', ENDPOINT)
  window.localStorage.clear()
  document.title = ''
  delete (window as Window & { goatcounter?: GoatCounter }).goatcounter
  Reflect.deleteProperty(navigator, 'sendBeacon')
  Object.defineProperty(navigator, 'webdriver', { configurable: true, value: false })
  Object.defineProperty(window.screen, 'width', { configurable: true, value: 1440 })
})

afterEach(() => {
  resetAnalyticsForTests()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  window.localStorage.clear()
  delete (window as Window & { goatcounter?: GoatCounter }).goatcounter
  Reflect.deleteProperty(navigator, 'sendBeacon')
})

describe('analytics disabled', () => {
  it('returns before beaconing, timing, or setting the first-export marker', () => {
    vi.stubEnv('NEXT_PUBLIC_GOATCOUNTER_URL', '')
    const beacon = installBeacon()
    trackPageView('/')
    trackEvent('open-editor')
    trackClick('open-editor')
    trackExportSuccess()
    expect(beacon).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(window.localStorage.getItem(FIRST_EXPORT_KEY)).toBeNull()
  })

  it('honors skipgc before every send and before the marker', () => {
    window.localStorage.setItem(ANALYTICS_OPT_OUT_KEY, 't')
    const beacon = installBeacon()
    trackPageView('/editor')
    trackEvent('open-editor')
    trackClick('open-editor')
    trackExportSuccess()
    expect(beacon).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(FIRST_EXPORT_KEY)).toBeNull()
  })
})

describe('page views', () => {
  it('sends the pathname without the event flag', () => {
    const beacon = installBeacon()
    trackPageView('/about')
    expect(beacon).toHaveBeenCalledTimes(1)
    const url = new URL(beacon.mock.calls[0]![0])
    expect(`${url.origin}${url.pathname}`).toBe(ENDPOINT)
    expect(url.searchParams.get('p')).toBe('/about')
    expect(url.searchParams.has('e')).toBe(false)
    expect(url.searchParams.get('b')).toBe('0')
    expect(url.searchParams.get('s')).toBe('1440')
    expect(url.searchParams.has('r')).toBe(true)
    expect(url.searchParams.has('q')).toBe(true)
    expect(url.searchParams.get('rnd')).toMatch(/^[a-z0-9]{5}$/)
  })
})

describe('custom events', () => {
  it('sends event: true and adds no_session only when asked', () => {
    const beacon = installBeacon()
    trackEvent('view-source')
    trackEvent('export-success', { noSession: true })
    expect(beacon).toHaveBeenCalledTimes(2)
    const first = new URL(beacon.mock.calls[0]![0])
    const second = new URL(beacon.mock.calls[1]![0])
    expect(first.searchParams.get('p')).toBe('view-source')
    expect(first.searchParams.get('e')).toBe('true')
    expect(first.searchParams.has('no_session')).toBe(false)
    expect(second.searchParams.get('p')).toBe('export-success')
    expect(second.searchParams.get('no_session')).toBe('true')
  })

  it('uses the script API first and falls back to the beacon when it throws', () => {
    const beacon = installBeacon()
    const count = vi.fn()
    installGoatCounter({ count })
    trackEvent('view-source')
    expect(count).toHaveBeenCalledWith({
      path: 'view-source',
      event: true,
      no_session: false,
    })
    expect(beacon).not.toHaveBeenCalled()

    count.mockImplementation(() => {
      throw new Error('rejected')
    })
    trackEvent('open-editor')
    expect(beacon).toHaveBeenCalledTimes(1)
    expect(new URL(beacon.mock.calls[0]![0]).searchParams.get('p')).toBe('open-editor')
  })

  it('drops the event when there is no script and the beacon fails, with no timer', () => {
    installBeacon(false)
    trackEvent('open-editor')
    expect(vi.getTimerCount()).toBe(0)
    expect(window.localStorage.getItem(FIRST_EXPORT_KEY)).toBeNull()
  })
})

describe('export conversion', () => {
  it('sends first-export once and export-success every time, without a script', () => {
    const beacon = installBeacon()
    trackExportSuccess()
    trackExportSuccess()
    trackExportSuccess()
    const paths = beacon.mock.calls.map(([url]) => new URL(url).searchParams.get('p'))
    expect(paths.filter((p) => p === 'first-export')).toHaveLength(1)
    expect(paths.filter((p) => p === 'export-success')).toHaveLength(3)
    for (const [url] of beacon.mock.calls) {
      expect(new URL(url).searchParams.get('no_session')).toBe('true')
    }
    expect(window.localStorage.getItem(FIRST_EXPORT_KEY)).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not fire first-export again while the marker persists', () => {
    const beacon = installBeacon()
    window.localStorage.setItem(FIRST_EXPORT_KEY, '1')
    trackExportSuccess()
    const paths = beacon.mock.calls.map(([url]) => new URL(url).searchParams.get('p'))
    expect(paths).toEqual(['export-success'])
  })

  it('clears the marker and guard when the first-export beacon fails', () => {
    let accepted = false
    const beacon = vi.fn((url: string) => {
      if (new URL(url).searchParams.get('p') === 'first-export') return accepted
      return true
    })
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon })
    trackExportSuccess()
    expect(window.localStorage.getItem(FIRST_EXPORT_KEY)).toBeNull()
    accepted = true
    trackExportSuccess()
    const paths = beacon.mock.calls.map(([url]) => new URL(url).searchParams.get('p'))
    expect(paths.filter((p) => p === 'first-export')).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('click transport', () => {
  it('sends one click beacon without waiting for a script', () => {
    const beacon = installBeacon()
    trackClick('open-editor')
    expect(beacon).toHaveBeenCalledTimes(1)
    const url = new URL(beacon.mock.calls[0]![0])
    expect(url.searchParams.get('p')).toBe('open-editor')
    expect(url.searchParams.get('e')).toBe('true')
  })

  it('never queues and never starts a timer when the beacon is unavailable', () => {
    trackClick('open-editor')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('export dialog call site', () => {
  it('calls trackExportSuccess once on the success path, before the catch', () => {
    const source = readSource('src/components/editor/ExportDialog.tsx')
    expect(source).toContain("import { trackExportSuccess } from '@/lib/analytics'")
    expect((source.match(/trackExportSuccess\(\)/g) ?? []).length).toBe(1)
    const call = source.indexOf('trackExportSuccess()')
    const failure = source.indexOf('} catch (error)', call)
    expect(call).toBeGreaterThan(-1)
    expect(failure).toBeGreaterThan(call)
  })
})

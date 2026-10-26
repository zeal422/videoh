// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { resetAnalyticsForTests, trackClick, trackEvent, trackExportSuccess } from '@/lib/analytics'

const ENDPOINT = 'https://videoh.goatcounter.com/count'
const FIRST_EXPORT_KEY = 'videoh:first-export'
const READY_EVENT = 'videoh:analytics-ready'

type CountOptions = { path: string; event: boolean; no_session?: boolean }
type GoatCounter = {
  count?: (options: CountOptions) => void
  url?: (options: CountOptions) => string
}

function installGoatCounter(api: GoatCounter) {
  ;(window as Window & { goatcounter?: GoatCounter }).goatcounter = api
}

function installBeacon(result = true) {
  const beacon = vi.fn((_url: string) => result)
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon })
  return beacon
}

function flushReady() {
  window.dispatchEvent(new Event(READY_EVENT))
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
  it('returns before queueing, retrying, or setting the first-export marker', () => {
    vi.stubEnv('NEXT_PUBLIC_GOATCOUNTER_URL', '')
    trackEvent('open-editor')
    trackClick('open-editor')
    trackExportSuccess()
    expect(vi.getTimerCount()).toBe(0)
    expect(window.localStorage.getItem(FIRST_EXPORT_KEY)).toBeNull()
  })
})

describe('custom events', () => {
  it('sends event: true with no_session false by default and true when asked', () => {
    const count = vi.fn()
    installGoatCounter({ count })
    trackEvent('view-source')
    trackEvent('export-success', { noSession: true })
    expect(count).toHaveBeenNthCalledWith(1, {
      path: 'view-source',
      event: true,
      no_session: false,
    })
    expect(count).toHaveBeenNthCalledWith(2, {
      path: 'export-success',
      event: true,
      no_session: true,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('queues while the script is missing and flushes on the ready event', () => {
    trackEvent('open-editor')
    expect(vi.getTimerCount()).toBe(1)
    const count = vi.fn()
    installGoatCounter({ count })
    flushReady()
    expect(count).toHaveBeenCalledWith({
      path: 'open-editor',
      event: true,
      no_session: false,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops a queued event after the bounded retry window', () => {
    trackEvent('open-editor')
    vi.advanceTimersByTime(6000)
    const count = vi.fn()
    installGoatCounter({ count })
    flushReady()
    expect(count).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires an older event without dropping a newer one', () => {
    trackEvent('open-editor')
    vi.advanceTimersByTime(4900)
    trackEvent('view-source')
    vi.advanceTimersByTime(100)
    expect(vi.getTimerCount()).toBe(1)
    const count = vi.fn()
    installGoatCounter({ count })
    flushReady()
    expect(count).toHaveBeenCalledTimes(1)
    expect(count).toHaveBeenCalledWith({
      path: 'view-source',
      event: true,
      no_session: false,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry after count() returns without throwing', () => {
    const count = vi.fn(() => undefined)
    installGoatCounter({ count })
    trackEvent('open-editor')
    expect(count).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(6000)
    expect(count).toHaveBeenCalledTimes(1)
  })
})

describe('export conversion', () => {
  it('sends first-export once and export-success every time', () => {
    const count = vi.fn()
    installGoatCounter({ count })
    trackExportSuccess()
    trackExportSuccess()
    trackExportSuccess()
    const first = count.mock.calls.filter(([options]) => options.path === 'first-export')
    const all = count.mock.calls.filter(([options]) => options.path === 'export-success')
    expect(first).toHaveLength(1)
    expect(all).toHaveLength(3)
    for (const [options] of [...first, ...all]) {
      expect(options).toMatchObject({ event: true, no_session: true })
    }
    expect(window.localStorage.getItem(FIRST_EXPORT_KEY)).not.toBeNull()
  })

  it('does not fire first-export again while the marker persists', () => {
    const count = vi.fn()
    installGoatCounter({ count })
    window.localStorage.setItem(FIRST_EXPORT_KEY, '1')
    trackExportSuccess()
    expect(count.mock.calls.some(([options]) => options.path === 'first-export')).toBe(false)
    expect(count.mock.calls.some(([options]) => options.path === 'export-success')).toBe(true)
  })

  it('clears the marker and guard when a first-export send is rejected', () => {
    const count = vi.fn((options: CountOptions) => {
      if (options.path === 'first-export') throw new Error('rejected')
    })
    installGoatCounter({ count })
    trackExportSuccess()
    expect(window.localStorage.getItem(FIRST_EXPORT_KEY)).toBeNull()
    count.mockImplementation(() => undefined)
    trackExportSuccess()
    expect(count.mock.calls.filter(([options]) => options.path === 'first-export')).toHaveLength(2)
  })

  it('clears an expired queued first-export so a later export can retry', () => {
    trackExportSuccess()
    expect(window.localStorage.getItem(FIRST_EXPORT_KEY)).not.toBeNull()
    vi.advanceTimersByTime(6000)
    expect(window.localStorage.getItem(FIRST_EXPORT_KEY)).toBeNull()
    const count = vi.fn()
    installGoatCounter({ count })
    trackExportSuccess()
    expect(count).toHaveBeenCalledWith({
      path: 'first-export',
      event: true,
      no_session: true,
    })
  })

  it('keeps a newer first-export while an older event expires', () => {
    trackEvent('open-editor')
    vi.advanceTimersByTime(4900)
    trackExportSuccess()
    vi.advanceTimersByTime(100)
    expect(window.localStorage.getItem(FIRST_EXPORT_KEY)).not.toBeNull()
    const count = vi.fn()
    installGoatCounter({ count })
    flushReady()
    const paths = count.mock.calls.map(([options]) => options.path)
    expect(paths).toEqual(['first-export', 'export-success'])
    expect(paths).not.toContain('open-editor')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears an older first-export while a newer event survives', () => {
    trackExportSuccess()
    vi.advanceTimersByTime(4900)
    trackEvent('open-editor')
    vi.advanceTimersByTime(100)
    expect(window.localStorage.getItem(FIRST_EXPORT_KEY)).toBeNull()
    const count = vi.fn()
    installGoatCounter({ count })
    flushReady()
    expect(count).toHaveBeenCalledTimes(1)
    expect(count).toHaveBeenCalledWith({
      path: 'open-editor',
      event: true,
      no_session: false,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows the same-session retry when storage is blocked', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    trackExportSuccess()
    vi.advanceTimersByTime(6000)
    setItem.mockRestore()
    const count = vi.fn()
    installGoatCounter({ count })
    trackExportSuccess()
    expect(count).toHaveBeenCalledWith({
      path: 'first-export',
      event: true,
      no_session: true,
    })
  })

  it('reserves a slot for first-export when the queue overflows', () => {
    trackExportSuccess()
    for (let i = 0; i < 30; i++) trackEvent(`generic-${i}`)
    const count = vi.fn()
    installGoatCounter({ count })
    flushReady()
    const paths = count.mock.calls.map(([options]) => options.path)
    expect(paths).toContain('first-export')
    expect(paths).toContain('generic-29')
    expect(paths).not.toContain('generic-0')
  })
})

describe('click transport', () => {
  it('uses sendBeacon with the official fields when the script is not ready', () => {
    const beacon = installBeacon()
    Object.defineProperty(navigator, 'webdriver', { configurable: true, value: true })
    document.title = 'videoh test'
    trackClick('open-editor')
    expect(beacon).toHaveBeenCalledTimes(1)
    const url = new URL(beacon.mock.calls[0]![0])
    expect(`${url.origin}${url.pathname}`).toBe(ENDPOINT)
    expect(url.searchParams.get('p')).toBe('open-editor')
    expect(url.searchParams.get('e')).toBe('true')
    expect(url.searchParams.get('b')).toBe('153')
    expect(url.searchParams.get('t')).toBe('videoh test')
    expect(url.searchParams.get('s')).toBe('1440')
    expect(url.searchParams.has('r')).toBe(true)
    expect(url.searchParams.has('q')).toBe(true)
    expect(url.searchParams.get('rnd')).toMatch(/^[a-z0-9]{5}$/)
  })

  it('uses the GoatCounter URL builder when it is available and count is not', () => {
    const built = `${ENDPOINT}?p=open-editor&e=true`
    const url = vi.fn(() => built)
    installGoatCounter({ url })
    const beacon = installBeacon()
    trackClick('open-editor')
    expect(url).toHaveBeenCalledWith({ path: 'open-editor', event: true })
    expect(beacon).toHaveBeenCalledWith(built)
  })

  it('falls back to the queue when sendBeacon is unavailable or returns false', () => {
    const beacon = installBeacon(false)
    trackClick('open-editor')
    expect(beacon).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
    const count = vi.fn()
    installGoatCounter({ count })
    flushReady()
    expect(count).toHaveBeenCalledWith({
      path: 'open-editor',
      event: true,
      no_session: false,
    })
  })

  it('does not duplicate a click on repeated ready events', () => {
    installBeacon(false)
    trackClick('open-editor')
    const count = vi.fn()
    installGoatCounter({ count })
    flushReady()
    flushReady()
    expect(count).toHaveBeenCalledTimes(1)
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

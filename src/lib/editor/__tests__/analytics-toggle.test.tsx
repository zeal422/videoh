// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ANALYTICS_OPT_OUT_KEY, trackPageView } from '@/lib/analytics'
import { AnalyticsToggle } from '@/components/site/AnalyticsToggle'
import { PageViewBeacon } from '@/components/site/PageViewBeacon'
import { SiteFooter } from '@/components/site/SiteFooter'

vi.mock('next/navigation', () => ({ usePathname: () => '/' }))

const ENDPOINT = 'https://videoh.goatcounter.com/count'

function installBeacon() {
  const beacon = vi.fn(() => true)
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon })
  return beacon
}

function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_GOATCOUNTER_URL', ENDPOINT)
  window.localStorage.clear()
  window.history.pushState({}, '', '/privacy')
  Reflect.deleteProperty(navigator, 'sendBeacon')
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  window.localStorage.clear()
  Reflect.deleteProperty(navigator, 'sendBeacon')
})

describe('analytics toggle', () => {
  it('flips skipgc once and stops page views until it is turned back on', () => {
    const beacon = installBeacon()
    render(<AnalyticsToggle />)
    const button = screen.getByRole('button', { name: /Analytics:/ })
    expect(button).toHaveTextContent('on')

    fireEvent.click(button)
    expect(window.localStorage.getItem(ANALYTICS_OPT_OUT_KEY)).toBe('t')
    expect(button).toHaveTextContent('off')
    trackPageView('/')
    expect(beacon).not.toHaveBeenCalled()

    fireEvent.click(button)
    expect(window.localStorage.getItem(ANALYTICS_OPT_OUT_KEY)).toBeNull()
    expect(button).toHaveTextContent('on')
    trackPageView('/')
    expect(beacon).toHaveBeenCalledTimes(1)
  })

  it('announces a persistence failure instead of claiming the opt-out saved', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    render(<AnalyticsToggle />)
    const button = screen.getByRole('button', { name: /Analytics:/ })
    fireEvent.click(button)
    expect(window.localStorage.getItem(ANALYTICS_OPT_OUT_KEY)).toBeNull()
    expect(button).toHaveTextContent('on')
    expect(screen.getByRole('status')).toHaveTextContent(
      'Analytics preference could not be saved in this browser.',
    )
    setItem.mockRestore()
  })

  it('applies the initial #toggle-goatcounter hash once under Strict Mode', () => {
    window.history.pushState({}, '', '/privacy#toggle-goatcounter')
    render(
      <StrictMode>
        <PageViewBeacon />
      </StrictMode>,
    )
    expect(window.localStorage.getItem(ANALYTICS_OPT_OUT_KEY)).toBe('t')
  })

  it('applies a later client-side hash change once', () => {
    render(<PageViewBeacon />)
    expect(window.localStorage.getItem(ANALYTICS_OPT_OUT_KEY)).toBeNull()

    act(() => {
      window.location.hash = '#toggle-goatcounter'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(window.localStorage.getItem(ANALYTICS_OPT_OUT_KEY)).toBe('t')
  })

  it('opts out before sending the page view for a hash visit', () => {
    const beacon = installBeacon()
    window.history.pushState({}, '', '/privacy#toggle-goatcounter')
    render(
      <StrictMode>
        <PageViewBeacon />
      </StrictMode>,
    )
    expect(window.localStorage.getItem(ANALYTICS_OPT_OUT_KEY)).toBe('t')
    expect(beacon).not.toHaveBeenCalled()
  })

  it('applies the alias again after the hash leaves and returns', () => {
    window.history.pushState({}, '', '/privacy#toggle-goatcounter')
    render(<PageViewBeacon />)
    expect(window.localStorage.getItem(ANALYTICS_OPT_OUT_KEY)).toBe('t')

    act(() => {
      window.location.hash = '#other'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    act(() => {
      window.location.hash = '#toggle-goatcounter'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(window.localStorage.getItem(ANALYTICS_OPT_OUT_KEY)).toBeNull()
  })

  it('does not flip twice when the page renders a second control', () => {
    window.history.pushState({}, '', '/privacy#toggle-goatcounter')
    render(
      <StrictMode>
        <PageViewBeacon />
        <AnalyticsToggle />
        <AnalyticsToggle />
      </StrictMode>,
    )
    expect(window.localStorage.getItem(ANALYTICS_OPT_OUT_KEY)).toBe('t')
  })

  it('renders in the site footer', () => {
    render(<SiteFooter />)
    expect(screen.getByRole('button', { name: /Analytics:/ })).toBeInTheDocument()
  })

  it('reaches the control from the editor Help menu', () => {
    const menus = readSource('src/lib/editor/menus.ts')
    expect(menus).toContain("id: 'help.analytics'")
    expect(menus).toContain("action: 'help.analytics'")
    const bar = readSource('src/components/editor/MenuBar.tsx')
    expect(bar).toContain("case 'help.analytics'")
    expect(bar).toContain("'/privacy#analytics-settings'")
    const privacy = readSource('src/app/(site)/privacy/page.tsx')
    expect(privacy).toContain('id="analytics-settings"')
    expect(privacy).toContain('<AnalyticsToggle />')
  })
})

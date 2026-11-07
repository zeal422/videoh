// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'

const nav = vi.hoisted(() => ({ pathname: '/' }))
const analytics = vi.hoisted(() => ({
  trackPageView: vi.fn(),
  isAnalyticsOptedOut: vi.fn(() => false),
  setAnalyticsOptedOut: vi.fn(),
}))

vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }))
vi.mock('@/lib/analytics', () => analytics)
vi.mock('@/components/editor/EditorShell', () => ({ default: () => null }))

import { PageViewBeacon } from '@/components/site/PageViewBeacon'
import { EditorBoot } from '@/components/editor/EditorBoot'

/**
 * Visit-scoped page views: one per pathname per component instance. Strict
 * Mode's double effect must not duplicate a view, but a client-side pathname
 * change or a remount after leaving the editor must send a new one.
 */

beforeEach(() => {
  nav.pathname = '/'
  analytics.trackPageView.mockReset()
  window.history.pushState({}, '', '/')
})

afterEach(() => {
  cleanup()
  vi.clearAllTimers()
})

describe('public page views', () => {
  it('sends one view on mount under Strict Mode', () => {
    render(
      <StrictMode>
        <PageViewBeacon />
      </StrictMode>,
    )
    expect(analytics.trackPageView).toHaveBeenCalledTimes(1)
    expect(analytics.trackPageView).toHaveBeenCalledWith('/')
  })

  it('sends a new view when the pathname changes', () => {
    const { rerender } = render(<PageViewBeacon />)
    nav.pathname = '/about'
    rerender(<PageViewBeacon />)
    expect(analytics.trackPageView.mock.calls.map(([path]) => path)).toEqual(['/', '/about'])
  })

  it('does not resend on a same-pathname re-render', () => {
    const { rerender } = render(<PageViewBeacon />)
    rerender(<PageViewBeacon />)
    expect(analytics.trackPageView).toHaveBeenCalledTimes(1)
  })

  it('sends again after a remount, as a return visit does', () => {
    const first = render(<PageViewBeacon />)
    first.unmount()
    render(<PageViewBeacon />)
    expect(analytics.trackPageView).toHaveBeenCalledTimes(2)
  })
})

describe('editor page view', () => {
  it('sends one editor view per mount under Strict Mode', () => {
    window.history.pushState({}, '', '/editor')
    const { unmount } = render(
      <StrictMode>
        <EditorBoot />
      </StrictMode>,
    )
    expect(analytics.trackPageView).toHaveBeenCalledTimes(1)
    expect(analytics.trackPageView).toHaveBeenCalledWith('/editor')
    unmount()
  })

  it('sends again after leaving and returning', () => {
    window.history.pushState({}, '', '/editor')
    const first = render(<EditorBoot />)
    first.unmount()
    render(<EditorBoot />)
    expect(analytics.trackPageView).toHaveBeenCalledTimes(2)
  })
})

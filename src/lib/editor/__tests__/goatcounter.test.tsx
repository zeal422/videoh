// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const scriptState = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}))

vi.mock('next/script', () => ({
  default: (props: Record<string, unknown>) => {
    scriptState.props = props
    return <script data-testid="goatcounter-script" />
  },
}))

import { GoatCounter } from '@/components/site/GoatCounter'

/**
 * GoatCounter locks: the optional script renders only when a URL is supplied,
 * loads after the page is interactive, and announces readiness from both
 * callbacks Next may use. The analytics helper listens for that event.
 */

afterEach(() => {
  cleanup()
  scriptState.props = null
  vi.restoreAllMocks()
})

describe('GoatCounter script', () => {
  it('renders the external script with the site endpoint and afterInteractive strategy', () => {
    render(<GoatCounter url="https://videoh.goatcounter.com/count" />)
    expect(screen.getByTestId('goatcounter-script')).not.toBeNull()
    expect(scriptState.props).toMatchObject({
      src: 'https://gc.zgo.at/count.js',
      'data-goatcounter': 'https://videoh.goatcounter.com/count',
      strategy: 'afterInteractive',
    })
  })

  it('renders nothing when the URL is empty', () => {
    render(<GoatCounter url="" />)
    expect(screen.queryByTestId('goatcounter-script')).toBeNull()
    expect(scriptState.props).toBeNull()
  })

  it('announces readiness from onLoad and onReady', () => {
    const ready = vi.fn()
    window.addEventListener('videoh:analytics-ready', ready)
    render(<GoatCounter url="https://videoh.goatcounter.com/count" />)

    act(() => {
      ;(scriptState.props?.onLoad as (() => void) | undefined)?.()
    })
    expect(ready).toHaveBeenCalledTimes(1)

    act(() => {
      ;(scriptState.props?.onReady as (() => void) | undefined)?.()
    })
    expect(ready).toHaveBeenCalledTimes(2)
    window.removeEventListener('videoh:analytics-ready', ready)
  })
})

'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ANALYTICS_OPT_OUT_EVENT, isAnalyticsOptedOut, setAnalyticsOptedOut } from '@/lib/analytics'

/**
 * Visible analytics opt-out. It writes the same origin-scoped `skipgc` flag
 * GoatCounter's `#toggle-goatcounter` used, so existing links and the script's
 * own checks keep working. Several copies may be mounted on one page (footer
 * and privacy section); the copy stays synchronized through the opt-out event,
 * while the single `PageViewBeacon` owns the hash alias.
 */
export function AnalyticsToggle() {
  const [disabled, setDisabled] = useState(false)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    const sync = () => setDisabled(isAnalyticsOptedOut())
    sync()
    window.addEventListener(ANALYTICS_OPT_OUT_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(ANALYTICS_OPT_OUT_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const toggle = () => {
    const next = !isAnalyticsOptedOut()
    const saved = setAnalyticsOptedOut(next)
    setAnnouncement(
      saved
        ? next
          ? 'Analytics disabled in this browser.'
          : 'Analytics enabled in this browser.'
        : 'Analytics preference could not be saved in this browser.',
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        aria-pressed={!disabled}
        onClick={toggle}
        className="h-7 text-xs"
      >
        Analytics: {disabled ? 'off' : 'on'}
      </Button>
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  )
}

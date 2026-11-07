'use client'

import { useCallback, useEffect, useRef } from 'react'
import { usePathname } from 'next/navigation'

import { isAnalyticsOptedOut, setAnalyticsOptedOut, trackPageView } from '@/lib/analytics'

/**
 * One page-view beacon per visited pathname. The ref is per component
 * instance, not module state: React Strict Mode's double effect still sends
 * one view, while leaving the public site and returning sends a new one
 * because the ref was destroyed with the unmount.
 *
 * This component also owns the `#toggle-goatcounter` alias. It is mounted
 * once in the public layout, so there is one listener. The page-view effect
 * calls `applyHash` before tracking, so an opt-out visit applies `skipgc`
 * before its view is considered even if the effect order changes. The visible
 * controls only flip the flag.
 */
export function PageViewBeacon() {
  const pathname = usePathname()
  const lastPath = useRef<string | null>(null)
  const handledHash = useRef<string | null>(null)

  const applyHash = useCallback(() => {
    if (window.location.hash !== '#toggle-goatcounter') {
      // Leaving the alias re-arms it: a later client-side navigation back
      // to the same hash is a new intent, not the same event.
      handledHash.current = null
      return
    }
    if (handledHash.current === window.location.hash) return
    handledHash.current = window.location.hash
    setAnalyticsOptedOut(!isAnalyticsOptedOut())
  }, [])

  useEffect(() => {
    applyHash()
    window.addEventListener('hashchange', applyHash)
    return () => window.removeEventListener('hashchange', applyHash)
  }, [applyHash])

  useEffect(() => {
    applyHash()
    if (!pathname || lastPath.current === pathname) return
    lastPath.current = pathname
    trackPageView(pathname)
  }, [pathname, applyHash])

  return null
}

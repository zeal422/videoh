'use client'

import Script from 'next/script'

export const ANALYTICS_READY_EVENT = 'videoh:analytics-ready'

function announceReady() {
  window.dispatchEvent(new Event(ANALYTICS_READY_EVENT))
}

/**
 * Loads the GoatCounter page-view script only when a public endpoint is
 * configured. Both callbacks announce readiness because Next may use either
 * one depending on how the script is cached and inserted.
 */
export function GoatCounter({ url = process.env.NEXT_PUBLIC_GOATCOUNTER_URL }: { url?: string }) {
  if (!url) return null
  return (
    <Script
      src="https://gc.zgo.at/count.js"
      data-goatcounter={url}
      strategy="afterInteractive"
      onLoad={announceReady}
      onReady={announceReady}
    />
  )
}

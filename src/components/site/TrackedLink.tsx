'use client'

import type { AnchorHTMLAttributes, ReactNode } from 'react'

import { trackClick } from '@/lib/analytics'

interface TrackedLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  event: string
  children: ReactNode
}

/**
 * Plain anchor that records one navigation click through trackClick. The
 * native navigation continues; onClick is composed rather than replaced.
 * The external data-goatcounter-click handler is deliberately not used,
 * because it would count the same click a second time after hydration.
 */
export function TrackedLink({ event, onClick, children, ...props }: TrackedLinkProps) {
  return (
    <a
      {...props}
      onClick={(clickEvent) => {
        trackClick(event)
        onClick?.(clickEvent)
      }}
    >
      {children}
    </a>
  )
}

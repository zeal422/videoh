'use client'

import { ChevronDown } from 'lucide-react'

/**
 * The small scroll cue under the hero strip. It is a real anchor, so it works
 * without JavaScript, and the click upgrades it to a smooth scroll that stops
 * below the sticky header.
 */
export function ScrollDownLink({ targetId }: { targetId: string }) {
  return (
    <a
      href={`#${targetId}`}
      aria-label="Scroll to the product section"
      onClick={(event) => {
        const target = document.getElementById(targetId)
        if (!target) return
        event.preventDefault()
        const reduceMotion =
          window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
        target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
        window.history.replaceState(null, '', `#${targetId}`)
      }}
      className="group inline-flex flex-col items-center gap-2 text-[10px] font-medium tracking-[0.24em] text-[var(--site-muted-2)] uppercase transition-colors hover:text-[var(--site-text)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      Scroll
      <span className="grid size-9 place-items-center rounded-full border border-white/10 bg-white/[0.02] transition-colors group-hover:border-white/20 group-hover:bg-white/[0.05] motion-safe:animate-[scroll-bob_1.8s_ease-in-out_infinite]">
        <ChevronDown aria-hidden="true" className="size-4" strokeWidth={1.5} />
      </span>
    </a>
  )
}

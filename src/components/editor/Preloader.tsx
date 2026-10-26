import type { ReactNode } from 'react'

/**
 * Preloader, the boot loading fallback while the client-only EditorShell
 * chunk loads (see EditorBoot.tsx).
 *
 * A centered 10x10 grid of rounded violet cells running one seamless radial
 * ripple: every cell shares the 1.6s phase timeline, and its delay is its
 * Euclidean distance from the grid center times DELAY_STEP, so a single
 * wavefront travels center-out once per cycle. The component is stateless:
 * no timers, no remounts, no variants. The DOM the server renders is the DOM
 * the client hydrates, and nothing touches it until the shell reveal
 * unmounts it, so the wave cannot visibly restart mid-show. Reduced motion
 * (motion-safe:) leaves the static dim grid: faint base opacity with no
 * animation running.
 */

export const RIPPLE_MS = 1600
// Corners land at exactly MAX_DELAY, so the last 0.4s flash ends as the
// 1.6s cycle loops (1.2 + 0.4 = 1.6): every cell fires exactly once per pass.
const MAX_DELAY = 1.2
const CENTER = 4.5
/** Seconds of delay per unit of Euclidean distance from the grid center. */
export const DELAY_STEP = MAX_DELAY / Math.hypot(CENTER, CENTER)

export function delayFor(r: number, c: number): number {
  return Math.hypot(r - CENTER, c - CENTER) * DELAY_STEP
}

export function Preloader() {
  const cells: ReactNode[] = []
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 10; c++) {
      cells.push(
        <span
          key={`${r}-${c}`}
          data-testid="preloader-cell"
          aria-hidden="true"
          className="size-3.5 rounded-[4px] bg-[hsl(270,100%,50%)] motion-safe:ripple-cell"
          style={{
            animationDelay: `${delayFor(r, c).toFixed(4)}s`,
            // Inline so it beats the motion-safe utility: the running
            // schedule overrides inline only through the animated variable,
            // while reduced motion (no animation) and unregistered @property
            // both rest at the faint base.
            opacity: 'calc(0.07 + 0.93 * var(--b, 0))',
          }}
        />,
      )
    }
  }
  return (
    <div className="flex h-dvh w-full items-center justify-center bg-black text-foreground">
      <div className="motion-safe:hue-travel">
        <div
          data-testid="preloader-grid"
          aria-hidden="true"
          className="grid grid-cols-10 gap-2 ripple-feather"
        >
          {cells}
        </div>
      </div>
      <span className="sr-only">Loading editor</span>
    </div>
  )
}

import type { CSSProperties } from 'react'

/**
 * Preloader, the boot loading fallback while the client-only EditorShell
 * chunk loads (see EditorBoot.tsx).
 *
 * A wordmark-led focus pull. Three copies of "videoh" share one grid cell:
 * a white master and rose/blue ghosts that start larger, rotated, and soft,
 * then settle into the sharp mark while the focus brackets close and the
 * distance needle reaches center. The first 2.4s keeps that depth convergence
 * at its original speed, then holds its 2.4s frame while the shell mounts
 * and releases into the bloom peak around 2.44s, where the strip exit starts.
 * It runs once and holds the settled lockup; it does not loop. It
 * fills the EditorBoot hold and lands on the exit, so there is no dead frame
 * after the focus settles.
 *
 * The lockup is drawn once per band. Six uneven bands tile the viewport in
 * black, so at rest they read as one screen; `exiting` feathers and slides
 * them away one beat apart while the mounted editor racks into focus behind.
 * The bands are rendered from the first frame so the handoff never remounts
 * the pull or restarts it mid-show.
 *
 * Stateless: no timers, no effects, no variants beyond the `exiting` and
 * `hold` flags. The `hold` flag freezes the pull at its 2.4s frame while the
 * shell mounts, so the glow and line never fade before the exit can start.
 * The server-rendered DOM is the hydrated DOM, so the pull cannot restart
 * mid-show. Reduced motion (prefers-reduced-motion: reduce) drops the pull
 * and leaves the settled lockup: sharp word, brackets, scale, rule, and label.
 */

const BANDS = [
  { top: 0, height: 12, delay: 0 },
  { top: 12, height: 16, delay: 0.03 },
  { top: 28, height: 22, delay: 0.06 },
  { top: 50, height: 26, delay: 0.09 },
  { top: 76, height: 14, delay: 0.12 },
  { top: 90, height: 10, delay: 0.15 },
] as const

function Lockup() {
  return (
    <div data-testid="preloader-stage" aria-hidden="true" className="preloader-stage">
      <div className="preloader-glow" />
      <div className="preloader-bloom" />
      <div className="preloader-word-stack">
        <span data-testid="preloader-ghost" className="preloader-ghost preloader-ghost-rose">
          videoh
        </span>
        <span data-testid="preloader-ghost" className="preloader-ghost preloader-ghost-blue">
          videoh
        </span>
        <span data-testid="preloader-word" className="preloader-word">
          videoh
        </span>
      </div>
      <div data-testid="preloader-brackets" className="preloader-brackets">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div data-testid="preloader-scale" className="preloader-scale">
        <i className="preloader-needle" />
      </div>
      <div data-testid="preloader-rule" className="preloader-rule" />
      <div className="preloader-label">
        {'LOADING'}
        <span className="preloader-label-dots">...</span>
      </div>
    </div>
  )
}

export function Preloader({
  exiting = false,
  hold = false,
}: {
  exiting?: boolean
  hold?: boolean
}) {
  const veilClass = ['preloader-veil']
  if (exiting) veilClass.push('preloader-exit')
  if (hold) veilClass.push('preloader-hold')
  return (
    <div
      data-testid="preloader-veil"
      data-exiting={exiting ? 'true' : undefined}
      className={veilClass.join(' ')}
    >
      {BANDS.map((band, index) => (
        <div
          key={band.top}
          data-testid="preloader-band"
          className="preloader-band"
          style={
            {
              '--preloader-top': `${band.top}%`,
              '--preloader-bottom': `${100 - band.top - band.height}%`,
              '--preloader-x': `${index % 2 === 0 ? -6 : 6}%`,
              '--preloader-delay': `${band.delay}s`,
            } as CSSProperties
          }
        >
          <Lockup />
        </div>
      ))}
      <div data-testid="preloader-vignette" className="preloader-vignette" />
      <span className="sr-only">Loading editor</span>
    </div>
  )
}

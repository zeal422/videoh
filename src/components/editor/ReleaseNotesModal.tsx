'use client'

/**
 * ReleaseNotesModal, the hand-curated release notes behind the welcome modal
 * (Help > What's new, and the once-per-version auto-open after login).
 *
 * Opened from two places: automatically once per new version after the
 * restore prompt resolves, and manually via Help > What's new. The data lives
 * in `src/lib/releases.ts`.
 *
 * Motion: the Dialog brings the app-standard entrance (fade + zoom from
 * tw-animate-css). Inside, each version block staggers in with an 8px slide
 * and fade, 70ms per block, latest first. Every stagger class is prefixed
 * with `motion-safe:` so prefers-reduced-motion users get an instant list.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { releases } from '@/lib/releases'

export function ReleaseNotesModal({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // The last five versions; the list container scrolls when they overflow.
  const shown = releases.slice(0, 5)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="release-notes-modal"
        className="flex max-h-[85dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-md"
      >
        <DialogHeader className="border-border border-b px-6 py-4">
          <DialogTitle className="text-base">What&apos;s new</DialogTitle>
          <DialogDescription className="text-xs">
            The last {shown.length} versions of this editor.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
          {shown.map((release, i) => (
            <section
              key={release.version}
              /* Staggered reveal: slide 8px + fade, 70ms per block, latest
                 first. motion-safe keeps prefers-reduced-motion instant. */
              className={cn(
                'flex flex-col gap-2',
                'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2',
                'motion-safe:fill-mode-backwards',
              )}
              style={i > 0 ? { animationDelay: `${i * 70}ms` } : undefined}
            >
              <div className="flex items-center gap-2">
                <span
                  data-testid={`release-chip-${release.version}`}
                  className={cn(
                    'inline-flex h-5 items-center rounded-full px-2 text-[11px] font-medium',
                    i === 0
                      ? 'bg-emerald-500 text-emerald-950'
                      : 'border-border text-muted-foreground border bg-zinc-900',
                  )}
                >
                  v{release.version}
                </span>
                <span className="text-muted-foreground text-[11px]">{release.date}</span>
                {i === 0 ? (
                  <span className="text-emerald-400 ml-auto text-[11px] font-medium">New</span>
                ) : null}
              </div>
              <ul className="flex flex-col gap-1.5">
                {release.highlights.map((h, j) => (
                  <li key={j} className="text-foreground/90 flex gap-2 text-xs leading-relaxed">
                    <span aria-hidden="true" className="text-emerald-400/70">
                      •
                    </span>
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

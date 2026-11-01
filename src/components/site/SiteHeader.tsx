import { GITHUB_URL } from '@/lib/seo'
import { TrackedLink } from '@/components/site/TrackedLink'

/**
 * The shared public header. It stays sticky and translucent so the landing
 * page's hero glow reads behind it, and it keeps the battery's
 * `data-testid="open-editor"` contract on the primary CTA.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 shrink-0 bg-[#080512]/70 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-[1288px] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-5">
        <a
          href="/"
          className="flex items-center gap-3 font-display text-[2.5rem] leading-none tracking-[-0.01em] text-[var(--site-text)]"
          aria-label="videoh"
        >
          {/* Transparent version of the favicon bars; the favicon keeps its tile. */}
          <svg
            viewBox="5 6 22 20"
            aria-hidden="true"
            focusable="false"
            className="h-9 w-9 shrink-0"
          >
            <rect x="6" y="7" width="14" height="4" rx="1.5" fill="#34d399" />
            <rect x="10" y="14" width="16" height="4" rx="1.5" fill="#fbbf24" />
            <rect x="6" y="21" width="12" height="4" rx="1.5" fill="#a78bfa" />
          </svg>
          videoh
        </a>
        <nav aria-label="Primary" className="ml-auto flex flex-wrap items-center gap-x-8 gap-y-2">
          <a
            href="/about"
            className="text-sm text-[var(--site-muted)] transition-colors hover:text-[var(--site-text)]"
          >
            About
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-[var(--site-muted)] transition-colors hover:text-[var(--site-text)]"
          >
            GitHub
          </a>
          <TrackedLink
            href="/editor"
            event="open-editor"
            data-testid="open-editor"
            className="site-cta-button inline-flex items-center justify-center rounded-full px-5 py-2.5 text-sm font-semibold"
          >
            <span className="site-cta-label">Open editor</span>
          </TrackedLink>
        </nav>
      </div>
    </header>
  )
}

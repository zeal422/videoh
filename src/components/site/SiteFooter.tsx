import { CONTACT_EMAIL, GITHUB_URL, LICENSE_URL } from '@/lib/seo'
import { AnalyticsToggle } from '@/components/site/AnalyticsToggle'
import { TrackedLink } from '@/components/site/TrackedLink'

/**
 * The public footer. The tagline keeps the local-media claim honest and the
 * contact mailto stays the one tracked link, so the footer can be reused on
 * the legal pages without a second analytics path.
 */
export function SiteFooter() {
  return (
    <footer className="mt-auto shrink-0 border-t border-white/5 bg-[#0d0d18]">
      <div className="mx-auto flex w-full max-w-[1288px] flex-col gap-8 px-6 py-10">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex max-w-sm flex-col gap-4">
            <a
              href="/"
              className="flex items-center gap-3 font-display text-4xl leading-none tracking-[-0.01em] text-[var(--site-text)]"
              aria-label="videoh"
            >
              <svg viewBox="5 6 22 20" aria-hidden="true" className="h-8 w-8 shrink-0">
                <rect x="6" y="7" width="14" height="4" rx="1.5" fill="#34d399" />
                <rect x="10" y="14" width="16" height="4" rx="1.5" fill="#fbbf24" />
                <rect x="6" y="21" width="12" height="4" rx="1.5" fill="#a78bfa" />
              </svg>
              videoh
            </a>
            <p className="text-sm leading-relaxed text-[var(--site-muted-2)]">
              No uploads. No account.
              <br />
              Your media stays local.
            </p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-7 gap-y-2 text-sm">
            <a href="/about" className="text-[var(--site-muted)] hover:text-[var(--site-text)]">
              About
            </a>
            <a href="/privacy" className="text-[var(--site-muted)] hover:text-[var(--site-text)]">
              Privacy
            </a>
            <a href="/terms" className="text-[var(--site-muted)] hover:text-[var(--site-text)]">
              Terms
            </a>
            <a href="/contact" className="text-[var(--site-muted)] hover:text-[var(--site-text)]">
              Contact
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--site-muted)] hover:text-[var(--site-text)]"
            >
              GitHub
            </a>
            <a
              href={LICENSE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--site-muted)] hover:text-[var(--site-text)]"
            >
              MIT License
            </a>
          </nav>
        </div>
        <div className="flex flex-col gap-2 border-t border-white/5 pt-6 text-xs text-[var(--site-muted-2)] sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 videoh. By VectorMedia for everyone.</p>
          <div className="flex flex-wrap items-center gap-4">
            <AnalyticsToggle />
            <TrackedLink
              href={`mailto:${CONTACT_EMAIL}`}
              event="contact-email"
              aria-label={`Email ${CONTACT_EMAIL}`}
              className="underline-offset-4 hover:text-[var(--site-text)] hover:underline"
            >
              {CONTACT_EMAIL}
            </TrackedLink>
          </div>
        </div>
      </div>
    </footer>
  )
}

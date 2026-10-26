import { GITHUB_URL } from '@/lib/seo'
import { TrackedLink } from '@/components/site/TrackedLink'

export function SiteHeader() {
  return (
    <header className="border-border/70 bg-background/80 sticky top-0 z-40 shrink-0 border-b backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 sm:px-8">
        <a
          href="/"
          className="font-display text-foreground flex items-center gap-2.5 text-2xl leading-none tracking-tight sm:gap-3"
          aria-label="videoh"
        >
          {/* Transparent version of the favicon bars; the favicon keeps its tile. */}
          <svg
            viewBox="5 6 22 20"
            aria-hidden="true"
            focusable="false"
            className="h-6 w-6 shrink-0 sm:h-7 sm:w-7"
          >
            <rect x="6" y="7" width="14" height="4" rx="1.5" fill="#34d399" />
            <rect x="10" y="14" width="16" height="4" rx="1.5" fill="#fbbf24" />
            <rect x="6" y="21" width="12" height="4" rx="1.5" fill="#a78bfa" />
          </svg>
          videoh
        </a>
        <nav aria-label="Primary" className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
          <a
            href="/about"
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            About
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground text-sm transition-colors"
          >
            GitHub
          </a>
          <TrackedLink
            href="/editor"
            event="open-editor"
            data-testid="open-editor"
            className="border-rose-400/40 bg-rose-500/10 text-rose-100 hover:bg-rose-500/20 focus-visible:ring-ring rounded-full border px-4 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            Open editor
          </TrackedLink>
        </nav>
      </div>
    </header>
  )
}

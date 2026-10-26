import { CONTACT_EMAIL, GITHUB_URL, LICENSE_URL } from '@/lib/seo'
import { TrackedLink } from '@/components/site/TrackedLink'

export function SiteFooter() {
  return (
    <footer className="border-border/70 bg-background/60 mt-auto shrink-0 border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-10 sm:px-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex max-w-sm flex-col gap-2">
            <a href="/" className="font-display text-foreground text-2xl leading-none">
              videoh
            </a>
            <p className="text-muted-foreground text-sm">
              No uploads. No account. Your media stays on your device.
            </p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <a href="/about" className="text-muted-foreground hover:text-foreground">
              About
            </a>
            <a href="/privacy" className="text-muted-foreground hover:text-foreground">
              Privacy
            </a>
            <a href="/terms" className="text-muted-foreground hover:text-foreground">
              Terms
            </a>
            <a href="/contact" className="text-muted-foreground hover:text-foreground">
              Contact
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              GitHub
            </a>
            <a
              href={LICENSE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground"
            >
              MIT license
            </a>
          </nav>
        </div>
        <div className="border-border/60 text-muted-foreground flex flex-col gap-2 border-t pt-6 text-xs sm:flex-row sm:items-center sm:justify-between">
          <p>Copyright 2026 VectorMedia. videoh is free and open source.</p>
          <TrackedLink
            href={`mailto:${CONTACT_EMAIL}`}
            event="contact-email"
            aria-label={`Email ${CONTACT_EMAIL}`}
            className="hover:text-foreground underline-offset-4 hover:underline"
          >
            {CONTACT_EMAIL}
          </TrackedLink>
        </div>
      </div>
    </footer>
  )
}

import { LegalPage } from '@/components/site/LegalPage'
import { TrackedLink } from '@/components/site/TrackedLink'
import { CONTACT_EMAIL, GITHUB_URL, pageMetadata } from '@/lib/seo'

export const metadata = pageMetadata({
  title: 'Contact',
  path: '/contact',
})

export default function ContactPage() {
  return (
    <LegalPage
      title="Contact"
      intro="Questions, corrections, and partnership notes are welcome. Bug reports are easiest to track on GitHub."
      lastUpdated="October 25, 2026"
    >
      <h2>Email</h2>
      <p>
        Write to{' '}
        <TrackedLink
          href={`mailto:${CONTACT_EMAIL}`}
          event="contact-email"
          aria-label={`Email ${CONTACT_EMAIL}`}
          className="text-foreground font-medium"
        >
          {CONTACT_EMAIL}
        </TrackedLink>
        . This inbox is read by the maintainer.
      </p>

      <h2>GitHub</h2>
      <p>
        The source, issues, and release notes live on{' '}
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        . Open an issue for a reproducible bug or a focused feature request.
      </p>

      <h2>Privacy and terms</h2>
      <p>
        Read the <a href="/privacy">Privacy page</a> for what the browser stores and what the
        analytics service receives. Read the <a href="/terms">Terms page</a> for the license and
        warranty terms.
      </p>
    </LegalPage>
  )
}

import { LegalPage } from '@/components/site/LegalPage'
import { CONTACT_EMAIL, GITHUB_URL, pageMetadata } from '@/lib/seo'

export const metadata = pageMetadata({
  title: 'Privacy',
  path: '/privacy',
})

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      intro="This page describes what videoh stores in your browser and what leaves your device. It is written to match how the app works, not to claim legal sufficiency."
      lastUpdated="October 25, 2026"
    >
      <h2>Your media stays local</h2>
      <p>
        videoh does not upload your video, audio, images, captions, or project files. Local media is
        read in the browser through object URLs and processed with canvas, Web Audio, and WebCodecs.
        When you close the tab, the browser releases those object URLs.
      </p>

      <h2>What the browser stores</h2>
      <p>videoh uses browser storage for the editor, not for a server-side profile:</p>
      <ul>
        <li>Autosave keeps the current project in localStorage so you can restore it later.</li>
        <li>Appearance and workspace preferences remember your palette and panel layout.</li>
        <li>
          A first-export marker remembers that this browser profile has already produced a
          successful export. Clearing site data resets it.
        </li>
        <li>
          A release-notes marker remembers the last version whose notes were shown, so the
          What&apos;s New dialog does not open on every visit. Clearing site data resets it.
        </li>
        <li>Project files you download remain wherever you save them.</li>
      </ul>
      <p>
        You can clear this data through your browser settings. Clearing it removes the autosave,
        preferences, first-export marker, and release-notes marker from that browser profile.
      </p>

      <h2>Analytics</h2>
      <p>
        videoh uses GoatCounter, a cookieless analytics service, to count page views and a small set
        of custom events: editor opens, source clicks, contact email clicks, first exports, and
        successful exports. These events help show whether the editor is useful. They are not used
        for advertising, and videoh does not run advertising pixels or a cookie banner.
      </p>
      <p>
        GoatCounter receives the page path, the event name, the referring page, the page title, the
        screen width, a browser bot flag, the query string, and a random request id. It does not
        receive your media or project contents. Ad blockers can prevent these requests, so the
        numbers are a lower bound.
      </p>

      <h2>Hosting</h2>
      <p>
        The site is hosted on Vercel. Vercel processes standard request logs, such as IP address,
        user agent, request path, and timestamp, to serve the app, keep it available, and protect it
        from abuse. videoh does not add a separate server-side database or user profile.
      </p>

      <h2>Contact</h2>
      <p>
        Privacy questions can go to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>. The
        source is public on{' '}
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        .
      </p>
    </LegalPage>
  )
}

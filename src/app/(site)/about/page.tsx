import { LegalPage } from '@/components/site/LegalPage'
import { GITHUB_URL, LICENSE_URL, pageMetadata } from '@/lib/seo'

export const metadata = pageMetadata({
  title: 'About',
  path: '/about',
})

export default function AboutPage() {
  return (
    <LegalPage
      title="About videoh"
      intro="videoh is an open-source video editor that runs in your browser. It is built for people who want a real timeline without handing their footage to a server."
      lastUpdated="October 25, 2026"
    >
      <h2>An editor that respects the file</h2>
      <p>
        Import video, audio, images, and captions. Arrange them on a multi-track timeline, trim and
        split clips, add transitions and text, mix audio, and export an MP4. The editor uses browser
        APIs, including WebCodecs, instead of a render farm.
      </p>
      <p>
        Your media stays on your device. There is no upload queue, no account, and no project
        database. The app stores autosave, appearance, and workspace preferences in your browser.
      </p>

      <h2>Open source, MIT licensed</h2>
      <p>
        The source is public on{' '}
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        . The code is released under the{' '}
        <a href={LICENSE_URL} target="_blank" rel="noreferrer">
          MIT license
        </a>
        , so you can read it, fork it, and build on it. The editor is free to use.
      </p>
      <p>
        Contributions are welcome. Read the contributing guide in the repository before opening a
        pull request, and report bugs through GitHub issues.
      </p>

      <h2>Privacy by default</h2>
      <p>
        videoh does not upload your media. It uses privacy-friendly analytics for aggregate traffic
        counts and a few product events. The Privacy page explains what the browser stores and what
        the analytics service receives.
      </p>

      <h2>Contact</h2>
      <p>
        Questions, corrections, and partnership notes can go to the{' '}
        <a href="/contact">contact page</a>. Technical issues are easiest to track on GitHub.
      </p>
    </LegalPage>
  )
}

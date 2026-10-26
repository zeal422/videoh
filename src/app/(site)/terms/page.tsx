import { LegalPage } from '@/components/site/LegalPage'
import { CONTACT_EMAIL, LICENSE_URL, pageMetadata } from '@/lib/seo'

export const metadata = pageMetadata({
  title: 'Terms',
  path: '/terms',
})

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms"
      intro="These terms describe the free videoh service and the license that covers its source code. They are a plain-language summary, not legal advice."
      lastUpdated="October 25, 2026"
    >
      <h2>The service</h2>
      <p>
        videoh is a free, browser-based video editor. You can use it without an account. The app
        runs in your browser, and your media stays on your device. There is no paid tier and no
        service-level guarantee.
      </p>

      <h2>MIT license</h2>
      <p>
        The source code is released under the{' '}
        <a href={LICENSE_URL} target="_blank" rel="noreferrer">
          MIT license
        </a>
        . You may use, copy, modify, merge, publish, distribute, sublicense, and sell copies of the
        software, provided the copyright notice and permission notice travel with it.
      </p>

      <h2>No warranty</h2>
      <p>
        The software is provided as is, without warranty of any kind, express or implied, including
        warranties of merchantability, fitness for a particular purpose, and non-infringement. The
        authors are not liable for claims, damages, or other liability arising from the software or
        its use.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Do not use videoh to violate the law or the rights of others.</li>
        <li>Only edit media you have the right to use.</li>
        <li>
          Do not attack, overload, or attempt to bypass the hosting provider's safeguards. The
          editor is client-side, so there is no private server-side content to reach.
        </li>
      </ul>

      <h2>Changes</h2>
      <p>
        The app and these pages may change as the project develops. A change to the Privacy or Terms
        copy is reviewed before it is published. Continuing to use the service after a change means
        you accept the updated terms.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms can go to{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </LegalPage>
  )
}

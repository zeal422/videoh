import { Hero } from '@/components/site/Hero'
import {
  HOME_TITLE,
  SITE_TITLE,
  faqJsonLd,
  pageMetadata,
  softwareApplicationJsonLd,
} from '@/lib/seo'

export const metadata = pageMetadata({
  title: HOME_TITLE,
  path: '/',
  openGraphTitle: SITE_TITLE,
})

export default function HomePage() {
  return (
    <>
      <Hero />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationJsonLd()) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd()) }}
      />
    </>
  )
}

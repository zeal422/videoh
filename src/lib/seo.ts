import type { Metadata } from 'next'

/**
 * Public site constants, metadata builders, sitemap routes, and JSON-LD.
 *
 * This module stays browser-free and framework-light: the only Next import is
 * the Metadata type, so the SEO tests can run in the Node environment. The
 * root layout consumes ROOT_METADATA; each page builds its own canonical and
 * Open Graph URL through pageMetadata.
 */

export const SITE_URL = 'https://videoh.vercel.app'
export const SITE_NAME = 'videoh'
export const SITE_TITLE = 'videoh, open-source video editing in your browser'
export const SITE_DESCRIPTION =
  'A free, open-source multi-track video editor that runs in your browser. No uploads, no account, MP4 export.'
export const CONTACT_EMAIL = 'vectormediagr@gmail.com'
export const GITHUB_URL = 'https://github.com/zeal422/videoh'
export const LICENSE_URL = 'https://github.com/zeal422/videoh/blob/main/LICENSE'
export const LAST_CONTENT_UPDATE = '2026-10-25'
export const HOME_TITLE = { absolute: SITE_TITLE }

export const ROOT_METADATA = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_TITLE, template: '%s | videoh' },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  authors: [{ name: 'VectorMedia', url: GITHUB_URL }],
  creator: 'VectorMedia',
  robots: { index: true, follow: true },
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    locale: 'en_US',
    url: SITE_URL,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: '/opengraph-image',
        width: 1200,
        height: 630,
        alt: SITE_TITLE,
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ['/opengraph-image'],
  },
  icons: { icon: '/icon.svg' },
} satisfies Metadata

export interface PageMetadataOptions {
  title: Metadata['title']
  path: string
  description?: string
  robots?: Metadata['robots']
  openGraphTitle?: string
}

/**
 * Build page metadata with its own canonical and Open Graph URL. The root
 * Open Graph and Twitter fields are spread first so siteName, type, locale,
 * and card survive every override.
 */
export function pageMetadata({
  title,
  path,
  description = SITE_DESCRIPTION,
  robots,
  openGraphTitle,
}: PageMetadataOptions): Metadata {
  const socialTitle = openGraphTitle ?? (typeof title === 'string' ? title : SITE_TITLE)
  return {
    title,
    description,
    alternates: { canonical: path },
    ...(robots ? { robots } : {}),
    openGraph: {
      ...ROOT_METADATA.openGraph,
      title: socialTitle,
      description,
      url: canonicalUrl(path),
    },
    twitter: {
      ...ROOT_METADATA.twitter,
      title: socialTitle,
      description,
    },
  }
}

export function canonicalUrl(path: string): string {
  return new URL(path, SITE_URL).toString()
}

export const INDEXABLE_ROUTES = [
  { path: '/', changeFrequency: 'weekly', priority: 1, lastModified: LAST_CONTENT_UPDATE },
  { path: '/about', changeFrequency: 'monthly', priority: 0.8, lastModified: LAST_CONTENT_UPDATE },
  { path: '/privacy', changeFrequency: 'yearly', priority: 0.3, lastModified: LAST_CONTENT_UPDATE },
  { path: '/terms', changeFrequency: 'yearly', priority: 0.3, lastModified: LAST_CONTENT_UPDATE },
  {
    path: '/contact',
    changeFrequency: 'monthly',
    priority: 0.5,
    lastModified: LAST_CONTENT_UPDATE,
  },
] as const

export const FAQ_ITEMS = [
  {
    question: 'Is videoh free?',
    answer: 'Yes. videoh is free to use and MIT licensed.',
  },
  {
    question: 'Does videoh upload my videos?',
    answer: 'No. Media is processed in your browser and is not uploaded to a videoh server.',
  },
  {
    question: 'What can I export?',
    answer: 'MP4 with H.264 video and AAC or Opus audio.',
  },
  {
    question: 'Which browsers work?',
    answer:
      'The full editor and export need a current Chromium, Edge, Firefox 130+, or Safari 26+. Playback may work in older browsers.',
  },
] as const

export function softwareApplicationJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    applicationCategory: 'VideoApplication',
    operatingSystem: 'Any',
    url: SITE_URL,
    description: SITE_DESCRIPTION,
    license: LICENSE_URL,
    isAccessibleForFree: true,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
  }
}

export function faqJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ_ITEMS.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  }
}

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import nextConfig from '../../../../next.config'
import sitemap from '@/app/sitemap'
import {
  CONTACT_EMAIL,
  FAQ_ITEMS,
  GITHUB_URL,
  HOME_TITLE,
  INDEXABLE_ROUTES,
  LAST_CONTENT_UPDATE,
  LICENSE_URL,
  ROOT_METADATA,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TITLE,
  SITE_URL,
  canonicalUrl,
  faqJsonLd,
  pageMetadata,
  softwareApplicationJsonLd,
} from '@/lib/seo'

const ROOT = resolve(__dirname, '..', '..', '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

/**
 * SEO locks: the root metadata is a single exported object, each non-root page
 * gets its own canonical and Open Graph URL, the sitemap lists only the five
 * indexable routes, the verification file is byte-exact, and preview
 * deployments are the only ones with X-Robots-Tag.
 */
describe('site metadata', () => {
  it('exports the exact root metadata', () => {
    expect(SITE_URL).toBe('https://videoh.vercel.app')
    expect(SITE_NAME).toBe('videoh')
    expect(SITE_TITLE).toBe('videoh, open-source video editing in your browser')
    expect(SITE_DESCRIPTION).toBe(
      'A free, open-source multi-track video editor that runs in your browser. No uploads, no account, MP4 export.',
    )
    expect(CONTACT_EMAIL).toBe('vectormediagr@gmail.com')
    expect(GITHUB_URL).toBe('https://github.com/zeal422/videoh')
    expect(LICENSE_URL).toBe('https://github.com/zeal422/videoh/blob/main/LICENSE')
    expect(LAST_CONTENT_UPDATE).toBe('2026-10-25')
    expect(HOME_TITLE).toEqual({ absolute: SITE_TITLE })
    expect(ROOT_METADATA.metadataBase).toEqual(new URL(SITE_URL))
    expect(ROOT_METADATA.title).toEqual({
      default: SITE_TITLE,
      template: '%s | videoh',
    })
    expect(ROOT_METADATA.description).toBe(SITE_DESCRIPTION)
    expect(ROOT_METADATA.applicationName).toBe(SITE_NAME)
    expect(ROOT_METADATA.authors).toEqual([{ name: 'VectorMedia', url: GITHUB_URL }])
    expect(ROOT_METADATA.creator).toBe('VectorMedia')
    expect(ROOT_METADATA.robots).toEqual({ index: true, follow: true })
    expect(ROOT_METADATA.openGraph).toMatchObject({
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
    })
    expect(ROOT_METADATA.twitter).toMatchObject({
      card: 'summary_large_image',
      title: SITE_TITLE,
      description: SITE_DESCRIPTION,
      images: ['/opengraph-image'],
    })
    expect(ROOT_METADATA.icons).toEqual({ icon: '/icon.svg' })
  })

  it('builds page metadata with the page canonical and its own Open Graph URL', () => {
    const about = pageMetadata({ title: 'About', path: '/about' })
    expect(about.title).toBe('About')
    expect(about.description).toBe(SITE_DESCRIPTION)
    expect(about.alternates).toEqual({ canonical: '/about' })
    expect(about.openGraph).toMatchObject({
      type: 'website',
      siteName: SITE_NAME,
      locale: 'en_US',
      url: 'https://videoh.vercel.app/about',
      title: 'About',
      description: SITE_DESCRIPTION,
    })
    expect(about.twitter).toMatchObject({
      card: 'summary_large_image',
      title: 'About',
      description: SITE_DESCRIPTION,
    })
  })

  it('keeps the home title absolute and the social title exact', () => {
    const home = pageMetadata({
      title: HOME_TITLE,
      path: '/',
      openGraphTitle: SITE_TITLE,
    })
    expect(home.title).toEqual(HOME_TITLE)
    expect(home.openGraph).toMatchObject({ url: 'https://videoh.vercel.app/', title: SITE_TITLE })
  })

  it('supports the editor robots directive without changing the root social fields', () => {
    const editor = pageMetadata({
      title: 'Editor',
      path: '/editor',
      robots: { index: false, follow: true },
    })
    expect(editor.robots).toEqual({ index: false, follow: true })
    expect(editor.openGraph).toMatchObject({
      siteName: SITE_NAME,
      type: 'website',
      locale: 'en_US',
      url: 'https://videoh.vercel.app/editor',
    })
  })

  it('lists only the five indexable routes with their metadata', () => {
    expect(INDEXABLE_ROUTES.map((route) => route.path)).toEqual([
      '/',
      '/about',
      '/privacy',
      '/terms',
      '/contact',
    ])
    for (const route of INDEXABLE_ROUTES) {
      expect(route.lastModified).toBe(LAST_CONTENT_UPDATE)
      expect(route.priority).toBeGreaterThan(0)
      expect(route.changeFrequency).toMatch(/^(weekly|monthly|yearly)$/)
    }
    expect(INDEXABLE_ROUTES.map((route) => route.path as string)).not.toContain('/editor')
  })

  it('canonicalizes paths with the production origin', () => {
    expect(canonicalUrl('/')).toBe('https://videoh.vercel.app/')
    expect(canonicalUrl('/about')).toBe('https://videoh.vercel.app/about')
    expect(canonicalUrl('/editor')).toBe('https://videoh.vercel.app/editor')
  })

  it('exports the exact FAQ used by the hero and JSON-LD', () => {
    expect(FAQ_ITEMS).toEqual([
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
    ])
  })

  it('serializes both JSON-LD types', () => {
    const app = JSON.stringify(softwareApplicationJsonLd())
    const faq = JSON.stringify(faqJsonLd())
    expect(app).toContain('"@type":"SoftwareApplication"')
    expect(app).toContain(`"name":"${SITE_NAME}"`)
    expect(faq).toContain('"@type":"FAQPage"')
    expect(faq).toContain('"@type":"Question"')
    expect(faq).toContain('"@type":"Answer"')
  })
})

describe('site files', () => {
  it('renders the sitemap from the indexable routes only', () => {
    const entries = sitemap()
    expect(entries.map((entry) => entry.url)).toEqual([
      'https://videoh.vercel.app/',
      'https://videoh.vercel.app/about',
      'https://videoh.vercel.app/privacy',
      'https://videoh.vercel.app/terms',
      'https://videoh.vercel.app/contact',
    ])
    expect(entries.some((entry) => entry.url.endsWith('/editor'))).toBe(false)
    expect(entries[0].priority).toBe(1)
  })

  it('ships the crawler policy and the byte-exact verification file', () => {
    expect(read('public/robots.txt')).toBe(
      'User-agent: *\nAllow: /\nSitemap: https://videoh.vercel.app/sitemap.xml\n',
    )
    expect(read('public/google80671fa4533bcad3.html')).toBe(
      'google-site-verification: google80671fa4533bcad3.html',
    )
  })

  it('declares the social image size and alt text', () => {
    const source = read('src/app/opengraph-image.tsx')
    expect(source).toContain('width: 1200')
    expect(source).toContain('height: 630')
    expect(source).toContain("alt = 'videoh, open-source video editing in your browser'")
  })

  it('consumes ROOT_METADATA from the root layout instead of duplicating it', () => {
    const layout = read('src/app/layout.tsx')
    expect(layout).toContain("import { ROOT_METADATA } from '@/lib/seo'")
    expect(layout).toContain('export const metadata = ROOT_METADATA')
    expect(layout).toContain('<GoatCounter />')
    expect(layout).not.toContain('Web Video Editor')
  })
})

describe('preview noindex header', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns X-Robots-Tag only for preview deployments', async () => {
    vi.stubEnv('VERCEL_ENV', 'preview')
    const preview = await nextConfig.headers?.()
    expect(preview).toEqual([
      {
        source: '/:path*',
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ])

    for (const env of ['production', 'development', '']) {
      vi.stubEnv('VERCEL_ENV', env)
      expect(await nextConfig.headers?.()).toEqual([])
    }
  })
})

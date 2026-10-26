// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const analytics = vi.hoisted(() => ({
  trackClick: vi.fn(),
  trackEvent: vi.fn(),
  trackExportSuccess: vi.fn(),
}))

vi.mock('@/lib/analytics', () => analytics)

vi.mock('next/image', () => ({
  default: ({
    src,
    alt,
    width,
    height,
    sizes,
    preload,
    ...rest
  }: {
    src: string
    alt: string
    width: number
    height: number
    sizes?: string
    preload?: boolean
    [key: string]: unknown
  }) => (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      data-preload={preload ? 'true' : undefined}
      data-sizes={sizes}
      {...rest}
    />
  ),
}))

import AboutPage from '@/app/(site)/about/page'
import ContactPage from '@/app/(site)/contact/page'
import PrivacyPage from '@/app/(site)/privacy/page'
import TermsPage from '@/app/(site)/terms/page'
import { Hero } from '@/components/site/Hero'
import { SiteFooter } from '@/components/site/SiteFooter'
import { SiteHeader } from '@/components/site/SiteHeader'
import { TimelineHero } from '@/components/site/TimelineHero'
import { TrackedLink } from '@/components/site/TrackedLink'
import { FAQ_ITEMS, CONTACT_EMAIL, GITHUB_URL } from '@/lib/seo'

const HERO_TITLE = 'Open-source video editing in your browser.'
const SCREENSHOT_ALT =
  'The videoh editor showing a night city street, an AFTER HOURS title, audio waveforms, markers, and a scale keyframe curve on a multi-track timeline'

/**
 * Public page locks: the hero is a real product page rather than the editor
 * shell, every CTA path is correct, the two mailto links are the only
 * contact-email sources, and the decorative timeline respects reduced motion.
 */

afterEach(() => {
  cleanup()
  analytics.trackClick.mockReset()
  analytics.trackEvent.mockReset()
  analytics.trackExportSuccess.mockReset()
})

describe('public hero', () => {
  it('renders the hero copy, feature sections, FAQ, and screenshot', () => {
    render(<Hero />)
    expect(screen.getByTestId('hero')).toBeInTheDocument()
    expect(screen.getByText('OPEN SOURCE · BROWSER NATIVE · LOCAL FIRST')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: HERO_TITLE })).toBeInTheDocument()
    expect(screen.getByText('No uploads. No account. No watermark.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Multi-track timeline' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Local-first media' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'MP4 export' })).toBeInTheDocument()
    for (const item of FAQ_ITEMS) {
      expect(screen.getByText(item.question)).toBeInTheDocument()
      expect(screen.getByText(item.answer)).toBeInTheDocument()
    }
    const image = screen.getByRole('img', { name: SCREENSHOT_ALT })
    expect(image).toHaveAttribute('data-preload', 'true')
    expect(image).toHaveAttribute('width', '1600')
    expect(image).toHaveAttribute('loading', 'eager')
    expect(image).toHaveAttribute('height', '1000')
  })

  it('points every open-editor CTA at /editor and the source CTA at GitHub', () => {
    render(<Hero />)
    const openEditor = screen.getAllByRole('link', { name: 'Open editor' })
    expect(openEditor).toHaveLength(2)
    for (const link of openEditor) expect(link).toHaveAttribute('href', '/editor')
    const source = screen.getByRole('link', { name: 'View source' })
    expect(source).toHaveAttribute('href', GITHUB_URL)
  })
})

describe('site chrome', () => {
  it('links the wordmark, About, GitHub, and the editor', () => {
    render(<SiteHeader />)
    const wordmark = screen.getByRole('link', { name: 'videoh' })
    expect(wordmark).toHaveAttribute('href', '/')
    const mark = wordmark.querySelector('svg')
    expect(mark).not.toBeNull()
    expect(mark).toHaveAttribute('viewBox', '5 6 22 20')
    expect(mark).toHaveAttribute('aria-hidden', 'true')
    expect(mark?.querySelectorAll('rect')).toHaveLength(3)
    expect(mark?.querySelector('rect[fill="#18181b"]')).toBeNull()
    expect(screen.getByRole('link', { name: 'About' })).toHaveAttribute('href', '/about')
    expect(screen.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', GITHUB_URL)
    expect(screen.getByTestId('open-editor')).toHaveAttribute('href', '/editor')
  })

  it('tracks the footer mailto but not the Contact navigation link', () => {
    render(<SiteFooter />)
    expect(
      screen.getByText('No uploads. No account. Your media stays on your device.'),
    ).toBeInTheDocument()
    const email = screen.getByRole('link', { name: `Email ${CONTACT_EMAIL}` })
    expect(email).toHaveAttribute('href', `mailto:${CONTACT_EMAIL}`)
    fireEvent.click(email)
    expect(analytics.trackClick).toHaveBeenCalledWith('contact-email')

    analytics.trackClick.mockClear()
    fireEvent.click(screen.getByRole('link', { name: 'Contact' }))
    expect(analytics.trackClick).not.toHaveBeenCalledWith('contact-email')
  })

  it('renders a plain anchor that tracks once and never blocks navigation', () => {
    const { container } = render(
      <TrackedLink href="/editor" event="open-editor">
        Open editor
      </TrackedLink>,
    )
    const link = container.querySelector('a')
    expect(link).not.toBeNull()
    const allowed = link!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    expect(allowed).toBe(true)
    expect(analytics.trackClick).toHaveBeenCalledTimes(1)
    expect(analytics.trackClick).toHaveBeenCalledWith('open-editor')
  })
})

describe('public pages', () => {
  it('renders the About, Privacy, Terms, and Contact headings and content', () => {
    const { unmount: unmountAbout } = render(<AboutPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'About videoh' })).toBeInTheDocument()
    expect(screen.getByText(/open source/i)).toBeInTheDocument()
    unmountAbout()

    const { unmount: unmountPrivacy } = render(<PrivacyPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy' })).toBeInTheDocument()
    expect(screen.getByText(/local media/i)).toBeInTheDocument()
    expect(screen.getAllByText(/GoatCounter/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Vercel/).length).toBeGreaterThan(0)
    expect(screen.getByText(/last version whose notes were shown/i)).toBeInTheDocument()
    unmountPrivacy()

    const { unmount: unmountTerms } = render(<TermsPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'Terms' })).toBeInTheDocument()
    expect(screen.getAllByText(/MIT/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/warranty/i).length).toBeGreaterThan(0)
    unmountTerms()

    render(<ContactPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'Contact' })).toBeInTheDocument()
  })

  it('tracks the contact page mailto and links GitHub', () => {
    render(<ContactPage />)
    const email = screen.getByRole('link', { name: `Email ${CONTACT_EMAIL}` })
    fireEvent.click(email)
    expect(analytics.trackClick).toHaveBeenCalledWith('contact-email')
    expect(screen.getByRole('link', { name: /GitHub/ })).toHaveAttribute('href', GITHUB_URL)
  })

  it('marks the timeline decorative and keeps its animation motion-safe', () => {
    render(<TimelineHero />)
    expect(screen.getByTestId('timeline-hero')).toHaveAttribute('aria-hidden', 'true')
    const source = readSource('src/components/site/TimelineHero.tsx')
    expect(source).toContain('motion-safe:animate-[clip-settle')
    expect(source).toContain('motion-safe:animate-[playhead-sweep')
    expect(source).toContain('bg-rose-500')
    expect(source).not.toMatch(/(^|\s)animate-/)
    const hero = readSource('src/components/site/Hero.tsx')
    expect(hero).toContain('motion-safe:animate-')
    expect(hero).not.toMatch(/(^|\s)animate-/)
  })
})

function readSource(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

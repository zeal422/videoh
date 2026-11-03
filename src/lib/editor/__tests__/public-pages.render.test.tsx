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

import editorScreenshot from '@/assets/editor-screenshot.png'
import AboutPage from '@/app/(site)/about/page'
import ContactPage from '@/app/(site)/contact/page'
import PrivacyPage from '@/app/(site)/privacy/page'
import TermsPage from '@/app/(site)/terms/page'
import { Hero } from '@/components/site/Hero'
import { SCREENSHOT_ALT } from '@/components/site/ProductShowcase'
import { SiteFooter } from '@/components/site/SiteFooter'
import { SiteHeader } from '@/components/site/SiteHeader'
import { TimelineHero } from '@/components/site/TimelineHero'
import { TrackedLink } from '@/components/site/TrackedLink'
import { FAQ_ITEMS, CONTACT_EMAIL, GITHUB_URL } from '@/lib/seo'

/**
 * Public page locks: the landing page is a real product page rather than the
 * editor shell, every CTA path is correct, the FAQ stays visible beside its
 * JSON-LD, the FAQ sits after privacy and the CTA closes the page, and the
 * decorative timeline respects reduced motion.
 */

afterEach(() => {
  cleanup()
  analytics.trackClick.mockReset()
  analytics.trackEvent.mockReset()
  analytics.trackExportSuccess.mockReset()
})

describe('public hero', () => {
  it('renders the landing sections, FAQ, and real editor screenshot', () => {
    render(<Hero />)
    expect(screen.getByTestId('hero')).toBeInTheDocument()
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading).toHaveTextContent('Video editing')
    expect(heading).toHaveTextContent('where you do.')
    expect(screen.getByText('No uploads. No account. Your media stays local.')).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: 'Runs in your browser' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Your data is yours' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Open source' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Export anywhere' })).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: /Everything you need\./ })).toBeInTheDocument()
    for (const item of [
      'Multi-track timeline',
      'Text & titles',
      'Transitions & effects',
      'Audio editing',
      'Frame-by-frame control',
      'Keyboard shortcuts',
    ]) {
      expect(screen.getByText(item)).toBeInTheDocument()
    }

    const toolsTitle = screen.getByRole('heading', { name: 'Create without limits.' })
    expect(toolsTitle).toBeInTheDocument()
    expect(toolsTitle.classList.contains('whitespace-nowrap')).toBe(false)
    expect(toolsTitle.classList.contains('min-[360px]:whitespace-nowrap')).toBe(true)
    for (const tool of ['Trim', 'Text', 'Effects', 'Audio', 'Export']) {
      expect(screen.getByText(tool, { exact: true })).toBeInTheDocument()
    }
    const toolTiles = document.querySelectorAll('.site-tool-tile')
    expect(toolTiles).toHaveLength(5)
    for (const tile of toolTiles) {
      expect(tile.classList.contains('aspect-square')).toBe(true)
      expect(tile.classList.contains('w-full')).toBe(true)
      expect(tile.classList.contains('max-w-16')).toBe(true)
      expect(tile.classList.contains('size-16')).toBe(false)
    }
    expect(screen.getByText('4K')).toBeInTheDocument()
    expect(screen.getByText('Support')).toBeInTheDocument()
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByText('Free', { exact: true })).toBeInTheDocument()

    const privacyTitle = screen.getByRole('heading', {
      name: 'Built for privacy. Built for you.',
    })
    expect(privacyTitle).toBeInTheDocument()
    expect(privacyTitle.classList.contains('xl:whitespace-nowrap')).toBe(true)
    expect(privacyTitle.classList.contains('whitespace-nowrap')).toBe(false)
    expect(privacyTitle.closest('.grid')?.className).toContain('xl:grid-cols-[0.32fr_0.62fr]')
    expect(screen.getByText('Your Device')).toBeInTheDocument()
    expect(screen.getByText('No media servers')).toBeInTheDocument()
    expect(screen.getByText(/Local first\./)).toBeInTheDocument()

    expect(screen.getByRole('heading', { name: 'Ready to start editing?' })).toBeInTheDocument()
    expect(screen.getAllByText('Open editor now').length).toBeGreaterThan(0)

    for (const item of FAQ_ITEMS) {
      expect(screen.getByText(item.question)).toBeInTheDocument()
      expect(screen.getByText(item.answer)).toBeInTheDocument()
    }

    const image = screen.getByRole('img', { name: SCREENSHOT_ALT })
    const expectedSrc =
      typeof editorScreenshot === 'string' ? editorScreenshot : editorScreenshot.src
    expect(image).toHaveAttribute('src', expectedSrc)
    expect(image).toHaveAttribute('width', '1921')
    expect(image).toHaveAttribute('height', '1079')
    expect(image).toHaveAttribute('loading', 'lazy')
    expect(image).toHaveAttribute('data-sizes')
    expect(image).not.toHaveAttribute('data-preload')

    const scrollLink = screen.getByRole('link', { name: 'Scroll to the product section' })
    expect(scrollLink).toHaveAttribute('href', '#product')
    expect(document.getElementById('product')).not.toBeNull()

    const css = readSource('src/app/globals.css')
    const reducedCta = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedCta).toContain('.site-cta-button:hover::after')
    expect(reducedCta).toContain('.site-cta-button:focus-visible::after')

    const scrollIntoView = vi.fn()
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    })
    const media = vi.fn((query: string) => ({ matches: false, media: query }))
    vi.stubGlobal('matchMedia', media)
    try {
      fireEvent.click(scrollLink)
      expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'smooth', block: 'start' })
      media.mockReturnValue({ matches: true, media: '(prefers-reduced-motion: reduce)' })
      fireEvent.click(scrollLink)
      expect(scrollIntoView).toHaveBeenLastCalledWith({ behavior: 'auto', block: 'start' })
    } finally {
      vi.unstubAllGlobals()
      if (originalScrollIntoView) {
        Object.defineProperty(Element.prototype, 'scrollIntoView', {
          configurable: true,
          writable: true,
          value: originalScrollIntoView,
        })
      } else {
        Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
      }
    }
  })

  it('points every open-editor CTA at /editor and the source CTAs at GitHub', () => {
    render(<Hero />)
    const openEditor = screen.getAllByRole('link', { name: 'Open editor' })
    expect(openEditor).toHaveLength(1)
    expect(openEditor[0]).toHaveAttribute('href', '/editor')
    expect(openEditor[0]).toHaveClass('site-cta-button')
    expect(screen.getByRole('link', { name: 'Open editor now' })).toHaveAttribute('href', '/editor')
    expect(screen.getByRole('link', { name: 'Open editor now' })).toHaveClass('site-cta-button')
    expect(screen.getByRole('link', { name: 'View source' })).toHaveAttribute('href', GITHUB_URL)
    expect(screen.getByRole('link', { name: 'Or view source on GitHub' })).toHaveAttribute(
      'href',
      GITHUB_URL,
    )
  })

  it('keeps the FAQ after privacy and the CTA after the FAQ', () => {
    const hero = readSource('src/components/site/Hero.tsx')
    const privacy = hero.indexOf('<PrivacyPanel />')
    const faq = hero.indexOf('<FaqSection />')
    const cta = hero.indexOf('<CtaPanel />')
    expect(privacy).toBeGreaterThan(-1)
    expect(faq).toBeGreaterThan(privacy)
    expect(cta).toBeGreaterThan(faq)
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
    expect(screen.getByTestId('open-editor')).toHaveClass('site-cta-button')
  })

  it('tracks the footer mailto but not the Contact navigation link', () => {
    render(<SiteFooter />)
    expect(screen.getByText(/No uploads\. No account\./)).toBeInTheDocument()
    expect(screen.getByText(/Your media stays local\./)).toBeInTheDocument()
    expect(screen.getByText('© 2026 videoh. By VectorMedia for everyone.')).toBeInTheDocument()
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

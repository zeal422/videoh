import { Github, Lock } from 'lucide-react'

import { CtaPanel } from '@/components/site/CtaPanel'
import { FaqSection } from '@/components/site/FaqSection'
import { FeatureStrip } from '@/components/site/FeatureStrip'
import { PrivacyPanel } from '@/components/site/PrivacyPanel'
import { ProductShowcase } from '@/components/site/ProductShowcase'
import { ScrollDownLink } from '@/components/site/ScrollDownLink'
import { TimelineHero } from '@/components/site/TimelineHero'
import { ToolBand } from '@/components/site/ToolBand'
import { TrackedLink } from '@/components/site/TrackedLink'
import { GITHUB_URL } from '@/lib/seo'

/**
 * The public landing page. It is one server-rendered composition: the hero,
 * feature strip, product proof, gradient tools band, privacy panel, closing
 * CTA, and the FAQ that keeps the FAQPage JSON-LD eligible. The editor never
 * mounts here; the timeline is CSS and the screenshot is a static image.
 */
export function Hero() {
  return (
    <div data-testid="hero" className="site-grain relative overflow-hidden bg-[var(--site-bg)]">
      <section
        aria-labelledby="hero-title"
        className="relative flex min-h-[calc(100svh_-_5rem)] flex-col"
      >
        <div aria-hidden="true" className="site-hero-bg absolute inset-0" />

        <div className="relative mx-auto grid w-full max-w-[1288px] gap-16 px-6 pt-16 pb-10 lg:grid-cols-2 lg:items-start lg:gap-20 lg:pt-16">
          <div className="relative z-10 motion-safe:animate-[hero-rise_0.8s_ease-out_both]">
            <p className="text-[11px] font-semibold tracking-[0.22em] text-rose-300 uppercase">
              Open source <span className="px-1 text-rose-300/55">•</span> Browser native{' '}
              <span className="px-1 text-rose-300/55">•</span> Local first
            </p>
            <h1
              id="hero-title"
              className="mt-5 font-display text-[clamp(4.5rem,8.5vw,7.625rem)] leading-[0.72] tracking-[-0.03em] text-[var(--site-text)]"
            >
              Video editing
              <br />
              that runs
              <br />
              <em className="site-gradient-text italic">where you do.</em>
            </h1>
            <p className="mt-8 max-w-[34rem] text-xl leading-relaxed text-[var(--site-muted)]">
              A powerful, open-source video editor that works entirely in your browser. No uploads.
              No accounts. All creativity.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <TrackedLink
                href="/editor"
                event="open-editor"
                className="site-cta-button inline-flex h-[3.25rem] items-center justify-center rounded-full px-7 text-base font-semibold"
              >
                <span className="site-cta-label">Open editor</span>
              </TrackedLink>
              <TrackedLink
                href={GITHUB_URL}
                event="view-source"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-[3.25rem] items-center justify-center gap-2 rounded-full border border-white/15 bg-white/[0.025] px-6 text-base font-medium text-[var(--site-text)] transition-colors hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                View source
                <Github aria-hidden="true" className="size-4" />
              </TrackedLink>
            </div>
            <p className="mt-6 flex items-center gap-2 text-sm text-[var(--site-muted-2)]">
              <Lock aria-hidden="true" className="size-4" />
              No uploads. No account. Your media stays local.
            </p>
          </div>

          <div className="relative z-10 motion-safe:animate-[hero-rise_0.9s_ease-out_0.12s_both] lg:pt-20">
            <div
              aria-hidden="true"
              className="absolute -top-4 right-8 hidden text-center text-sm text-[#b3a1c6]/70 lg:block"
            >
              Your edit, in real time.
              <svg
                viewBox="0 0 100 100"
                fill="none"
                className="mx-auto mt-1 h-14 w-14 -translate-x-5 text-[#8b5ca8] drop-shadow-[0_0_5px_rgba(139,92,168,0.3)]"
              >
                <path
                  d="M82 18C62 20 40 38 30 78"
                  stroke="currentColor"
                  strokeWidth="3.2"
                  strokeLinecap="round"
                />
                <path
                  d="M30 78L22 60M30 78L46 70"
                  stroke="currentColor"
                  strokeWidth="3.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <TimelineHero />
          </div>
        </div>

        <div className="relative mx-auto mt-10 w-full max-w-[1288px] px-6 pb-4">
          <FeatureStrip />
          <div className="mt-6 flex justify-center">
            <ScrollDownLink targetId="product" />
          </div>
        </div>
      </section>

      <ProductShowcase />
      <ToolBand />
      <PrivacyPanel />
      <FaqSection />
      <CtaPanel />
    </div>
  )
}

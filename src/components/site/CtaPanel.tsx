import { ArrowRight, Github } from 'lucide-react'

import { TrackedLink } from '@/components/site/TrackedLink'
import { GITHUB_URL } from '@/lib/seo'

/**
 * The closing conversion panel. It sits directly under the privacy section,
 * as the reference does, so the page ends on the local-first promise before
 * the FAQ and footer.
 */
export function CtaPanel() {
  return (
    <section aria-labelledby="cta-title" className="relative pt-6 pb-20 sm:pt-10 sm:pb-24">
      <div className="mx-auto w-full max-w-[1288px] px-6">
        <div className="site-cta-panel rounded-2xl">
          <div className="relative z-10 flex flex-col gap-8 p-8 sm:p-12 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <h2
                id="cta-title"
                className="font-display text-4xl leading-[1.05] tracking-[-0.01em] text-white sm:text-5xl"
              >
                Ready to start editing?
              </h2>
              <p className="mt-3 text-base leading-relaxed text-white/70">
                Open videoh in your browser and start creating.
                <br className="hidden sm:block" /> No signup. No limits. Just your story.
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-start gap-4 sm:items-center">
              <TrackedLink
                href="/editor"
                event="open-editor"
                className="site-cta-button inline-flex h-12 items-center justify-center rounded-full px-7 text-sm font-semibold"
              >
                <span className="site-cta-label">
                  Open editor now
                  <ArrowRight aria-hidden="true" className="size-4" />
                </span>
              </TrackedLink>
              <TrackedLink
                href={GITHUB_URL}
                event="view-source"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 text-sm text-white/70 transition-colors hover:text-white"
              >
                <Github aria-hidden="true" className="size-4" />
                Or view source on GitHub
              </TrackedLink>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

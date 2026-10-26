import Image from 'next/image'

import { TimelineHero } from '@/components/site/TimelineHero'
import { TrackedLink } from '@/components/site/TrackedLink'
import { FAQ_ITEMS, GITHUB_URL } from '@/lib/seo'

const FEATURES = [
  {
    title: 'Multi-track timeline',
    body: 'Arrange video, audio, text, and captions on a real timeline. Trim, split, link, and undo without leaving the tab.',
  },
  {
    title: 'Local-first media',
    body: 'Your files stay on your device. videoh uses object URLs and browser APIs, so there is no upload queue and no account.',
  },
  {
    title: 'MP4 export',
    body: 'Render H.264 video with AAC or Opus audio through WebCodecs. The file is yours, with no watermark.',
  },
]

const SCREENSHOT_ALT =
  'The videoh editor showing a night city street, an AFTER HOURS title, audio waveforms, markers, and a scale keyframe curve on a multi-track timeline'

export function Hero() {
  return (
    <div data-testid="hero" className="site-grain relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_10%,rgba(244,63,94,0.14),transparent_34%),radial-gradient(circle_at_82%_20%,rgba(139,92,246,0.12),transparent_30%)]"
      />
      <section
        aria-labelledby="hero-title"
        className="relative mx-auto flex w-full max-w-6xl flex-col gap-14 px-5 pt-16 pb-20 sm:px-8 sm:pt-24 lg:pt-28"
      >
        <div className="grid items-center gap-12 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="flex flex-col gap-6 motion-safe:animate-[hero-rise_0.8s_ease-out_both]">
            <p className="text-[11px] font-medium tracking-[0.24em] text-rose-300/90 uppercase">
              OPEN SOURCE · BROWSER NATIVE · LOCAL FIRST
            </p>
            <h1
              id="hero-title"
              className="font-display text-foreground max-w-3xl text-5xl leading-[0.95] tracking-tight text-balance sm:text-6xl lg:text-7xl"
            >
              Open-source video editing in your browser.
            </h1>
            <p className="text-muted-foreground max-w-xl text-lg leading-relaxed text-pretty">
              A multi-track timeline, local media, and MP4 export. All of it runs in your browser,
              with no uploads and no account.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <TrackedLink
                href="/editor"
                event="open-editor"
                className="bg-rose-500 text-rose-950 hover:bg-rose-400 focus-visible:ring-ring inline-flex items-center rounded-full px-6 py-3 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                Open editor
              </TrackedLink>
              <TrackedLink
                href={GITHUB_URL}
                event="view-source"
                target="_blank"
                rel="noreferrer"
                className="border-border/80 bg-background/40 text-foreground hover:bg-accent focus-visible:ring-ring inline-flex items-center rounded-full border px-6 py-3 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                View source
              </TrackedLink>
            </div>
            <p className="text-muted-foreground text-sm">No uploads. No account. No watermark.</p>
          </div>

          <div className="motion-safe:animate-[hero-rise_0.9s_ease-out_0.12s_both]">
            <TimelineHero />
          </div>
        </div>

        <div className="border-border/70 bg-card/40 relative overflow-hidden rounded-2xl border p-2 shadow-2xl shadow-black/30 motion-safe:animate-[hero-rise_1s_ease-out_0.2s_both] sm:p-3">
          <Image
            src="/screenshots/editor.png"
            alt={SCREENSHOT_ALT}
            width={1600}
            height={1000}
            preload
            loading="eager"
            sizes="(min-width: 1152px) 1088px, 100vw"
            className="border-border/60 h-auto w-full rounded-xl border"
          />
        </div>
      </section>

      <section aria-labelledby="features-title" className="relative border-border/60 border-y">
        <div className="mx-auto w-full max-w-6xl px-5 py-16 sm:px-8">
          <div className="mb-10 flex flex-col gap-3">
            <p className="text-muted-foreground text-[11px] tracking-[0.22em] uppercase">
              Built for the edit
            </p>
            <h2 id="features-title" className="font-display text-3xl tracking-tight sm:text-4xl">
              The timeline is the product.
            </h2>
          </div>
          <div className="grid gap-6 md:grid-cols-3">
            {FEATURES.map((feature) => (
              <article
                key={feature.title}
                className="border-border/70 bg-background/40 flex flex-col gap-3 rounded-xl border p-6"
              >
                <h3 className="text-foreground text-base font-medium">{feature.title}</h3>
                <p className="text-muted-foreground text-sm leading-relaxed">{feature.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section aria-labelledby="faq-title" className="relative">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 py-16 sm:px-8 lg:grid-cols-[0.7fr_1.3fr]">
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-[11px] tracking-[0.22em] uppercase">FAQ</p>
            <h2 id="faq-title" className="font-display text-3xl tracking-tight sm:text-4xl">
              Straight answers.
            </h2>
          </div>
          <dl className="divide-border/70 border-border/70 divide-y border-y">
            {FAQ_ITEMS.map((item) => (
              <div key={item.question} className="grid gap-2 py-5 sm:grid-cols-[0.8fr_1.2fr]">
                <dt className="text-foreground text-sm font-medium">{item.question}</dt>
                <dd className="text-muted-foreground text-sm leading-relaxed">{item.answer}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section className="relative border-border/60 border-t">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-6 px-5 py-16 sm:px-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-[11px] tracking-[0.22em] uppercase">
              Ready when you are
            </p>
            <h2 className="font-display text-3xl tracking-tight sm:text-4xl">
              Start editing in your browser.
            </h2>
          </div>
          <TrackedLink
            href="/editor"
            event="open-editor"
            className="bg-rose-500 text-rose-950 hover:bg-rose-400 focus-visible:ring-ring inline-flex items-center rounded-full px-6 py-3 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            Open editor
          </TrackedLink>
        </div>
      </section>
    </div>
  )
}

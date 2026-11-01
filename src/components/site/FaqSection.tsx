import { FAQ_ITEMS } from '@/lib/seo'

/**
 * The FAQ stays visible on the page, so the FAQPage JSON-LD in the home route
 * remains eligible. It sits after privacy and before the closing CTA.
 */
export function FaqSection() {
  return (
    <section
      aria-labelledby="faq-title"
      className="border-t border-white/5 bg-[var(--site-bg)] py-20 sm:py-28"
    >
      <div className="mx-auto grid w-full max-w-[1288px] gap-12 px-6 lg:grid-cols-[0.7fr_1.3fr]">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.22em] text-rose-400 uppercase">FAQ</p>
          <h2
            id="faq-title"
            className="mt-4 font-display text-4xl leading-[1.05] tracking-[-0.01em] text-[var(--site-text)] sm:text-5xl"
          >
            Questions, answered.
          </h2>
          <p className="mt-4 max-w-sm text-base leading-relaxed text-[var(--site-muted)]">
            The practical answers about privacy, export, and browser support.
          </p>
        </div>

        <dl className="border-t border-white/10">
          {FAQ_ITEMS.map((item) => (
            <div
              key={item.question}
              className="grid gap-3 border-b border-white/10 py-6 sm:grid-cols-[0.8fr_1.2fr] sm:gap-8"
            >
              <dt className="text-base font-medium text-white">{item.question}</dt>
              <dd className="text-sm leading-relaxed text-[var(--site-muted)]">{item.answer}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  )
}

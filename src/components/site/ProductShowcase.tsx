import Image from 'next/image'
import { CircleCheck } from 'lucide-react'

export const SCREENSHOT_ALT =
  'The videoh editor showing the nine-track parity demo with color-bar filmstrips, linked A/V badges, a volume envelope on A2, the Pen tool active in the toolbar, an opacity keyframe curve with dots over the selected V1 video, and the inspector opacity graph above a full-width timeline'

const CHECKLIST = [
  'Multi-track timeline',
  'Text & titles',
  'Transitions & effects',
  'Audio editing',
  'Frame-by-frame control',
  'Keyboard shortcuts',
]

/**
 * The product proof under the hero. The real editor capture sits in the wide
 * right column, with the feature checklist held to a narrow left column so the
 * screenshot keeps the reference's scale.
 */
export function ProductShowcase() {
  return (
    <section
      id="product"
      aria-labelledby="product-title"
      className="relative scroll-mt-24 py-20 sm:py-24"
    >
      <div className="mx-auto grid w-full max-w-[1288px] gap-12 px-6 lg:grid-cols-[0.26fr_0.74fr] lg:items-center lg:gap-8">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.22em] text-rose-400 uppercase">
            Powerful. Yet simple.
          </p>
          <h2
            id="product-title"
            className="mt-4 text-3xl leading-[1.15] font-medium tracking-[-0.03em] text-[var(--site-text)]"
          >
            <span className="block sm:whitespace-nowrap">Everything you need.</span>
            <span className="block sm:whitespace-nowrap">Nothing you don&apos;t.</span>
          </h2>
          <p className="mt-5 max-w-md text-base leading-relaxed text-[var(--site-muted)] sm:text-[1.0625rem]">
            Trim, cut, split, add text, transitions, and more. All in a clean, intuitive interface
            that gets out of your way.
          </p>
          <ul className="mt-8 space-y-4">
            {CHECKLIST.map((item) => (
              <li
                key={item}
                className="flex items-center gap-3 text-[0.9375rem] text-white/90 sm:text-base"
              >
                <CircleCheck
                  aria-hidden="true"
                  className="size-5 shrink-0 text-rose-400 drop-shadow-[0_0_5px_rgba(251,113,133,0.35)]"
                />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative">
          <div
            aria-hidden="true"
            className="absolute inset-[6%] rounded-[2rem] bg-[radial-gradient(ellipse_at_55%_45%,rgba(236,72,153,0.20),rgba(124,58,237,0.14)_40%,transparent_72%)] blur-3xl"
          />
          <Image
            src="/screenshots/editor.png"
            alt={SCREENSHOT_ALT}
            width={1600}
            height={1000}
            loading="lazy"
            sizes="(min-width: 1024px) 900px, 100vw"
            className="relative z-10 h-auto w-full rounded-xl border border-white/10 shadow-[0_30px_80px_rgba(0,0,0,0.55),0_0_60px_rgba(236,72,153,0.08)]"
          />
        </div>
      </div>
    </section>
  )
}

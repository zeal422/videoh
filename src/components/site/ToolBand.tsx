import type { CSSProperties } from 'react'
import { AudioLines, ExternalLink, Scissors, Sparkles, type LucideIcon } from 'lucide-react'

interface Tool {
  label: string
  icon?: LucideIcon
  letter?: string
  a: string
  b: string
  color: string
}

const TOOLS: Tool[] = [
  {
    label: 'Trim',
    icon: Scissors,
    a: 'rgba(244, 63, 94, 0.85)',
    b: 'rgba(251, 146, 60, 0.35)',
    color: '#fb7185',
  },
  {
    label: 'Text',
    letter: 'T',
    a: 'rgba(167, 139, 250, 0.85)',
    b: 'rgba(139, 92, 246, 0.35)',
    color: '#a78bfa',
  },
  {
    label: 'Effects',
    icon: Sparkles,
    a: 'rgba(236, 72, 153, 0.85)',
    b: 'rgba(167, 139, 250, 0.45)',
    color: '#e879f9',
  },
  {
    label: 'Audio',
    icon: AudioLines,
    a: 'rgba(251, 146, 60, 0.85)',
    b: 'rgba(244, 63, 94, 0.35)',
    color: '#fb923c',
  },
  {
    label: 'Export',
    icon: ExternalLink,
    a: 'rgba(251, 191, 36, 0.85)',
    b: 'rgba(251, 146, 60, 0.35)',
    color: '#fbbf24',
  },
]

/**
 * The full-bleed gradient tools band. The tile borders use the same
 * padding-box/border-box gradient technique as the hero card, with one
 * CSS-variable pair per tile so the five accents stay readable.
 */
export function ToolBand() {
  return (
    <section aria-labelledby="tools-title" className="site-tools-band">
      <div className="relative z-10 mx-auto grid w-full max-w-[1288px] gap-12 px-6 py-20 sm:py-24 lg:grid-cols-[0.37fr_0.63fr] lg:items-center lg:gap-20">
        <div className="min-w-0">
          <h2
            id="tools-title"
            className="text-3xl font-medium tracking-[-0.03em] text-white min-[360px]:whitespace-nowrap sm:text-4xl"
          >
            Create without limits.
          </h2>
          <p className="mt-4 max-w-sm text-lg leading-relaxed text-white/70">
            From quick cuts to complex edits, videoh gives you the tools to bring your ideas to
            life.
          </p>
          <div className="mt-8 flex gap-8 sm:gap-10">
            <div>
              <strong className="block text-2xl font-medium text-rose-400 sm:text-3xl">∞</strong>
              <span className="mt-1 block text-sm text-white/80">Projects</span>
            </div>
            <div>
              <strong className="block text-2xl font-medium text-rose-400 sm:text-3xl">4K</strong>
              <span className="mt-1 block text-sm text-white/80">Support</span>
            </div>
            <div>
              <strong className="block text-2xl font-medium text-rose-400 sm:text-3xl">100%</strong>
              <span className="mt-1 block text-sm text-white/80">Free</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-5 gap-3 sm:gap-5 lg:gap-7">
          {TOOLS.map((tool) => {
            const Icon = tool.icon
            return (
              <div key={tool.label} className="flex flex-col items-center gap-3">
                <div
                  className="site-tool-tile flex aspect-square w-full max-w-16 items-center justify-center rounded-2xl sm:max-w-20 lg:max-w-[7.5rem]"
                  style={
                    {
                      '--tile-a': tool.a,
                      '--tile-b': tool.b,
                    } as CSSProperties
                  }
                >
                  {Icon ? (
                    <Icon
                      aria-hidden="true"
                      className="size-7 sm:size-9 lg:size-10"
                      style={{ color: tool.color, filter: `drop-shadow(0 0 8px ${tool.color})` }}
                    />
                  ) : (
                    <span
                      aria-hidden="true"
                      className="font-display text-3xl leading-none sm:text-4xl lg:text-5xl"
                      style={{ color: tool.color, filter: `drop-shadow(0 0 8px ${tool.color})` }}
                    >
                      {tool.letter}
                    </span>
                  )}
                </div>
                <span className="text-xs font-medium text-white sm:text-sm">{tool.label}</span>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

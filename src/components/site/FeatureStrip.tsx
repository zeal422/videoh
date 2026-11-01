import { CloudUpload, Code2, Shield, Zap } from 'lucide-react'

const FEATURES = [
  {
    title: 'Runs in your browser',
    body: 'No installs, no bloat. Just open and edit.',
    icon: Zap,
    className: 'text-amber-300',
  },
  {
    title: 'Your data is yours',
    body: 'Everything stays local. Nothing is uploaded.',
    icon: Shield,
    className: 'text-rose-400',
  },
  {
    title: 'Open source',
    body: 'Built by the community, for the community.',
    icon: Code2,
    className: 'text-amber-300',
  },
  {
    title: 'Export anywhere',
    body: 'Export MP4 with custom settings. Watermark free.',
    icon: CloudUpload,
    className: 'text-amber-300',
  },
]

/**
 * The four promises directly under the hero. The gap-px grid is the divider:
 * the outer surface shows through as a one-pixel line, so the strip keeps the
 * reference's segmented look without four separate border rules.
 */
export function FeatureStrip() {
  return (
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-[var(--site-border)] bg-white/[0.06] sm:grid-cols-2 lg:grid-cols-4">
      {FEATURES.map(({ title, body, icon: Icon, className }) => (
        <div
          key={title}
          className="flex items-center gap-4 bg-[var(--site-panel-strong)] px-5 py-5 sm:px-6 sm:py-6"
        >
          <Icon
            aria-hidden="true"
            className={`size-8 shrink-0 drop-shadow-[0_0_8px_currentColor] ${className}`}
            fill={title === 'Your data is yours' ? 'currentColor' : 'none'}
            fillOpacity={title === 'Your data is yours' ? 0.16 : undefined}
          />
          <div>
            <h3 className="text-[0.9375rem] font-medium text-[var(--site-text)]">{title}</h3>
            <p className="mt-1 text-[0.8125rem] leading-snug text-[var(--site-muted-2)]">{body}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

const WAVEFORM = [
  18, 34, 26, 48, 30, 56, 22, 40, 62, 28, 44, 20, 36, 52, 24, 42, 30, 58, 26, 38, 50, 22, 46, 32,
  54, 24, 40, 28, 60, 20,
]

/**
 * The public hero's decorative timeline. It is CSS only, so the marketing page
 * never mounts an editor element or a browser engine. The card carries the
 * reference's angled perspective and its right-side orange rim; the glow is a
 * separate blurred layer so the card can keep a crisp gradient border.
 *
 * Every animation is motion-safe. Reduced motion renders the same composition
 * without movement.
 */
export function TimelineHero() {
  return (
    <div
      data-testid="timeline-hero"
      aria-hidden="true"
      className="timeline-stack relative mx-auto w-full max-w-[38rem]"
    >
      <div className="timeline-glow motion-safe:animate-[hero-rise_1s_ease-out_0.2s_both]" />
      <div className="timeline-card p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-rose-400 shadow-[0_0_8px_rgba(251,113,133,0.55)]" />
            <span className="size-2 rounded-full bg-amber-300 shadow-[0_0_8px_rgba(251,191,36,0.45)]" />
            <span className="size-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.45)]" />
          </div>
          <span className="text-xs text-[var(--site-muted-2)]">...</span>
        </div>

        <div className="relative flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-[10px] font-semibold text-emerald-400">V1</span>
            <div className="relative h-10 flex-1 overflow-hidden rounded-md border border-white/[0.06] bg-emerald-500/[0.035] sm:h-11">
              <div className="absolute inset-y-1 left-[1%] w-[27%] rounded bg-gradient-to-b from-emerald-400 to-emerald-500 shadow-[0_0_12px_rgba(52,211,153,0.24)] motion-safe:animate-[clip-settle_0.7s_ease-out_both]" />
              <div className="absolute inset-y-1 left-[31%] w-[22%] rounded bg-gradient-to-b from-emerald-400 to-emerald-500 opacity-80 shadow-[0_0_12px_rgba(52,211,153,0.2)] motion-safe:animate-[clip-settle_0.7s_ease-out_0.08s_both]" />
              <div className="absolute inset-y-1 left-[56%] w-[42%] rounded bg-gradient-to-b from-emerald-400 to-emerald-500 shadow-[0_0_12px_rgba(52,211,153,0.24)] motion-safe:animate-[clip-settle_0.7s_ease-out_0.16s_both]" />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-[10px] font-semibold text-amber-300">A1</span>
            <div className="relative h-10 flex-1 overflow-hidden rounded-md border border-white/[0.06] bg-amber-400/[0.035] sm:h-11">
              <div className="flex h-full items-center gap-[2px] px-2">
                {WAVEFORM.map((height, index) => (
                  <span
                    key={index}
                    className="flex-1 rounded-sm bg-amber-300/90 motion-safe:animate-[clip-settle_0.5s_ease-out_both]"
                    style={{ height: `${height}%`, animationDelay: `${index * 18}ms` }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-[10px] font-semibold text-violet-400">T1</span>
            <div className="relative h-8 flex-1 overflow-hidden rounded-md border border-white/[0.06] bg-violet-400/[0.035] sm:h-9">
              <div className="absolute inset-y-1 left-[8%] w-[38%] rounded bg-gradient-to-b from-violet-500 to-violet-600 opacity-90 motion-safe:animate-[clip-settle_0.7s_ease-out_0.2s_both]" />
              <div className="absolute inset-y-1 left-[50%] w-[20%] rounded bg-gradient-to-b from-violet-500 to-violet-600 opacity-80 motion-safe:animate-[clip-settle_0.7s_ease-out_0.28s_both]" />
              <div className="absolute inset-y-1 left-[73%] w-[13%] rounded bg-gradient-to-b from-violet-500 to-violet-600 opacity-80 motion-safe:animate-[clip-settle_0.7s_ease-out_0.34s_both]" />
              <div className="absolute inset-y-1 left-[89%] w-[10%] rounded bg-gradient-to-b from-violet-500 to-violet-600 opacity-80 motion-safe:animate-[clip-settle_0.7s_ease-out_0.4s_both]" />
            </div>
          </div>

          <span className="pointer-events-none absolute -top-1 -bottom-1 left-[47%] z-20 w-px bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.9),0_0_16px_rgba(244,63,94,0.45)] motion-safe:animate-[playhead-sweep_7s_ease-in-out_infinite]">
            <span className="absolute -top-0.5 -left-[3px] size-2 rounded-full bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.9)]" />
          </span>
        </div>
      </div>
    </div>
  )
}

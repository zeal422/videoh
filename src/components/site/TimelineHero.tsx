const WAVEFORM = [18, 34, 26, 48, 30, 56, 22, 40, 62, 28, 44, 20, 36, 52, 24, 42, 30, 58, 26, 38]

/**
 * Decorative timeline made from divs and CSS only. It borrows the editor's
 * kind colours and its one rose playhead; amber stays a small secondary
 * accent. Every animation is motion-safe, so reduced motion renders the
 * same strip without movement.
 */
export function TimelineHero() {
  return (
    <div
      data-testid="timeline-hero"
      aria-hidden="true"
      className="border-border/70 relative overflow-hidden rounded-2xl border bg-zinc-950/90 p-4 shadow-2xl shadow-black/40 sm:p-5"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-rose-500/80" />
          <span className="size-2 rounded-full bg-amber-300/80" />
          <span className="size-2 rounded-full bg-emerald-400/80" />
        </div>
        <span className="text-[10px] tracking-[0.2em] text-zinc-500 uppercase">
          Timeline 00:00:14:08
        </span>
      </div>

      <div className="relative flex flex-col gap-2">
        <div className="absolute inset-y-0 left-[47%] z-20 w-px bg-rose-500 motion-safe:animate-[playhead-sweep_7s_ease-in-out_infinite]">
          <span className="absolute -top-1 -left-1 size-2 rounded-full bg-rose-500" />
        </div>

        <div className="flex items-center gap-3">
          <span className="w-6 shrink-0 text-[10px] font-medium text-emerald-400">V1</span>
          <div className="relative h-12 flex-1 overflow-hidden rounded-md border border-emerald-400/20 bg-emerald-950/20">
            <div className="absolute inset-y-1 left-[2%] w-[28%] rounded bg-emerald-500/80 motion-safe:animate-[clip-settle_0.7s_ease-out_both]" />
            <div className="absolute inset-y-1 left-[33%] w-[23%] rounded bg-emerald-500/65 motion-safe:animate-[clip-settle_0.7s_ease-out_0.08s_both]" />
            <div className="absolute inset-y-1 left-[59%] w-[34%] rounded bg-emerald-500/80 motion-safe:animate-[clip-settle_0.7s_ease-out_0.16s_both]" />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="w-6 shrink-0 text-[10px] font-medium text-amber-300">A1</span>
          <div className="relative flex h-12 flex-1 items-end gap-[2px] overflow-hidden rounded-md border border-amber-300/20 bg-amber-950/20 px-2 py-2">
            {WAVEFORM.map((height, index) => (
              <span
                key={index}
                className="flex-1 rounded-sm bg-amber-300/70 motion-safe:animate-[clip-settle_0.5s_ease-out_both]"
                style={{ height: `${height}%`, animationDelay: `${index * 18}ms` }}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="w-6 shrink-0 text-[10px] font-medium text-violet-400">T1</span>
          <div className="relative h-10 flex-1 overflow-hidden rounded-md border border-violet-400/20 bg-violet-950/20">
            <div className="absolute inset-y-1 left-[12%] w-[36%] rounded bg-violet-500/75 motion-safe:animate-[clip-settle_0.7s_ease-out_0.2s_both]" />
            <div className="absolute inset-y-1 left-[52%] w-[18%] rounded bg-violet-500/60 motion-safe:animate-[clip-settle_0.7s_ease-out_0.28s_both]" />
          </div>
        </div>
      </div>
    </div>
  )
}

import type { ReactNode } from 'react'

export function LegalPage({
  title,
  intro,
  lastUpdated,
  children,
}: {
  title: string
  intro?: string
  lastUpdated: string
  children: ReactNode
}) {
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-5 py-16 sm:px-8 sm:py-20">
      <header className="flex flex-col gap-4">
        <p className="text-muted-foreground text-[11px] tracking-[0.22em] uppercase">videoh</p>
        <h1 className="font-display text-4xl tracking-tight sm:text-5xl">{title}</h1>
        {intro ? <p className="text-muted-foreground max-w-2xl text-lg">{intro}</p> : null}
        <p className="text-muted-foreground text-xs">Last updated {lastUpdated}</p>
      </header>
      <div className="text-foreground/90 flex flex-col gap-6 text-sm leading-relaxed [&_a]:underline [&_a]:underline-offset-4 [&_h2]:text-lg [&_h2]:font-medium [&_li]:ml-5 [&_li]:list-disc [&_p]:max-w-2xl [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2">
        {children}
      </div>
    </article>
  )
}

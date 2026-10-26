'use client'

import { useEffect, useState } from 'react'
import type { ComponentType } from 'react'

import { Preloader } from '@/components/editor/Preloader'
import { applyTheme, themeStorage } from '@/components/editor/apply-theme'
import { Button } from '@/components/ui/button'
import { readTheme } from '@/lib/editor/theme'

/**
 * videoh, a browser-based editor.
 *
 * The entire app is client-side (object URLs, canvas compositing, Web Audio,
 * WebCodecs), and the initial document contains randomly generated ids, so
 * the shell loads client-only to avoid SSR hydration mismatches.
 *
 * The shell chunk loads in an effect while the preloader shows; the reveal
 * waits for both the import and a 3.2s minimum show. That holds first paint
 * up to ~3.2s on fast loads; the branding moment is the requested design,
 * not an accident. The swap is manual on purpose: next/dynamic's loading
 * boundary remounts its fallback after hydration (measured ~245ms, which
 * visibly restarted the wave), while this keeps one stable preloader DOM
 * from SSR through the reveal. A rejected chunk import surfaces a retry
 * instead of hanging on the preloader.
 */
const MIN_SHOW_MS = 3200

export function EditorBoot() {
  const [Shell, setShell] = useState<ComponentType | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    applyTheme(readTheme(themeStorage()))
  }, [])
  useEffect(() => {
    let cancelled = false
    setFailed(false)
    void Promise.all([
      import('@/components/editor/EditorShell'),
      new Promise((resolve) => setTimeout(resolve, MIN_SHOW_MS)),
    ])
      .then(([mod]) => {
        // Functional-update form: passing mod.default directly would make
        // React call it as an updater instead of storing it.
        if (!cancelled) setShell(() => mod.default)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [attempt])
  if (Shell !== null) return <Shell />
  if (failed) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-background text-foreground">
        <div className="flex max-w-xs flex-col items-center gap-3 text-center" role="alert">
          <p className="text-sm text-muted-foreground">The editor failed to load.</p>
          <div className="flex gap-2">
            <Button type="button" onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </Button>
            {attempt >= 1 && (
              <Button type="button" variant="outline" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            )}
          </div>
        </div>
      </div>
    )
  }
  return <Preloader />
}

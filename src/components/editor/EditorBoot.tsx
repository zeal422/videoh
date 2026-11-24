'use client'

import { memo, useEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'

import { Preloader } from '@/components/editor/Preloader'
import { applyTheme, themeStorage } from '@/components/editor/apply-theme'
import { Button } from '@/components/ui/button'
import { readTheme } from '@/lib/editor/theme'
import { trackPageView } from '@/lib/analytics'

/**
 * videoh, a browser-based editor.
 *
 * The entire app is client-side (object URLs, canvas compositing, Web Audio,
 * WebCodecs), and the initial document contains randomly generated ids, so
 * the shell loads client-only to avoid SSR hydration mismatches.
 *
 * The shell chunk loads in an effect while the preloader shows. The pull runs
 * untouched to its 2.4s depth split, then holds that frame while the shell
 * mounts behind it; the hold releases into a short tail, and the strip exit
 * starts on the bloom peak around 2.44s, so the strips carry that light with
 * them instead of starting after it faded. The hold is measured from the
 * pull's actual progress, so a slow hydration cannot add a dead pause. That
 * holds first paint up to ~2.44s on fast loads; the branding moment is the
 * requested design, not an accident. The swap is manual on purpose: next/dynamic's loading
 * boundary remounts its fallback after hydration (measured ~245ms, which
 * visibly restarted the preloader), while this keeps one stable preloader DOM
 * from SSR through the reveal. A rejected chunk import surfaces a retry
 * instead of hanging on the preloader.
 *
 * The handoff is a one-shot strip exit, not a hard swap. The shell mounts
 * behind the held pull frame, and the preloader's six uneven bands feather
 * and slide away over 1s while the editor racks into focus.
 * Because the overlay is already on screen and its pull has settled, the exit
 * adds no load time and never replays the pull. The shell is mounted inert and
 * receives `interactive: false` until reveal, so no keyboard shortcut or
 * version greeting can fire behind the veil; the full reveal lands at about
 * 3.44s (the 2.44s pull plus the 1s exit). Reduced motion skips the exit and
 * reveals the shell at 2.44s.
 */
const MIN_SHOW_MS = 2438
const HOLD_MS = 2400
const HOLD_FRAME_MS = 16
const EXIT_MS = 1000

type BootPhase = 'loading' | 'exiting' | 'revealed'
type ShellComponent = ComponentType<{ interactive?: boolean }>

function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * The preference is live, not sampled once: a user can flip reduce-motion
 * while the pull is running, and the boot must switch timelines instead of
 * finishing the one it started with.
 */
function useReducedMotion() {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    }
    query.addListener(onChange)
    return () => query.removeListener(onChange)
  }, [])
  return reduced
}

function pullTimeTo(targetMs: number, fallbackElapsedMs: number) {
  if (typeof document === 'undefined') return Math.max(0, targetMs - fallbackElapsedMs)
  const word = document.querySelector<HTMLElement>('.preloader-word')
  const animation = word?.getAnimations?.()[0]
  const elapsed =
    typeof animation?.currentTime === 'number' ? animation.currentTime : fallbackElapsedMs
  return Math.max(0, targetMs - elapsed)
}

/**
 * The shell mounts behind the held pull frame. The memo keeps the hold
 * release and the exit phase flip from re-rendering the whole editor.
 */
const ShellHost = memo(function ShellHost({
  component: Component,
  interactive,
}: {
  component: ShellComponent
  interactive: boolean
}) {
  return <Component interactive={interactive} />
})

export function EditorBoot() {
  const [Shell, setShell] = useState<ShellComponent | null>(null)
  const [phase, setPhase] = useState<BootPhase>('loading')
  const [hold, setHold] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [shellReady, setShellReady] = useState(false)
  const shellModule = useRef<ShellComponent | null>(null)
  const pageViewSent = useRef(false)
  // The boot clock resets per attempt, so a retry gets its own minimum show
  // instead of inheriting the failed attempt's elapsed time.
  const bootStartedAt = useRef<number | null>(null)
  const reducedMotion = useReducedMotion()
  const elapsedSinceBoot = () =>
    bootStartedAt.current === null ? 0 : performance.now() - bootStartedAt.current
  useEffect(() => {
    bootStartedAt.current = performance.now()
  }, [attempt])
  useEffect(() => {
    applyTheme(readTheme(themeStorage()))
  }, [])
  useEffect(() => {
    // One editor page view per mount. The ref survives Strict Mode's double
    // effect but not an unmount, so navigating away and back sends again.
    if (pageViewSent.current) return
    pageViewSent.current = true
    trackPageView(window.location.pathname)
  }, [])
  useEffect(() => {
    let cancelled = false
    void import('@/components/editor/EditorShell')
      .then((mod) => {
        if (cancelled) return
        shellModule.current = mod.default
        setShellReady(true)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [attempt])
  useEffect(() => {
    if (phase !== 'loading' || reducedMotion || hold || Shell !== null) return
    // Hold the pull at the 2.4s depth split while the shell mounts behind it.
    // The fallback uses wall time, so a slow hydration with no animation API
    // cannot add a second full hold.
    const timer = setTimeout(() => setHold(true), pullTimeTo(HOLD_MS, elapsedSinceBoot()))
    return () => clearTimeout(timer)
  }, [phase, attempt, hold, Shell, reducedMotion])
  useEffect(() => {
    if (!reducedMotion || !shellReady || phase !== 'loading') return
    // Reduced motion holds the settled lockup, then reveals the mounted shell
    // once the minimum show is spent. The wait is the remainder of the boot
    // contract, not a fresh 2.44s after a slow import.
    const timer = setTimeout(
      () => {
        if (shellModule.current === null) return
        setShell(() => shellModule.current)
        setPhase('revealed')
      },
      Math.max(0, MIN_SHOW_MS - elapsedSinceBoot()),
    )
    return () => clearTimeout(timer)
  }, [reducedMotion, shellReady, phase, attempt])
  useEffect(() => {
    if (!hold || !shellReady || Shell !== null) return
    // The held frame has painted; mount the shell behind it.
    const timer = setTimeout(() => {
      if (shellModule.current !== null) setShell(() => shellModule.current)
    }, HOLD_FRAME_MS)
    return () => clearTimeout(timer)
  }, [hold, shellReady, Shell])
  useEffect(() => {
    if (!hold || Shell === null) return
    // Let the mount commit paint while the pull is frozen, then resume into
    // the bloom peak. The shell is already mounted before the strip exit starts.
    const timer = setTimeout(() => setHold(false), HOLD_FRAME_MS)
    return () => clearTimeout(timer)
  }, [hold, Shell])
  useEffect(() => {
    if (hold || Shell === null || phase !== 'loading') return
    // The pull resumes from 2.4s; the exit starts on the bloom peak.
    const timer = setTimeout(() => setPhase('exiting'), pullTimeTo(MIN_SHOW_MS, HOLD_MS))
    return () => clearTimeout(timer)
  }, [hold, Shell, phase, attempt])
  useEffect(() => {
    if (phase !== 'exiting') return
    // A reduce-motion request mid-exit skips the rest of the strips instead
    // of leaving the user under an animation they asked to stop.
    const timer = setTimeout(() => setPhase('revealed'), reducedMotion ? 0 : EXIT_MS)
    return () => clearTimeout(timer)
  }, [phase, reducedMotion])
  if (failed) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-background text-foreground">
        <div className="flex max-w-xs flex-col items-center gap-3 text-center" role="alert">
          <p className="text-sm text-muted-foreground">The editor failed to load.</p>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => {
                setFailed(false)
                setPhase('loading')
                setHold(false)
                setShellReady(false)
                setShell(null)
                shellModule.current = null
                setAttempt((a) => a + 1)
              }}
            >
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
  return (
    <>
      <div
        className="preloader-editor-rack"
        data-exiting={phase === 'exiting' ? 'true' : undefined}
        inert={phase !== 'revealed'}
      >
        <div className="preloader-editor-rack-stage">
          {Shell !== null && (
            <ShellHost key="shell" component={Shell} interactive={phase === 'revealed'} />
          )}
        </div>
      </div>
      {phase !== 'revealed' && (
        <Preloader key="preloader" exiting={phase === 'exiting'} hold={hold} />
      )}
    </>
  )
}

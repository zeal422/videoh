'use client'

import dynamic from 'next/dynamic'

/**
 * Web Video Editor — single-page editor.
 *
 * The entire app is client-side (object URLs, canvas compositing, Web Audio,
 * MediaRecorder), and the initial document contains randomly generated ids, so
 * the shell is loaded client-only to avoid SSR hydration mismatches.
 */
const EditorShell = dynamic(() => import('@/components/editor/EditorShell'), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh w-full items-center justify-center bg-background text-foreground">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="size-2 animate-pulse rounded-full bg-rose-500" />
        Loading editor…
      </div>
    </div>
  ),
})

export default function Home() {
  return <EditorShell />
}

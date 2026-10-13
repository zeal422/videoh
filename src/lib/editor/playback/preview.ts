'use client'

import { docDuration } from '../factories'
import { effectiveMediaUrl } from '../media/proxies'
import { useEditorStore } from '../store'
import type { PlaybackController } from './engine-ref'
import { playbackRef } from './engine-ref'
import { PlaybackCore } from './core'

/**
 * App-wide preview engine singleton. `attachPreviewEngine(canvas)` is called
 * once by the PreviewPanel; all other UI goes through `playbackRef`.
 */
let core: PlaybackCore | null = null

export function attachPreviewEngine(canvas: HTMLCanvasElement): PlaybackController {
  core?.dispose()
  core = new PlaybackCore({
    canvas,
    getDoc: () => useEditorStore.getState().doc,
    resolveMediaUrl: effectiveMediaUrl,
    getActiveSequencePath: () => useEditorStore.getState().activeSequencePath,
    onFrame: (t) => {
      const state = useEditorStore.getState()
      if (state.playhead !== t) state.setPlayhead(t)
    },
    onPlayingChange: (playing) => {
      const state = useEditorStore.getState()
      if (state.playing !== playing) state.setPlaying(playing)
    },
    onEnd: () => undefined,
  })

  const controller: PlaybackController = {
    play: () => void core?.play(),
    pause: () => core?.pause(),
    toggle: () => core?.toggle(),
    seek: (t: number) => core?.seek(t),
    stepFrames: (n: number) => core?.stepFrames(n),
    setMasterVolume: (v: number) => core?.setMasterVolume(v),
    get isExporting() {
      return playbackRef.current?.isExporting ?? false
    },
  }
  playbackRef.current = controller
  return controller
}

/** Detaches (and disposes) the preview engine — used on unmount. */
export function detachPreviewEngine(): void {
  core?.dispose()
  core = null
  playbackRef.current = null
}

/** Draws the current playhead frame when paused (called after doc edits). */
export function refreshPausedPreview(): void {
  if (core && !core.isPlaying) {
    core.seek(useEditorStore.getState().playhead)
  }
}

/** Convenience: seek to the end of the timeline. */
export function seekToEnd(): void {
  playbackRef.current?.seek(docDuration(useEditorStore.getState().doc))
}

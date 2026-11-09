'use client'

import { nextVideoKeyframe } from '../media/keyframes'
import { effectiveMediaUrl } from '../media/proxies'
import { useEditorStore } from '../store'
import { formatTransportTime } from '../time'
import { toast } from '@/hooks/use-toast'
import type { PlaybackController } from './engine-ref'
import { playbackRef } from './engine-ref'
import { PlaybackCore, type MediaErrorInfo } from './core'
import { createScrubFrameSource } from './scrub-source'

/**
 * App-wide preview engine singleton. `attachPreviewEngine(canvas)` is called
 * once by the PreviewPanel; all other UI goes through `playbackRef`.
 */
let core: PlaybackCore | null = null

/** Cause-specific titles for the audio-only toast, keyed by MediaError.code. */
const AUDIO_ERROR_TITLES: Record<number, string> = {
  1: 'Audio playback was interrupted',
  2: 'Audio could not be loaded',
  4: 'Audio source is not supported',
}

/**
 * Routes a playback media notice. An audio-only failure is a toast, never a
 * shared notice: it must not replace a picture-damage or skipped-media notice
 * that is already showing.
 */
export function handlePreviewMediaError(info: MediaErrorInfo | null, clipId?: string): void {
  if (info?.audioOnly) {
    toast({
      title: AUDIO_ERROR_TITLES[info.code] ?? 'Audio could not be decoded',
      description: `The audio at ${formatTransportTime(info.time)} is muted so the picture keeps playing.`,
    })
    return
  }
  useEditorStore.getState().setMediaError(info, clipId)
}

export function attachPreviewEngine(canvas: HTMLCanvasElement): PlaybackController {
  core?.dispose()
  useEditorStore.getState().clearMediaError()
  core = new PlaybackCore({
    canvas,
    getDoc: () => useEditorStore.getState().doc,
    resolveMediaUrl: effectiveMediaUrl,
    getActiveSequencePath: () => useEditorStore.getState().activeSequencePath,
    getProjectEpoch: () => useEditorStore.getState().projectEpoch,
    nextKeyframe: (url, sourceTime) => nextVideoKeyframe(url, sourceTime),
    onMediaError: handlePreviewMediaError,
    onPreviewRecovering: (recovering) => useEditorStore.getState().setPreviewRecovering(recovering),
    createScrubSource: () => createScrubFrameSource(),
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
  }
  playbackRef.current = controller
  return controller
}

/** Detaches (and disposes) the preview engine — used on unmount. */
export function detachPreviewEngine(): void {
  core?.dispose()
  core = null
  playbackRef.current = null
  useEditorStore.getState().clearMediaError()
}

/** Draws the current playhead frame when paused (called after doc edits). */
export function refreshPausedPreview(): void {
  if (core && !core.isPlaying) {
    core.refresh(useEditorStore.getState().playhead)
  }
}

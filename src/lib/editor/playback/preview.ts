'use client'

import { createElement } from 'react'

import { ToastAction, type ToastActionElement } from '@/components/ui/toast'
import { nextVideoKeyframe } from '../media/keyframes'
import { findClip, findMedia } from '../factories'
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
    const state = useEditorStore.getState()
    const mutedId = clipId ?? info.clipId
    const found = mutedId ? findClip(state.doc, mutedId) : undefined
    const asset = found ? findMedia(state.doc, found.clip.mediaId) : undefined
    const name = found?.clip.text ?? asset?.name ?? 'Audio'
    const at = formatTransportTime(info.time)
    const description = state.playing
      ? `${name} at ${at} was muted so the picture can continue. Press Play or Retry to reconnect it.`
      : `${name} at ${at} has a decode error. Retry to reconnect the audio.`
    const actionElement = createElement(
      ToastAction,
      { altText: 'Retry audio', onClick: () => playbackRef.current?.retryAudio(mutedId) },
      'Retry',
    )
    toast({
      title: AUDIO_ERROR_TITLES[info.code] ?? 'Audio could not be decoded',
      description,
      action: actionElement as unknown as ToastActionElement,
    })
    return
  }
  useEditorStore.getState().setMediaError(info, clipId)
}

export function attachPreviewEngine(canvas: HTMLCanvasElement): PlaybackController {
  core?.dispose()
  useEditorStore.getState().clearMediaError()
  useEditorStore.getState().clearAudioMuted()
  core = new PlaybackCore({
    canvas,
    getDoc: () => useEditorStore.getState().doc,
    resolveMediaUrl: effectiveMediaUrl,
    getActiveSequencePath: () => useEditorStore.getState().activeSequencePath,
    getProjectEpoch: () => useEditorStore.getState().projectEpoch,
    nextKeyframe: (url, sourceTime) => nextVideoKeyframe(url, sourceTime),
    onMediaError: handlePreviewMediaError,
    onAudioMutedChange: (clipId, muted) => useEditorStore.getState().setAudioMuted(clipId, muted),
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
    retryAudio: (clipId?: string) => core?.retryAudio(clipId),
    noteDocChanged: (doc) => core?.noteDocChanged(doc),
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
  useEditorStore.getState().clearAudioMuted()
}

/** Draws the current playhead frame when paused (called after doc edits). */
export function refreshPausedPreview(): void {
  if (core && !core.isPlaying) {
    core.refresh(useEditorStore.getState().playhead)
  }
}

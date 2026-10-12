'use client'

import { effectiveMediaUrl } from '../media/proxies'
import { useEditorStore } from '../store'
import type { MediaAsset } from '../types'

/**
 * Source monitor element lifecycle (three-point editing).
 *
 * A small singleton in the shape of `playback/preview.ts`: ONE `<video>`
 * element for the selected asset, owned here (browser APIs stay in
 * `media/`, `playback/`, `export/`). There is no sequence engine, no audio
 * graph and no waveform in this version: the element is a plain preview whose
 * playback and seek callbacks write `sourcePlayhead`, the ONE owner of the
 * source time. `attachSourcePreview` releases the previous element first, so
 * changing the selected asset (or unmounting the panel) never leaves a second
 * live element behind.
 */

let element: HTMLVideoElement | null = null
let notify: (() => void) | null = null

/** Mounts the element for `asset` inside `host`, releasing any previous one. */
export function attachSourcePreview(
  host: HTMLElement,
  asset: MediaAsset,
  onStateChange?: () => void,
): void {
  detachSourcePreview()
  notify = onStateChange ?? null
  const el = document.createElement('video')
  el.dataset.testid = 'source-preview'
  el.setAttribute('aria-label', `${asset.name} source preview`)
  el.playsInline = true
  el.preload = 'metadata'
  const url = effectiveMediaUrl(asset)
  if (url) el.src = url
  el.addEventListener('timeupdate', () => writeTime(el))
  el.addEventListener('seeked', () => writeTime(el))
  el.addEventListener('play', () => notify?.())
  el.addEventListener('pause', () => notify?.())
  el.addEventListener('ended', () => notify?.())
  host.appendChild(el)
  element = el
  writeTime(el)
  notify?.()
}

/** Releases the element (paused, src dropped, removed from the DOM). */
export function detachSourcePreview(): void {
  const el = element
  element = null
  notify = null
  if (!el) return
  el.pause()
  el.removeAttribute('src')
  el.remove()
}

export function sourcePreviewPlay(): void {
  const el = element
  if (!el) return
  void el.play().catch(() => {
    /* autoplay refusal: the transport just stays paused */
  })
}

export function sourcePreviewPause(): void {
  element?.pause()
}

/** Seeks the source element and records the position in the store. */
export function sourcePreviewSeek(t: number): void {
  const el = element
  if (!el) return
  el.currentTime = t
  writeTime(el)
}

export function sourcePreviewIsPlaying(): boolean {
  return !!element && !element.paused
}

function writeTime(el: HTMLVideoElement): void {
  useEditorStore.getState().setSourcePlayhead(el.currentTime)
}

import type { Clip, MediaAsset } from '../types'

/**
 * Per-clip HTMLMediaElement pool.
 *
 * Each clip gets its OWN video/audio element (two clips may reference the same
 * asset simultaneously — e.g. after a split or across tracks). Elements are
 * parked in a hidden container so browsers schedule them reliably.
 *
 * The pool also hands out `MediaElementAudioSourceNode`s (one per element per
 * AudioContext) so the playback engine can route element audio through the
 * Web Audio graph for gain/mute/mixing.
 */
export class ClipMediaPool {
  private els = new Map<string, HTMLVideoElement | HTMLAudioElement>()
  private srcNodes = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()
  private container: HTMLDivElement | null = null

  private ensureContainer(): HTMLDivElement {
    if (this.container) return this.container
    const el = document.createElement('div')
    el.setAttribute('aria-hidden', 'true')
    el.style.cssText =
      'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;'
    document.body.appendChild(el)
    this.container = el
    return el
  }

  /** Returns the element for this clip, creating it (or re-creating after relink). */
  get(clip: Clip, asset: MediaAsset): HTMLVideoElement | HTMLAudioElement {
    const existing = this.els.get(clip.id)
    if (existing && existing.dataset.assetId === asset.id && existing.src === asset.url) {
      return existing
    }
    if (existing) this.release(clip.id)

    const el =
      asset.kind === 'video' ? document.createElement('video') : document.createElement('audio')
    el.dataset.assetId = asset.id
    el.preload = 'auto'
    el.src = asset.url
    if (el instanceof HTMLVideoElement) {
      el.playsInline = true
      // Video elements double as compositor sources; audio must stay audible.
      el.muted = false
    }
    this.ensureContainer().appendChild(el)
    this.els.set(clip.id, el)
    return el
  }

  /** One MediaElementAudioSourceNode per element per context. */
  getSourceNode(el: HTMLMediaElement, ctx: AudioContext): MediaElementAudioSourceNode {
    const cached = this.srcNodes.get(el)
    if (cached) return cached
    const node = ctx.createMediaElementSource(el)
    this.srcNodes.set(el, node)
    return node
  }

  /** Every pooled clip id (the playback engine reconciles against the doc). */
  ids(): string[] {
    return [...this.els.keys()]
  }

  /** The pooled element for a clip id, undefined when none is pooled. */
  peek(clipId: string): HTMLVideoElement | HTMLAudioElement | undefined {
    return this.els.get(clipId)
  }

  pauseAll(): void {
    for (const el of this.els.values()) {
      if (!el.paused) el.pause()
    }
  }

  release(clipId: string): void {
    const el = this.els.get(clipId)
    if (!el) return
    el.pause()
    el.removeAttribute('src')
    try {
      el.load()
    } catch {
      // detached elements may throw — ignore
    }
    el.remove()
    this.els.delete(clipId)
  }

  dispose(): void {
    for (const id of [...this.els.keys()]) this.release(id)
    this.container?.remove()
    this.container = null
  }
}

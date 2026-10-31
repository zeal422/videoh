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
 *
 * A clip reading below the source frame rate additionally parks a MUTED second
 * element on the blend partner read (`getNext`), kept out of the audio graph.
 */
export class ClipMediaPool {
  constructor(private onError?: (clipId: string, el: HTMLMediaElement) => void) {}

  private els = new Map<string, HTMLVideoElement | HTMLAudioElement>()
  /**
   * Parked "next frame" elements for sub-frame-rate blending (0.7.0), one per
   * blended clip, kept apart from `els` so every existing rule still sees
   * exactly one element per clip (the audio graph, the release pass, `ids()`).
   */
  private nextEls = new Map<string, HTMLVideoElement>()
  private srcNodes = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()
  private errorHandlers = new WeakMap<HTMLMediaElement, () => void>()
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

  /**
   * Returns the element for this clip, creating it (or re-creating after relink
   * or a proxy URL change). `url` is the effective source URL: the original by
   * default, or the proxy when proxies are enabled and ready.
   */
  get(clip: Clip, asset: MediaAsset, url: string = asset.url): HTMLVideoElement | HTMLAudioElement {
    const wantsAudio = asset.kind !== 'video' || clip.audioOnly === true
    // A clip that reads audio only must not keep a stale parked video partner.
    if (wantsAudio) this.releaseNext(clip.id)
    const existing = this.els.get(clip.id)
    if (
      existing &&
      existing.dataset.assetId === asset.id &&
      existing.getAttribute('src') === url &&
      existing instanceof HTMLAudioElement === wantsAudio
    ) {
      return existing
    }
    if (existing) this.release(clip.id)

    const el = this.create(clip.id, asset, url, clip.audioOnly === true)
    if (el instanceof HTMLVideoElement) el.muted = false // it must stay audible
    this.els.set(clip.id, el)
    return el
  }

  /**
   * The parked element showing the frame AFTER this clip's current one, for
   * sub-frame-rate blending, or undefined for a non-video asset. Created (or
   * re-created after a relink or proxy change) on demand; positioned by the
   * playback engine.
   *
   * It is MUTED: it must never add a second copy of the clip's audio, and it is
   * never handed to `getSourceNode`, so it stays out of the Web Audio graph.
   */
  getNext(clip: Clip, asset: MediaAsset, url: string = asset.url): HTMLVideoElement | undefined {
    if (asset.kind !== 'video' || clip.audioOnly) {
      this.releaseNext(clip.id)
      return undefined
    }
    const existing = this.nextEls.get(clip.id)
    if (existing && existing.dataset.assetId === asset.id && existing.getAttribute('src') === url) {
      return existing
    }
    if (existing) this.releaseNext(clip.id)
    const el = this.create(clip.id, asset, url, false) as HTMLVideoElement
    el.muted = true
    this.nextEls.set(clip.id, el)
    return el
  }

  /** Creates a hidden element wired to a URL and parks it in the container. */
  private create(
    clipId: string,
    asset: MediaAsset,
    url: string,
    audioOnly: boolean,
  ): HTMLVideoElement | HTMLAudioElement {
    const el =
      asset.kind === 'video' && !audioOnly
        ? document.createElement('video')
        : document.createElement('audio')
    el.dataset.assetId = asset.id
    el.preload = 'auto'
    el.src = url
    if (el instanceof HTMLVideoElement) el.playsInline = true
    const onError = () => this.onError?.(clipId, el)
    el.addEventListener('error', onError)
    this.errorHandlers.set(el, onError)
    this.ensureContainer().appendChild(el)
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

  /** The parked blend partner of a clip, undefined when none is pooled. */
  peekNext(clipId: string): HTMLVideoElement | undefined {
    return this.nextEls.get(clipId)
  }

  /** Every clip id holding a parked blend partner. */
  nextIds(): string[] {
    return [...this.nextEls.keys()]
  }

  pauseAll(): void {
    for (const el of this.els.values()) {
      if (!el.paused) el.pause()
    }
    for (const el of this.nextEls.values()) {
      if (!el.paused) el.pause()
    }
  }

  release(clipId: string): void {
    const el = this.els.get(clipId)
    if (!el) return
    // Drop the map entry first: teardown is best-effort and must not leave a
    // released element discoverable through peek().
    this.els.delete(clipId)
    this.teardown(el)
  }

  /** Drops a clip's parked blend partner, leaving the clip's own element alone. */
  releaseNext(clipId: string): void {
    const el = this.nextEls.get(clipId)
    if (!el) return
    this.nextEls.delete(clipId)
    this.teardown(el)
  }

  private teardown(el: HTMLMediaElement): void {
    // Detach first: load() on an empty source can emit an error, and a
    // listener that outlives the pool entry would report a phantom decode.
    const onError = this.errorHandlers.get(el)
    if (onError) {
      el.removeEventListener('error', onError)
      this.errorHandlers.delete(el)
    }
    try {
      el.pause()
    } catch {
      // already detached
    }
    try {
      el.removeAttribute('src')
    } catch {
      // already detached
    }
    try {
      el.load()
    } catch {
      // detached elements may throw; ignore
    }
    try {
      el.remove()
    } catch {
      // already detached
    }
  }

  dispose(): void {
    for (const id of [...this.els.keys()]) this.release(id)
    for (const id of [...this.nextEls.keys()]) this.releaseNext(id)
    this.container?.remove()
    this.container = null
  }
}

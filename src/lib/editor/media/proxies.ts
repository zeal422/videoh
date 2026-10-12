import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
} from 'mediabunny'
import { pickAudioCodec } from '../export/mp4'
import { planProxy, type ProxyPlan } from '../proxy'
import { useEditorStore } from '../store'
import type { MediaAsset } from '../types'

/**
 * Proxy registry (0.8.0). Browser-bound: builds a lower-resolution A/V stand-in
 * for a heavy source with the installed mediabunny stack, owns the resulting
 * object URLs, and installs them into the session store slice.
 *
 * Session-only by design: the URL is revoked on relink, removal or project
 * open, and a build in flight for a stale source never installs over a fresh
 * one (a per-asset generation token).
 */

const AUDIO_BITRATE = 192_000

/** Per-asset build generation: a bump invalidates any in-flight build. */
const generations = new Map<string, number>()

/**
 * The effective source URL for an asset: the proxy URL when proxies are on and
 * that asset's proxy is ready, else the original.
 */
export function effectiveMediaUrl(asset: MediaAsset): string {
  const state = useEditorStore.getState()
  if (!state.proxiesEnabled) return asset.url
  const entry = state.proxyByAssetId[asset.id]
  return entry?.status === 'ready' && entry.url ? entry.url : asset.url
}

/** Decodes a file to an AudioBuffer, mirroring the exporter's mechanism. */
async function decodeAudio(file: File): Promise<AudioBuffer | null> {
  if (typeof OfflineAudioContext === 'undefined') return null
  const ctx = new OfflineAudioContext(2, 1, 48_000)
  try {
    return await ctx.decodeAudioData(await file.arrayBuffer())
  } catch {
    return null
  }
}

/** Transcodes a file to a lower-resolution A/V MP4 blob per the plan. */
async function transcode(file: File, plan: ProxyPlan): Promise<Blob> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })
  const videoTrack = await input.getPrimaryVideoTrack()
  if (!videoTrack) throw new Error('Proxy source has no video track')

  const sink = new CanvasSink(videoTrack, {
    width: plan.width,
    height: plan.height,
    fit: 'contain',
  })
  const canvas = document.createElement('canvas')
  canvas.width = plan.width
  canvas.height = plan.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Proxy canvas unavailable')

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const videoSource = new CanvasSource(canvas, {
    codec: plan.videoCodec,
    quality: new Quality({ bitrate: plan.videoBitrate }),
  })
  output.addVideoTrack(videoSource)

  // The source's OWN demuxed audio track is the authority on whether the proxy
  // must carry audio. `plan.includeAudio` comes from the import-time waveform
  // probe, which can fail even when the element still plays the audio; trusting
  // it alone could ship a video-only proxy that silences the clip.
  const sourceHasAudio = (await input.getAudioTracks()).length > 0
  let audioSource: AudioBufferSource | null = null
  let audioBuffer: AudioBuffer | null = null
  if (sourceHasAudio || plan.includeAudio) {
    audioBuffer = await decodeAudio(file)
    // A proxy that cannot carry the source audio must not be marked ready: a
    // video-only proxy would silence the clip in both monitors. Fail the build
    // so the element stays on the original instead.
    if (!audioBuffer) throw new Error('Proxy audio could not be decoded')
    audioSource = new AudioBufferSource({
      codec: await pickAudioCodec(() => canEncodeAudio('aac')),
      quality: new Quality({ bitrate: AUDIO_BITRATE }),
    })
    output.addAudioTrack(audioSource)
  }

  await output.start()
  for await (const frame of sink.canvases()) {
    ctx.clearRect(0, 0, plan.width, plan.height)
    ctx.drawImage(frame.canvas, 0, 0)
    await videoSource.add(frame.timestamp, frame.duration)
  }
  if (audioSource && audioBuffer) {
    await audioSource.add(audioBuffer)
    audioSource.close()
  }
  await output.finalize()

  const buffer = (output.target as BufferTarget).buffer
  if (!buffer) throw new Error('Proxy produced no data')
  return new Blob([buffer], { type: 'video/mp4' })
}

/**
 * Builds a proxy for an asset (if it qualifies) and installs the object URL in
 * the store. A stale build (relinked, removed, or superseded) is discarded.
 */
export async function buildProxy(asset: MediaAsset): Promise<void> {
  const plan = planProxy(asset)
  if (!plan || !asset.file) return
  const gen = (generations.get(asset.id) ?? 0) + 1
  generations.set(asset.id, gen)
  useEditorStore.getState().setProxyEntry(asset.id, { status: 'building' })
  try {
    const blob = await transcode(asset.file, plan)
    if (generations.get(asset.id) !== gen) return
    const url = URL.createObjectURL(blob)
    useEditorStore.getState().setProxyEntry(asset.id, { status: 'ready', url })
  } catch {
    if (generations.get(asset.id) !== gen) return
    useEditorStore.getState().setProxyEntry(asset.id, { status: 'failed' })
  }
}

/** Drops an asset's proxy: invalidates any in-flight build and revokes the URL. */
export function dropProxy(assetId: string): void {
  generations.set(assetId, (generations.get(assetId) ?? 0) + 1)
  const entry = useEditorStore.getState().proxyByAssetId[assetId]
  if (entry?.url) URL.revokeObjectURL(entry.url)
  useEditorStore.getState().clearProxyEntry(assetId)
}

/** Drops every proxy (project open): revokes all URLs and clears the slice. */
export function revokeAllProxies(): void {
  const { proxyByAssetId } = useEditorStore.getState()
  for (const [assetId, entry] of Object.entries(proxyByAssetId)) {
    generations.set(assetId, (generations.get(assetId) ?? 0) + 1)
    if (entry.url) URL.revokeObjectURL(entry.url)
  }
  useEditorStore.setState({ proxyByAssetId: {} })
}

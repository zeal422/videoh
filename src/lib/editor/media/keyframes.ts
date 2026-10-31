import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, UrlSource } from 'mediabunny'

import { KEYFRAME_TIMEOUT_MS } from '../constants'

/**
 * The next verified video keyframe after `sourceTime`, in the source URL the
 * failing element is actually using. `undefined` means "use the source-time
 * fallback": no video track, no later keyframe, an unreadable source, a
 * rejection, or a timeout.
 *
 * The URL is authoritative: with proxies enabled the element reads the proxy,
 * whose keyframe positions can differ from the original file.
 */
const KEYFRAME_SEEK_EPSILON = 1e-4

export async function nextVideoKeyframe(
  sourceUrl: string,
  sourceTime: number,
  timeoutMs = KEYFRAME_TIMEOUT_MS,
): Promise<number | undefined> {
  let input: Input | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const controller = new AbortController()
  // Start the bound before any source setup: a slow blob fetch or Input
  // construction must not escape it.
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      resolve(undefined)
    }, timeoutMs)
  })
  const lookup = (async () => {
    try {
      // A blob URL is local: reading it as a Blob lets mediabunny seek the
      // index directly instead of issuing range requests over the whole file.
      let source: BlobSource | UrlSource
      if (sourceUrl.startsWith('blob:')) {
        const response = await fetch(sourceUrl, { signal: controller.signal })
        if (timedOut) return undefined
        if (!response.ok) return undefined
        const blob = await response.blob()
        if (timedOut) return undefined
        source = new BlobSource(blob)
      } else {
        source = new UrlSource(sourceUrl)
      }
      const created = new Input({ source, formats: ALL_FORMATS })
      // The timeout may win while the source is being read. The race has
      // already returned, so dispose this late input instead of leaking it.
      if (timedOut) {
        created.dispose()
        return undefined
      }
      input = created
      const track = await created.getPrimaryVideoTrack()
      if (timedOut) return undefined
      if (!track) return undefined
      const sink = new EncodedPacketSink(track)
      const key = await sink.getKeyPacket(sourceTime, { verifyKeyPackets: true })
      if (timedOut) return undefined
      const packet = key ?? (await sink.getFirstKeyPacket({ verifyKeyPackets: true }))
      if (timedOut) return undefined
      if (!packet) return undefined
      const next =
        key === null ? packet : await sink.getNextKeyPacket(packet, { verifyKeyPackets: true })
      if (timedOut) return undefined
      return next ? next.timestamp + KEYFRAME_SEEK_EPSILON : undefined
    } catch {
      return undefined
    }
  })()
  try {
    return await Promise.race([lookup, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    input?.dispose()
  }
}

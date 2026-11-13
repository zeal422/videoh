/**
 * Pure export option matrix (0.21.0): containers, output bounds, bitrate
 * clamping and contain-fit math. Shared by the dialog and the exporter so the
 * two cannot disagree about an extension, MIME type or validation rule.
 *
 * Browser-free and Node-testable; mediabunny format construction stays in
 * export/mp4.ts.
 */
import { EXPORT_AUDIO_BITRATE, EXPORT_VIDEO_BITRATES, estimateExportBytes } from './offline'

export type ExportContainer = 'mp4' | 'mov' | 'mkv' | 'wav' | 'mp3' | 'm4a'

export type ExportQuality = keyof typeof EXPORT_VIDEO_BITRATES

export interface ExportContainerSpec {
  container: ExportContainer
  label: string
  extension: string
  mimeType: string
  audioOnly: boolean
}

/** One row per delivery container; the dialog renders this order. */
export const EXPORT_CONTAINERS: Record<ExportContainer, ExportContainerSpec> = {
  mp4: {
    container: 'mp4',
    label: 'MP4',
    extension: '.mp4',
    mimeType: 'video/mp4',
    audioOnly: false,
  },
  mov: {
    container: 'mov',
    label: 'MOV',
    extension: '.mov',
    mimeType: 'video/quicktime',
    audioOnly: false,
  },
  mkv: {
    container: 'mkv',
    label: 'MKV',
    extension: '.mkv',
    mimeType: 'video/x-matroska',
    audioOnly: false,
  },
  wav: {
    container: 'wav',
    label: 'WAV',
    extension: '.wav',
    mimeType: 'audio/wav',
    audioOnly: true,
  },
  mp3: {
    container: 'mp3',
    label: 'MP3',
    extension: '.mp3',
    mimeType: 'audio/mpeg',
    audioOnly: true,
  },
  m4a: {
    container: 'm4a',
    label: 'M4A',
    extension: '.m4a',
    mimeType: 'audio/mp4',
    audioOnly: true,
  },
}

export const EXPORT_CONTAINER_ORDER: readonly ExportContainer[] = [
  'mp4',
  'mov',
  'mkv',
  'wav',
  'mp3',
  'm4a',
]

export function containerSpec(container: ExportContainer): ExportContainerSpec {
  const spec = EXPORT_CONTAINERS[container]
  if (!spec) throw new Error(`Unknown export container: ${String(container)}`)
  return spec
}

export function isAudioOnlyContainer(container: ExportContainer): boolean {
  return containerSpec(container).audioOnly
}

/** Output frame bounds. A single per-dimension cap, documented in docs/flows.md. */
export const EXPORT_MIN_DIMENSION = 16
export const EXPORT_MAX_DIMENSION = 4096

/** Video bitrate override bounds in bits per second. */
export const EXPORT_BITRATE_MIN = 500_000
export const EXPORT_BITRATE_MAX = 40_000_000

export interface OutputSize {
  width: number
  height: number
}

/**
 * Resolves a requested output frame size. Absent values mean the project size;
 * a half-specified size is invalid rather than guessed. Valid sizes are rounded
 * to even numbers because H.264 encodes in 2x2 chroma blocks.
 */
export function resolveOutputSize(
  width: number | undefined,
  height: number | undefined,
  fallback: OutputSize,
): OutputSize | null {
  if (width === undefined && height === undefined) return { ...fallback }
  if (width === undefined || height === undefined) return null
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width < EXPORT_MIN_DIMENSION || height < EXPORT_MIN_DIMENSION) return null
  if (width > EXPORT_MAX_DIMENSION || height > EXPORT_MAX_DIMENSION) return null
  return { width: evenDimension(width), height: evenDimension(height) }
}

export function evenDimension(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

/**
 * The video bitrate to encode at. An absent or invalid override keeps the
 * quality preset; a finite one is clamped to the documented range.
 */
export function resolveVideoBitrate(requested: number | undefined): number | undefined {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return undefined
  return Math.min(EXPORT_BITRATE_MAX, Math.max(EXPORT_BITRATE_MIN, Math.round(requested)))
}

/** The centered, unstretched rectangle that fits `src` inside `dst`. */
export function containRect(
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): { x: number; y: number; width: number; height: number } {
  if (
    !(srcWidth > 0) ||
    !(srcHeight > 0) ||
    !(dstWidth > 0) ||
    !(dstHeight > 0) ||
    !Number.isFinite(srcWidth) ||
    !Number.isFinite(srcHeight) ||
    !Number.isFinite(dstWidth) ||
    !Number.isFinite(dstHeight)
  ) {
    return { x: 0, y: 0, width: Math.max(0, dstWidth), height: Math.max(0, dstHeight) }
  }
  const scale = Math.min(dstWidth / srcWidth, dstHeight / srcHeight)
  const width = Math.min(dstWidth, srcWidth * scale)
  const height = Math.min(dstHeight, srcHeight * scale)
  return { x: (dstWidth - width) / 2, y: (dstHeight - height) / 2, width, height }
}

/** PCM WAV bytes per second: 48 kHz, stereo, 16-bit. */
const WAV_BYTES_PER_SECOND = 48_000 * 2 * 2

/**
 * Approximate output size for the dialog. WAV is exact PCM; compressed audio
 * uses the exporter's 192 kbps track; video uses the override or the quality
 * tier. Encoder decisions still make the real file vary.
 */
export function estimateExportBytesForOptions(args: {
  duration: number
  container: ExportContainer
  quality: ExportQuality
  videoBitrate?: number
}): number {
  const { duration, container, quality } = args
  if (!(duration > 0)) return 0
  const spec = containerSpec(container)
  if (spec.container === 'wav') return Math.round(duration * WAV_BYTES_PER_SECOND)
  if (spec.audioOnly) return Math.round((duration * EXPORT_AUDIO_BITRATE) / 8)
  const bitrate = resolveVideoBitrate(args.videoBitrate)
  if (bitrate === undefined) {
    return estimateExportBytes(duration, quality)
  }
  return Math.round((duration * (bitrate + EXPORT_AUDIO_BITRATE)) / 8)
}

'use client'

import { useEffect, useRef, useState } from 'react'
import { Download, Loader2, MonitorPlay, Save, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { toast } from '@/hooks/use-toast'
import { trackExportSuccess } from '@/lib/analytics'

import { docDuration } from '@/lib/editor/factories'
import { hasOfflineMedia, offlineAudibleMedia } from '@/lib/editor/offline'
import {
  audioCodecSupported,
  downloadBlob,
  exportTimeline,
  hasAudibleMix,
  probeExportCodecs,
  webCodecsSupported,
  type ExportFileSink,
  type ExportHandle,
} from '@/lib/editor/export/mp4'
import {
  containerSpec,
  estimateExportBytesForOptions,
  EXPORT_CONTAINER_ORDER,
  resolveOutputSize,
  resolveVideoBitrate,
  type ExportContainer,
} from '@/lib/editor/export/options'
import { formatTime } from '@/lib/editor/time'
import { useEditorStore, useStableDoc } from '@/lib/editor/store'

type Phase = 'setup' | 'exporting' | 'done'
type ExportQuality = 'low' | 'medium' | 'high'

/** Past this estimated size the dialog nudges toward a streamed export. */
const STREAM_HINT_BYTES = 100_000_000

/** The File System Access picker (not in the default DOM lib). */
interface SaveFilePicker {
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    types?: { description?: string; accept: Record<string, string[]> }[]
  }) => Promise<FileSystemFileHandle>
}

function hasSaveFilePicker(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window
}

/**
 * Why a container cannot be offered in this browser right now, or null when it
 * can. MP3 and M4A wait for their encoder probes; WAV uses PCM and needs no
 * AudioEncoder, and every audio-only container needs an audible mix.
 */
function unavailableReason(
  container: ExportContainer,
  codecs: { aac: boolean; mp3: boolean } | null,
  audible: boolean,
): string | null {
  const spec = containerSpec(container)
  if (!spec.audioOnly) {
    return webCodecsSupported()
      ? null
      : 'This browser has no WebCodecs support. Use a current Chromium, Edge, Firefox 130+, or Safari 26+.'
  }
  if (container !== 'wav' && !audioCodecSupported()) return 'This browser cannot encode audio.'
  if (!audible) return 'The timeline has no audible audio. Add audio or export a video.'
  if (container === 'mp3') {
    if (codecs === null) return 'Checking MP3 support…'
    return codecs.mp3 ? null : 'MP3 encoding is unavailable in this browser.'
  }
  if (container === 'm4a') {
    if (codecs === null) return 'Checking AAC support…'
    return codecs.aac ? null : 'M4A needs an AAC encoder, which this browser does not have.'
  }
  return null
}

/** Modal that renders the timeline to a video or audio file (WebCodecs, offline). */
export function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const doc = useStableDoc()
  const [phase, setPhase] = useState<Phase>('setup')
  const [progress, setProgress] = useState(0)
  const [container, setContainer] = useState<ExportContainer>('mp4')
  const [quality, setQuality] = useState<ExportQuality>('medium')
  const [outWidth, setOutWidth] = useState('')
  const [outHeight, setOutHeight] = useState('')
  const [bitrate, setBitrate] = useState('')
  const [codecs, setCodecs] = useState<{ aac: boolean; mp3: boolean } | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [resultSize, setResultSize] = useState(0)
  const [resultFile, setResultFile] = useState<{ name: string; bytes: number } | null>(null)
  const [resultContainer, setResultContainer] = useState<ExportContainer | null>(null)
  const handleRef = useRef<ExportHandle | null>(null)
  const resultBlobRef = useRef<Blob | null>(null)

  const duration = docDuration(doc)
  const spec = containerSpec(container)
  const audioOnly = spec.audioOnly
  // The done view reads the format captured when the export started, not the
  // live selector: the select stays editable while createWritable() is pending.
  const resultSpec = resultContainer ? containerSpec(resultContainer) : spec
  const resultAudioOnly = resultSpec.audioOnly
  const audible = hasAudibleMix(doc)

  const widthRaw = outWidth.trim()
  const heightRaw = outHeight.trim()
  const widthValue = widthRaw === '' ? undefined : Number(widthRaw)
  const heightValue = heightRaw === '' ? undefined : Number(heightRaw)
  const outputSize = audioOnly
    ? null
    : resolveOutputSize(widthValue, heightValue, {
        width: doc.project.width,
        height: doc.project.height,
      })
  const sizeError = !audioOnly && outputSize === null

  const bitrateRaw = bitrate.trim()
  const bitrateValue = bitrateRaw === '' ? undefined : Number(bitrateRaw) * 1_000_000
  const bitrateError =
    !audioOnly && bitrateRaw !== '' && (!Number.isFinite(bitrateValue) || (bitrateValue ?? 0) <= 0)
  const resolvedBitrate = audioOnly ? undefined : resolveVideoBitrate(bitrateValue)
  const estimated = estimateExportBytesForOptions({
    duration,
    container,
    quality,
    videoBitrate: resolvedBitrate,
  })
  const canStream = hasSaveFilePicker()
  const reason = unavailableReason(container, codecs, audible)
  const offlineAudio = audioOnly ? offlineAudibleMedia(doc) : []
  const offlineBlocked = audioOnly ? offlineAudio.length > 0 : hasOfflineMedia(doc)
  const canStart = duration > 0 && !offlineBlocked && reason === null && !sizeError && !bitrateError

  useEffect(() => {
    if (!open) return
    let alive = true
    void probeExportCodecs().then((next) => {
      if (alive) setCodecs(next)
    })
    return () => {
      alive = false
    }
  }, [open])

  const start = async (mode: 'download' | 'file') => {
    if (!canStart) return
    // Capture the invocation's format before any await. The selector remains
    // interactive while the picker and createWritable() are pending, so reading
    // the state later would let a format change alter the result's handling.
    const exportContainer = container
    const exportSpec = containerSpec(exportContainer)
    // A streamed export opens a native picker first; a dismissal is not an error.
    let fileStream: ExportFileSink | undefined
    let fileName: string | undefined
    if (mode === 'file') {
      const picker = (window as unknown as SaveFilePicker).showSaveFilePicker
      if (!picker) return
      let handle: FileSystemFileHandle
      try {
        // Call through window: showSaveFilePicker needs its Window receiver.
        handle = await picker.call(window, {
          suggestedName: `${doc.project.name || 'export'}${exportSpec.extension}`,
          types: [
            {
              description: `${exportSpec.label} file`,
              accept: { [exportSpec.mimeType]: [exportSpec.extension] },
            },
          ],
        })
      } catch (error) {
        // A dismissed picker throws AbortError (silent); anything else is a
        // real failure the user must see.
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          toast({
            title: 'Export failed',
            description: error instanceof Error ? error.message : String(error),
            variant: 'destructive',
          })
        }
        return
      }
      try {
        fileStream = await handle.createWritable()
        fileName = handle.name
      } catch (error) {
        // The file was chosen but could not be opened for writing: surface it.
        toast({
          title: 'Export failed',
          description: error instanceof Error ? error.message : String(error),
          variant: 'destructive',
        })
        return
      }
    }

    // Pause the preview engine while the export engine owns the media elements.
    useEditorStore.getState().setPlaying(false)
    setPhase('exporting')
    setProgress(0)
    const handle: ExportHandle = { cancelled: false }
    handleRef.current = handle
    try {
      const result = await exportTimeline(
        doc,
        {
          container: exportContainer,
          quality,
          videoBitrate: resolvedBitrate,
          width: outputSize?.width,
          height: outputSize?.height,
          onProgress: (t) => setProgress(duration > 0 ? t / duration : 0),
          fileStream,
          fileName,
        },
        handle,
      )
      setResultContainer(exportContainer)
      if (result.kind === 'file') {
        setResultFile({ name: result.fileName, bytes: result.bytes })
        setPhase('done')
        toast({
          title: 'Export complete',
          description: `${result.fileName} · ${(result.bytes / 1e6).toFixed(1)} MB`,
        })
      } else {
        resultBlobRef.current = result.blob
        setResultSize(result.blob.size)
        setResultUrl(URL.createObjectURL(result.blob))
        setPhase('done')
        toast({
          title: 'Export complete',
          description: `${(result.blob.size / 1e6).toFixed(1)} MB ${exportSpec.label}`,
        })
      }
      trackExportSuccess()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== 'Export cancelled') {
        toast({
          title: 'Export failed',
          description: message,
          variant: 'destructive',
        })
      }
      setPhase('setup')
    } finally {
      handleRef.current = null
    }
  }

  const cancel = () => {
    if (handleRef.current) handleRef.current.cancelled = true
    setPhase('setup')
  }

  const close = (next: boolean) => {
    if (phase === 'exporting') return // must cancel first
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    setResultUrl(null)
    resultBlobRef.current = null
    setResultFile(null)
    setResultContainer(null)
    setPhase('setup')
    setProgress(0)
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MonitorPlay className="size-4" /> Export
          </DialogTitle>
          <DialogDescription>
            Renders the timeline offline to {spec.label} ({audioOnly ? 'audio only' : 'H.264 video'}
            ). {doc.project.width}×{doc.project.height} @ {doc.project.fps}fps ·{' '}
            {formatTime(duration)}.
          </DialogDescription>
        </DialogHeader>

        {phase === 'setup' && (
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Format</Label>
              <Select value={container} onValueChange={(v) => setContainer(v as ExportContainer)}>
                <SelectTrigger className="mt-1" aria-label="Export format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPORT_CONTAINER_ORDER.map((candidate) => {
                    const candidateSpec = containerSpec(candidate)
                    return (
                      <SelectItem
                        key={candidate}
                        value={candidate}
                        disabled={unavailableReason(candidate, codecs, audible) !== null}
                      >
                        {candidateSpec.label} {candidateSpec.audioOnly ? 'audio' : 'video'}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              {reason && (
                <p
                  className="mt-1 text-xs font-medium text-destructive"
                  data-testid="export-container-unsupported"
                >
                  {reason}
                </p>
              )}
              {container === 'mov' && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  MOV uses H.264. Audio is AAC when the browser can encode it, otherwise Opus;
                  strict QuickTime players may not read the Opus fallback.
                </p>
              )}
            </div>

            {!audioOnly && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs" htmlFor="export-width">
                      Output width (px)
                    </Label>
                    <Input
                      id="export-width"
                      type="number"
                      className="mt-1 h-8 text-xs"
                      value={outWidth}
                      placeholder={String(doc.project.width)}
                      min={16}
                      max={4096}
                      step={2}
                      onChange={(e) => setOutWidth(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label className="text-xs" htmlFor="export-height">
                      Output height (px)
                    </Label>
                    <Input
                      id="export-height"
                      type="number"
                      className="mt-1 h-8 text-xs"
                      value={outHeight}
                      placeholder={String(doc.project.height)}
                      min={16}
                      max={4096}
                      step={2}
                      onChange={(e) => setOutHeight(e.target.value)}
                    />
                  </div>
                </div>
                {sizeError ? (
                  <p
                    className="text-xs font-medium text-destructive"
                    data-testid="export-size-error"
                  >
                    Set both output dimensions from 16 to 4096 pixels. Empty fields use the project
                    size.
                  </p>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    Empty fields use the project size. A different aspect ratio is letterboxed,
                    never stretched.
                  </p>
                )}

                <div>
                  <Label className="text-xs">Quality</Label>
                  <Select value={quality} onValueChange={(v) => setQuality(v as ExportQuality)}>
                    <SelectTrigger className="mt-1" aria-label="Export quality">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low (~2.5 Mbps)</SelectItem>
                      <SelectItem value="medium">Medium (~6 Mbps)</SelectItem>
                      <SelectItem value="high">High (~12 Mbps)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div>
                  <Label className="text-xs" htmlFor="export-bitrate">
                    Video bitrate (Mbps, optional)
                  </Label>
                  <Input
                    id="export-bitrate"
                    type="number"
                    className="mt-1 h-8 text-xs"
                    value={bitrate}
                    placeholder="Quality preset"
                    min={0.5}
                    max={40}
                    step={0.5}
                    onChange={(e) => setBitrate(e.target.value)}
                  />
                  {bitrateError ? (
                    <p
                      className="mt-1 text-xs font-medium text-destructive"
                      data-testid="export-bitrate-error"
                    >
                      Enter a positive bitrate in Mbps.
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Overrides the quality preset and clamps to 0.5 to 40 Mbps.
                    </p>
                  )}
                </div>
              </>
            )}

            <p className="text-xs text-muted-foreground" data-testid="export-size-estimate">
              Estimated size ~{(estimated / 1e6).toFixed(1)} MB
              {estimated >= STREAM_HINT_BYTES && canStream
                ? '. Large file: use Export to file to bound memory.'
                : '.'}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Rendering is offline and frame-accurate: it needs no tab focus and does not follow
              playback speed. Wall time tracks how fast the browser decodes the sources. Reversed
              clips read their source backwards in the export.
            </p>
            {!audioOnly && !webCodecsSupported() && (
              <p className="text-xs font-medium text-destructive" data-testid="export-unsupported">
                This browser has no WebCodecs support. Use a current Chromium, Edge, Firefox 130+,
                or Safari 26+.
              </p>
            )}
            {offlineBlocked && (
              <p
                className="text-xs font-medium text-destructive"
                data-testid="export-offline-warning"
              >
                {audioOnly
                  ? `Some audio media is offline: ${offlineAudio.join(', ')}. Relink the missing files in the media bin first, or the export will leave them silent.`
                  : 'Some media is offline. Relink the missing files in the media bin first, or the export will be black and silent where they appear.'}
              </p>
            )}
            <Button className="w-full" onClick={() => void start('download')} disabled={!canStart}>
              Start export
            </Button>
            {canStream && (
              <Button
                variant="outline"
                className="w-full gap-1.5"
                onClick={() => void start('file')}
                disabled={!canStart}
              >
                <Save className="size-4" /> Export to file
              </Button>
            )}
          </div>
        )}

        {phase === 'exporting' && (
          <div className="space-y-4">
            <Progress value={Math.round(progress * 100)} aria-label="Export progress" />
            <p className="text-center text-xs text-muted-foreground">
              Rendering… {Math.round(progress * 100)}%
            </p>
            <Button variant="destructive" className="w-full gap-1.5" onClick={cancel}>
              <X className="size-4" /> Cancel
            </Button>
          </div>
        )}

        {phase === 'done' && resultUrl && (
          <div className="space-y-4">
            {resultAudioOnly ? (
              <audio
                src={resultUrl}
                controls
                className="w-full"
                data-testid="export-result-audio"
              />
            ) : (
              <video
                src={resultUrl}
                controls
                className="max-h-64 w-full rounded-md border bg-black"
                data-testid="export-result-video"
              />
            )}
            <p className="text-center text-xs text-muted-foreground">
              {(resultSize / 1e6).toFixed(1)} MB · {resultSpec.label}
            </p>
            <Button
              className="w-full gap-1.5"
              onClick={() => {
                if (resultBlobRef.current) {
                  downloadBlob(
                    resultBlobRef.current,
                    `${doc.project.name || 'export'}${resultSpec.extension}`,
                  )
                }
              }}
            >
              <Download className="size-4" /> Download
            </Button>
          </div>
        )}

        {phase === 'done' && resultFile && (
          <div className="space-y-4" data-testid="export-result-file">
            <p className="text-center text-sm">
              Saved {resultFile.name}
              <br />
              <span className="text-xs text-muted-foreground">
                {(resultFile.bytes / 1e6).toFixed(1)} MB · {resultSpec.label}
              </span>
            </p>
            <Button className="w-full" onClick={() => close(false)}>
              Done
            </Button>
          </div>
        )}

        {phase === 'exporting' && <Loader2 className="hidden" aria-hidden="true" />}
      </DialogContent>
    </Dialog>
  )
}

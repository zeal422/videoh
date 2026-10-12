'use client'

import { useRef, useState } from 'react'
import { Download, Loader2, MonitorPlay, Save, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

import { docDuration } from '@/lib/editor/factories'
import { hasOfflineMedia } from '@/lib/editor/offline'
import { estimateExportBytes } from '@/lib/editor/export/offline'
import { formatTime } from '@/lib/editor/time'
import {
  downloadBlob,
  exportTimeline,
  webCodecsSupported,
  type ExportFileSink,
  type ExportHandle,
} from '@/lib/editor/export/mp4'
import { useEditorStore } from '@/lib/editor/store'

type Phase = 'setup' | 'exporting' | 'done'

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

/** Modal that renders the timeline to an MP4 file (WebCodecs, offline frame-by-frame). */
export function ExportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const doc = useEditorStore((s) => s.doc)
  const [phase, setPhase] = useState<Phase>('setup')
  const [progress, setProgress] = useState(0)
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('medium')
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [resultSize, setResultSize] = useState(0)
  const [resultFile, setResultFile] = useState<{ name: string; bytes: number } | null>(null)
  const handleRef = useRef<ExportHandle | null>(null)
  const resultBlobRef = useRef<Blob | null>(null)

  const duration = docDuration(doc)
  const estimated = estimateExportBytes(duration, quality)
  const canStream = hasSaveFilePicker()
  // Restored-session assets have no object URL until relinked. Rendering with
  // them produces a valid, entirely black, silent MP4 reported as a success:
  // the preview warns about exactly this condition, so the export refuses it
  // up front instead of producing the file. The shared predicate is per-clip,
  // so it also refuses a dangling mediaId and ignores an offline asset
  // nothing uses.

  const start = async (mode: 'download' | 'file') => {
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
          suggestedName: `${doc.project.name || 'export'}.mp4`,
          types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
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
          quality,
          onProgress: (t) => setProgress(duration > 0 ? t / duration : 0),
          fileStream,
          fileName,
        },
        handle,
      )
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
          description: `${(result.blob.size / 1e6).toFixed(1)} MB MP4`,
        })
      }
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
    setPhase('setup')
    setProgress(0)
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MonitorPlay className="size-4" /> Export video
          </DialogTitle>
          <DialogDescription>
            Renders the timeline offline to an MP4 file (H.264 video, AAC or Opus audio).{' '}
            {doc.project.width}×{doc.project.height} @ {doc.project.fps}fps · {formatTime(duration)}
            .
          </DialogDescription>
        </DialogHeader>

        {phase === 'setup' && (
          <div className="space-y-4">
            <div>
              <Label className="text-xs">Quality</Label>
              <Select value={quality} onValueChange={(v) => setQuality(v as typeof quality)}>
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
            {!webCodecsSupported() && (
              <p className="text-xs font-medium text-destructive" data-testid="export-unsupported">
                This browser has no WebCodecs support. Use a current Chromium, Edge, Firefox 130+,
                or Safari 26+.
              </p>
            )}
            {hasOfflineMedia(doc) && (
              <p
                className="text-xs font-medium text-destructive"
                data-testid="export-offline-warning"
              >
                Some media is offline. Relink the missing files in the media bin first, or the
                export will be black and silent where they appear.
              </p>
            )}
            <Button
              className="w-full"
              onClick={() => void start('download')}
              disabled={duration <= 0 || !webCodecsSupported() || hasOfflineMedia(doc)}
            >
              Start export
            </Button>
            {canStream && (
              <Button
                variant="outline"
                className="w-full gap-1.5"
                onClick={() => void start('file')}
                disabled={duration <= 0 || !webCodecsSupported() || hasOfflineMedia(doc)}
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
            <video
              src={resultUrl}
              controls
              className="max-h-64 w-full rounded-md border bg-black"
              data-testid="export-result-video"
            />
            <p className="text-center text-xs text-muted-foreground">
              {(resultSize / 1e6).toFixed(1)} MB · MP4
            </p>
            <Button
              className="w-full gap-1.5"
              onClick={() => {
                if (resultBlobRef.current) {
                  downloadBlob(resultBlobRef.current, `${doc.project.name || 'export'}.mp4`)
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
                {(resultFile.bytes / 1e6).toFixed(1)} MB · MP4
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

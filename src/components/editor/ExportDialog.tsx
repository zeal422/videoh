'use client'

import { useRef, useState } from 'react'
import { Download, Loader2, MonitorPlay, X } from 'lucide-react'

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
import { formatTime } from '@/lib/editor/time'
import { downloadBlob, exportTimeline, type ExportHandle } from '@/lib/editor/export/exporter'
import { useEditorStore } from '@/lib/editor/store'

type Phase = 'setup' | 'exporting' | 'done'

/** Modal that renders the timeline to a video file (MediaRecorder, real-time). */
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
  const handleRef = useRef<ExportHandle | null>(null)
  const resultBlobRef = useRef<Blob | null>(null)

  const duration = docDuration(doc)

  const start = async () => {
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
        },
        handle,
      )
      resultBlobRef.current = result.blob
      setResultSize(result.blob.size)
      setResultUrl(URL.createObjectURL(result.blob))
      setPhase('done')
      toast({
        title: 'Export complete',
        description: `${(result.blob.size / 1e6).toFixed(1)} MB WebM`,
      })
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
            Renders the timeline in real time to a WebM file ({doc.project.width}×
            {doc.project.height} @ {doc.project.fps}fps · {formatTime(duration)}).
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
            <p className="text-xs leading-relaxed text-muted-foreground">
              Export plays the timeline once from start to end — keep this tab focused for the best
              result.
            </p>
            <Button className="w-full" onClick={() => void start()} disabled={duration <= 0}>
              Start export
            </Button>
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
              {(resultSize / 1e6).toFixed(1)} MB · WebM
            </p>
            <Button
              className="w-full gap-1.5"
              onClick={() => {
                if (resultBlobRef.current) {
                  downloadBlob(resultBlobRef.current, `${doc.project.name || 'export'}.webm`)
                }
              }}
            >
              <Download className="size-4" /> Download
            </Button>
          </div>
        )}

        {phase === 'exporting' && <Loader2 className="hidden" aria-hidden="true" />}
      </DialogContent>
    </Dialog>
  )
}

'use client'

import { useCallback, useRef, useState } from 'react'
import {
  FileAudio,
  FileImage,
  FileVideo,
  Import,
  Link2,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { toast } from '@/hooks/use-toast'

import { importFile } from '@/lib/editor/media/probe'
import { commandsToAddMedia } from '@/lib/editor/actions'
import { docDuration } from '@/lib/editor/factories'
import { importMediaFiles } from '@/lib/editor/project-io'
import { SAMPLES, filterNewSamples } from '@/lib/editor/sample-media'
import { useEditorStore } from '@/lib/editor/store'
import type { MediaAsset } from '@/lib/editor/types'
import { cn } from '@/lib/utils'

/** Left panel: media assets (import, relink, remove, drag onto the timeline). */
export function MediaBin({ className, heading = true }: { className?: string; heading?: boolean }) {
  const media = useEditorStore((s) => s.doc.media)
  const [importing, setImporting] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Re-entrancy guard: "Load sample media" is async (3 fetches + probes), so
  // rapid re-presses must not race past the dedup check inside loadSamples.
  const loadingSamplesRef = useRef(false)

  const importFiles = useCallback(async (files: FileList | File[]) => {
    setImporting((n) => n + 1)
    try {
      await importMediaFiles(files)
    } finally {
      setImporting((n) => n - 1)
    }
  }, [])

  const loadSamples = useCallback(async () => {
    if (loadingSamplesRef.current) return
    loadingSamplesRef.current = true
    try {
      // Idempotent: skip samples already in the bin so re-pressing the button
      // never duplicates entries (user-facing bug report).
      const existingNames = useEditorStore.getState().doc.media.map((m) => m.name)
      const fresh = filterNewSamples(SAMPLES, existingNames)
      if (fresh.length === 0) {
        toast({
          title: 'Sample media already loaded',
          description: 'All samples are already in your media bin.',
        })
        return
      }
      const files: File[] = []
      for (const sample of fresh) {
        try {
          const res = await fetch(sample.path)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const blob = await res.blob()
          files.push(new File([blob], sample.name, { type: blob.type }))
        } catch {
          toast({
            title: 'Sample unavailable',
            description: sample.name,
            variant: 'destructive',
          })
        }
      }
      if (files.length) await importFiles(files)
    } finally {
      loadingSamplesRef.current = false
    }
  }, [importFiles])

  const quickAdd = (asset: MediaAsset) => {
    const store = useEditorStore.getState()
    const commands = commandsToAddMedia(store.doc, asset, docDuration(store.doc))
    if (!commands) return
    store.apply(commands)
  }

  const removeAsset = (asset: MediaAsset) => {
    try {
      useEditorStore.getState().apply({ type: 'removeMediaAsset', mediaId: asset.id })
    } catch (error) {
      toast({
        title: 'Could not remove media',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }

  const relink = async (asset: MediaAsset, file: File) => {
    try {
      const fresh = await importFile(file)
      useEditorStore.getState().apply({
        type: 'relinkMedia',
        mediaId: asset.id,
        patch: {
          url: fresh.url,
          duration: fresh.duration,
          width: fresh.width,
          height: fresh.height,
          thumbnail: fresh.thumbnail,
          hasAudio: fresh.hasAudio,
          waveformPeaks: fresh.waveformPeaks,
        },
      })
      toast({ title: 'Media relinked', description: asset.name })
    } catch (error) {
      toast({
        title: 'Relink failed',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }

  return (
    <aside
      aria-label="Media bin"
      className={cn('flex min-h-0 flex-col bg-card', className)}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(e) => {
        e.preventDefault()
        if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files)
      }}
    >
      <div
        className={cn('flex items-center justify-between gap-2 px-3 py-2', heading && 'border-b')}
      >
        {heading && <h2 className="text-sm font-semibold">Media</h2>}
        <Button
          size="sm"
          variant="secondary"
          className="h-7 gap-1.5"
          onClick={() => fileInputRef.current?.click()}
        >
          {importing > 0 ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Import className="size-3.5" />
          )}
          Import
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          className="hidden"
          aria-hidden="true"
          onChange={(e) => {
            if (e.target.files?.length) void importFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      <div className="px-3 pt-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-full gap-1.5 text-xs"
          disabled={importing > 0}
          onClick={() => void loadSamples()}
        >
          {importing > 0 ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          Load sample media
        </Button>
      </div>

      <div className="editor-scroll mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        {media.length === 0 && (
          <div className="mt-6 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            <p className="font-medium">No media yet</p>
            <p className="mt-1 leading-relaxed">
              Import video, audio or image files — or click <em>Load sample media</em> to try the
              editor instantly. Drag assets onto the timeline.
            </p>
          </div>
        )}
        {media.map((asset) => (
          <MediaItem
            key={asset.id}
            asset={asset}
            onQuickAdd={() => quickAdd(asset)}
            onRemove={() => removeAsset(asset)}
            onRelink={(file) => void relink(asset, file)}
          />
        ))}
      </div>
    </aside>
  )
}

function MediaItem({
  asset,
  onQuickAdd,
  onRemove,
  onRelink,
}: {
  asset: MediaAsset
  onQuickAdd: () => void
  onRemove: () => void
  onRelink: (file: File) => void
}) {
  const KindIcon =
    asset.kind === 'video' ? FileVideo : asset.kind === 'audio' ? FileAudio : FileImage
  const relinkInputRef = useRef<HTMLInputElement>(null)

  return (
    <div
      className={cn(
        'group flex cursor-grab items-center gap-2 rounded-md border bg-background/60 p-2 transition-colors hover:bg-accent/60 active:cursor-grabbing',
        asset.missing && 'border-amber-500/40 bg-amber-500/5',
      )}
      data-testid={`media-item-${asset.id}`}
      draggable={!asset.missing}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-media-id', asset.id)
        // The kind rides as a dedicated TYPE (not a value): dragover may read
        // the type list but never the values, and the timeline's drop
        // indicator needs the kind to preview the track it would create.
        e.dataTransfer.setData(`application/x-media-kind-${asset.kind}`, '1')
        e.dataTransfer.effectAllowed = 'copy'
      }}
    >
      <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
        {asset.thumbnail ? (
          <img src={asset.thumbnail} alt="" className="size-full object-cover" />
        ) : (
          <KindIcon className="size-5 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={asset.name}>
          {asset.name}
        </p>
        <div className="mt-0.5 flex items-center gap-1">
          <Badge variant="outline" className="px-1 py-0 text-[10px] uppercase">
            {asset.kind}
          </Badge>
          {asset.missing ? (
            <span className="text-[10px] text-amber-500">offline</span>
          ) : (
            <span className="text-[10px] text-muted-foreground">
              {asset.kind === 'image'
                ? `${asset.width}×${asset.height}`
                : `${asset.duration.toFixed(1)}s`}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {asset.missing ? (
          <IconMiniButton label="Relink media file" onClick={() => relinkInputRef.current?.click()}>
            <Link2 className="size-3.5" />
          </IconMiniButton>
        ) : (
          <IconMiniButton label="Add to timeline" onClick={onQuickAdd}>
            <Plus className="size-3.5" />
          </IconMiniButton>
        )}
        <IconMiniButton label="Remove from bin" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </IconMiniButton>
      </div>
      <input
        ref={relinkInputRef}
        type="file"
        accept={asset.kind === 'video' ? 'video/*' : asset.kind === 'audio' ? 'audio/*' : 'image/*'}
        className="hidden"
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onRelink(file)
          e.target.value = ''
        }}
      />
    </div>
  )
}

function IconMiniButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {children}
    </button>
  )
}

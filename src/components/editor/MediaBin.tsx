'use client'

import { useCallback, useRef, useState } from 'react'
import {
  FileAudio,
  FileImage,
  FileVideo,
  Gauge,
  Import,
  Link2,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { toast } from '@/hooks/use-toast'

import { importFile } from '@/lib/editor/media/probe'
import { relinkPatchFrom } from '@/lib/editor/media/relink'
import { buildProxy, dropProxy } from '@/lib/editor/media/proxies'
import { shouldProxy } from '@/lib/editor/proxy'
import { commandsToAddMedia } from '@/lib/editor/actions'
import { activeSequenceDuration } from '@/lib/editor/factories'
import { importMediaFiles } from '@/lib/editor/project-io'
import { useEditorStore, useStableDoc } from '@/lib/editor/store'
import type { MediaAsset } from '@/lib/editor/types'
import { cn } from '@/lib/utils'

/** Left panel: media assets (import, relink, remove, drag onto the timeline). */
export function MediaBin({ className, heading = true }: { className?: string; heading?: boolean }) {
  const media = useEditorStore((s) => s.doc.media)
  const sourceAssetId = useEditorStore((s) => s.sourceAssetId)
  const setSourceAsset = useEditorStore((s) => s.setSourceAsset)
  const [importing, setImporting] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const importFiles = useCallback(async (files: FileList | File[]) => {
    setImporting((n) => n + 1)
    try {
      await importMediaFiles(files)
    } finally {
      setImporting((n) => n - 1)
    }
  }, [])

  const quickAdd = (asset: MediaAsset) => {
    const store = useEditorStore.getState()
    const commands = commandsToAddMedia(
      store.doc,
      asset,
      activeSequenceDuration(store.doc, store.activeSequencePath),
      undefined,
      store.untargetedTracks,
      store.activeSequencePath[store.activeSequencePath.length - 1],
    )
    if (!commands) return
    store.apply(commands)
  }

  const removeAsset = (asset: MediaAsset) => {
    try {
      if (!useEditorStore.getState().apply({ type: 'removeMediaAsset', mediaId: asset.id })) return
      // The remove succeeded: the proxy's bytes belong to a gone asset.
      dropProxy(asset.id)
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
      const applied = useEditorStore.getState().apply({
        type: 'relinkMedia',
        mediaId: asset.id,
        patch: relinkPatchFrom(fresh, 'manual'),
      })
      if (!applied) return
      // The source bytes changed, so any proxy built for the old file is stale.
      dropProxy(asset.id)
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

      <div className="editor-scroll mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 pb-3">
        {media.length === 0 && (
          <div className="mt-6 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            <p className="font-medium">No media yet</p>
            <p className="mt-1 leading-relaxed">
              Import video, audio, or image files, then drag assets onto the timeline.
            </p>
          </div>
        )}
        {media.map((asset) => (
          <MediaItem
            key={asset.id}
            asset={asset}
            selected={asset.id === sourceAssetId}
            onSelect={() => setSourceAsset(asset.id)}
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
  selected,
  onSelect,
  onQuickAdd,
  onRemove,
  onRelink,
}: {
  asset: MediaAsset
  /** True when this asset is the Source monitor's selection. */
  selected: boolean
  onSelect: () => void
  onQuickAdd: () => void
  onRemove: () => void
  onRelink: (file: File) => void
}) {
  const KindIcon =
    asset.kind === 'video' ? FileVideo : asset.kind === 'audio' ? FileAudio : FileImage
  const relinkInputRef = useRef<HTMLInputElement>(null)
  const proxy = useEditorStore((s) => s.proxyByAssetId[asset.id])
  // A proxy can only be built from a live source file: an offline (restored)
  // heavy asset qualifies by size but has nothing to transcode.
  const canProxy = shouldProxy(asset) && !!asset.file

  return (
    <div
      className={cn(
        'group flex cursor-grab items-center gap-2 rounded-md border bg-background/60 p-2 transition-colors hover:bg-accent/60 active:cursor-grabbing',
        asset.missing && 'border-amber-500/40 bg-amber-500/5',
        // Selection ring mirrors the timeline's rose selection ring.
        selected && 'border-rose-400/70 bg-rose-500/10 ring-1 ring-rose-400/60',
      )}
      data-testid={`media-item-${asset.id}`}
      data-selected={selected}
      aria-pressed={selected}
      onClick={onSelect}
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
      <div className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
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
        <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
          <span className="uppercase">{asset.kind}</span>
          <span aria-hidden>·</span>
          {asset.missing ? (
            <span className="text-amber-500">offline</span>
          ) : (
            <span>
              {asset.kind === 'image'
                ? `${asset.width}×${asset.height}`
                : `${asset.duration.toFixed(1)}s`}
            </span>
          )}
          {proxy?.status === 'ready' && <span className="text-emerald-500">proxy</span>}
          {proxy?.status === 'building' && <span>proxy…</span>}
          {proxy?.status === 'failed' && <span className="text-destructive">proxy failed</span>}
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
        {canProxy && proxy?.status !== 'building' && proxy?.status !== 'ready' && (
          <IconMiniButton label="Build proxy" onClick={() => void buildProxy(asset)}>
            <Gauge className="size-3.5" />
          </IconMiniButton>
        )}
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

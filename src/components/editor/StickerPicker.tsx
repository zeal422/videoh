'use client'

import { useRef, useState, type KeyboardEvent } from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from '@/hooks/use-toast'

import { commandsToAddMedia } from '@/lib/editor/actions'
import { activeSequenceId, findSequence } from '@/lib/editor/factories'
import { importFile } from '@/lib/editor/media/probe'
import { storeMediaAsset } from '@/lib/editor/media/persist'
import {
  STICKERS,
  fetchStickerFile,
  stickerUrl,
  type StickerDef,
} from '@/lib/editor/media/stickers'
import { currentProjectToken, isProjectTokenCurrent } from '@/lib/editor/project-io'
import { useEditorStore } from '@/lib/editor/store'
import type { MediaAsset } from '@/lib/editor/types'

/**
 * Local sticker picker (0.25.0). Each sticker goes through the real image
 * import path (probe, thumbnail, content hash, OPFS write) and lands as an
 * image clip on the timeline. No remote request and no new schema.
 */
export function StickerPicker({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  // The tiles are a small grid: arrow keys move focus between them, which a
  // plain row of buttons does not offer.
  const tiles = useRef<Array<HTMLButtonElement | null>>([])
  const onTilesKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (step === 0) return
    event.preventDefault()
    const current = tiles.current.findIndex((tile) => tile === document.activeElement)
    const next = ((current === -1 ? 0 : current) + step + STICKERS.length) % STICKERS.length
    tiles.current[next]?.focus()
  }

  const insert = async (sticker: StickerDef) => {
    if (busy) return
    setBusy(sticker.id)
    const token = currentProjectToken()
    // Capture the destination before the async import: the user may move the
    // playhead or switch sequences while the file probes, and the sticker
    // must land where the insertion started, not where the UI happens to be
    // when the bytes resolve.
    const capture = (() => {
      const state = useEditorStore.getState()
      return {
        playhead: state.playhead,
        sequenceId: activeSequenceId(state.activeSequencePath),
      }
    })()
    let fresh: MediaAsset | null = null
    let attached = false
    try {
      const file = await fetchStickerFile(sticker)
      fresh = await importFile(file)
      if (!isProjectTokenCurrent(token)) return
      const { asset, warning } = await storeMediaAsset(token.projectId, fresh)
      if (!isProjectTokenCurrent(token)) return
      const store = useEditorStore.getState()
      if (capture.sequenceId && !findSequence(store.doc, capture.sequenceId)) {
        toast({
          title: `Could not add the ${sticker.name} sticker`,
          description: 'The sequence it was aimed at was deleted before the import finished.',
          variant: 'destructive',
        })
        return
      }
      const commands = commandsToAddMedia(
        store.doc,
        asset,
        capture.playhead,
        undefined,
        [],
        capture.sequenceId,
      )
      if (!commands) throw new Error('No video track is available for this sticker')
      if (!store.apply([{ type: 'addMediaAsset', asset }, ...commands])) return
      attached = true
      const added = commands.find((command) => command.type === 'addClip')
      if (added && added.type === 'addClip') {
        useEditorStore.getState().select(added.clip.id)
      }
      toast({
        title: warning ? 'Sticker added (session only)' : 'Sticker added',
        description: warning ?? sticker.name,
        ...(warning ? { variant: 'destructive' as const } : {}),
      })
    } catch (error) {
      toast({
        title: `Could not add the ${sticker.name} sticker`,
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      if (!attached && fresh?.url) {
        try {
          URL.revokeObjectURL(fresh.url)
        } catch {
          // An already revoked URL is harmless.
        }
      }
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="sticker-picker">
        <DialogHeader>
          <DialogTitle>Stickers</DialogTitle>
          <DialogDescription>
            Bundled local images. Each one is imported into this project and added at the playhead
            on a video track.
          </DialogDescription>
        </DialogHeader>
        <div
          className="grid grid-cols-3 gap-2"
          role="group"
          aria-label="Stickers"
          onKeyDown={onTilesKeyDown}
        >
          {STICKERS.map((sticker, index) => (
            <button
              key={sticker.id}
              type="button"
              ref={(element) => {
                tiles.current[index] = element
              }}
              data-testid={`sticker-${sticker.id}`}
              aria-label={`Add ${sticker.name} sticker`}
              disabled={busy !== null}
              onClick={() => void insert(sticker)}
              className="flex flex-col items-center gap-1.5 rounded-md border border-border bg-muted/30 p-2 transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="relative flex size-20 items-center justify-center">
                <img src={stickerUrl(sticker)} alt="" className="max-h-20 max-w-20" />
                {busy === sticker.id && (
                  <Loader2 className="absolute size-5 animate-spin text-foreground" />
                )}
              </span>
              <span className="text-[11px] text-muted-foreground">{sticker.name}</span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

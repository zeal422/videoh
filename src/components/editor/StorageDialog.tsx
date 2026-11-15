'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { HardDrive, Loader2, ShieldCheck, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { toast } from '@/hooks/use-toast'

import { collectReferencedHashes } from '@/lib/editor/media-cleanup-plan'
import {
  clearAllProjectMedia,
  cleanUnusedMedia,
  listUnusedMedia,
  type MediaCleanRefusal,
} from '@/lib/editor/media/persist'
import {
  estimateMediaStore,
  isMediaStoreSupported,
  isStoragePersistent,
  projectMediaUsage,
  requestPersistentStorage,
} from '@/lib/editor/media/media-store'
import { hasPendingInstall, readAutosave } from '@/lib/editor/persistence'
import { currentProjectLock } from '@/lib/editor/project-io'
import { useEditorStore } from '@/lib/editor/store'

/**
 * Durable-media controls (0.23.0): storage usage, persistent-storage request,
 * Clean Unused Media, and the destructive Clear All. Both destructive actions
 * require a confirmation step, and Clear All names that saved copies lose their
 * media. The dialog never deletes a hash the live doc, either history stack, the
 * autosave slot, or a claim shard still reaches.
 */

type Phase = 'ready' | 'confirm-clean' | 'confirm-clear' | 'working'

const REFUSALS: Record<MediaCleanRefusal, string> = {
  unsupported: 'Stored media is unavailable in this browser.',
  activity: 'Wait for the current import to finish, then try again.',
  pending:
    'The imported project is still saving its install record. Wait a moment, then try again.',
  unclaimed:
    'This project opened without a saved-copy record. Save the project once, then clean again.',
  claims:
    'The saved-copy records are missing or unreadable, so stored media and fonts cannot be deleted safely.',
  busy: 'Another tab has this project open. Close it, then try again.',
  changed: 'The open project changed before the clean ran, so nothing was deleted.',
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${bytes} B`
}

export function StorageDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const doc = useEditorStore((s) => s.doc)
  const cleanBlocked = useEditorStore((s) => s.mediaCleanBlocked)
  const [phase, setPhase] = useState<Phase>('ready')
  const [supported, setSupported] = useState(true)
  const [projectBytes, setProjectBytes] = useState(0)
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null)
  const [persistent, setPersistent] = useState(false)
  const [candidates, setCandidates] = useState(0)
  const [candidateBytes, setCandidateBytes] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  /** The project whose destructive action the user is confirming. */
  const [confirmedProjectId, setConfirmedProjectId] = useState<string | null>(null)
  /** Orders refresh passes so a stale one cannot publish after a newer one. */
  const refreshRequest = useRef(0)

  // Read the live store inside the callback, not at render: clean re-reads
  // references after every await, and a doc edited while the dialog is open
  // must not be judged by an older render's snapshot.
  const referenced = useCallback(() => {
    const state = useEditorStore.getState()
    return collectReferencedHashes({
      doc: state.doc,
      past: state.past,
      future: state.future,
      autosave: readAutosave(),
    })
  }, [])

  const refresh = useCallback(async () => {
    const projectId = doc.project.id
    const request = ++refreshRequest.current
    // A project installed while the reads are in flight owns the dialog now.
    // Publishing this pass would show the old project's usage and candidates
    // under the new project's name, or arm its confirmations with stale data.
    const isCurrent = () =>
      refreshRequest.current === request && useEditorStore.getState().doc.project.id === projectId
    const supportedNow = isMediaStoreSupported()
    setSupported(supportedNow)
    if (!supportedNow) {
      if (!isCurrent()) return
      setProjectBytes(0)
      setEstimate(null)
      setPersistent(false)
      setCandidates(0)
      setCandidateBytes(0)
      setNotice(REFUSALS.unsupported)
      return
    }
    try {
      const usage = await projectMediaUsage(projectId)
      if (!isCurrent()) return
      setProjectBytes(usage)
      const currentEstimate = await estimateMediaStore()
      if (!isCurrent()) return
      setEstimate(currentEstimate)
      setPersistent(await isStoragePersistent())
      if (!isCurrent()) return
      const listing = await listUnusedMedia(projectId, referenced())
      if (!isCurrent()) return
      setCandidates(listing.candidates.length)
      setCandidateBytes(listing.reclaimed)
      setNotice(listing.blocked ? REFUSALS.claims : null)
    } catch {
      // An unreadable store is not "nothing to clean": fail closed.
      if (!isCurrent()) return
      setCandidates(0)
      setCandidateBytes(0)
      setNotice(REFUSALS.claims)
    }
  }, [doc, referenced])

  // Data loads when the dialog opens; phase lifecycle lives in the effects
  // below so this one only synchronizes with the store.
  useEffect(() => {
    if (!open) return
    // Deferred out of the effect body: the lint rule treats a setState-capable
    // caller invoked synchronously here as a cascading render.
    queueMicrotask(() => void refresh())
  }, [open, refresh])

  // The parent can close the dialog without going through onOpenChange. Reset
  // on every open-state change too, so a reopen never resumes an armed
  // confirmation left by the previous visit.
  useEffect(() => {
    queueMicrotask(() => {
      setPhase('ready')
      setConfirmedProjectId(null)
    })
  }, [open])

  const persistedBytes = estimate?.usage ?? projectBytes

  const runClean = async () => {
    // Read the target at click time: the confirmation and the dialog's render
    // may both be older than a project that was installed in between.
    const projectId = useEditorStore.getState().doc.project.id
    if (confirmedProjectId !== projectId) {
      setPhase('ready')
      setConfirmedProjectId(null)
      return
    }
    setPhase('working')
    try {
      const outcome = await cleanUnusedMedia({
        projectId,
        lock: currentProjectLock(),
        cleanBlocked: useEditorStore.getState().mediaCleanBlocked,
        pendingInstall: hasPendingInstall,
        referenced,
        isProjectCurrent: () => useEditorStore.getState().doc.project.id === projectId,
      })
      if (outcome.status === 'ran') {
        const count = outcome.report.deleted.length
        toast({
          title:
            count > 0 ? `Reclaimed ${formatBytes(outcome.report.reclaimed)}` : 'Nothing to clean',
          description:
            count > 0
              ? `${count} unused stored file${count === 1 ? '' : 's'} removed from this project's storage.${outcome.report.warning ? ` ${outcome.report.warning}` : ''}`
              : `Every stored media or font file is still referenced.${outcome.report.warning ? ` ${outcome.report.warning}` : ''}`,
        })
      } else {
        toast({
          title: 'Clean Unused Media is unavailable',
          description: REFUSALS[outcome.status],
          variant: 'destructive',
        })
      }
    } catch (error) {
      // A store failure must leave the controls usable, not stuck on working.
      toast({
        title: 'Clean Unused Media failed',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setPhase('ready')
      setConfirmedProjectId(null)
      await refresh()
    }
  }

  const requestKeep = async () => {
    const granted = await requestPersistentStorage()
    setPersistent(granted)
    toast({
      title: granted ? 'Storage will be kept' : 'Storage request declined',
      description: granted
        ? 'The browser will keep this project media on this device.'
        : 'Your browser decides. Keeping the original files is the safe fallback.',
    })
  }

  const runClearAll = async () => {
    const projectId = useEditorStore.getState().doc.project.id
    if (confirmedProjectId !== projectId) {
      setPhase('ready')
      setConfirmedProjectId(null)
      return
    }
    setPhase('working')
    try {
      const outcome = await clearAllProjectMedia({
        projectId,
        lock: currentProjectLock(),
      })
      if (outcome.status === 'busy' || outcome.status === 'unsupported') {
        toast({
          title: 'Clear All Stored Media is unavailable',
          description: REFUSALS[outcome.status],
          variant: 'destructive',
        })
        return
      }
      const result = outcome.result
      toast({
        title: result.deleted > 0 ? `Cleared ${formatBytes(result.reclaimed)}` : 'Nothing to clear',
        description:
          result.deleted > 0
            ? 'Every asset becomes offline on reload until you relink it. Saved copies of this project lose their media.'
            : 'No stored media or fonts were found for this project.',
      })
    } catch (error) {
      toast({
        title: 'Clear All Stored Media failed',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setPhase('ready')
      setConfirmedProjectId(null)
      await refresh()
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Every transition starts from a clean slate: a close never leaves an
        // armed confirmation behind, and a reopen never resumes one.
        setPhase('ready')
        setConfirmedProjectId(null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="storage-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDrive className="size-4" />
            Project storage
          </DialogTitle>
          <DialogDescription>
            Imported media is kept on this device so it survives a reload. Clearing site data
            removes it.
          </DialogDescription>
        </DialogHeader>

        {!supported ? (
          <p className="text-sm text-muted-foreground">
            This browser cannot store media. Imports stay usable for this session only, and need
            relinking after a reload.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5" data-testid="storage-usage">
              <div className="flex items-baseline justify-between text-sm">
                <span>This project</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatBytes(projectBytes)}
                </span>
              </div>
              {estimate && estimate.quota > 0 && (
                <>
                  <Progress value={Math.min(100, (persistedBytes / estimate.quota) * 100)} />
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(persistedBytes)} used of {formatBytes(estimate.quota)} available on
                    this device.
                  </p>
                </>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md border p-2">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <ShieldCheck className="size-4 text-muted-foreground" />
                  {persistent
                    ? 'Media is kept on this device'
                    : 'Let the browser evict this media?'}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {persistent
                    ? 'The browser will not clear this storage to reclaim space.'
                    : 'Ask the browser to keep this storage instead of clearing it under pressure.'}
                </p>
              </div>
              {!persistent && (
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="storage-persist"
                  onClick={() => void requestKeep()}
                >
                  Keep media
                </Button>
              )}
            </div>

            <div className="space-y-2 rounded-md border p-2">
              <p className="text-sm font-medium">Clean Unused Media</p>
              <p className="text-xs text-muted-foreground">
                {cleanBlocked
                  ? REFUSALS.unclaimed
                  : notice
                    ? notice
                    : candidates > 0
                      ? `${candidates} unreferenced file${candidates === 1 ? '' : 's'} (${formatBytes(candidateBytes)}). Nothing you can undo, reopen, or saved copy still references is touched.`
                      : 'Every stored file is reachable from this project, its history, or a saved copy.'}
              </p>
              {phase === 'confirm-clean' && confirmedProjectId === doc.project.id ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    data-testid="storage-clean-confirm"
                    onClick={() => void runClean()}
                  >
                    Delete {candidates} file{candidates === 1 ? '' : 's'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPhase('ready')
                      setConfirmedProjectId(null)
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  data-testid="storage-clean"
                  disabled={phase === 'working' || candidates === 0 || cleanBlocked}
                  onClick={() => {
                    setConfirmedProjectId(doc.project.id)
                    setPhase('confirm-clean')
                  }}
                >
                  {phase === 'working' ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Clean Unused Media
                </Button>
              )}
            </div>

            <div className="space-y-2 rounded-md border border-destructive/40 p-2">
              <p className="text-sm font-medium">Clear All Stored Media</p>
              <p className="text-xs text-muted-foreground">
                Removes every stored file for this project, including the ones in use. Every asset
                becomes offline on reload, and every saved copy of this project loses its media
                until it is relinked.
              </p>
              {phase === 'confirm-clear' && confirmedProjectId === doc.project.id ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    data-testid="storage-clear-confirm"
                    onClick={() => void runClearAll()}
                  >
                    Clear everything
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setPhase('ready')
                      setConfirmedProjectId(null)
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="destructive"
                  data-testid="storage-clear"
                  disabled={phase === 'working' || projectBytes === 0}
                  onClick={() => {
                    setConfirmedProjectId(doc.project.id)
                    setPhase('confirm-clear')
                  }}
                >
                  <Trash2 className="size-3.5" />
                  Clear All Stored Media
                </Button>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/hooks/use-toast'

import { activeTracks, findSequence } from '@/lib/editor/factories'
import { useEditorStore } from '@/lib/editor/store'
import {
  createBuiltinTemplates,
  templateFromSequence,
  type ProjectTemplate,
} from '@/lib/editor/templates'
import {
  deleteSavedTemplate,
  listSavedTemplates,
  saveTemplate,
  templatesSupported,
  updateSavedTemplate,
} from '@/lib/editor/template-store'
import { TEMPLATE_DESCRIPTION_MAX, TEMPLATE_NAME_MAX } from '@/lib/editor/constants'

/**
 * Local template gallery (0.26.0): built-in title/lower-third/credits cards and
 * the user's saved templates. Applying installs a fresh compound sequence at
 * the playhead as one undo entry and opens it; saving captures the current
 * sequence's text and shape clips, never media and never track group ids.
 */
export function TemplateGallery({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [builtins] = useState(() => createBuiltinTemplates())
  const [saved, setSaved] = useState<ProjectTemplate[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'unsupported'>('loading')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!templatesSupported()) {
      setStatus('unsupported')
      return
    }
    try {
      setSaved(await listSavedTemplates())
      setStatus('ready')
    } catch {
      setStatus('unsupported')
    }
  }, [])

  useEffect(() => {
    if (!open) return
    // Start the async read on a microtask: the effect body must not call a
    // state-setting function synchronously (cascading-render lint), and the
    // resolution already lands in a promise.
    void Promise.resolve().then(refresh)
  }, [open, refresh])

  const apply = (template: ProjectTemplate) => {
    const state = useEditorStore.getState()
    const path = state.activeSequencePath
    const sequenceId = path[path.length - 1]
    const destination = activeTracks(state.doc, path).find((track) => track.kind === 'video')
    const before = new Set((state.doc.project.sequences ?? []).map((sequence) => sequence.id))
    try {
      const applied = state.apply({
        type: 'applyTemplate',
        template,
        start: state.playhead,
        ...(sequenceId ? { sequenceId } : {}),
        ...(destination ? { trackId: destination.id } : {}),
      })
      if (!applied) return
      const next = useEditorStore.getState()
      const added = (next.doc.project.sequences ?? []).find((sequence) => !before.has(sequence.id))
      if (added) next.openSequence(added.id)
      onOpenChange(false)
      toast({ title: 'Template applied', description: template.name })
    } catch (error) {
      toast({
        title: 'Template not applied',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }

  const saveCurrent = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast({ title: 'Enter a template name', variant: 'destructive' })
      return
    }
    const state = useEditorStore.getState()
    const path = state.activeSequencePath
    const sequenceId = path[path.length - 1]
    const sequence = sequenceId ? findSequence(state.doc, sequenceId) : undefined
    setBusy(true)
    try {
      const template = templateFromSequence(
        {
          id: sequence?.id ?? 'seq_root',
          name: sequence?.name ?? state.doc.project.name,
          tracks: activeTracks(state.doc, path),
        },
        { name: trimmed, description: description.trim() },
      )
      await saveTemplate(template)
      setName('')
      setDescription('')
      await refresh()
      toast({ title: 'Template saved', description: template.name })
    } catch (error) {
      toast({
        title: 'Template not saved',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setBusy(false)
    }
  }

  const rename = async (template: ProjectTemplate, next: string): Promise<string | null> => {
    const trimmed = next.trim()
    if (!trimmed || trimmed === template.name) return null
    try {
      await updateSavedTemplate(template.id, { name: trimmed })
      await refresh()
      return null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast({
        title: 'Template not renamed',
        description: message,
        variant: 'destructive',
      })
      return message
    }
  }

  const remove = async (template: ProjectTemplate) => {
    try {
      await deleteSavedTemplate(template.id)
      await refresh()
    } catch (error) {
      toast({
        title: 'Template not deleted',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        data-testid="template-gallery"
      >
        <DialogHeader>
          <DialogTitle>Templates</DialogTitle>
          <DialogDescription>
            Templates create a new sequence at the playhead from text and shapes. They never store
            media, and saving keeps only text and shape clips.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Built-in
            </h3>
            <div className="grid gap-2 sm:grid-cols-3">
              {builtins.map((template) => (
                <TemplateCard
                  key={template.id}
                  template={template}
                  onApply={() => apply(template)}
                />
              ))}
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Saved
            </h3>
            {status === 'loading' ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading saved templates
              </p>
            ) : status === 'unsupported' ? (
              <p className="text-xs text-muted-foreground" data-testid="template-store-unavailable">
                Saved templates are unavailable in this browser.
              </p>
            ) : saved.length === 0 ? (
              <p className="text-xs text-muted-foreground">No saved templates yet.</p>
            ) : (
              <div className="space-y-2" role="list" aria-label="Saved templates">
                {saved.map((template) => (
                  <SavedTemplateRow
                    key={`${template.id}:${template.name}`}
                    template={template}
                    onRename={(next) => rename(template, next)}
                    onApply={() => apply(template)}
                    onDelete={() => void remove(template)}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="space-y-2 border-t border-border pt-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Save current sequence
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label htmlFor="template-name" className="text-xs">
                  Name
                </Label>
                <Input
                  id="template-name"
                  data-testid="template-name"
                  className="mt-1 h-8"
                  maxLength={TEMPLATE_NAME_MAX}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="template-description" className="text-xs">
                  Description
                </Label>
                <Input
                  id="template-description"
                  data-testid="template-description"
                  className="mt-1 h-8"
                  maxLength={TEMPLATE_DESCRIPTION_MAX}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1"
              data-testid="template-save"
              onClick={() => void saveCurrent()}
              disabled={busy || status === 'unsupported'}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              Save current sequence
            </Button>
          </section>
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

/**
 * One saved template with its own name draft. The draft is controlled so a
 * refused rename restores the stored name immediately; a successful rename
 * changes the row key, which remounts it with the new saved value.
 */
function SavedTemplateRow({
  template,
  onRename,
  onApply,
  onDelete,
}: {
  template: ProjectTemplate
  onRename: (next: string) => Promise<string | null>
  onApply: () => void
  onDelete: () => void
}) {
  const [draft, setDraft] = useState(template.name)
  const commit = async () => {
    const failure = await onRename(draft)
    if (failure) setDraft(template.name)
  }
  return (
    <div role="listitem" className="flex items-center gap-2 rounded border border-border p-2">
      <div className="min-w-0 flex-1">
        <Input
          aria-label={`Template name ${template.name}`}
          value={draft}
          maxLength={TEMPLATE_NAME_MAX}
          className="h-8"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        {template.description && (
          <p className="mt-1 truncate text-[11px] text-muted-foreground">{template.description}</p>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8"
        aria-label={`Apply template ${template.name}`}
        onClick={onApply}
      >
        Apply
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={`Delete template ${template.name}`}
        onClick={onDelete}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  )
}

function TemplateCard({ template, onApply }: { template: ProjectTemplate; onApply: () => void }) {
  return (
    <div className="rounded border border-border p-2" data-testid={`template-card-${template.id}`}>
      <p className="text-sm font-medium">{template.name}</p>
      <p className="mt-1 min-h-8 text-[11px] leading-relaxed text-muted-foreground">
        {template.description}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2 h-7 w-full"
        aria-label={`Apply template ${template.name}`}
        onClick={onApply}
      >
        Apply
      </Button>
    </div>
  )
}

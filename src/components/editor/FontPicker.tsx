'use client'

import { useState } from 'react'
import { Loader2, Settings2, Trash2, Upload } from 'lucide-react'

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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from '@/hooks/use-toast'

import {
  FONT_FILE_ACCEPT,
  BUILTIN_FONTS,
  isBuiltinFontFamily,
  sanitizeFontName,
} from '@/lib/editor/fonts'
import {
  FONT_NAME_MAX,
  FONT_WEIGHT_DEFAULT,
  FONT_WEIGHT_MAX,
  FONT_WEIGHT_MIN,
} from '@/lib/editor/constants'
import { uid } from '@/lib/editor/factories'
import {
  commitStagedFont,
  discardStagedFont,
  stageProjectFont,
  type StagedFont,
} from '@/lib/editor/media/font-store'
import { beginMediaActivityWhenIdle, endMediaActivity } from '@/lib/editor/media/persist'
import { currentProjectToken, isProjectTokenCurrent } from '@/lib/editor/project-io'
import { useEditorStore } from '@/lib/editor/store'
import type { ProjectFont } from '@/lib/editor/types'
import type { EditorCommand } from '@/lib/editor/commands'

/**
 * Font family picker (0.25.0): built-in system families first, then the
 * project's uploaded fonts. Selecting writes `TextStyle.fontFamily` through
 * the existing `setTextStyle` command. The upload dialog validates and loads
 * the face before the font entry commits, and the face joins the active
 * registry only after that commit.
 */
export function FontPicker({
  clipId,
  value,
  onSelect,
}: {
  clipId: string
  value: string
  onSelect: (family: string) => void
}) {
  const fonts = useEditorStore((s) => s.doc.project.fonts)
  const projectFonts = fonts ?? []
  const brandFamilies = useEditorStore((s) => s.doc.project.brandKit?.fontFamilies) ?? []
  const [uploadOpen, setUploadOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const known = new Set<string>(projectFonts.map((font) => font.family))
  return (
    <div>
      <Label className="text-xs">Font</Label>
      <div className="mt-1 flex gap-2">
        <Select value={value} onValueChange={onSelect}>
          <SelectTrigger className="h-8 min-w-0 flex-1" aria-label="Font family">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Built-in</SelectLabel>
              {BUILTIN_FONTS.map((font) => (
                <SelectItem key={font.family} value={font.family}>
                  {font.label}
                </SelectItem>
              ))}
            </SelectGroup>
            {projectFonts.length > 0 && (
              <SelectGroup>
                <SelectLabel>Project fonts</SelectLabel>
                {projectFonts.map((font) => (
                  <SelectItem key={font.id} value={font.family}>
                    {fontLabel(font)}
                  </SelectItem>
                ))}
              </SelectGroup>
            )}
            {brandFamilies.length > 0 && (
              <SelectGroup>
                <SelectLabel>Brand kit</SelectLabel>
                {brandFamilies.map((family) => {
                  const available = known.has(family) || isBuiltinFontFamily(family)
                  return (
                    <SelectItem key={family} value={family} disabled={!available}>
                      {brandFamilyLabel(family, projectFonts)}
                    </SelectItem>
                  )
                })}
              </SelectGroup>
            )}
            {!known.has(value) && !isBuiltinFontFamily(value) && (
              <SelectGroup>
                <SelectLabel>Current</SelectLabel>
                <SelectItem value={value}>{value}</SelectItem>
              </SelectGroup>
            )}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5"
          aria-label="Upload font"
          onClick={() => setUploadOpen(true)}
        >
          <Upload className="size-3.5" />
          Upload
        </Button>
        {projectFonts.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0"
            aria-label="Manage project fonts"
            title="Manage project fonts"
            onClick={() => setManageOpen(true)}
          >
            <Settings2 className="size-3.5" />
          </Button>
        )}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Uploaded fonts are stored with this project and used in preview and export.
      </p>
      <FontUploadDialog
        key={uploadOpen ? 'font-upload-open' : 'font-upload-closed'}
        clipId={clipId}
        open={uploadOpen}
        onOpenChange={setUploadOpen}
      />
      <FontManagerDialog open={manageOpen} onOpenChange={setManageOpen} />
    </div>
  )
}

/**
 * Rename or remove the project's uploaded fonts. Removal is only offered for a
 * font no text clip or preset still names; the command layer refuses the rest
 * with the reference named, and that refusal is surfaced here.
 */
function FontManagerDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const fonts = useEditorStore((s) => s.doc.project.fonts) ?? []
  const apply = useEditorStore((s) => s.apply)
  const run = (command: EditorCommand) => {
    try {
      apply(command)
    } catch (error) {
      toast({
        title: 'Font not changed',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }
  const rename = (font: ProjectFont, next: string) => {
    if (next === font.name) return
    run({ type: 'renameProjectFont', fontId: font.id, name: next })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="font-manager-dialog">
        <DialogHeader>
          <DialogTitle>Project fonts</DialogTitle>
          <DialogDescription>
            Rename a font, or remove one that no text clip or saved preset still uses.
          </DialogDescription>
        </DialogHeader>
        {fonts.length === 0 ? (
          <p className="text-xs text-muted-foreground">This project has no uploaded fonts.</p>
        ) : (
          <div className="space-y-2" role="list" aria-label="Project fonts">
            {fonts.map((font) => (
              <div key={font.id} role="listitem" className="flex items-center gap-2">
                <Input
                  aria-label={`Font name for ${font.name}`}
                  defaultValue={font.name}
                  maxLength={FONT_NAME_MAX}
                  className="h-8"
                  onBlur={(event) => rename(font, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  aria-label={`Remove font ${font.name}`}
                  title={`Remove ${font.name}`}
                  onClick={() => run({ type: 'removeProjectFont', fontId: font.id })}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
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

function fontLabel(font: ProjectFont): string {
  const details = [font.weight ? String(font.weight) : '', font.style === 'italic' ? 'Italic' : '']
    .filter(Boolean)
    .join(' ')
  return details ? `${font.name} (${details})` : font.name
}

/** A brand reference that no built-in or project font answers is shown, disabled. */
function brandFamilyLabel(family: string, projectFonts: readonly ProjectFont[]): string {
  const builtin = BUILTIN_FONTS.find((font) => font.family === family)
  if (builtin) return builtin.label
  const project = projectFonts.find((font) => font.family === family)
  if (project) return project.name
  return `${family} (unavailable)`
}

function fileStem(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function FontUploadDialog({
  clipId,
  open,
  onOpenChange,
}: {
  clipId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [weight, setWeight] = useState(String(FONT_WEIGHT_DEFAULT))
  const [style, setStyle] = useState<'normal' | 'italic'>('normal')
  const [busy, setBusy] = useState(false)

  const upload = async () => {
    if (!file) {
      toast({ title: 'Choose a font file first', variant: 'destructive' })
      return
    }
    const display = sanitizeFontName(name)
    if (!display) {
      toast({ title: 'Enter a font name', variant: 'destructive' })
      return
    }
    const token = currentProjectToken()
    setBusy(true)
    // Hold the media-activity reservation from staging through commit: the
    // stored hash is unreferenced until `addProjectFont` commits it, and the
    // clean action refuses while activity is in flight instead of deleting it.
    // The finally below releases the hold on refusal or failure, leaving the
    // bytes for a later clean without touching committed media.
    const activity = await beginMediaActivityWhenIdle()
    let staged: StagedFont | null = null
    try {
      staged = await stageProjectFont(
        {
          projectId: token.projectId,
          id: uid('font'),
          name: display,
          file,
          weight: Number(weight),
          style,
        },
        activity,
      )
      if (!isProjectTokenCurrent(token)) {
        discardStagedFont(staged)
        return
      }
      const applied = useEditorStore.getState().apply([
        { type: 'addProjectFont', font: staged.font },
        { type: 'setTextStyle', clipId, style: { fontFamily: staged.font.family } },
      ])
      if (!applied) {
        discardStagedFont(staged)
        return
      }
      if (!commitStagedFont(staged, token.projectId)) {
        toast({
          title: 'Font stored but not active',
          description: 'The project changed; reopen it to load the font.',
          variant: 'destructive',
        })
        return
      }
      // The command batch already applied the family to the clip; reapplying
      // here would add a second, empty undo entry.
      toast({ title: 'Font added', description: `${staged.font.name} is ready to use.` })
      onOpenChange(false)
    } catch (error) {
      if (staged) discardStagedFont(staged)
      toast({
        title: 'Font upload failed',
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      endMediaActivity()
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="font-upload-dialog">
        <DialogHeader>
          <DialogTitle>Upload a font</DialogTitle>
          <DialogDescription>
            WOFF2, WOFF, TTF, or OTF, up to 8 MB. The font is stored with this project and loads
            before preview and export.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="font-file" className="text-xs">
              Font file
            </Label>
            <Input
              id="font-file"
              type="file"
              accept={FONT_FILE_ACCEPT}
              data-testid="font-file"
              className="mt-1"
              onChange={(event) => {
                const next = event.target.files?.[0] ?? null
                setFile(next)
                if (next && !nameTouched) setName(sanitizeFontName(fileStem(next.name)) ?? '')
              }}
            />
          </div>
          <div>
            <Label htmlFor="font-name" className="text-xs">
              Display name
            </Label>
            <Input
              id="font-name"
              data-testid="font-name"
              className="mt-1 h-8"
              maxLength={FONT_NAME_MAX}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setNameTouched(true)
              }}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Weight</Label>
              <Select value={weight} onValueChange={setWeight}>
                <SelectTrigger className="mt-1 h-8" aria-label="Font weight">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[100, 200, 300, 400, 500, 600, 700, 800, 900]
                    .filter((value) => value >= FONT_WEIGHT_MIN && value <= FONT_WEIGHT_MAX)
                    .map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Style</Label>
              <Select
                value={style}
                onValueChange={(value) => setStyle(value === 'italic' ? 'italic' : 'normal')}
              >
                <SelectTrigger className="mt-1 h-8" aria-label="Font style">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="italic">Italic</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void upload()} disabled={busy || !file} data-testid="font-upload">
            {busy && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Upload font
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

'use client'

import { useRef, useState } from 'react'
import {
  BetweenHorizontalStart,
  Copy,
  ChevronDown,
  FolderOpen,
  Magnet,
  Loader2,
  MonitorPlay,
  MousePointer2,
  MoveHorizontal,
  PenTool,
  Plus,
  Redo2,
  Save,
  Scissors,
  Slice,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
  FileVideo,
  FileAudio,
  Type as TypeIcon,
} from 'lucide-react'
import { toast } from '@/hooks/use-toast'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

import { commandsToAddText } from '@/lib/editor/actions'
import { canSplitAllAt, canSplitAnySelectedAt } from '@/lib/editor/links'
import { createBuiltinTextPresets } from '@/lib/editor/factories'
import { PPS_MAX, PPS_MIN } from '@/lib/editor/constants'
import { openProjectFile } from '@/lib/editor/project-io'
import { executeAction, type ExecutorActionId } from '@/lib/editor/action-executor'
import { createActionContext } from '@/hooks/editor/action-context'
import { useEditorStore, useStableDoc } from '@/lib/editor/store'
import type { TextStyle } from '@/lib/editor/types'
import { isAutomationGestureLive } from '@/hooks/editor/gesture-state'

/** Top toolbar: tools (V/C), edit history, edit tools, zoom, project name, project IO, export. */
export function Toolbar({ onOpenExport }: { onOpenExport: () => void }) {
  const doc = useStableDoc()
  const past = useEditorStore((s) => s.past)
  const future = useEditorStore((s) => s.future)
  const selections = useEditorStore((s) => s.selections)
  const playhead = useEditorStore((s) => s.playhead)
  const snapEnabled = useEditorStore((s) => s.snapEnabled)
  const pxPerSec = useEditorStore((s) => s.pxPerSec)
  const activeTool = useEditorStore((s) => s.activeTool)
  const dropMode = useEditorStore((s) => s.dropMode)
  const untargetedTracks = useEditorStore((s) => s.untargetedTracks)
  const activeSequencePath = useEditorStore((s) => s.activeSequencePath)
  const { apply, setActiveTool, setDropMode } = useEditorStore.getState()

  // A live gesture owns the tool: switching mid-drag would show one tool while
  // the in-flight closures still run the old one. Same rule as the keyboard.
  const chooseTool = (tool: 'select' | 'razor' | 'ripple' | 'slip' | 'pen') => {
    if (isAutomationGestureLive()) return
    setActiveTool(tool)
  }

  const loadInputRef = useRef<HTMLInputElement>(null)
  const [isLoading, setIsLoading] = useState(false)

  const selectedIds = selections
  const hasSelection = selectedIds.length > 0

  const showError = (error: unknown) => {
    toast({
      title: 'Action failed',
      description: error instanceof Error ? error.message : String(error),
      variant: 'destructive',
    })
  }

  /** One executor call, with the toolbar's export/dialog callbacks injected. */
  const run = (action: ExecutorActionId) => {
    const store = useEditorStore.getState()
    try {
      const outcome = executeAction(action, createActionContext({ openExport: onOpenExport }))
      if (outcome.commands) {
        const applied = store.apply(outcome.commands)
        if (applied && outcome.successToast) toast({ title: outcome.successToast })
      }
    } catch (error) {
      showError(error)
    }
  }

  const addTextWithStyle = (style?: TextStyle) => {
    try {
      apply(
        commandsToAddText(
          doc,
          playhead,
          untargetedTracks,
          activeSequencePath[activeSequencePath.length - 1],
          style,
        ),
      )
    } catch (error) {
      showError(error)
    }
  }

  const handleLoadFile = async (file: File) => {
    // The picker already ran (this File came from the hidden input): open it
    // through the SAME coordinator the menu uses, so menu opens, toolbar opens
    // and File > New all invalidate each other's in-flight loads. Opening a
    // second picker here would make the user choose twice.
    setIsLoading(true)
    try {
      await openProjectFile(file)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <header
        role="toolbar"
        aria-label="Main toolbar"
        className="editor-scroll flex h-auto min-h-12 shrink-0 items-center gap-1 overflow-x-auto overflow-y-hidden border-b bg-card px-2 py-1 sm:px-3"
      >
        {/* History */}
        <ToolButton
          label="Undo (Ctrl+Z)"
          onClick={() => run('edit.undo')}
          disabled={past.length === 0}
          icon={<Undo2 className="size-4" />}
        />
        <ToolButton
          label="Redo (Ctrl+Shift+Z)"
          onClick={() => run('edit.redo')}
          disabled={future.length === 0}
          icon={<Redo2 className="size-4" />}
        />

        <Separator orientation="vertical" className="mx-0.5 h-6" />

        {/* Tools (Premiere: V selection / C razor) */}
        <ToolButton
          label="Selection tool (V)"
          onClick={() => chooseTool('select')}
          active={activeTool === 'select'}
          icon={<MousePointer2 className="size-4" />}
        />
        <ToolButton
          label="Razor tool (C) — click a clip to cut it"
          onClick={() => chooseTool('razor')}
          active={activeTool === 'razor'}
          icon={<Slice className="size-4" />}
        />
        <ToolButton
          label="Ripple trim tool (B). Drag a clip edge to shift later clips on this track; linked partners on other tracks do not shift."
          onClick={() => chooseTool('ripple')}
          active={activeTool === 'ripple'}
          icon={<BetweenHorizontalStart className="size-4" />}
        />
        <ToolButton
          label="Slip tool (Y). Drag a clip to change which part of its source it shows, without moving it."
          onClick={() => chooseTool('slip')}
          active={activeTool === 'slip'}
          icon={<MoveHorizontal className="size-4" />}
        />
        <ToolButton
          label="Pen tool (P). Click the curve to add a keyframe, drag a dot to edit it, Alt-click or Delete to remove. Edits volume on audio clips and opacity on picture clips."
          onClick={() => chooseTool('pen')}
          active={activeTool === 'pen'}
          icon={<PenTool className="size-4" />}
        />

        <Separator orientation="vertical" className="mx-0.5 h-6" />

        {/* Placement mode (Premiere-style Place / Insert / Overwrite). Sticky
            and session-only; `,`/`.` are independent one-shot insert/overwrite
            keys and ignore this toggle. */}
        <div
          role="group"
          aria-label="Placement mode"
          className="border-border flex shrink-0 items-center overflow-hidden rounded-md border"
        >
          {PLACEMENT_MODES.map(({ mode, label, hint }) => (
            <Tooltip key={mode}>
              <TooltipTrigger asChild>
                <Button
                  variant={dropMode === mode ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={dropMode === mode}
                  aria-label={`${label} placement${hint ? ` (${hint})` : ''}`}
                  data-testid={`placement-mode-${mode}`}
                  onClick={() => setDropMode(mode)}
                  className="h-7 rounded-none px-2 text-xs"
                >
                  {label}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {mode === 'place'
                  ? 'Place lane drops plainly (default)'
                  : mode === 'insert'
                    ? 'Insert: ripple later clips right (key: ,)'
                    : 'Overwrite: replace the covered span (key: .)'}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        <Separator orientation="vertical" className="mx-0.5 h-6" />

        {/* Edit tools */}
        <ToolButton
          label="Add Edit (Ctrl+K)"
          onClick={() => run('clip.split')}
          disabled={
            hasSelection
              ? !canSplitAnySelectedAt(doc, selectedIds, playhead)
              : !canSplitAllAt(doc, playhead, activeSequencePath)
          }
          icon={<Scissors className="size-4" />}
        />
        <ToolButton
          label="Duplicate selection (D)"
          onClick={() => run('clip.duplicate')}
          disabled={!hasSelection}
          icon={<Copy className="size-4" />}
        />
        <ToolButton
          label="Delete selection (Del)"
          onClick={() => run('clip.delete')}
          disabled={!hasSelection}
          icon={<Trash2 className="size-4" />}
        />

        <Separator orientation="vertical" className="mx-0.5 h-6" />

        {/* Add material */}
        <div className="flex items-center">
          <ToolButton
            label="Add text clip (T)"
            onClick={() => run('graphics.newText')}
            icon={<TypeIcon className="size-4" />}
          />
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Add text with preset style"
                    className="-ml-1 size-8"
                  >
                    <ChevronDown className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Add text with preset style</TooltipContent>
            </Tooltip>
            <DropdownMenuContent aria-label="Text style presets">
              <DropdownMenuItem onSelect={() => addTextWithStyle()}>Default style</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Built-in presets</DropdownMenuLabel>
              {createBuiltinTextPresets().map((preset) => (
                <DropdownMenuItem key={preset.id} onSelect={() => addTextWithStyle(preset.style)}>
                  {preset.name}
                </DropdownMenuItem>
              ))}
              {(doc.project.textPresets ?? []).length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>Saved presets</DropdownMenuLabel>
                  {(doc.project.textPresets ?? []).map((preset) => (
                    <DropdownMenuItem
                      key={preset.id}
                      onSelect={() => addTextWithStyle(preset.style)}
                    >
                      {preset.name}
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Add track" className="size-8">
                  <Plus className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Add track</TooltipContent>
          </Tooltip>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => run('sequence.addVideoTrack')}>
              <FileVideo className="mr-2 size-4" /> Video track
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => run('sequence.addAudioTrack')}>
              <FileAudio className="mr-2 size-4" /> Audio track
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => run('sequence.addTextTrack')}>
              <TypeIcon className="mr-2 size-4" /> Text track
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Separator orientation="vertical" className="mx-0.5 h-6" />

        {/* Snap + zoom */}
        <ToolButton
          label={snapEnabled ? 'Snapping on' : 'Snapping off'}
          onClick={() => run('view.toggleSnap')}
          active={snapEnabled}
          icon={<Magnet className="size-4" />}
        />
        <ToolButton
          label="Zoom out (−)"
          onClick={() => run('view.zoomOut')}
          disabled={pxPerSec <= PPS_MIN}
          icon={<ZoomOut className="size-4" />}
        />
        <ToolButton
          label="Zoom in (+)"
          onClick={() => run('view.zoomIn')}
          disabled={pxPerSec >= PPS_MAX}
          icon={<ZoomIn className="size-4" />}
        />

        {/* Project name (center, flexible) */}
        <div className="mx-1 min-w-0 flex-1 lg:mx-2">
          <Input
            aria-label="Project name"
            value={doc.project.name}
            onChange={(e) =>
              apply({
                type: 'setProjectSettings',
                patch: { name: e.target.value },
              })
            }
            className="h-8 w-full max-w-xs bg-transparent text-sm font-medium"
          />
        </div>

        {/* Project IO + export */}
        <ToolButton
          label="Save project (Ctrl+S)"
          onClick={() => run('file.saveProject')}
          icon={<Save className="size-4" />}
        />
        <ToolButton
          label="Open project…"
          onClick={() => loadInputRef.current?.click()}
          icon={<FolderOpen className="size-4" />}
        />
        <input
          ref={loadInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          aria-hidden="true"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleLoadFile(file)
            e.target.value = ''
          }}
        />
        <Button size="sm" className="ml-1 gap-1.5" aria-label="Export" onClick={onOpenExport}>
          {isLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <MonitorPlay className="size-4" />
          )}
          <span className="hidden xl:inline">Export</span>
        </Button>
      </header>
    </TooltipProvider>
  )
}

/** The sticky placement-mode control's options (order = display order). */
const PLACEMENT_MODES: { mode: 'place' | 'insert' | 'overwrite'; label: string; hint: string }[] = [
  { mode: 'place', label: 'Place', hint: '' },
  { mode: 'insert', label: 'Insert', hint: ',' },
  { mode: 'overwrite', label: 'Overwrite', hint: '.' },
]

function ToolButton({
  label,
  onClick,
  icon,
  disabled,
  active,
}: {
  label: string
  onClick: () => void
  icon: React.ReactNode
  disabled?: boolean
  active?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          disabled={disabled}
          className={active ? 'size-8 bg-accent text-accent-foreground' : 'size-8'}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Static wiring locks for the layering features (user request: drag text in
 * the preview monitor, discoverable V2+ track adding, per-clip opacity like
 * Premiere/Photoshop). jsdom cannot do real layout or pointer capture, so —
 * like timeline-layers.test.ts / media-pool.test.ts — these lock the source
 * wiring that browser E2E verified.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('preview drag-to-position (text)', () => {
  const panel = read('src/components/editor/PreviewPanel.tsx')

  it('uses the transient gesture protocol (one undo step per drag)', () => {
    expect(panel).toMatch(/beginTransient\(e\.pointerId\)/)
    expect(panel).toMatch(/applyTransient\(\{[^}]*type: 'setTextStyle'/)
    expect(panel).toMatch(/commitTransient\(\)/)
    expect(panel).toMatch(/cancelTransient\(\)/)
  })

  it('wires pointer down/move/up/cancel on the preview canvas', () => {
    expect(panel).toMatch(/onPointerDown=\{onCanvasPointerDown\}/)
    expect(panel).toMatch(/onPointerMove=\{onCanvasPointerMove\}/)
    expect(panel).toMatch(/onPointerUp=\{\(e\) => endTextDrag\(true, e\)\}/)
    expect(panel).toMatch(/onPointerCancel=\{\(e\) => endTextDrag\(false, e\)\}/)
  })

  it('grab cursor only when a text clip is live at the playhead', () => {
    expect(panel).toMatch(/cursor-grab/)
    expect(panel).toMatch(/cursor-grabbing/)
    expect(panel).toMatch(
      /playhead >= textClip\.start && playhead < textClip\.start \+ textClip\.duration/,
    )
  })

  it('renders a dashed drag outline from measureTextBox', () => {
    expect(panel).toMatch(/measureTextBox/)
    expect(panel).toMatch(/text-drag-outline/)
  })
})

describe('inspector opacity slider', () => {
  const panel = read('src/components/editor/InspectorPanel.tsx')

  it('offers opacity for visual clips only, transient + committed', () => {
    expect(panel).toMatch(/aria-label="Clip opacity percent"/)
    // gated to video/image/text — audio clips have gain, not opacity
    expect(panel).toMatch(/asset\.kind !== 'audio'/)
    expect(panel).toMatch(/applyTransient\(\{[^}]*type: 'setClipOpacity'/)
    expect(panel).toMatch(/type: 'setClipOpacity'/)
  })
})

describe('add track affordance (discoverable V2/V3)', () => {
  const panel = read('src/components/editor/timeline/TimelinePanel.tsx')

  it('timeline corner cell exposes Add track with all three kinds', () => {
    expect(panel).toMatch(/aria-label="Add track"/)
    expect(panel).toMatch(/addTrack\('video'\)/)
    expect(panel).toMatch(/addTrack\('audio'\)/)
    expect(panel).toMatch(/addTrack\('text'\)/)
  })
})

describe('drop-between-tracks (media → new layer at an exact z-position)', () => {
  const panel = read('src/components/editor/timeline/TimelinePanel.tsx')
  const bin = read('src/components/editor/MediaBin.tsx')
  const commands = read('src/lib/editor/commands.ts')
  const geometry = read('src/lib/editor/timeline-drop.ts')

  it('timeline drop handlers are media-drag guarded (clip gestures / file drags untouched)', () => {
    // pointer-driven clip move/trim has no dataTransfer payload, and OS file
    // drags must keep flowing to the media bin — the guard is what keeps the
    // content-level drop zones from hijacking them.
    expect(panel).toMatch(/types\.includes\('application\/x-media-id'\)/)
  })

  it('renders the insertion line + "+ V2" preview pill', () => {
    expect(panel).toMatch(/data-testid="track-insert-line"/)
    expect(panel).toMatch(/data-testid="track-insert-label"/)
    expect(panel).toMatch(/previewTrackName/)
  })

  it('drop path wires commandsToAddMediaInNewTrack at the boundary index', () => {
    expect(panel).toMatch(/commandsToAddMediaInNewTrack\(/)
    expect(panel).toMatch(/computeTrackDropTarget\(/)
    expect(panel).toMatch(/mediaKindFromDragEvent\(/)
  })

  it('media bin drags carry the kind as a dedicated TYPE (dragover cannot read values)', () => {
    expect(bin).toMatch(/application\/x-media-kind-\$\{asset\.kind\}/)
    expect(geometry).toMatch(/MEDIA_KIND_DRAG_TYPE_PREFIX = 'application\/x-media-kind-'/)
  })

  it('addTrack supports explicit atIndex placement and skips the convention sort', () => {
    expect(commands).toMatch(/atIndex\??: number/)
    expect(commands).toMatch(/command\.atIndex !== undefined/)
    // explicit placement splices verbatim; only the default path re-sorts
    expect(commands).toMatch(/splice\(index, 0, track\)/)
    expect(commands).toMatch(/reorderTracksConvention\(doc\)/)
  })
})

describe('text-box mirrors the compositor', () => {
  it('uses the same 1.2 line height and font-string contract', () => {
    const compositor = read('src/lib/editor/playback/compositor.ts')
    const textBox = read('src/lib/editor/playback/text-box.ts')
    expect(compositor).toMatch(/fontSize \* 1\.2/)
    expect(textBox).toMatch(/fontSize \* 1\.2/)
    // identical font template so measureText matches what is actually drawn
    const fontPattern = /style\.italic \? 'italic ' : ''/
    expect(compositor).toMatch(fontPattern)
    expect(textBox).toMatch(fontPattern)
  })
})

describe('A/V linked clips (Premiere-style split + unlink)', () => {
  const clipView = read('src/components/editor/timeline/ClipView.tsx')
  const keyboard = read('src/hooks/editor/useEditorKeyboard.ts')
  const actions = read('src/lib/editor/actions.ts')
  const core = read('src/lib/editor/playback/core.ts')
  const commands = read('src/lib/editor/commands.ts')

  it('drop path splits video-with-audio into a linked pair (audioOnly twin)', () => {
    expect(actions).toMatch(/assetHasAudio\(asset\)/)
    expect(actions).toMatch(/audioOnly: true/)
    expect(actions).toMatch(/uid\('link'\)/)
  })

  it('the audio twin may live on audio tracks (clipFitsTrack rule)', () => {
    const factories = read('src/lib/editor/factories.ts')
    expect(factories).toMatch(/asset\.kind === 'video' && !!clip\.audioOnly/)
  })

  it('the playback engine shadows the video part while its twin exists', () => {
    expect(core).toMatch(/hasLinkedAudioTwin\(doc, clip\)/)
    // The link helpers (shadow rule + the derived rate-change-silence
    // predicate) come from links.ts, so both render paths share one definition.
    expect(core).toMatch(/import \{ hasLinkedAudioTwin, linkGroupChangesRate \} from '\.\.\/links'/)
    expect(core).toMatch(/linkGroupChangesRate\(doc, clip\)/)
  })

  it('splitClip re-links right halves (fresh group), keeping A/V pairing', () => {
    expect(commands).toMatch(/rightLinkId\??: string/)
    expect(commands).toMatch(/command\.rightLinkId \?\? `link_\$\{cryptoRandom\(\)\}`/)
  })

  it('clip moves drag the whole selection along (same time delta, per-lane track offset)', () => {
    // The partner math itself is pure and lives in clip-gesture.ts (decideMove);
    // the component keeps the capture and dispatch wiring.
    expect(clipView).toMatch(
      /partners: \{ id: string; trackIndex: number; kind: string; origStart: number \}\[\]/,
    )
    expect(clipView).toMatch(/decideMove\(/)
    expect(clipView).toMatch(/resolveSelectionGroups\(fresh\.doc, selIds\)/)
  })

  it('right-click opens the Premiere-style clip context menu', () => {
    expect(clipView).toMatch(/<ContextMenu/)
    expect(clipView).toMatch(/<ContextMenuTrigger asChild>/)
    expect(clipView).toMatch(/data-testid="clip-link-badge"/)
    expect(clipView).toMatch(/data-testid="menu-unlink"/)
    expect(clipView).toMatch(/data-testid="menu-cut"/)
    expect(clipView).toMatch(/data-testid="menu-copy"/)
    expect(clipView).toMatch(/data-testid="menu-paste"/)
    expect(clipView).toMatch(/data-testid="menu-split"/)
    expect(clipView).toMatch(/data-testid="menu-delete"/)
    // Task 20 additions: manual Link + Ripple Delete + Ctrl+K hint.
    expect(clipView).toMatch(/data-testid="menu-link"/)
    expect(clipView).toMatch(/data-testid="menu-ripple-delete"/)
    expect(clipView).toMatch(/Split at Playhead\s*<ContextMenuShortcut>Ctrl\+K/)
    // Right-click selects the clip before any menu action runs — but NEVER
    // collapses an existing multi-selection.
    expect(clipView).toMatch(
      /if \(!clipIsSelected\(live\.doc, live\.selections, clip\)\) live\.select\(clip\.id\)/,
    )
  })

  it('shift/ctrl click multi-selects whole link groups; dragging a selected clip keeps the selection', () => {
    expect(clipView).toMatch(/if \(e\.shiftKey\) live\.addSelection\(clip\.id\)/)
    expect(clipView).toMatch(
      /else if \(e\.ctrlKey \|\| e\.metaKey\) live\.toggleSelection\(clip\.id\)/,
    )
    // Plain pointerdown only selects when the clip is NOT already selected —
    // dragging a multi-selection must never collapse it.
    expect(clipView).toMatch(
      /else if \(!clipIsSelected\(live\.doc, live\.selections, clip\)\) live\.select\(clip\.id\)/,
    )
    // Right-click never touches the selection (the context menu decides).
    expect(clipView).toMatch(/if \(e\.button !== 0\) \{/)
  })

  it('razor tool (C) cuts the clip at the pointer instead of moving it', () => {
    expect(clipView).toMatch(/if \(activeTool === 'razor' && mode === 'move'\)/)
    expect(clipView).toMatch(/commandsToSplitClipsAt\(store\.doc, \[clip\.id\], at\)/)
    expect(clipView).toMatch(/cursor-crosshair/)
    // Timeline lanes show the blade cursor while the razor is active.
    expect(read('src/components/editor/timeline/TimelinePanel.tsx')).toMatch(
      /activeTool === 'razor' && 'cursor-crosshair'/,
    )
  })

  it('keyboard wires the full Premiere shortcut map globally', () => {
    // Clipboard (multi-selection aware).
    expect(keyboard).toMatch(/commandsToCutClips\(doc, selectedIds\)/)
    expect(keyboard).toMatch(/copyClips\(doc, selectedIds\)/)
    expect(keyboard).toMatch(/commandsToPasteClips\(doc, playhead\)/)
    // Tools: V selection / C razor / Escape back.
    expect(keyboard).toMatch(/setActiveTool\('razor'\)/)
    expect(keyboard).toMatch(/setActiveTool\('select'\)/)
    // Add Edit (Ctrl+K): split selection, or ALL tracks with no selection.
    expect(keyboard).toMatch(/commandsToSplitClipsAt\(doc, selectedIds, playhead\)/)
    expect(keyboard).toMatch(/commandsToSplitAllAt\(doc, playhead\)/)
    // S toggles snapping (Premiere), split moved to Ctrl+K.
    expect(keyboard).toMatch(/store\.toggleSnap\(\)/)
    // Delete / Shift+Delete ripple / Ctrl+L smart link-unlink toggle.
    expect(keyboard).toMatch(/commandsToDeleteClips\(doc, selectedIds\)/)
    expect(keyboard).toMatch(/commandsToRippleDeleteClips\(doc, selectedIds\)/)
    expect(keyboard).toMatch(/commandsToUnlinkClips\(doc, selectedIds\)/)
    expect(keyboard).toMatch(/commandsToLinkClips\(doc, selectedIds\)/)
    // Select all / deselect all.
    expect(keyboard).toMatch(/store\.selectAll\(\)/)
    expect(keyboard).toMatch(/store\.deselectAll\(\)/)
    // Shuttle + edit points + frame steps + zoom-to-fit.
    expect(keyboard).toMatch(/playbackRef\.current\?\.play\(\)/)
    expect(keyboard).toMatch(/playbackRef\.current\?\.pause\(\)/)
    expect(keyboard).toMatch(/nearestEditPoint\(doc, playhead, 'prev'\)/)
    expect(keyboard).toMatch(/nearestEditPoint\(doc, playhead, 'next'\)/)
    expect(keyboard).toMatch(/FRAME_STEPS/)
    expect(keyboard).toMatch(/'\\\\'/)
    // Mute still routes to the audio twin; G opens the gain dialog by event.
    expect(keyboard).toMatch(/audibleClipId\(doc, primaryId\)/)
    expect(keyboard).toMatch(/editor:audio-gain/)
  })

  it('the inspector routes gain/mute to the audio side and hints the link', () => {
    const inspector = read('src/components/editor/InspectorPanel.tsx')
    expect(inspector).toMatch(/linkedAudioTwin\(doc, clip\)/)
    expect(inspector).toMatch(/data-testid="linked-av-hint"/)
  })
})

describe('track operations are reachable from the timeline UI', () => {
  const panel = read('src/components/editor/timeline/TimelinePanel.tsx')

  it('the track-header menu dispatches rename + delete (both had NO ui before)', () => {
    expect(panel).toMatch(/type: 'renameTrack', trackId: track\.id/)
    expect(panel).toMatch(/type: 'removeTrack', trackId: track\.id/)
    expect(panel).toMatch(/data-testid="track-context-menu"/)
    expect(panel).toMatch(/data-testid="track-menu-delete"/)
  })

  it('delete is offered but disabled for the last remaining lane', () => {
    expect(panel).toMatch(/canDelete=\{doc\.project\.tracks\.length > 1\}/)
    expect(panel).toMatch(/disabled=\{!canDelete\}/)
  })

  it('menu rename takes focus instead of Radix handing it back to the header', () => {
    // Radix restores focus when the menu closes, and the rename field mounts a
    // moment later — so every keystroke was swallowed until the user re-clicked
    // the field. The close-focus is suppressed for that one item, and the field
    // takes focus a frame later, once Radix has settled.
    expect(panel).toMatch(/onCloseAutoFocus/)
    expect(panel).toMatch(/event\.preventDefault\(\)/)
    expect(panel).toMatch(/requestAnimationFrame\(\(\) => renameInputRef\.current\?\.focus\(\)\)/)
  })

  it('a clip dragged over an incompatible lane reads as blocked, and says why', () => {
    const clip = read('src/components/editor/timeline/ClipView.tsx')
    expect(clip).toMatch(/setAttribute\('data-drop-blocked', 'true'\)/)
    expect(clip).toMatch(/removeAttribute\('data-drop-blocked'\)/)
    expect(clip).toMatch(/Not a valid drop target/)
  })

  it('a refused drop rolls the whole drag back, not just the lane change', () => {
    // The drag keeps applying the LEGAL half of the gesture (the time shift, on
    // the original lane) while the pointer sits over the blocked lane, so
    // committing would move the clip to a new time while the toast says the drop
    // was invalid. Cancel restores the base doc instead.
    const clip = read('src/components/editor/timeline/ClipView.tsx')
    expect(clip).toMatch(/if \(g\.blockedLane\) store\.cancelTransient\(\)/)
    expect(clip).toMatch(/else store\.commitTransient\(\)/)
  })

  it('refuses a second drag while another gesture owns the transient base', () => {
    // `gesture` is a per-instance ref: a drag on a different clip (another
    // ClipView) is invisible to the local check, but the store holds ONE
    // transient base and beginTransient would overwrite it. The store's flag is
    // the shared truth, and the refusal still leaves the click selecting.
    const clip = read('src/components/editor/timeline/ClipView.tsx')
    expect(clip).toMatch(/import \{ currentTransientToken, isTransientActive, useEditorStore \}/)
    expect(clip).toMatch(/const transientOwnedElsewhere = isTransientActive\(\)/)
    expect(clip).toMatch(/if \(transientOwnedElsewhere\) return/)
  })

  it('adding a track scrolls by the new row, so the lanes you were on stay put', () => {
    expect(panel).toMatch(/data-track-row=\{track\.id\}/)
    expect(panel).toMatch(/scrollEl\.scrollTop \+= rowEl\.getBoundingClientRect\(\)\.height/)
  })
})

describe('a clip drag survives crossing lanes (and can reach lanes off screen)', () => {
  const clip = read('src/components/editor/timeline/ClipView.tsx')

  it('drives the gesture from window listeners instead of clip-element handlers', () => {
    // A clip that changes lane is rendered inside THAT lane's clip list, so React
    // unmounts the component and mounts a new one: element handlers (and their
    // pointer capture) die with it. Binding the gesture to the element is what
    // made a drag stop at the first lane it crossed, leaving one-lane moves as
    // the only thing that ever worked.
    // The end handler is capture-phase so it beats EditorShell's dangling-gesture
    // safety net, which is registered on window earlier (at mount) and would
    // otherwise commit before a refused drop could cancel itself.
    expect(clip).toMatch(/window\.addEventListener\('pointerup', onUp, true\)/)
    expect(clip).toMatch(/window\.removeEventListener\('pointerup', g\.onUp, true\)/)
    expect(clip).toMatch(/window\.addEventListener\('pointermove', onMove\)/)
    expect(clip).toMatch(/window\.removeEventListener\('pointermove', g\.onMove\)/)
    expect(clip).not.toMatch(/onPointerMove=\{onPointerMove\}/)
    expect(clip).not.toMatch(/setPointerCapture/)
  })

  it('does not tear a live drag down when the component unmounts mid-gesture', () => {
    expect(clip).toMatch(/if \(gesture\.current\) return/)
  })

  it('re-reads the lane boxes on every move (auto-scroll moves the rows under the pointer)', () => {
    expect(clip).toMatch(/g\.lanes = readLanes\(\)/)
  })

  it('queues the next auto-scroll frame BEFORE replaying the move', () => {
    // The replay calls syncAutoScroll; with a null ref that queues a second loop
    // on top of this one, and the scroll compounds into a runaway every frame.
    expect(clip).toMatch(
      /autoScrollRaf\.current = requestAnimationFrame\(autoScrollTick\)[\s\S]{0,400}?moveTo\(g\.lastX, g\.lastY\)/,
    )
  })

  it('keeps the auto-scroll band pure and frame-budgeted', () => {
    const geometry = read('src/lib/editor/timeline-scroll.ts')
    expect(geometry).toMatch(/export function autoScrollStep/)
    expect(geometry).toMatch(/AUTOSCROLL_EDGE_PX = 24/)
    expect(geometry).toMatch(/AUTOSCROLL_MAX_STEP_PX = 14/)
  })
})

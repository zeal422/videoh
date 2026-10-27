import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Static wiring locks for the volume envelope (0.13.0). jsdom cannot prove
 * pointer layering or the real curve geometry, so the source shape that the
 * browser proof depends on is pinned here.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('timeline envelope wiring', () => {
  const clipView = read('src/components/editor/timeline/ClipView.tsx')
  const envelope = read('src/components/editor/timeline/VolumeEnvelope.tsx')

  it('draws the envelope above the waveform and below the label and trim handles', () => {
    expect(clipView).toContain("from './VolumeEnvelope'")
    const envelopeIndex = clipView.indexOf('<VolumeEnvelope')
    expect(envelopeIndex).toBeGreaterThan(-1)
    expect(envelopeIndex).toBeGreaterThan(clipView.indexOf('<Waveform'))
    expect(envelopeIndex).toBeLessThan(clipView.indexOf('{/* label */}'))
    expect(envelopeIndex).toBeLessThan(clipView.indexOf('{/* trim handles */}'))
    // The clip root is inset-y-1, so the overlay gets its real content height.
    expect(clipView).toMatch(/height=\{height - 8\}/)
    expect(clipView).toMatch(/inert=\{activeTool !== 'select'\}/)
  })

  it('keeps pointer events off the empty space and on the dots and line only', () => {
    expect(envelope).toMatch(/pointer-events-none absolute inset-0/)
    expect(envelope).toMatch(/data-testid="volume-envelope-plot"/)
    expect(envelope).toMatch(/className="pointer-events-none absolute"/)
    expect(envelope).toMatch(/pointerEvents: inert \? 'none' : 'stroke'/)
    expect(envelope).toMatch(/pointer-events-auto cursor-ns-resize/)
    expect(envelope).toMatch(/inert\s*\? 'pointer-events-none'/)
    // The curve is white, never the selection rose.
    expect(envelope).toMatch(/className="stroke-white\/90"/)
    expect(envelope).not.toMatch(/stroke-rose/)
    // A dot at local 0 sits clear of the 8px trim handle.
    expect(envelope).toMatch(/const TRIM_INSET = 8/)
    expect(envelope).toMatch(/left: TRIM_INSET, right: TRIM_INSET/)
    // Trim handles are z-10; the dot layer is below them.
    expect(clipView).toMatch(/left-0 z-10 w-2/)
    expect(clipView).toMatch(/activeTool === 'slip' \? 'cursor-default' : 'cursor-ew-resize'/)
    expect(envelope).toMatch(/z-\[1\]/)
  })

  it('writes every edit through the existing volume keyframe command', () => {
    expect(envelope).toMatch(/type: 'setClipKeyframes'/)
    expect(envelope).toMatch(/property: 'volume'/)
    expect(envelope).toMatch(/beginTransient\(pointerId\)/)
    expect(envelope).toMatch(/currentTransientToken\(\) !== token/)
    expect(envelope).toMatch(/commitTransient\(\)/)
    expect(envelope).toMatch(/cancelTransient\(\)/)
    expect(envelope).toMatch(/DRAG_THRESHOLD_PX = 3/)
    expect(envelope).toMatch(/addVolumeKeyframe/)
    expect(envelope).toMatch(/removeVolumeKeyframe/)
    expect(envelope).toMatch(/moveVolumeKeyframe/)
  })

  it('never hides a curve on a muted clip', () => {
    expect(envelope).toMatch(/clip\.muted && 'opacity-50'/)
    expect(envelope).not.toMatch(/clip\.muted\s*\)\s*return null/)
  })
})

describe('shared dB graph', () => {
  const effectControls = read('src/components/editor/effect-controls/EffectControlsPanel.tsx')
  const inspector = read('src/components/editor/InspectorPanel.tsx')

  it('exports the graph from Effect Controls and imports it in the Clip tab', () => {
    expect(effectControls).toMatch(
      /export \{ KeyframeGraph, PropertyRow as EffectControlsPropertyRow \}/,
    )
    expect(inspector).toMatch(
      /import \{\s*EffectControlsPanel,\s*KeyframeGraph,\s*\} from '@\/components\/editor\/effect-controls\/EffectControlsPanel'/,
    )
    // No second graph implementation in the inspector.
    expect(inspector).not.toMatch(/function KeyframeGraph/)
    expect(inspector).not.toMatch(/data-testid=\{`kf-seg-/)
  })

  it('uses the db scale for volume and keeps linear the default', () => {
    expect(effectControls).toMatch(/scale=\{property === 'volume' \? 'db' : 'linear'\}/)
    expect(effectControls).toMatch(/scale = 'linear'/)
    expect(inspector).toMatch(/scale="db"/)
    // The axis labels are part of the shared graph, not a Clip-tab copy.
    expect(effectControls).toMatch(/data-testid=\{`kf-axis-\$\{property\}`\}/)
    expect(effectControls).toMatch(/ -6 dB/)
    expect(effectControls).toMatch(/ 0 dB/)
    expect(effectControls).toMatch(/>-inf</)
  })

  it('keeps the stored values linear and only rounds at display time', () => {
    const volume = read('src/lib/editor/volume-automation.ts')
    expect(volume).toMatch(/20 \* Math\.log10\(gain\)/)
    expect(volume).toMatch(/10 \*\* \(db \/ 20\)/)
    expect(volume).toMatch(/clampPropertyValue\('volume'/)
    // Writes convert back to linear gain; no dB value enters the doc.
    expect(volume).toMatch(/function unitToGain/)
    expect(volume).toMatch(/dbToGain\(unitToDb\(u\)\)/)
    expect(inspector).toMatch(/type: 'setClipGain'/)
    expect(inspector).toMatch(/gain: v \/ 100/)
    const types = read('src/lib/editor/types.ts')
    expect(types).toMatch(/Linear audio gain/)
    expect(types).not.toMatch(/gainDb/)
    expect(read('src/lib/editor/commands.ts')).not.toMatch(/dbToGain/)
  })

  it('lists the pure module in the coverage scope', () => {
    expect(read('vitest.config.ts')).toContain("'src/lib/editor/volume-automation.ts'")
  })
})

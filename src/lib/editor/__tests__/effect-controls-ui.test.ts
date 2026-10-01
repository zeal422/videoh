import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { EQ_DB_MAX, EQ_DB_MIN } from '../constants'

/**
 * Static wiring locks for the 0.5.0 UI (Effect Controls tab, keyframe editing,
 * audio shaping, speed/reverse, Alt-drag rate stretch). jsdom cannot run the
 * pointer-capture gesture or canvas drawing. As in compositing-ui.test.ts,
 * these locks cover the source wiring the browser E2E verifies.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('inspector tabs', () => {
  const inspector = read('src/components/editor/InspectorPanel.tsx')

  it('offers Clip / Effect Controls tabs when a clip is selected', () => {
    expect(inspector).toMatch(/aria-label="Inspector tabs"/)
    expect(inspector).toMatch(/data-testid=\{`inspector-tab-\$\{value\}`\}/)
    expect(inspector).toMatch(/'Effect Controls'/)
    expect(inspector).toMatch(/<EffectControlsPanel clip=\{clip\} trackKind=\{trackKind\} \/>/)
  })

  it('the project inspector still renders with nothing selected', () => {
    expect(inspector).toMatch(/<ProjectInspector \/>/)
  })
})

describe('effect controls surface', () => {
  const ec = read('src/components/editor/effect-controls/EffectControlsPanel.tsx')

  it('lists every animatable property group', () => {
    for (const prop of ['opacity', 'positionX', 'positionY', 'scale']) {
      expect(ec).toMatch(new RegExp(`key: '${prop}'`))
    }
    for (const prop of ['exposure', 'contrast', 'saturation', 'brightness', 'hue']) {
      expect(ec).toMatch(new RegExp(`key: '${prop}'`))
    }
    expect(ec).toMatch(/key: 'volume'/)
  })

  it('keyframe diamond adds/removes via setClipKeyframes at the playhead', () => {
    expect(ec).toMatch(/data-testid=\{`kf-toggle-\$\{property\}`\}/)
    expect(ec).toMatch(/type: 'setClipKeyframes', clipId: clip\.id, property, keyframes: next/)
    expect(ec).toMatch(/playheadLocal/)
  })

  it('animated property sliders write keyframes; statics use their commands', () => {
    expect(ec).toMatch(/animated \?/)
    expect(ec).toMatch(/type: 'setClipOpacity', clipId: clip\.id, opacity: v/)
    expect(ec).toMatch(/type: 'setClipGain', clipId: clip\.id, gain: v/)
    expect(ec).toMatch(/type: 'setClipAnimStatic', clipId: clip\.id, property, value: v/)
  })

  it('the light graph drags dots with the transient protocol (one undo step)', () => {
    expect(ec).toMatch(/data-testid=\{`kf-graph-\$\{property\}`\}/)
    expect(ec).toMatch(/data-testid=\{`kf-dot-\$\{property\}-\$\{i\}`\}/)
    expect(ec).toMatch(/applyTransient\(\{ type: 'setClipKeyframes'/)
    // One undo step: the dot snapshots the base on pointerdown and the release
    // commits, so the drag cannot leave a no-op history entry behind.
    expect(ec).toMatch(
      /onPointerDown=\{\(e\) => \{\s*e\.stopPropagation\(\)\s*tokenRef\.current = useEditorStore\.getState\(\)\.beginTransient\(e\.pointerId\)/,
    )
    // The drag keeps the token so a foreign commit mid-drag refuses frames.
    expect(ec).toMatch(/if \(currentTransientToken\(\) !== tokenRef\.current\) return/)
    expect(ec).toMatch(/commitTransient\(\)/)
  })

  it('the graph offers a per-keyframe easing picker and marks eased dots', () => {
    expect(ec).toMatch(/KEYFRAME_INTERPOLATIONS\.map/)
    expect(ec).toMatch(/data-testid=\{`kf-ease-\$\{property\}-\$\{value\}`\}/)
    // The picker stamps the preset's exact bezier data alongside the name, so
    // a later split/trim subdivision starts from the real shape.
    expect(ec).toMatch(/presetControls\(interpolation\)/)
    expect(ec).toMatch(/next\.easeOut = \[\.\.\.controls\]/)
    expect(ec).toMatch(/data-interpolation=\{k\.interpolation \?\? 'linear'\}/)
    // Eased segments get a distinct dot state (dashed border).
    expect(ec).toMatch(/eased \? 'border-dashed border-amber-700' : 'border-amber-600'/)
    // The picker needs the playhead to know which keyframe it edits, and the
    // graph needs the mirrored-axis flag so a reversed timeScale row lines up.
    expect(ec).toMatch(
      /<KeyframeGraph\s+clip=\{clip\}\s+property=\{property\}\s+playheadLocal=\{playheadLocal\}/,
    )
    expect(ec).toMatch(/mirrored=\{mirrored\}/)
  })

  it('audio shaping: pan, EQ bands, compressor, noise reduction, auto-duck', () => {
    expect(ec).toMatch(/aria-label="Clip pan"/)
    expect(ec).toMatch(/type: 'setClipPan'/)
    expect(ec).toMatch(/aria-label="Toggle EQ"/)
    expect(ec).toMatch(/type: 'setClipEq'/)
    expect(ec).toMatch(/aria-label="Clip compressor"/)
    expect(ec).toMatch(/type: 'setClipCompressor'/)
    expect(ec).toMatch(/aria-label="Reduce noise"/)
    expect(ec).toMatch(/type: 'setClipDenoise'/)
    expect(ec).toMatch(/aria-label="Apply auto-duck"/)
    expect(ec).toMatch(/computeDuckingKeyframes\(doc, clip, dialogue/)
    expect(ec).toMatch(/type: 'setClipKeyframes', clipId: clip\.id, property: 'volume'/)
  })

  it('speed slider + reverse switch dispatch their commands', () => {
    expect(ec).toMatch(/aria-label="Clip speed"/)
    expect(ec).toMatch(/type: 'setClipSpeed'/)
    expect(ec).toMatch(/aria-label="Reverse clip"/)
    expect(ec).toMatch(/type: 'setClipReverse'/)
  })

  it('exposes the time-remap row: a timeScale curve plus the speed fallback', () => {
    expect(ec).toMatch(/key: 'timeScale', label: 'Time remapping'/)
    // The static (unanimated) control writes the clip's speed field, which
    // staticPropertyValue reads for timeScale; the curve rides setClipKeyframes
    // like every other property row. Anchor the dispatch to the timeScale
    // BRANCH: the same one-line dispatch also lives in the Speed section, so a
    // bare `type: 'setClipSpeed'` match would pass with the branch deleted.
    expect(ec).toMatch(
      /if \(property === 'timeScale'\) \{\s*if \(commit\) apply\(\{ type: 'setClipSpeed', clipId: clip\.id, speed: v \}\)/,
    )
    expect(ec).toMatch(/case 'timeScale':/)
  })
})

describe('rate stretch (Alt-drag)', () => {
  const clipView = read('src/components/editor/timeline/ClipView.tsx')
  const gesture = read('src/lib/editor/clip-gesture.ts')

  it('captures altKey onto the gesture and applies the speed/trim pair atomically', () => {
    expect(clipView).toMatch(/rateStretch: e\.altKey && mode !== 'move'/)
    expect(clipView).toMatch(/decideRateStretch\(/)
    expect(clipView).toMatch(/type: 'setClipSpeed', clipId: clip\.id, speed: s\.speed/)
    expect(clipView).toMatch(/type: 'trimClip'/)
    // `applyTransient` swallows command errors, so the pair is validated with
    // applyCommands BEFORE either half applies (and the toast fires only from
    // that prevalidation): otherwise a rejected trim would leave the speed
    // applied and the catch would be unreachable dead code.
    expect(clipView).toMatch(
      /applyCommands\(useEditorStore\.getState\(\)\.doc, \[speedCommand, trimCommand\]\)/,
    )
    expect(clipView).toMatch(
      /store\.applyTransient\(speedCommand\)\s*store\.applyTransient\(trimCommand\)/,
    )
  })

  it('the pure decision keeps the source span fixed and clamps speed', () => {
    expect(gesture).toMatch(/export function decideRateStretch/)
    expect(gesture).toMatch(/origDuration \* origSpeed/)
    expect(gesture).toMatch(/clampSpeed/)
    expect(gesture).toMatch(/SPEED_MAX/)
    expect(gesture).toMatch(/SPEED_MIN/)
  })

  it('clips advertise speed and reverse with badges', () => {
    expect(clipView).toMatch(/data-testid="clip-speed-badge"/)
    expect(clipView).toMatch(/data-testid="clip-reverse-badge"/)
  })

  it('keeps the static speed controls off a ramped clip', () => {
    const ec = read('src/components/editor/effect-controls/EffectControlsPanel.tsx')
    // A `timeScale` curve (of any shape) owns the rate, so Alt-drag has no
    // rate to re-time and the slider/badge would advertise a field the engines
    // never read.
    expect(clipView).toMatch(/g\.rateStretch && isMedia && !hasTimeScaleCurve\(clip\)/)
    expect(clipView).toMatch(/\(clip\.speed \?\? 1\) !== 1 && !hasTimeScaleCurve\(clip\)/)
    expect(ec).toMatch(/const ramped = hasTimeScaleCurve\(clip\)/)
    expect(ec).toMatch(/disabled=\{ramped\}/)
  })
})

describe('export dialog (MP4 pipeline)', () => {
  const dialog = read('src/components/editor/ExportDialog.tsx')
  const mp4 = read('src/lib/editor/export/mp4.ts')

  it('uses the WebCodecs exporter and reports MP4', () => {
    expect(dialog).toMatch(/from '@\/lib\/editor\/export\/mp4'/)
    expect(dialog).toMatch(/\.mp4/)
    expect(dialog).toMatch(/data-testid="export-unsupported"/)
    expect(dialog).not.toMatch(/WebM/)
  })

  it('gates the start button on offline assets before producing a black file (static lock)', () => {
    // The preview warns via offlineMediaAt; the export must refuse the same
    // condition up front instead of rendering an all-black MP4 with a success
    // toast (every restored asset is url-less until relinked).
    expect(dialog).toMatch(/from '@\/lib\/editor\/offline'/)
    expect(dialog).toMatch(/hasOfflineMedia/)
    expect(dialog).toMatch(/data-testid="export-offline-warning"/)
    expect(dialog).toMatch(/disabled=\{[^}]*hasOfflineMedia/)
  })

  it('the pipeline composites via the offline plan and encodes avc + the adaptive audio codec', () => {
    expect(mp4).toMatch(/new Mp4OutputFormat/)
    expect(mp4).toMatch(/codec: 'avc'/)
    expect(mp4).toMatch(/pickAudioCodec\(\(\) => canEncodeAudio\('aac'\)\)/)
    expect(mp4).toMatch(/planVideoFrame\(doc, t\)/)
    expect(mp4).toMatch(/new OfflineAudioContext/)
    expect(mp4).toMatch(/VideoSampleSink/)
    expect(mp4).toMatch(/getSample\(/)
  })

  it('every track is opened before the output starts (Mediabunny rejects later adds)', () => {
    const addVideo = mp4.indexOf('addVideoTrack')
    const addAudio = mp4.indexOf('addAudioTrack')
    const start = mp4.indexOf('await output.start()')
    expect(addVideo).toBeGreaterThan(-1)
    expect(addAudio).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(addVideo)
    expect(start).toBeGreaterThan(addAudio)
  })

  it('the MediaRecorder exporter is gone', () => {
    expect(() => read('src/lib/editor/export/exporter.ts')).toThrow()
  })

  it('clamps EQ band gains to the shared limits in BOTH render paths', () => {
    // A malformed (hand-edited) doc can carry out-of-range bands; the preview
    // clamped them while the export assigned them raw, so one timeline could
    // render two different mixes. Both paths now read one named bound.
    expect([EQ_DB_MIN, EQ_DB_MAX]).toEqual([-24, 24])
    const core = read('src/lib/editor/playback/core.ts')
    for (const band of ['low', 'mid', 'high']) {
      const clamped = new RegExp(`clamp\\(clip\\.eq\\.${band}, EQ_DB_MIN, EQ_DB_MAX\\)`)
      expect(core).toMatch(clamped)
      expect(mp4).toMatch(clamped)
    }
    // The preview no longer carries its own copy of the bound.
    expect(core).not.toMatch(/clamp\(clip\.eq\.\w+, -24, 24\)/)
  })
})

describe('slider naming', () => {
  it('keeps the generated Slider stock and forwards the label in NamedSlider', () => {
    // The label has to land on the thumb (the element with role="slider"),
    // which the stock shadcn Slider cannot do: it spreads root props onto the
    // root only, and Radix names a thumb from the thumb's own props. The
    // forwarding lives in the editor-owned wrapper so src/components/ui/ stays
    // exactly as generated (a hand edit there was a review finding).
    expect(read('src/components/ui/slider.tsx')).not.toMatch(/aria-label/)
    const named = read('src/components/editor/NamedSlider.tsx')
    expect(named).toMatch(/aria-label=\{thumbLabel\}/)
    expect(named).toMatch(/thumbLabel = _values\.length === 1 \? ariaLabel : undefined/)
  })
})

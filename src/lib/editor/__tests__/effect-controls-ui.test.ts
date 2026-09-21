import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
      /onPointerDown=\{\(e\) => \{\s*e\.stopPropagation\(\)\s*useEditorStore\.getState\(\)\.beginTransient\(\)/,
    )
    expect(ec).toMatch(/commitTransient\(\)/)
  })

  it('audio shaping: pan, EQ bands, compressor, auto-duck', () => {
    expect(ec).toMatch(/aria-label="Clip pan"/)
    expect(ec).toMatch(/type: 'setClipPan'/)
    expect(ec).toMatch(/aria-label="Toggle EQ"/)
    expect(ec).toMatch(/type: 'setClipEq'/)
    expect(ec).toMatch(/aria-label="Clip compressor"/)
    expect(ec).toMatch(/type: 'setClipCompressor'/)
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
})

describe('rate stretch (Alt-drag)', () => {
  const clipView = read('src/components/editor/timeline/ClipView.tsx')
  const gesture = read('src/lib/editor/clip-gesture.ts')

  it('captures altKey onto the gesture and dispatches speed-then-trim', () => {
    expect(clipView).toMatch(/rateStretch: e\.altKey && mode !== 'move'/)
    expect(clipView).toMatch(/decideRateStretch\(/)
    expect(clipView).toMatch(/type: 'setClipSpeed', clipId: clip\.id, speed: s\.speed/)
    expect(clipView).toMatch(/applyTransient\(\{\s*type: 'trimClip'/)
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
})

import { beforeEach, describe, expect, it } from 'vitest'

import {
  applyCommand,
  applyCommands,
  EditorCommand,
  EditorCommandError,
  TrackLockedError,
} from '../commands'
import { copyClips } from '../clipboard'
import { createClip, createDoc, createMediaAsset, createTextClip, createTrack } from '../factories'
import { isTransientActive, useEditorStore } from '../store'
import { anySoloFor, audibleTrackIds, clipGroupTracks } from '../tracks'
import type { Clip, Doc, MediaAsset, Sequence, Track } from '../types'

/**
 * Track solo and lock (0.14.0).
 *
 * The point of this suite is that both are REAL state: solo is one shared
 * audibility rule used by every audio path, and lock is enforced by the
 * command layer (with a typed inventory that the compiler keeps complete),
 * not by disabled UI. The doc must never change on a refused edit.
 */

const VIDEO: MediaAsset = createMediaAsset({
  id: 'mv',
  kind: 'video',
  name: 'v.mp4',
  duration: 30,
  width: 640,
  height: 360,
  url: 'blob:v',
  hasAudio: true,
})
const AUDIO: MediaAsset = createMediaAsset({
  id: 'ma',
  kind: 'audio',
  name: 'a.mp3',
  duration: 30,
  url: 'blob:a',
})

function clip(id: string, mediaId: string, over: Partial<Clip> = {}): Clip {
  return createClip({ id, mediaId, start: 0, duration: 2, inPoint: 0, ...over })
}

function project(tracks: Track[], sequences?: Sequence[]): Doc {
  return {
    project: {
      id: 'p_lock',
      name: 'lock',
      width: 1920,
      height: 1080,
      fps: 30,
      tracks,
      ...(sequences ? { sequences } : {}),
    },
    media: [VIDEO, AUDIO],
  }
}

/**
 * V1 open, V2 locked, A1 locked, A2 open, A3 open holding the unlocked audio
 * half of a pair whose video half sits on locked V2. T1 is a locked text lane.
 */
function lockDoc(): Doc {
  const v1 = createTrack('video', 1, { id: 'v1', clips: [clip('cv1', 'mv')] })
  const v2 = createTrack('video', 2, { id: 'v2', locked: true })
  v2.clips = [clip('cv2', 'mv'), clip('lv', 'mv', { linkId: 'pair' })]
  const a1 = createTrack('audio', 1, { id: 'a1', locked: true, clips: [clip('ca1', 'ma')] })
  const a2 = createTrack('audio', 2, { id: 'a2' })
  const a3 = createTrack('audio', 3, { id: 'a3', clips: [clip('la', 'ma', { linkId: 'pair' })] })
  const t1 = createTrack('text', 1, { id: 't1', locked: true })
  t1.clips = [createTextClip({ id: 'ct1', start: 0, duration: 2, text: 'hi' })]
  return project([t1, v1, v2, a1, a2, a3])
}

function lockedName(fn: () => void): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof TrackLockedError) return error.message
    throw error
  }
  throw new Error('command was not refused')
}

beforeEach(() => {
  useEditorStore.setState(useEditorStore.getInitialState())
})

describe('track flags data model', () => {
  it('factories preserve solo and locked through a partial', () => {
    const track = createTrack('audio', 1, { id: 'a9', solo: true, locked: true })
    expect(track.solo).toBe(true)
    expect(track.locked).toBe(true)
  })

  it('setTrackSolo and setTrackLocked write the flags', () => {
    const doc = lockDoc()
    const soloed = applyCommand(doc, { type: 'setTrackSolo', trackId: 'a2', solo: true })
    expect(soloed.project.tracks.find((t) => t.id === 'a2')?.solo).toBe(true)
    const unlocked = applyCommand(doc, { type: 'setTrackLocked', trackId: 'v2', locked: false })
    expect(unlocked.project.tracks.find((t) => t.id === 'v2')?.locked).toBe(false)
  })

  it('refuses solo on video and text tracks, and non-boolean values', () => {
    const doc = lockDoc()
    expect(() => applyCommand(doc, { type: 'setTrackSolo', trackId: 'v1', solo: true })).toThrow(
      EditorCommandError,
    )
    expect(() => applyCommand(doc, { type: 'setTrackSolo', trackId: 't1', solo: true })).toThrow(
      'Solo is only available on audio tracks',
    )
    expect(() =>
      applyCommand(doc, { type: 'setTrackSolo', trackId: 'a2', solo: 'yes' as never }),
    ).toThrow('Track solo must be a boolean')
    expect(() =>
      applyCommand(doc, { type: 'setTrackLocked', trackId: 'v1', locked: 1 as never }),
    ).toThrow('Track lock must be a boolean')
  })

  it('refuses an unknown track id', () => {
    const doc = lockDoc()
    expect(() => applyCommand(doc, { type: 'setTrackSolo', trackId: 'nope', solo: true })).toThrow(
      'Unknown track',
    )
    expect(() =>
      applyCommand(doc, { type: 'setTrackLocked', trackId: 'nope', locked: true }),
    ).toThrow('Unknown track')
  })

  it('removeTrack deletes the flags with the lane, and undo restores them', () => {
    const doc = lockDoc()
    const store = useEditorStore.getState()
    useEditorStore.setState({ doc, past: [], future: [] })
    expect(store.apply({ type: 'removeTrack', trackId: 'a2' })).toBe(true)
    expect(useEditorStore.getState().doc.project.tracks.some((t) => t.id === 'a2')).toBe(false)
    useEditorStore.getState().undo()
    const restored = useEditorStore.getState().doc.project.tracks.find((t) => t.id === 'a2')
    expect(restored).toBeDefined()
    expect(restored?.locked).toBeUndefined()
    expect(restored?.solo).toBeUndefined()

    // A locked lane's own flags survive a remove when it is the LAST lane? No:
    // locked lanes cannot be removed. Prove an unlocked lane carrying a flag
    // (solo) round-trips through removal and undo.
    const soloDoc = applyCommand(doc, { type: 'setTrackSolo', trackId: 'a2', solo: true })
    useEditorStore.setState({ doc: soloDoc, past: [], future: [] })
    expect(store.apply({ type: 'removeTrack', trackId: 'a2' })).toBe(true)
    useEditorStore.getState().undo()
    expect(useEditorStore.getState().doc.project.tracks.find((t) => t.id === 'a2')?.solo).toBe(true)
  })
})

describe('audibility helper', () => {
  const a = (id: string, over: Partial<Track> = {}) =>
    createTrack('audio', 1, { id, clips: [clip(`c_${id}`, 'ma')], ...over })
  const v = (id: string, over: Partial<Track> = {}) =>
    createTrack('video', 1, { id, clips: [clip(`c_${id}`, 'mv')], ...over })

  it('no solo keeps the pre-0.14 rule: every non-muted track', () => {
    const tracks = [v('v1'), v('v2', { muted: true }), a('a1'), a('a2', { muted: true })]
    expect(anySoloFor(tracks)).toBe(false)
    expect([...audibleTrackIds(tracks)]).toEqual(['v1', 'a1'])
  })

  it('one solo leaves only that audio track', () => {
    const tracks = [v('v1'), a('a1', { solo: true }), a('a2')]
    expect(anySoloFor(tracks)).toBe(true)
    expect([...audibleTrackIds(tracks)]).toEqual(['a1'])
  })

  it('multiple solos are all audible', () => {
    const tracks = [a('a1', { solo: true }), a('a2', { solo: true }), a('a3')]
    expect([...audibleTrackIds(tracks)]).toEqual(['a1', 'a2'])
  })

  it('a soloed track that is muted stays silent', () => {
    const tracks = [a('a1', { solo: true, muted: true }), a('a2')]
    expect([...audibleTrackIds(tracks)]).toEqual([])
  })

  it('a mute on another track does not silence the soloed one', () => {
    const tracks = [a('a1', { solo: true }), a('a2', { muted: true })]
    expect([...audibleTrackIds(tracks)]).toEqual(['a1'])
  })

  it('a video lane is excluded while any audio track is soloed', () => {
    const tracks = [v('v1'), a('a1', { solo: true })]
    expect(audibleTrackIds(tracks).has('v1')).toBe(false)
  })

  it('ignores a hostile solo flag on a video or text lane', () => {
    const tracks = [
      v('v1', { solo: true }),
      createTrack('text', 1, { id: 't1', solo: true }),
      a('a1'),
    ]
    expect(anySoloFor(tracks)).toBe(false)
    expect([...audibleTrackIds(tracks)]).toEqual(['v1', 't1', 'a1'])
  })
})

describe('lock command inventory', () => {
  it('refuses every clip-editing command on a locked lane, naming the track', () => {
    const doc = lockDoc()
    const blocked: EditorCommand[] = [
      { type: 'moveClip', clipId: 'cv2', trackId: 'v2', start: 1 },
      { type: 'trimClip', clipId: 'cv2', start: 0, inPoint: 0, duration: 1, edge: 'tail' },
      { type: 'splitClip', clipId: 'cv2', atTime: 1 },
      { type: 'deleteClip', clipId: 'cv2' },
      { type: 'setClipGain', clipId: 'cv2', gain: 0.5 },
      { type: 'setClipMuted', clipId: 'cv2', muted: true },
      { type: 'setClipOpacity', clipId: 'cv2', opacity: 0.5 },
      { type: 'setClipSpeed', clipId: 'cv2', speed: 2 },
      { type: 'setClipReverse', clipId: 'cv2', reverse: true },
      { type: 'setClipPan', clipId: 'cv2', pan: 0.5 },
      { type: 'setClipEq', clipId: 'cv2', eq: { low: 1, mid: 0, high: 0 } },
      { type: 'setClipCompressor', clipId: 'cv2', enabled: true },
      { type: 'setClipDenoise', clipId: 'cv2', enabled: true },
      { type: 'setClipColorParams', clipId: 'cv2', temperature: 10, tint: 0 },
      { type: 'setClipAnimStatic', clipId: 'cv2', property: 'scale', value: 2 },
      { type: 'setClipKeyframes', clipId: 'cv2', property: 'volume', keyframes: [] },
      { type: 'setClipBlendMode', clipId: 'cv2', blendMode: 'multiply' },
      { type: 'setClipLut', clipId: 'cv2', lutId: null },
      { type: 'addTransition', clipId: 'cv2', duration: 0.5 },
      { type: 'removeTransition', clipId: 'cv2' },
      { type: 'addEffect', clipId: 'cv2', effectType: 'crop' },
      { type: 'removeEffect', clipId: 'cv2', effectId: 'fx' },
      { type: 'setEffectEnabled', clipId: 'cv2', effectId: 'fx', enabled: false },
      { type: 'resetEffect', clipId: 'cv2', effectId: 'fx' },
      { type: 'setEffectParams', clipId: 'cv2', effectId: 'fx', params: {} },
      {
        type: 'setEffectKeyframes',
        clipId: 'cv2',
        effectId: 'fx',
        property: 'left',
        keyframes: [],
      },
      { type: 'addClipMarker', clipId: 'cv2', marker: { id: 'm1', time: 0 } },
      { type: 'moveClipMarker', clipId: 'cv2', markerId: 'm1', time: 1 },
      { type: 'updateClipMarker', clipId: 'cv2', markerId: 'm1', patch: { name: 'x' } },
      { type: 'deleteClipMarker', clipId: 'cv2', markerId: 'm1' },
      { type: 'setTextContent', clipId: 'ct1', text: 'nope' },
      { type: 'setTextStyle', clipId: 'ct1', style: { bold: true } },
      { type: 'addCaptionCue', trackId: 't1', start: 3 },
      { type: 'addClip', clip: clip('new', 'ma', { audioOnly: true }), trackId: 'a1' },
    ]
    for (const command of blocked) {
      expect(() => applyCommand(doc, command), command.type).toThrow(TrackLockedError)
    }
    expect(lockedName(() => applyCommand(doc, blocked[0]))).toBe(
      'Track V2 is locked. Unlock it to edit its clips.',
    )
  })

  it('refuses a linked group move, split or delete when ANY member is locked', () => {
    const doc = lockDoc()
    // The audio half is on open A3; its video partner sits on locked V2.
    expect(() =>
      applyCommand(doc, { type: 'moveClip', clipId: 'la', trackId: 'a3', start: 1 }),
    ).toThrow(TrackLockedError)
    expect(() => applyCommand(doc, { type: 'splitClip', clipId: 'la', atTime: 1 })).toThrow(
      TrackLockedError,
    )
    expect(() => applyCommand(doc, { type: 'deleteClip', clipId: 'la' })).toThrow(TrackLockedError)
    expect(() => applyCommand(doc, { type: 'unlinkClip', clipId: 'la' })).toThrow(TrackLockedError)
    expect(() => applyCommand(doc, { type: 'linkClips', clipIds: ['cv1', 'cv2'] })).toThrow(
      TrackLockedError,
    )
    // Trim edits only the named clip, so an open lane's clip can still be
    // trimmed while its partner's lane is locked.
    expect(() =>
      applyCommand(doc, {
        type: 'trimClip',
        clipId: 'la',
        start: 0,
        inPoint: 0,
        duration: 1,
        edge: 'tail',
      }),
    ).not.toThrow()
  })

  it('refuses a compound whose source or destination lane is locked', () => {
    const doc = lockDoc()
    expect(() =>
      applyCommand(doc, { type: 'createCompoundClip', clipIds: ['cv1', 'cv2'], trackId: 'v1' }),
    ).toThrow(TrackLockedError)
    expect(() =>
      applyCommand(doc, { type: 'createCompoundClip', clipIds: ['cv1'], trackId: 'v2' }),
    ).toThrow(TrackLockedError)
    const ok = applyCommand(doc, {
      type: 'createCompoundClip',
      clipIds: ['cv1'],
      trackId: 'v1',
    })
    expect(ok.project.sequences).toHaveLength(1)
  })

  it('refuses media removal and relink when a locked clip uses the asset', () => {
    const doc = lockDoc()
    expect(() => applyCommand(doc, { type: 'removeMediaAsset', mediaId: 'mv' })).toThrow(
      TrackLockedError,
    )
    expect(() =>
      applyCommand(doc, { type: 'relinkMedia', mediaId: 'mv', patch: { name: 'new.mp4' } }),
    ).toThrow(TrackLockedError)

    // A media asset no locked clip uses can go.
    const unused: MediaAsset = createMediaAsset({ id: 'mz', kind: 'audio', name: 'z.mp3' })
    const withUnused: Doc = { ...doc, media: [...doc.media, unused] }
    expect(
      applyCommand(withUnused, { type: 'removeMediaAsset', mediaId: 'mz' }).media,
    ).toHaveLength(2)
  })

  it('refuses removing a locked track or an open lane that holds a locked clip partner', () => {
    const doc = lockDoc()
    expect(() => applyCommand(doc, { type: 'removeTrack', trackId: 'v2' })).toThrow(
      TrackLockedError,
    )
    expect(() => applyCommand(doc, { type: 'removeTrack', trackId: 'a1' })).toThrow(
      TrackLockedError,
    )
    // A3 itself is open, but it holds the audio half of a pair whose video half
    // is on locked V2: removing it would split the group.
    expect(() => applyCommand(doc, { type: 'removeTrack', trackId: 'a3' })).toThrow(
      TrackLockedError,
    )
    // A genuinely free lane can still be removed.
    expect(
      applyCommand(doc, { type: 'removeTrack', trackId: 'a2' }).project.tracks.some(
        (t) => t.id === 'a2',
      ),
    ).toBe(false)
  })

  it('allows every exempt command even when every lane is locked', () => {
    const doc = lockDoc()
    for (const track of doc.project.tracks) track.locked = true
    doc.project.markers = [{ id: 'sm', time: 4 }]
    const style = {
      fontSize: 64,
      color: '#ffffff',
      fontFamily: 'Inter',
      bold: false,
      italic: false,
      align: 'center' as const,
      x: 0.5,
      y: 0.5,
      shadow: false,
    }
    doc.project.textPresets = [{ id: 'p1', name: 'Preset', style }]
    const allowed: EditorCommand[] = [
      {
        type: 'addMediaAsset',
        asset: createMediaAsset({ id: 'mnew', kind: 'audio', name: 'new.mp3' }),
      },
      {
        type: 'addSequence',
        sequence: { id: 'sq_new', name: 'New', tracks: [createTrack('video', 1)] },
      },
      { type: 'addTrack', kind: 'audio' },
      { type: 'renameTrack', trackId: 'v2', name: 'Locked V' },
      { type: 'toggleTrackMute', trackId: 'v2' },
      { type: 'setTrackSolo', trackId: 'a1', solo: true },
      { type: 'setTrackLocked', trackId: 'v2', locked: false },
      { type: 'setTrackVisible', trackId: 'v2', visible: false },
      { type: 'setKeyframeDefault', property: 'opacity', interpolation: 'easeIn' },
      {
        type: 'importProjectLut',
        lut: { id: 'lut_new', name: 'L', kind: '1d', size: 2, data: 'AAAA' },
      },
      { type: 'saveTextPreset', preset: { id: 'p2', name: 'Second', style } },
      { type: 'renameTextPreset', presetId: 'p1', name: 'Renamed' },
      { type: 'deleteTextPreset', presetId: 'p1' },
      {
        type: 'importCaptions',
        cues: [{ start: 0, duration: 1, text: 'new lane' }],
      },
      { type: 'addSequenceMarker', marker: { id: 'sm2', time: 3 } },
      { type: 'moveSequenceMarker', markerId: 'sm', time: 5 },
      { type: 'updateSequenceMarker', markerId: 'sm', patch: { name: 'cue' } },
      { type: 'deleteSequenceMarker', markerId: 'sm' },
      { type: 'setProjectSettings', patch: { name: 'Renamed' } },
    ]
    for (const command of allowed) {
      expect(() => applyCommand(doc, command), command.type).not.toThrow()
    }
    // importCaptions creates its own new text lane, so even a locked text lane
    // does not stand in its way.
    const captioned = applyCommand(doc, {
      type: 'importCaptions',
      cues: [{ start: 0, duration: 1, text: 'new lane' }],
    })
    expect(captioned.project.tracks.filter((t) => t.kind === 'text')).toHaveLength(2)
  })

  it('refuses the whole batch and writes nothing when one member is locked', () => {
    const doc = lockDoc()
    const before = structuredClone(doc)
    expect(() =>
      applyCommands(doc, [
        { type: 'moveClip', clipId: 'cv1', trackId: 'v1', start: 9 },
        { type: 'deleteClip', clipId: 'cv2' },
      ]),
    ).toThrow(TrackLockedError)
    expect(doc).toEqual(before)
  })

  it('refuses a batch that locks an open lane and then edits it', () => {
    // V1 starts open. The batch locks it, then adds a clip to it. Validating
    // against the pre-batch doc would let both commands through and leave the
    // clip on a lane that is locked in the final document.
    const doc = lockDoc()
    const before = structuredClone(doc)
    expect(() =>
      applyCommands(doc, [
        { type: 'setTrackLocked', trackId: 'v1', locked: true },
        {
          type: 'addClip',
          clip: createClip({ id: 'late', mediaId: 'mv', start: 10, duration: 2 }),
          trackId: 'v1',
        },
      ]),
    ).toThrow(TrackLockedError)
    expect(doc).toEqual(before)
  })

  it('refuses removing a matte source lane when a locked clip references it', () => {
    // removeTrack strips trackMatte entries pointing at the removed lane from
    // every remaining clip in the sequence. That is an edit of those clips, so
    // a locked referencing lane must refuse the removal even though the removed
    // lane itself is open.
    const source = createTrack('video', 1, { id: 'matte_src' })
    const lockedTarget = createTrack('video', 2, { id: 'matte_dst', locked: true })
    lockedTarget.clips = [
      createClip({
        id: 'matte_clip',
        mediaId: 'mv',
        start: 0,
        duration: 2,
        effects: [{ id: 'fx_matte', type: 'trackMatte', trackId: 'matte_src' }],
      }),
    ]
    const doc = project([source, lockedTarget])
    expect(() => applyCommand(doc, { type: 'removeTrack', trackId: 'matte_src' })).toThrow(
      TrackLockedError,
    )
  })

  it('removes an open matte source lane and strips the effect with it', () => {
    const source = createTrack('video', 1, { id: 'matte_src' })
    const target = createTrack('video', 2, { id: 'matte_dst' })
    target.clips = [
      createClip({
        id: 'matte_clip',
        mediaId: 'mv',
        start: 0,
        duration: 2,
        effects: [{ id: 'fx_matte', type: 'trackMatte', trackId: 'matte_src' }],
      }),
    ]
    const doc = project([source, target])
    const next = applyCommand(doc, { type: 'removeTrack', trackId: 'matte_src' })
    const remaining = next.project.tracks.find((t) => t.id === 'matte_dst')
    expect(remaining?.clips[0].effects).toBeUndefined()
  })

  it('nested lock applies to its own sequence, and the container lane is independent', () => {
    const nestedOpen = createTrack('video', 1, { id: 'n_open' })
    nestedOpen.clips = [clip('n_clip', 'mv')]
    const nestedLocked = createTrack('audio', 1, { id: 'n_locked', locked: true })
    nestedLocked.clips = [clip('n_audio', 'ma', { audioOnly: true })]
    const container = createTrack('video', 1, { id: 'root_c' })
    container.clips = [createClip({ id: 'comp', sequenceId: 'seqx', start: 0, duration: 2 })]
    const doc = project(
      [container],
      [{ id: 'seqx', name: 'X', tracks: [nestedOpen, nestedLocked] }],
    )
    // The nested open track edits; the nested locked lane refuses.
    expect(() =>
      applyCommand(doc, { type: 'moveClip', clipId: 'n_clip', trackId: 'n_open', start: 1 }),
    ).not.toThrow()
    expect(() => applyCommand(doc, { type: 'deleteClip', clipId: 'n_audio' })).toThrow(
      'Track A1 is locked',
    )
    // The container itself is on an open lane and can be moved.
    expect(() =>
      applyCommand(doc, { type: 'moveClip', clipId: 'comp', trackId: 'root_c', start: 2 }),
    ).not.toThrow()
  })

  it('reports the clip group tracks a command would touch', () => {
    const doc = lockDoc()
    expect(clipGroupTracks(doc, ['la']).map((t) => t.id)).toEqual(['a3', 'v2'])
    expect(clipGroupTracks(doc, ['cv1']).map((t) => t.id)).toEqual(['v1'])
  })
})

describe('store lock behavior', () => {
  function storeWithDoc(doc: Doc) {
    useEditorStore.setState({ ...useEditorStore.getInitialState(), doc })
    return useEditorStore.getState()
  }

  it('a refused apply leaves the doc and history byte-identical and records one notice', () => {
    const doc = lockDoc()
    const store = storeWithDoc(doc)
    const before = structuredClone(useEditorStore.getState().doc)
    expect(store.apply({ type: 'deleteClip', clipId: 'cv2' })).toBe(false)
    expect(useEditorStore.getState().doc).toEqual(before)
    expect(useEditorStore.getState().past).toHaveLength(0)
    expect(useEditorStore.getState().lockNotice?.message).toBe(
      'Track V2 is locked. Unlock it to edit its clips.',
    )
    expect(useEditorStore.getState().lockNotice?.trackId).toBe('v2')
  })

  it('a refused batch writes nothing and adds no history entry', () => {
    const doc = lockDoc()
    const store = storeWithDoc(doc)
    const before = structuredClone(useEditorStore.getState().doc)
    expect(
      store.apply([
        { type: 'moveClip', clipId: 'cv1', trackId: 'v1', start: 9 },
        { type: 'deleteClip', clipId: 'cv2' },
      ]),
    ).toBe(false)
    expect(useEditorStore.getState().doc).toEqual(before)
    expect(useEditorStore.getState().past).toHaveLength(0)
  })

  it('a batch that locks an open lane and then edits it writes nothing', () => {
    const doc = lockDoc()
    const store = storeWithDoc(doc)
    const before = structuredClone(useEditorStore.getState().doc)
    expect(
      store.apply([
        { type: 'setTrackLocked', trackId: 'v1', locked: true },
        {
          type: 'addClip',
          clip: createClip({ id: 'late', mediaId: 'mv', start: 10, duration: 2 }),
          trackId: 'v1',
        },
      ]),
    ).toBe(false)
    expect(useEditorStore.getState().doc).toEqual(before)
    expect(useEditorStore.getState().past).toHaveLength(0)
    expect(useEditorStore.getState().lockNotice?.trackId).toBe('v1')
  })

  it('a locked track refuses transient frames and commits no history', () => {
    const doc = lockDoc()
    storeWithDoc(doc)
    const store = useEditorStore.getState()
    const before = structuredClone(store.doc)
    store.beginTransient(7)
    expect(isTransientActive()).toBe(true)
    store.applyTransient({ type: 'moveClip', clipId: 'cv2', trackId: 'v2', start: 1 })
    expect(useEditorStore.getState().doc).toEqual(before)
    store.commitTransient()
    expect(useEditorStore.getState().past).toHaveLength(0)
    expect(useEditorStore.getState().doc).toEqual(before)
  })

  it('Plan 04 envelope frames (move, add, remove) are refused as transients', () => {
    const doc = lockDoc()
    // Give the locked audio clip a curve so a "remove" has something to remove.
    doc.project.tracks.find((t) => t.id === 'a1')!.clips[0].keyframes = {
      volume: [
        { time: 0, value: 1 },
        { time: 1, value: 0.5 },
      ],
    }
    storeWithDoc(doc)
    const before = structuredClone(useEditorStore.getState().doc)
    const store = useEditorStore.getState()
    const curve = [
      { time: 0, value: 1 },
      { time: 1, value: 0.5 },
    ]
    store.beginTransient(3)
    store.applyTransient({
      type: 'setClipKeyframes',
      clipId: 'ca1',
      property: 'volume',
      keyframes: [
        { time: 0, value: 1 },
        { time: 1, value: 0.1 },
      ],
    })
    store.applyTransient({
      type: 'setClipKeyframes',
      clipId: 'ca1',
      property: 'volume',
      keyframes: [...curve, { time: 1.5, value: 0.8 }],
    })
    store.applyTransient({
      type: 'setClipKeyframes',
      clipId: 'ca1',
      property: 'volume',
      keyframes: [{ time: 0, value: 1 }],
    })
    expect(useEditorStore.getState().doc).toEqual(before)
    store.commitTransient()
    expect(useEditorStore.getState().past).toHaveLength(0)
    expect(useEditorStore.getState().doc).toEqual(before)
  })

  it('undo still reverts a pre-lock edit after the lock lands', () => {
    const doc = lockDoc()
    const store = storeWithDoc(doc)
    expect(store.apply({ type: 'moveClip', clipId: 'cv1', trackId: 'v1', start: 6 })).toBe(true)
    expect(store.apply({ type: 'setTrackLocked', trackId: 'v1', locked: true })).toBe(true)
    const start = () =>
      useEditorStore.getState().doc.project.tracks.find((t) => t.id === 'v1')!.clips[0].start
    expect(start()).toBe(6)
    useEditorStore.getState().undo() // the lock
    useEditorStore.getState().undo() // the move
    expect(start()).toBe(0)
  })

  it('selection, copy, open compound and nested edits stay allowed', () => {
    const nested = createTrack('video', 1, { id: 'n_open' })
    nested.clips = [clip('n_clip', 'mv')]
    const container = createTrack('video', 1, { id: 'vroot' })
    container.clips = [createClip({ id: 'comp', sequenceId: 'seqx', start: 0, duration: 2 })]
    const doc = project(
      [container, createTrack('audio', 1)],
      [{ id: 'seqx', name: 'X', tracks: [nested] }],
    )
    storeWithDoc(doc)
    const store = useEditorStore.getState()
    store.select('comp')
    expect(useEditorStore.getState().selection).toBe('comp')
    expect(copyClips(useEditorStore.getState().doc, ['comp'])).toBe(1)
    store.openSequence('seqx')
    expect(useEditorStore.getState().activeSequencePath).toEqual(['seqx'])
    expect(store.apply({ type: 'moveClip', clipId: 'n_clip', trackId: 'n_open', start: 1 })).toBe(
      true,
    )
  })
})

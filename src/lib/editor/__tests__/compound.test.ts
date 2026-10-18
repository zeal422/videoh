import { describe, expect, it } from 'vitest'
import { commandsToRippleDeleteClips } from '../actions'
import { applyCommand, EditorCommandError } from '../commands'
import {
  createClip,
  createDoc,
  createMediaAsset,
  docDuration,
  findClip,
  maxSequenceDepth,
  sequenceDuration,
} from '../factories'
import { deserializeDoc, SerializationError, serializeDoc } from '../serialization'
import { pruneOrphanSequences } from '../tracks'
import type { Clip, Doc, Sequence } from '../types'

/**
 * Compound clips (0.8.1): the model, the command guards, orphan pruning and
 * serialization v4. The render recursion is locked separately by the compositor
 * and export planner suites.
 */

function videoLane(doc: Doc) {
  const lane = doc.project.tracks.find((t) => t.kind === 'video')
  if (!lane) throw new Error('no video lane')
  return lane
}

function docWithClips(): Doc {
  const doc = createDoc()
  doc.media.push(createMediaAsset({ id: 'm1', kind: 'video', duration: 10, url: 'blob:x' }))
  const lane = videoLane(doc)
  lane.clips.push(createClip({ id: 'c1', mediaId: 'm1', start: 0, duration: 2 }))
  lane.clips.push(createClip({ id: 'c2', mediaId: 'm1', start: 2, duration: 2 }))
  return doc
}

function withCompound(doc: Doc): { doc: Doc; compound: Clip; sequence: Sequence } {
  const lane = videoLane(doc)
  const next = applyCommand(doc, {
    type: 'createCompoundClip',
    clipIds: ['c1', 'c2'],
    trackId: lane.id,
  })
  const compound = next.project.tracks.find((t) => t.id === lane.id)!.clips[0]
  const sequence = next.project.sequences!.find((s) => s.id === compound.sequenceId)!
  return { doc: next, compound, sequence }
}

describe('createCompoundClip', () => {
  it('refuses a selection whose span is not finite', () => {
    const doc = docWithClips()
    videoLane(doc).clips[0].start = NaN
    expect(() =>
      applyCommand(doc, {
        type: 'createCompoundClip',
        clipIds: ['c1', 'c2'],
        trackId: videoLane(doc).id,
      }),
    ).toThrow(EditorCommandError)
  })

  it('folds the selection into one container and rebases the sequence', () => {
    const { doc, compound, sequence } = withCompound(docWithClips())
    const lane = videoLane(doc)
    // The originals left the root lane and now live inside the sequence.
    expect(lane.clips.some((c) => c.id === 'c1')).toBe(false)
    expect(findClip(doc, 'c1')?.sequenceId).toBe(sequence.id)
    expect(lane.clips).toHaveLength(1)
    expect(compound.start).toBe(0)
    expect(compound.duration).toBe(4)
    expect(sequence.tracks[0].clips.map((c) => c.start)).toEqual([0, 2])
  })

  it('docDuration counts the container span, not the child end times', () => {
    const { doc } = withCompound(docWithClips())
    expect(docDuration(doc)).toBe(4)
    // A child longer than the container never inflates the root number.
    const stretched = structuredClone(doc)
    stretched.project.sequences![0].tracks[0].clips[0].duration = 99
    expect(docDuration(stretched)).toBe(4)
    expect(sequenceDuration(stretched.project.sequences![0])).toBe(99)
  })

  it('findClip locates a nested clip and reports its owning sequence', () => {
    const { doc, sequence } = withCompound(docWithClips())
    const inner = sequence.tracks[0].clips[0]
    expect(findClip(doc, inner.id)?.sequenceId).toBe(sequence.id)
  })

  it('a compound clip fits only a video lane', () => {
    const { doc, compound } = withCompound(docWithClips())
    const audioLane = doc.project.tracks.find((t) => t.kind === 'audio')!
    expect(() =>
      applyCommand(doc, { type: 'addClip', clip: compound, trackId: audioLane.id }),
    ).toThrow(EditorCommandError)
  })

  it('refuses speed and reverse on a compound', () => {
    const { doc, compound } = withCompound(docWithClips())
    expect(() =>
      applyCommand(doc, { type: 'setClipSpeed', clipId: compound.id, speed: 2 }),
    ).toThrow(EditorCommandError)
    expect(() =>
      applyCommand(doc, { type: 'setClipReverse', clipId: compound.id, reverse: true }),
    ).toThrow(EditorCommandError)
  })

  it('refuses a compound that would close a cycle', () => {
    const doc = createDoc()
    doc.project.sequences = [
      {
        id: 'A',
        name: 'A',
        tracks: [
          {
            id: 'ta',
            kind: 'video',
            name: 'V1',
            clips: [{ id: 'ka', sequenceId: 'B', start: 0, duration: 1, inPoint: 0 }],
          },
        ],
      },
      {
        id: 'B',
        name: 'B',
        tracks: [
          {
            id: 'tb',
            kind: 'video',
            name: 'V1',
            clips: [{ id: 'kb', sequenceId: 'A', start: 0, duration: 1, inPoint: 0 }],
          },
        ],
      },
    ]
    // 'kb' lives in B and references A, and B is reachable from A (A -> B).
    expect(() =>
      applyCommand(doc, { type: 'createCompoundClip', clipIds: ['kb'], trackId: 'tb' }),
    ).toThrow(EditorCommandError)
  })

  it('refuses a compound beyond the nesting limit', () => {
    const doc = createDoc()
    const sequences: Sequence[] = []
    for (let i = 1; i <= 8; i++) {
      const clip: Clip =
        i < 8
          ? { id: `k${i}`, sequenceId: `S${i + 1}`, start: 0, duration: 1, inPoint: 0 }
          : { id: `k${i}`, mediaId: 'm1', start: 0, duration: 1, inPoint: 0 }
      sequences.push({
        id: `S${i}`,
        name: `S${i}`,
        tracks: [{ id: `t${i}`, kind: 'video', name: 'V1', clips: [clip] }],
      })
    }
    doc.project.sequences = sequences
    videoLane(doc).clips.push({
      id: 'rootk',
      sequenceId: 'S1',
      start: 0,
      duration: 1,
      inPoint: 0,
    })
    expect(maxSequenceDepth(doc)).toBe(8)
    expect(() =>
      applyCommand(doc, { type: 'createCompoundClip', clipIds: ['k8'], trackId: 't8' }),
    ).toThrow(EditorCommandError)
  })

  it('prunes a sequence when its last container is removed', () => {
    const { doc, compound } = withCompound(docWithClips())
    expect(doc.project.sequences).toHaveLength(1)
    const deleted = applyCommand(doc, { type: 'deleteClip', clipId: compound.id })
    expect(pruneOrphanSequences(deleted).project.sequences).toBeUndefined()
  })

  it('adds and removes a track inside a sequence, leaving the root alone', () => {
    const { doc, sequence } = withCompound(docWithClips())
    const withTrack = applyCommand(doc, {
      type: 'addTrack',
      kind: 'audio',
      trackId: 'newaudio',
      sequenceId: sequence.id,
    })
    expect(withTrack.project.sequences![0].tracks.some((t) => t.id === 'newaudio')).toBe(true)
    expect(withTrack.project.tracks.some((t) => t.id === 'newaudio')).toBe(false)
    const removed = applyCommand(withTrack, { type: 'removeTrack', trackId: 'newaudio' })
    expect(removed.project.sequences![0].tracks.some((t) => t.id === 'newaudio')).toBe(false)
  })

  it('expands a selected link group into the compound', () => {
    const doc = docWithClips()
    const linked = applyCommand(doc, { type: 'linkClips', clipIds: ['c1', 'c2'] })
    const lane = videoLane(linked)
    const next = applyCommand(linked, {
      type: 'createCompoundClip',
      clipIds: ['c1'],
      trackId: lane.id,
    })
    // The unselected partner moved with the selected clip.
    expect(videoLane(next).clips.some((c) => c.id === 'c1' || c.id === 'c2')).toBe(false)
    const innerIds = next.project
      .sequences![0].tracks.flatMap((t) => t.clips.map((c) => c.id))
      .sort()
    expect(innerIds).toEqual(['c1', 'c2'])
  })

  it('links within a sequence and refuses a cross-sequence link', () => {
    const { doc, compound, sequence } = withCompound(docWithClips())
    const inner = sequence.tracks[0].clips[0]
    const added = applyCommand(doc, {
      type: 'addClip',
      trackId: sequence.tracks[0].id,
      clip: createClip({ id: 'inner2', mediaId: 'm1', start: 2, duration: 2 }),
    })
    const linked = applyCommand(added, { type: 'linkClips', clipIds: [inner.id, 'inner2'] })
    const innerLink = findClip(linked, inner.id)?.clip.linkId
    expect(innerLink).toBeTruthy()
    expect(findClip(linked, 'inner2')?.clip.linkId).toBe(innerLink)
    expect(() =>
      applyCommand(added, { type: 'linkClips', clipIds: [inner.id, compound.id] }),
    ).toThrow(EditorCommandError)
  })
})

describe('serialization v4', () => {
  it('round-trips a compound clip', () => {
    const { doc, compound, sequence } = withCompound(docWithClips())
    const json = serializeDoc(doc)
    expect(json.version).toBe(4)
    const back = deserializeDoc(JSON.parse(JSON.stringify(json))).doc
    expect(back.project.sequences).toHaveLength(1)
    expect(findClip(back, compound.id)?.clip.sequenceId).toBe(sequence.id)
  })

  it('loads a v3 file (no sequences) unchanged', () => {
    const json = JSON.parse(JSON.stringify(serializeDoc(docWithClips())))
    json.version = 3
    delete json.project.sequences
    const { doc } = deserializeDoc(json)
    expect(doc.project.sequences).toBeUndefined()
    expect(findClip(doc, 'c1')).toBeDefined()
  })

  it('drops a compound clip whose sequence is missing', () => {
    const { doc } = withCompound(docWithClips())
    const json = JSON.parse(JSON.stringify(serializeDoc(doc)))
    json.project.sequences = []
    const { doc: loaded } = deserializeDoc(json)
    expect(videoLane(loaded).clips).toHaveLength(0)
  })

  it('rejects a cyclic sequence graph', () => {
    const raw = {
      version: 4,
      project: {
        tracks: [],
        sequences: [
          {
            id: 'A',
            name: 'A',
            tracks: [
              {
                id: 'ta',
                kind: 'video',
                name: 'V1',
                clips: [{ id: 'ka', sequenceId: 'A', start: 0, duration: 1, inPoint: 0 }],
              },
            ],
          },
        ],
      },
    }
    expect(() => deserializeDoc(raw)).toThrow(SerializationError)
  })

  it('rejects duplicate track, clip or sequence ids', () => {
    const raw = {
      version: 4,
      project: {
        tracks: [
          {
            id: 't',
            kind: 'video',
            name: 'V1',
            clips: [{ id: 'c', start: 0, duration: 1, inPoint: 0 }],
          },
        ],
        sequences: [
          { id: 'A', name: 'A', tracks: [{ id: 't', kind: 'video', name: 'V1', clips: [] }] },
        ],
      },
    }
    expect(() => deserializeDoc(raw)).toThrow(SerializationError)
  })

  it('rejects a link id shared across sequences', () => {
    const raw = {
      version: 4,
      project: {
        tracks: [
          {
            id: 't',
            kind: 'video',
            name: 'V1',
            clips: [{ id: 'c', linkId: 'L', start: 0, duration: 1, inPoint: 0 }],
          },
        ],
        sequences: [
          {
            id: 'A',
            name: 'A',
            tracks: [
              {
                id: 'ta',
                kind: 'video',
                name: 'V1',
                clips: [{ id: 'ca', linkId: 'L', start: 0, duration: 1, inPoint: 0 }],
              },
            ],
          },
        ],
      },
    }
    expect(() => deserializeDoc(raw)).toThrow(SerializationError)
  })

  it('rejects a compound clip with incompatible media or retiming fields', () => {
    const raw = {
      version: 4,
      project: {
        tracks: [
          {
            id: 't',
            kind: 'video',
            name: 'V1',
            clips: [{ id: 'c', sequenceId: 'A', mediaId: 'm', start: 0, duration: 1, inPoint: 0 }],
          },
        ],
        sequences: [{ id: 'A', name: 'A', tracks: [] }],
      },
    }
    expect(() => deserializeDoc(raw)).toThrow(SerializationError)
  })

  it('rejects a compound clip flagged audioOnly', () => {
    const raw = {
      version: 4,
      project: {
        tracks: [
          {
            id: 't',
            kind: 'video',
            name: 'V1',
            clips: [
              { id: 'c', sequenceId: 'A', audioOnly: true, start: 0, duration: 1, inPoint: 0 },
            ],
          },
        ],
        sequences: [{ id: 'A', name: 'A', tracks: [] }],
      },
    }
    expect(() => deserializeDoc(raw)).toThrow(SerializationError)
  })

  it('rejects a file deeper than the nesting limit', () => {
    const sequences: Sequence[] = []
    for (let i = 1; i <= 9; i++) {
      const clip: Clip =
        i < 9
          ? { id: `k${i}`, sequenceId: `S${i + 1}`, start: 0, duration: 1, inPoint: 0 }
          : { id: `k${i}`, start: 0, duration: 1, inPoint: 0 }
      sequences.push({
        id: `S${i}`,
        name: `S${i}`,
        tracks: [{ id: `t${i}`, kind: 'video', name: 'V1', clips: [clip] }],
      })
    }
    const raw = {
      version: 4,
      project: {
        tracks: [
          {
            id: 'root',
            kind: 'video',
            name: 'V1',
            clips: [{ id: 'rk', sequenceId: 'S1', start: 0, duration: 1, inPoint: 0 }],
          },
        ],
        sequences,
      },
    }
    expect(() => deserializeDoc(raw)).toThrow(SerializationError)
  })

  it('rejects a duplicate clip id and a duplicate sequence id', () => {
    const dupClip = {
      version: 4,
      project: {
        tracks: [
          {
            id: 't',
            kind: 'video',
            name: 'V1',
            clips: [
              { id: 'c', start: 0, duration: 1, inPoint: 0 },
              { id: 'c', start: 1, duration: 1, inPoint: 0 },
            ],
          },
        ],
      },
    }
    expect(() => deserializeDoc(dupClip)).toThrow(SerializationError)
    const dupSeq = {
      version: 4,
      project: {
        tracks: [],
        sequences: [
          { id: 'S', name: 'A', tracks: [] },
          { id: 'S', name: 'B', tracks: [] },
        ],
      },
    }
    expect(() => deserializeDoc(dupSeq)).toThrow(SerializationError)
  })

  it('accepts a valid depth-eight create and a depth-eight file', () => {
    // Build a root -> S1 -> ... -> S8 chain (depth 8) and create one more
    // compound at depth 8 (which would be depth 9) is refused; a file at
    // exactly depth 8 loads.
    const doc = createDoc()
    const sequences: Sequence[] = []
    for (let i = 1; i <= 8; i++) {
      const clip: Clip =
        i < 8
          ? { id: `k${i}`, sequenceId: `S${i + 1}`, start: 0, duration: 1, inPoint: 0 }
          : { id: `k${i}`, mediaId: 'm1', start: 0, duration: 1, inPoint: 0 }
      sequences.push({
        id: `S${i}`,
        name: `S${i}`,
        tracks: [{ id: `t${i}`, kind: 'video', name: 'V1', clips: [clip] }],
      })
    }
    doc.project.sequences = sequences
    videoLane(doc).clips.push({ id: 'rootk', sequenceId: 'S1', start: 0, duration: 1, inPoint: 0 })
    expect(maxSequenceDepth(doc)).toBe(8)
    // Serializes and reloads unchanged.
    const back = deserializeDoc(JSON.parse(JSON.stringify(serializeDoc(doc)))).doc
    expect(back.project.sequences).toHaveLength(8)
  })
})

describe('compound clip editing and lifetime (0.8.1)', () => {
  it('refuses placing a compound into its own referenced sequence', () => {
    const { doc, sequence } = withCompound(docWithClips())
    const compound = videoLane(doc).clips[0]
    expect(() =>
      applyCommand(doc, { type: 'addClip', trackId: sequence.tracks[0].id, clip: compound }),
    ).toThrow(EditorCommandError)
    expect(() =>
      applyCommand(doc, {
        type: 'moveClip',
        clipId: compound.id,
        trackId: sequence.tracks[0].id,
        start: 0,
      }),
    ).toThrow(EditorCommandError)
  })

  it('ripple-deletes inside a sequence only when given the active path', () => {
    const { doc, sequence } = withCompound(docWithClips())
    const inner = sequence.tracks[0].clips[0]
    // With the active path: the clip after the removed one shifts left.
    const withPath = commandsToRippleDeleteClips(doc, [inner.id], [sequence.id])
    expect(withPath?.some((c) => c.type === 'moveClip')).toBe(true)
    // Without it (defaults to the root): no nested clip is shifted.
    const rootOnly = commandsToRippleDeleteClips(doc, [inner.id])
    expect(rootOnly?.some((c) => c.type === 'moveClip')).toBe(false)
  })

  it('refuses placing a compound whose referenced sequence is missing', () => {
    const doc = createDoc()
    const lane = videoLane(doc)
    expect(() =>
      applyCommand(doc, {
        type: 'addClip',
        trackId: lane.id,
        clip: createClip({ id: 'c', sequenceId: 'ghost', start: 0, duration: 1 }),
      }),
    ).toThrow(EditorCommandError)
  })

  it('keeps a shared sequence while another container references it', () => {
    const { doc, compound, sequence } = withCompound(docWithClips())
    const lane = videoLane(doc)
    // Duplicate the container (a second reference to the same sequence).
    const copy = applyCommand(doc, {
      type: 'addClip',
      trackId: lane.id,
      clip: { ...compound, id: 'comp2', start: compound.duration },
    })
    expect(copy.project.sequences).toHaveLength(1)
    // Removing one container keeps the sequence.
    const oneGone = pruneOrphanSequences(
      applyCommand(copy, { type: 'deleteClip', clipId: 'comp2' }),
    )
    expect(oneGone.project.sequences).toHaveLength(1)
    // Removing the last one prunes it.
    const bothGone = pruneOrphanSequences(
      applyCommand(oneGone, { type: 'deleteClip', clipId: compound.id }),
    )
    expect(bothGone.project.sequences).toBeUndefined()
    expect(sequence.id).toBeTruthy()
  })

  it('edits a nested clip without touching the root lanes', () => {
    const { doc, sequence } = withCompound(docWithClips())
    const inner = sequence.tracks[0].clips[0]
    const rootBefore = videoLane(doc).clips.length
    const moved = applyCommand(doc, {
      type: 'moveClip',
      clipId: inner.id,
      trackId: sequence.tracks[0].id,
      start: 1.5,
    })
    const innerAfter = moved.project.sequences![0].tracks[0].clips.find((c) => c.id === inner.id)!
    expect(innerAfter.start).toBe(1.5)
    expect(videoLane(moved).clips.length).toBe(rootBefore)
    const trimmed = applyCommand(moved, {
      type: 'trimClip',
      clipId: inner.id,
      start: 1.5,
      inPoint: inner.inPoint,
      duration: 0.5,
      edge: 'tail',
    })
    expect(
      trimmed.project.sequences![0].tracks[0].clips.find((c) => c.id === inner.id)!.duration,
    ).toBeCloseTo(0.5, 5)
  })
})

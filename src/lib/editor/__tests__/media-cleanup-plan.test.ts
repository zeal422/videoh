import { describe, expect, it } from 'vitest'

import {
  collectMediaHashes,
  collectReferencedHashes,
  planMediaCleanup,
} from '../media-cleanup-plan'
import { createDoc, createMediaAsset } from '../factories'
import { serializeDoc } from '../serialization'
import type { Doc } from '../types'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const C = 'c'.repeat(64)
const D = 'd'.repeat(64)

function docWith(hashes: string[], projectId?: string): Doc {
  const doc = createDoc()
  if (projectId) doc.project.id = projectId
  doc.media = hashes.map((contentHash, index) =>
    createMediaAsset({
      id: `m${index}`,
      kind: 'video',
      name: `${index}.mp4`,
      contentHash,
      missing: true,
    }),
  )
  return doc
}

describe('collectMediaHashes', () => {
  it('keeps only valid hashes, deduped and sorted', () => {
    const doc = docWith([B, A, B])
    doc.media.push(createMediaAsset({ id: 'bad', kind: 'video', contentHash: '../evil' }))
    expect(collectMediaHashes(doc)).toEqual([A, B])
  })
})

describe('collectReferencedHashes', () => {
  it('unions the live doc, both history stacks, and the autosave slot', () => {
    const doc = docWith([A])
    const past = [docWith([B])]
    const future = [docWith([C])]
    const autosave = JSON.stringify(serializeDoc(docWith([D], doc.project.id)))
    const referenced = collectReferencedHashes({ doc, past, future, autosave })
    expect([...referenced].sort()).toEqual([A, B, C, D])
  })

  it('ignores an autosave slot for a different project', () => {
    const doc = docWith([A], 'proj_one')
    const autosave = JSON.stringify(serializeDoc(docWith([B], 'proj_two')))
    const referenced = collectReferencedHashes({ doc, past: [], future: [], autosave })
    expect([...referenced]).toEqual([A])
  })

  it('ignores a malformed or absent autosave slot', () => {
    const doc = docWith([A])
    expect([...collectReferencedHashes({ doc, past: [], future: [], autosave: null })]).toEqual([A])
    expect([...collectReferencedHashes({ doc, past: [], future: [], autosave: '{nope' })]).toEqual([
      A,
    ])
  })
})

describe('planMediaCleanup', () => {
  const stored = [
    { hash: A, size: 10 },
    { hash: B, size: 20 },
    { hash: C, size: 30 },
  ]

  it('deletes only unclaimed hashes outside the reference set', () => {
    const plan = planMediaCleanup({
      stored,
      referenced: new Set([A]),
      claimed: [B],
    })
    expect(plan.blocked).toBe(false)
    expect(plan.candidates).toEqual([{ hash: C, size: 30 }])
    expect(plan.reclaimed).toBe(30)
    expect(plan.claimedCount).toBe(1)
  })

  it('reports no candidates when every entry is reachable', () => {
    const plan = planMediaCleanup({
      stored,
      referenced: new Set([A, B, C]),
      claimed: [],
    })
    expect(plan.candidates).toEqual([])
    expect(plan.reclaimed).toBe(0)
  })

  it('blocks content-hash deletion when claims are missing', () => {
    const plan = planMediaCleanup({ stored, referenced: new Set(), claimed: null })
    expect(plan).toEqual({ candidates: [], reclaimed: 0, claimedCount: 0, blocked: true })
  })

  it('sorts candidates by hash', () => {
    const plan = planMediaCleanup({
      stored: [
        { hash: C, size: 1 },
        { hash: A, size: 1 },
      ],
      referenced: new Set(),
      claimed: [],
    })
    expect(plan.candidates.map((candidate) => candidate.hash)).toEqual([A, C])
  })
})

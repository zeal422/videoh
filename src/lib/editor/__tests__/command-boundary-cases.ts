import type { EditorCommand } from '../commands'
import type { Doc, Track } from '../types'

/** One hostile command-payload case: a label and a command factory. */
export type CommandBoundaryCase = [string, (doc: Doc) => EditorCommand]

const videoTrack = (doc: Doc): Track => doc.project.tracks.find((track) => track.kind === 'video')!

/** The hostile-payload table behind the command boundary tests. */
export const COMMAND_BOUNDARY_CASES: CommandBoundaryCase[] = [
  [
    'a non-string track name',
    (doc) => ({
      type: 'renameTrack',
      trackId: videoTrack(doc).id,
      name: 42 as unknown as string,
    }),
  ],
  [
    'a non-string preset name',
    (doc) => ({ type: 'renameTextPreset', presetId: 'preset_a', name: 42 as unknown as string }),
  ],
  [
    'a non-string project name',
    (doc) => ({ type: 'setProjectSettings', patch: { name: 7 as unknown as string } }),
  ],
  ['a non-finite gain', (doc) => ({ type: 'setClipGain', clipId: 'clip_a', gain: Number.NaN })],
  [
    'a non-finite color temperature',
    (doc) => ({ type: 'setClipColorParams', clipId: 'clip_a', temperature: Number.NaN, tint: 0 }),
  ],
  [
    'a non-object EQ payload',
    (doc) =>
      ({ type: 'setClipEq', clipId: 'clip_a', eq: 'bad' as unknown as null }) as EditorCommand,
  ],
  [
    'an unknown animatable property',
    (doc) =>
      ({
        type: 'setClipAnimStatic',
        clipId: 'clip_a',
        property: 'bogus',
        value: 1,
      }) as unknown as EditorCommand,
  ],
  [
    'a non-boolean mute flag',
    (doc) => ({ type: 'setClipMuted', clipId: 'clip_a', muted: 1 as unknown as boolean }),
  ],
  [
    'a non-boolean reverse flag',
    (doc) => ({ type: 'setClipReverse', clipId: 'clip_a', reverse: 1 as unknown as boolean }),
  ],
  [
    'a non-string text body',
    (doc) => ({
      type: 'setTextContent',
      clipId: 'clip_text_boundary',
      text: 7 as unknown as string,
    }),
  ],
  [
    'a non-object style payload',
    (doc) => ({
      type: 'setTextStyle',
      clipId: 'clip_text_boundary',
      style: 'bad' as unknown as never,
    }),
  ],
  [
    'an unknown transition type',
    (doc) =>
      ({
        type: 'addTransition',
        clipId: 'clip_a',
        duration: 1,
        transitionType: 'bogus',
      }) as unknown as EditorCommand,
  ],
  [
    'a malformed media asset',
    (doc) =>
      ({
        type: 'addMediaAsset',
        asset: {
          id: 'asset_bad',
          name: 'bad',
          kind: 'bogus',
          duration: 1,
          width: 1,
          height: 1,
          url: 'blob:bad',
        },
      }) as unknown as EditorCommand,
  ],
  [
    'a non-string media name',
    (doc) =>
      ({
        type: 'addMediaAsset',
        asset: {
          id: 'asset_bad_name',
          name: 7 as unknown as string,
          kind: 'video',
          duration: 1,
          width: 1,
          height: 1,
          url: 'blob:bad',
        },
      }) as unknown as EditorCommand,
  ],
  [
    'a non-string media url',
    (doc) =>
      ({
        type: 'addMediaAsset',
        asset: {
          id: 'asset_bad_url',
          name: 'bad',
          kind: 'video',
          duration: 1,
          width: 1,
          height: 1,
          url: 7 as unknown as string,
        },
      }) as unknown as EditorCommand,
  ],
  [
    'an unknown trim edge',
    (doc) =>
      ({
        type: 'trimClip',
        clipId: 'clip_a',
        start: 0,
        inPoint: 0,
        duration: 2,
        edge: 'bogus',
      }) as unknown as EditorCommand,
  ],
  [
    'a non-array keyframe payload',
    (doc) =>
      ({
        type: 'setClipKeyframes',
        clipId: 'clip_a',
        property: 'opacity',
        keyframes: null,
      }) as unknown as EditorCommand,
  ],
  [
    'a non-object sequence marker patch',
    (doc) =>
      ({
        type: 'updateSequenceMarker',
        markerId: 'marker_a',
        patch: null,
      }) as unknown as EditorCommand,
  ],
  [
    'a non-string clip marker name',
    (doc) =>
      ({
        type: 'updateClipMarker',
        clipId: 'clip_a',
        markerId: 'clip_marker',
        patch: { name: 7 },
      }) as unknown as EditorCommand,
  ],
]

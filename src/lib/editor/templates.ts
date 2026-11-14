/**
 * templates.ts: the local template schema, validation, and deterministic
 * sequence planning (0.26.0).
 *
 * A template is external data, never part of `Doc`, and it carries no media:
 * it describes text and shape clips only. The format has its own version field
 * so it never rides `SERIALIZATION_VERSION`. Applying a template mints fresh
 * sequence, track, and clip ids (and one fresh link id per link group), remaps
 * every internal reference, and installs the result as one undo entry.
 */

import {
  KEYFRAME_PROPERTY_BOUNDS,
  MAX_TIMELINE_SECONDS,
  MIN_CLIP_DURATION,
  OPACITY_MAX,
  OPACITY_MIN,
  ROTATION_MAX,
  ROTATION_MIN,
  TEMPLATE_DESCRIPTION_MAX,
  TEMPLATE_MAX_CLIPS,
  TEMPLATE_MAX_DURATION,
  TEMPLATE_MAX_TEXT_LENGTH,
  TEMPLATE_MAX_TRACKS,
  TEMPLATE_NAME_MAX,
  TEMPLATE_VERSION,
} from './constants'
import {
  createDefaultTextStyle,
  TEXT_PRESET_FONT_MAX,
  TEXT_PRESET_FONT_MIN,
  uid,
} from './factories'
import { BUILTIN_FONTS, primaryFontFamily, sanitizeFontFamily } from './fonts'
import {
  clampPropertyValue,
  isAnimatableProperty,
  isKeyframeInterpolation,
  sanitizeKeyframes,
} from './keyframes'
import { isShapeHexColor, sanitizeShape } from './shapes'
import { clamp } from './time'
import type {
  AnimStaticProperty,
  Clip,
  Doc,
  Keyframe,
  KeyframeMap,
  KeyframeProperty,
  Sequence,
  ShapeStyle,
  TextStyle,
  Track,
} from './types'

export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateError'
  }
}

/** A text or shape clip inside a template. Media and compound clips are absent by design. */
export interface TemplateClip {
  id: string
  start: number
  duration: number
  /** Optional link group. Repeated values across clips define one group. */
  linkId?: string
  text?: string
  style?: TextStyle
  shape?: ShapeStyle
  /** Visual opacity, 0..1 (default 1). */
  opacity?: number
  /** Static rotation in degrees, -3600..3600 (default 0). */
  rotation?: number
  /** Explicit flip pair; absent means neither axis flips. */
  flipX?: boolean
  flipY?: boolean
  /** Static values for animatable position/scale/color properties. */
  animStatics?: Partial<Record<AnimStaticProperty, number>>
  /** Per-property keyframe curves for visual properties. */
  keyframes?: KeyframeMap
}

export interface TemplateTrack {
  id: string
  kind: 'video' | 'text'
  name: string
  clips: TemplateClip[]
}

export interface TemplateSequence {
  id: string
  name: string
  tracks: TemplateTrack[]
}

/** One saved or built-in template. */
export interface ProjectTemplate {
  id: string
  name: string
  description: string
  version: number
  sequence: TemplateSequence
}

const TEMPLATE_ROOT_KEYS = ['id', 'name', 'description', 'version', 'sequence'] as const
const SEQUENCE_KEYS = ['id', 'name', 'tracks'] as const
const TRACK_KEYS = ['id', 'kind', 'name', 'clips'] as const
const CLIP_KEYS = [
  'id',
  'start',
  'duration',
  'linkId',
  'text',
  'style',
  'shape',
  'opacity',
  'rotation',
  'flipX',
  'flipY',
  'animStatics',
  'keyframes',
] as const
const STYLE_KEYS = [
  'fontSize',
  'color',
  'fontFamily',
  'bold',
  'italic',
  'align',
  'x',
  'y',
  'shadow',
] as const

function assertKnownKeys(
  entry: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(entry)) {
    if (!allowedSet.has(key))
      throw new TemplateError(`Template ${what} has an unknown field: ${key}`)
  }
}

function safeId(raw: unknown, what: string): string {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > 96 ||
    !/^[A-Za-z0-9_-]+$/.test(raw)
  ) {
    throw new TemplateError(`Template ${what} id is invalid`)
  }
  return raw
}

/** Display names may not look like a path or carry control characters. */
function safeName(raw: unknown, max: number, what: string): string {
  if (typeof raw !== 'string') throw new TemplateError(`Template ${what} must be a string`)
  const name = raw.trim()
  if (!name) throw new TemplateError(`Template ${what} cannot be empty`)
  if (name.length > max) throw new TemplateError(`Template ${what} is too long`)
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new TemplateError(`Template ${what} contains control characters`)
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new TemplateError(`Template ${what} must not look like a path`)
  }
  return name
}

function safeDescription(raw: unknown): string {
  if (raw === undefined) return ''
  if (typeof raw !== 'string') throw new TemplateError('Template description must be a string')
  const description = raw.trim()
  if (description.length > TEMPLATE_DESCRIPTION_MAX) {
    throw new TemplateError('Template description is too long')
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description)) {
    throw new TemplateError('Template description contains control characters')
  }
  return description
}

function safeText(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new TemplateError('Template text clip has no text')
  }
  if (raw.length > TEMPLATE_MAX_TEXT_LENGTH) throw new TemplateError('Template text is too long')
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) {
    throw new TemplateError('Template text contains control characters')
  }
  return raw
}

function parseStyle(raw: unknown): TextStyle {
  if (typeof raw !== 'object' || raw === null) {
    throw new TemplateError('Template text clip has no style')
  }
  const entry = raw as Record<string, unknown>
  assertKnownKeys(entry, STYLE_KEYS, 'style')
  const defaultStyle = createDefaultTextStyle()
  if (entry.color !== undefined && !isShapeHexColor(entry.color)) {
    throw new TemplateError('Template text color is invalid')
  }
  const color = isShapeHexColor(entry.color) ? entry.color.toLowerCase() : defaultStyle.color
  if (entry.fontFamily !== undefined && !sanitizeFontFamily(entry.fontFamily)) {
    throw new TemplateError('Template font family is invalid')
  }
  const fontFamily = sanitizeFontFamily(entry.fontFamily) ?? defaultStyle.fontFamily
  const fontSize =
    typeof entry.fontSize === 'number' && Number.isFinite(entry.fontSize)
      ? clamp(entry.fontSize, TEXT_PRESET_FONT_MIN, TEXT_PRESET_FONT_MAX)
      : defaultStyle.fontSize
  const align =
    entry.align === 'left' || entry.align === 'right' || entry.align === 'center'
      ? entry.align
      : defaultStyle.align
  const x =
    typeof entry.x === 'number' && Number.isFinite(entry.x) ? clamp(entry.x, 0, 1) : defaultStyle.x
  const y =
    typeof entry.y === 'number' && Number.isFinite(entry.y) ? clamp(entry.y, 0, 1) : defaultStyle.y
  return {
    fontSize,
    color,
    fontFamily,
    bold: typeof entry.bold === 'boolean' ? entry.bold : defaultStyle.bold,
    italic: typeof entry.italic === 'boolean' ? entry.italic : defaultStyle.italic,
    align,
    x,
    y,
    shadow: typeof entry.shadow === 'boolean' ? entry.shadow : defaultStyle.shadow,
  }
}

function isTemplateAnimStaticProperty(p: string): p is AnimStaticProperty {
  return (
    isAnimatableProperty(p) &&
    p !== 'opacity' &&
    p !== 'rotation' &&
    p !== 'volume' &&
    p !== 'timeScale'
  )
}

function isTemplateKeyframeProperty(p: string): p is KeyframeProperty {
  return isAnimatableProperty(p) && p !== 'volume' && p !== 'timeScale'
}

function validEaseQuad(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)
  )
}

/**
 * The visual fields a template carries beyond text style and shape geometry:
 * opacity, rotation, the flip pair, static position/scale/color values, and
 * keyframe curves. Media, audio, retiming, effects, and transitions are not
 * template content. Values clamp to the same bounds the commands enforce; a
 * non-number or an unsupported property name refuses.
 */
function parseVisualFields(entry: Record<string, unknown>): Partial<TemplateClip> {
  const out: Partial<TemplateClip> = {}
  if (entry.opacity !== undefined) {
    if (typeof entry.opacity !== 'number' || !Number.isFinite(entry.opacity)) {
      throw new TemplateError('Template clip opacity is invalid')
    }
    const opacity = clamp(entry.opacity, OPACITY_MIN, OPACITY_MAX)
    if (opacity !== 1) out.opacity = opacity
  }
  if (entry.rotation !== undefined) {
    if (typeof entry.rotation !== 'number' || !Number.isFinite(entry.rotation)) {
      throw new TemplateError('Template clip rotation is invalid')
    }
    const rotation = clamp(entry.rotation, ROTATION_MIN, ROTATION_MAX)
    if (rotation !== 0) out.rotation = rotation
  }
  if (entry.flipX !== undefined) {
    if (typeof entry.flipX !== 'boolean') throw new TemplateError('Template clip flip is invalid')
    if (entry.flipX) out.flipX = true
  }
  if (entry.flipY !== undefined) {
    if (typeof entry.flipY !== 'boolean') throw new TemplateError('Template clip flip is invalid')
    if (entry.flipY) out.flipY = true
  }

  if (entry.animStatics !== undefined) {
    if (typeof entry.animStatics !== 'object' || entry.animStatics === null) {
      throw new TemplateError('Template clip static values are invalid')
    }
    const statics: NonNullable<TemplateClip['animStatics']> = {}
    for (const [property, value] of Object.entries(entry.animStatics as Record<string, unknown>)) {
      if (!isTemplateAnimStaticProperty(property)) {
        throw new TemplateError(`Template clip has an unsupported static property: ${property}`)
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TemplateError('Template clip static value is invalid')
      }
      const clamped = clampPropertyValue(property, value)
      if (clamped !== KEYFRAME_PROPERTY_BOUNDS[property].default) statics[property] = clamped
    }
    if (Object.keys(statics).length > 0) out.animStatics = statics
  }

  if (entry.keyframes !== undefined) {
    if (typeof entry.keyframes !== 'object' || entry.keyframes === null) {
      throw new TemplateError('Template clip keyframes are invalid')
    }
    const map: KeyframeMap = {}
    for (const [property, value] of Object.entries(entry.keyframes as Record<string, unknown>)) {
      if (!isTemplateKeyframeProperty(property)) {
        throw new TemplateError(`Template clip has an unsupported keyframe property: ${property}`)
      }
      if (!Array.isArray(value)) throw new TemplateError('Template clip keyframes are invalid')
      const cleaned: Keyframe[] = []
      for (const rawKeyframe of value) {
        if (typeof rawKeyframe !== 'object' || rawKeyframe === null) {
          throw new TemplateError('Template clip keyframe is invalid')
        }
        const keyframeRaw = rawKeyframe as Record<string, unknown>
        const time = keyframeRaw.time
        const keyframeValue = keyframeRaw.value
        if (
          typeof time !== 'number' ||
          !Number.isFinite(time) ||
          time < 0 ||
          typeof keyframeValue !== 'number' ||
          !Number.isFinite(keyframeValue)
        ) {
          throw new TemplateError('Template clip keyframe is invalid')
        }
        const keyframe: Keyframe = { time, value: keyframeValue }
        if (isKeyframeInterpolation(keyframeRaw.interpolation)) {
          keyframe.interpolation = keyframeRaw.interpolation
        }
        if (validEaseQuad(keyframeRaw.easeOut)) keyframe.easeOut = keyframeRaw.easeOut
        cleaned.push(keyframe)
      }
      const sanitized = sanitizeKeyframes(property, cleaned)
      if (sanitized.length !== cleaned.length) {
        throw new TemplateError('Template clip keyframe is invalid')
      }
      if (sanitized.length > 0) map[property] = sanitized
    }
    if (Object.keys(map).length > 0) out.keyframes = map
  }
  return out
}

function parseClip(raw: unknown, kind: 'video' | 'text', seenClipIds: Set<string>): TemplateClip {
  if (typeof raw !== 'object' || raw === null)
    throw new TemplateError('Template clip is not an object')
  const entry = raw as Record<string, unknown>
  assertKnownKeys(entry, CLIP_KEYS, 'clip')
  const id = safeId(entry.id, 'clip')
  if (seenClipIds.has(id)) throw new TemplateError(`Duplicate template clip id: ${id}`)
  seenClipIds.add(id)

  const start = entry.start
  const duration = entry.duration
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) {
    throw new TemplateError('Template clip start must be a non-negative number')
  }
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < MIN_CLIP_DURATION) {
    throw new TemplateError('Template clip duration is too short')
  }
  if (start + duration > TEMPLATE_MAX_DURATION || start + duration > MAX_TIMELINE_SECONDS) {
    throw new TemplateError('Template clip end is past the supported timeline range')
  }

  const hasText = entry.text !== undefined
  const hasShape = entry.shape !== undefined
  if (hasText === hasShape) {
    throw new TemplateError('Template clip must be either a text clip or a shape clip')
  }
  let linkId: string | undefined
  if (entry.linkId !== undefined) linkId = safeId(entry.linkId, 'link')
  const visual = parseVisualFields(entry)

  if (hasText) {
    if (kind !== 'text') throw new TemplateError('Template text clips live on text tracks')
    return {
      id,
      start,
      duration,
      ...(linkId ? { linkId } : {}),
      ...visual,
      text: safeText(entry.text),
      style: parseStyle(entry.style),
    }
  }

  if (kind !== 'video') throw new TemplateError('Template shape clips live on video tracks')
  const shape = sanitizeShape(entry.shape)
  if (!shape) throw new TemplateError('Template shape clip is invalid')
  return { id, start, duration, ...(linkId ? { linkId } : {}), ...visual, shape }
}

/**
 * Validates a template from any trust boundary and returns a normalized copy.
 * Unknown fields, unknown versions, duplicate ids, path-like names, malformed
 * colors, oversized counts, and clips on the wrong lane kind all refuse.
 */
export function parseTemplate(raw: unknown): ProjectTemplate {
  if (typeof raw !== 'object' || raw === null) throw new TemplateError('Template is not an object')
  const entry = raw as Record<string, unknown>
  assertKnownKeys(entry, TEMPLATE_ROOT_KEYS, 'root')
  if (
    typeof entry.version !== 'number' ||
    !Number.isInteger(entry.version) ||
    entry.version !== TEMPLATE_VERSION
  ) {
    throw new TemplateError(`Unsupported template version: ${String(entry.version)}`)
  }
  const id = safeId(entry.id, 'template')
  const name = safeName(entry.name, TEMPLATE_NAME_MAX, 'name')
  const description = safeDescription(entry.description)

  if (typeof entry.sequence !== 'object' || entry.sequence === null) {
    throw new TemplateError('Template has no sequence')
  }
  const sequenceRaw = entry.sequence as Record<string, unknown>
  assertKnownKeys(sequenceRaw, SEQUENCE_KEYS, 'sequence')
  const sequenceId = safeId(sequenceRaw.id, 'sequence')
  const sequenceName = safeName(sequenceRaw.name, TEMPLATE_NAME_MAX, 'sequence name')
  if (!Array.isArray(sequenceRaw.tracks)) throw new TemplateError('Template sequence has no tracks')
  if (sequenceRaw.tracks.length === 0) throw new TemplateError('Template has no tracks')
  if (sequenceRaw.tracks.length > TEMPLATE_MAX_TRACKS) {
    throw new TemplateError(`Template has more than ${TEMPLATE_MAX_TRACKS} tracks`)
  }

  const seenTrackIds = new Set<string>()
  const seenClipIds = new Set<string>()
  let clipCount = 0
  const tracks: TemplateTrack[] = []
  for (const rawTrack of sequenceRaw.tracks) {
    if (typeof rawTrack !== 'object' || rawTrack === null) {
      throw new TemplateError('Template track is not an object')
    }
    const trackRaw = rawTrack as Record<string, unknown>
    assertKnownKeys(trackRaw, TRACK_KEYS, 'track')
    const trackId = safeId(trackRaw.id, 'track')
    if (seenTrackIds.has(trackId))
      throw new TemplateError(`Duplicate template track id: ${trackId}`)
    seenTrackIds.add(trackId)
    if (trackRaw.kind !== 'video' && trackRaw.kind !== 'text') {
      throw new TemplateError('Template tracks must be video or text tracks')
    }
    const kind: 'video' | 'text' = trackRaw.kind
    const trackName = safeName(trackRaw.name, TEMPLATE_NAME_MAX, 'track name')
    if (!Array.isArray(trackRaw.clips)) throw new TemplateError('Template track has no clips')
    const clips: TemplateClip[] = []
    for (const rawClip of trackRaw.clips) {
      clipCount += 1
      if (clipCount > TEMPLATE_MAX_CLIPS) {
        throw new TemplateError(`Template has more than ${TEMPLATE_MAX_CLIPS} clips`)
      }
      clips.push(parseClip(rawClip, kind, seenClipIds))
    }
    tracks.push({ id: trackId, kind, name: trackName, clips })
  }
  if (clipCount === 0) throw new TemplateError('Template has no clips')

  return {
    id,
    name,
    description,
    version: TEMPLATE_VERSION,
    sequence: { id: sequenceId, name: sequenceName, tracks },
  }
}

/** The primary families this build and project can actually render. */
function knownFontFamilies(doc: Doc): Set<string> {
  const families = new Set<string>()
  for (const font of [...BUILTIN_FONTS, ...(doc.project.fonts ?? [])]) {
    const primary = primaryFontFamily(font.family)
    if (primary) families.add(primary)
  }
  return families
}

/**
 * Apply-time support check: a template naming a font this project does not have
 * is refused whole, never partially applied. Shape kinds are already gated by
 * `sanitizeShape` during parsing.
 *
 * Comparison uses the primary family token, not the whole stack: an uploaded
 * font's clips carry `videoh-font-…, Arial, sans-serif`, but a hand-edited or
 * older reference may change its fallbacks while still naming the same face.
 */
export function validateTemplateForDoc(template: ProjectTemplate, doc: Doc): void {
  const known = knownFontFamilies(doc)
  for (const track of template.sequence.tracks) {
    for (const clip of track.clips) {
      if (!clip.style) continue
      const family = primaryFontFamily(clip.style.fontFamily)
      if (!family || !known.has(family)) {
        throw new TemplateError(
          `This template uses a font this project does not have: ${clip.style.fontFamily}`,
        )
      }
    }
  }
}

/**
 * Builds a fresh sequence from a validated template. Every sequence, track, and
 * clip id is new, and one fresh link id is minted per distinct template link
 * group. The returned duration is the longest clip end.
 */
export function mintTemplateSequence(template: ProjectTemplate): {
  sequence: Sequence
  duration: number
} {
  const linkIds = new Map<string, string>()
  const linkIdFor = (raw: string): string => {
    const existing = linkIds.get(raw)
    if (existing) return existing
    const fresh = uid('link')
    linkIds.set(raw, fresh)
    return fresh
  }
  let duration = 0
  const tracks: Track[] = template.sequence.tracks.map((track) => {
    const clips: Clip[] = track.clips.map((clip) => {
      const freshLink = clip.linkId ? linkIdFor(clip.linkId) : undefined
      duration = Math.max(duration, clip.start + clip.duration)
      const base: Clip = {
        id: uid('clip'),
        start: clip.start,
        duration: clip.duration,
        inPoint: 0,
        ...(freshLink ? { linkId: freshLink } : {}),
        ...(clip.opacity !== undefined ? { opacity: clip.opacity } : {}),
        ...(clip.rotation !== undefined ? { rotation: clip.rotation } : {}),
        ...(clip.flipX ? { flipX: true } : {}),
        ...(clip.flipY ? { flipY: true } : {}),
        ...(clip.animStatics ? { animStatics: structuredClone(clip.animStatics) } : {}),
        ...(clip.keyframes ? { keyframes: structuredClone(clip.keyframes) } : {}),
      }
      if (clip.text !== undefined) {
        return { ...base, text: clip.text, style: structuredClone(clip.style) }
      }
      return { ...base, shape: structuredClone(clip.shape) }
    })
    return {
      id: uid('track'),
      kind: track.kind,
      name: track.name,
      clips,
    }
  })
  return {
    sequence: { id: uid('seq'), name: template.sequence.name, tracks },
    duration,
  }
}

/** The visual clip fields a template preserves; unsupported curves are omitted. */
function templateClipVisuals(clip: Clip): Partial<TemplateClip> {
  const visuals: Partial<TemplateClip> = {}
  if (clip.opacity !== undefined) visuals.opacity = clip.opacity
  if (clip.rotation !== undefined) visuals.rotation = clip.rotation
  if (clip.flipX) visuals.flipX = true
  if (clip.flipY) visuals.flipY = true
  if (clip.animStatics) {
    const statics: NonNullable<TemplateClip['animStatics']> = {}
    for (const [property, value] of Object.entries(clip.animStatics)) {
      if (!isTemplateAnimStaticProperty(property) || typeof value !== 'number') continue
      statics[property] = value
    }
    if (Object.keys(statics).length > 0) visuals.animStatics = statics
  }
  if (clip.keyframes) {
    const map: KeyframeMap = {}
    for (const [property, value] of Object.entries(clip.keyframes)) {
      if (!isTemplateKeyframeProperty(property) || !value) continue
      map[property] = structuredClone(value)
    }
    if (Object.keys(map).length > 0) visuals.keyframes = map
  }
  return visuals
}

/**
 * Captures the current sequence as a template, keeping text and shape clips and
 * dropping every media/audio/compound clip. Track group membership is never
 * stored. A sequence with nothing to capture refuses rather than saving an
 * empty template.
 */
export function templateFromSequence(
  sequence: Sequence,
  meta: { name: string; description?: string; id?: string },
): ProjectTemplate {
  const tracks: TemplateTrack[] = []
  for (const track of sequence.tracks) {
    if (track.kind === 'audio') continue
    const clips: TemplateClip[] = []
    for (const clip of track.clips) {
      if (clip.text !== undefined && clip.style) {
        clips.push({
          id: clip.id,
          start: clip.start,
          duration: clip.duration,
          ...(clip.linkId ? { linkId: clip.linkId } : {}),
          ...templateClipVisuals(clip),
          text: clip.text,
          style: structuredClone(clip.style),
        })
      } else if (clip.shape) {
        clips.push({
          id: clip.id,
          start: clip.start,
          duration: clip.duration,
          ...(clip.linkId ? { linkId: clip.linkId } : {}),
          ...templateClipVisuals(clip),
          shape: structuredClone(clip.shape),
        })
      }
    }
    if (clips.length === 0) continue
    tracks.push({
      id: track.id,
      kind: track.kind === 'text' ? 'text' : 'video',
      name: track.name,
      clips,
    })
  }
  if (tracks.length === 0) {
    throw new TemplateError('This sequence has no text or shape clips to save')
  }
  return parseTemplate({
    id: meta.id ?? uid('tpl'),
    name: meta.name,
    description: meta.description ?? '',
    version: TEMPLATE_VERSION,
    sequence: {
      id: sequence.id,
      name: sequence.name,
      tracks,
    },
  })
}

const TITLE_CARD: ProjectTemplate = {
  id: 'tpl_builtin_title_card',
  name: 'Title card',
  description: 'A centered title over a solid backdrop shape.',
  version: TEMPLATE_VERSION,
  sequence: {
    id: 'seq_tpl_title_card',
    name: 'Title card',
    tracks: [
      {
        id: 'track_tpl_title_text',
        kind: 'text',
        name: 'Title',
        clips: [
          {
            id: 'clip_tpl_title_text',
            start: 0,
            duration: 5,
            text: 'Your title',
            style: {
              ...createDefaultTextStyle(),
              fontSize: 96,
              x: 0.5,
              y: 0.42,
            },
          },
        ],
      },
      {
        id: 'track_tpl_title_backdrop',
        kind: 'video',
        name: 'Backdrop',
        clips: [
          {
            id: 'clip_tpl_title_backdrop',
            start: 0,
            duration: 5,
            shape: { kind: 'rectangle', fill: '#0f172a', radius: 0 },
          },
        ],
      },
    ],
  },
}

const LOWER_THIRD: ProjectTemplate = {
  id: 'tpl_builtin_lower_third',
  name: 'Lower third',
  description: 'A left-aligned name line near the bottom of the frame.',
  version: TEMPLATE_VERSION,
  sequence: {
    id: 'seq_tpl_lower_third',
    name: 'Lower third',
    tracks: [
      {
        id: 'track_tpl_lower_third_text',
        kind: 'text',
        name: 'Lower third',
        clips: [
          {
            id: 'clip_tpl_lower_third_text',
            start: 0,
            duration: 4,
            text: 'Name goes here',
            style: {
              ...createDefaultTextStyle(),
              fontSize: 56,
              align: 'left',
              x: 0.08,
              y: 0.78,
            },
          },
        ],
      },
    ],
  },
}

const CREDITS: ProjectTemplate = {
  id: 'tpl_builtin_credits',
  name: 'Rolling credits',
  description: 'Two centered credit lines, one after the other.',
  version: TEMPLATE_VERSION,
  sequence: {
    id: 'seq_tpl_credits',
    name: 'Credits',
    tracks: [
      {
        id: 'track_tpl_credits_text',
        kind: 'text',
        name: 'Credits',
        clips: [
          {
            id: 'clip_tpl_credits_one',
            start: 0,
            duration: 3,
            text: 'Directed by',
            style: { ...createDefaultTextStyle(), fontSize: 48, y: 0.46 },
          },
          {
            id: 'clip_tpl_credits_two',
            start: 3,
            duration: 3,
            text: 'Your name',
            style: { ...createDefaultTextStyle(), fontSize: 64, y: 0.54 },
          },
        ],
      },
    ],
  },
}

/** The built-in template set, fresh per call so callers cannot mutate the set. */
export function createBuiltinTemplates(): ProjectTemplate[] {
  return [TITLE_CARD, LOWER_THIRD, CREDITS].map((template) => structuredClone(template))
}

import {
  activeTracks,
  clampSourceTime,
  docDuration,
  findMedia,
  findSequence,
  mediaPlayable,
  sequenceDuration,
  sourceTimeAt,
} from '../factories'
import { blendPartnerTime, blendWeight } from '../frame-blend'
import { denoiseFilters } from './denoise'
import { EQ_DB_MAX, EQ_DB_MIN, KEYFRAME_TIMEOUT_MS, SPEED_MAX, SPEED_MIN } from '../constants'
import { crossfadeFactor } from '../transition'
import { hasLinkedAudioTwin, linkGroupChangesRate } from '../links'
import { animatedValue, constantTimeScaleRate, hasTimeScaleRamp } from '../keyframes'
import { ClipMediaPool } from '../media/elements'
import { clampedClipLocalTime } from '../markers'
import { clamp, frameToTime } from '../time'
import { audibleTrackIds } from '../tracks'
import type { Clip, Doc, MediaAsset, Track } from '../types'
import { drawFrame, type FrameBlendSource } from './compositor'
import type { ScrubFrameSource } from './scrub-source'

/**
 * PlaybackCore: the preview playback engine.
 *
 * - Master clock: the AudioContext clock when audio is available (sample-accurate,
 *   drift-free), otherwise `performance.now()`.
 * - Compositing: draws every frame into the provided canvas via `drawFrame`.
 * - Audio: one HTMLMediaElement per clip (see ClipMediaPool), routed through a
 *   per-clip GainNode → master GainNode → destination (+ optional MediaStream
 *   capture destination). Per-frame gain computes clip gain × mute ×
 *   track mute × crossfade alpha.
 * - Drift correction: element position is compared with the expected source
 *   time every frame; a gap wider than DRIFT_THRESHOLD (0.4 s) triggers a
 *   resync. Reversed and ramped clips are stepped instead (see syncMedia).
 * - Sub-frame-rate blending: a clip reading below the source frame rate parks a
 *   SECOND, muted element on the partner read (frame-blend.ts) and the
 *   compositor blends the pair, exactly as the exporter blends it.
 */

export interface PlaybackCoreOptions {
  canvas: HTMLCanvasElement
  getDoc: () => Doc
  /**
   * The effective source URL for an asset: the proxy URL when proxies are on
   * and ready, else `asset.url`. Omitted by tests, which always read the
   * original.
   */
  resolveMediaUrl?: (asset: MediaAsset) => string
  /**
   * The active compound sequence path (0.8.1). The preview renders and syncs
   * the open sequence's tracks; omitted by tests, which start from the project
   * root.
   */
  getActiveSequencePath?: () => readonly string[]
  /** Project-replacement signal, bumped only by `replaceDoc`. */
  getProjectEpoch?: () => number
  /** Verified video keyframe lookup for decode recovery. */
  nextKeyframe?: (url: string, sourceTime: number) => Promise<number | undefined>
  /** Persistent decode-recovery status for the preview overlay. */
  onMediaError?: (info: MediaErrorInfo | null, clipId?: string) => void
  /** Neutral scrub-recovery notice, separate from the damaged-media notice. */
  onPreviewRecovering?: (recovering: boolean) => void
  /**
   * Builds the WebCodecs scrub frame source (0.18.0). Omitted by tests and by
   * browsers without WebCodecs; the `<video>` path then runs unchanged.
   */
  createScrubSource?: () => ScrubFrameSource | null
  onFrame?: (t: number) => void
  onEnd?: () => void
  onPlayingChange?: (playing: boolean) => void
}

export interface MediaErrorInfo {
  clipId: string
  code: number
  time: number
  skippedTo?: number
  terminal: boolean
}

interface RecoveryState {
  attempts: number
  failedFrom: number
  failedTo: number
  terminal: boolean
  /** True once a skip was committed; only those clear as playback passes. */
  committed: boolean
}

/**
 * One clip reachable from the active sequence, with the absolute timeline time
 * its sequence's local 0 sits at and the enclosing compound containers. Used to
 * sync every nested clip's element and to multiply each container's gain once.
 */
interface NestedClip {
  clip: Clip
  track: Track
  /** Absolute time of this clip's sequence local 0. */
  offset: number
  /** Enclosing containers from outermost to innermost, with their track and sequence offset. */
  ancestors: { clip: Clip; track: Track; offset: number; audibleTracks: Set<string> }[]
  /** Track ids audible in THIS clip's sequence (solo + mute, tracks.ts). */
  audibleTracks: Set<string>
}

/** Depth-first walk of a track list, descending into every compound clip. */
function walkClips(
  doc: Doc,
  tracks: readonly Track[],
  offset: number,
  ancestors: { clip: Clip; track: Track; offset: number; audibleTracks: Set<string> }[],
  out: NestedClip[],
): void {
  // One audibility set per sequence: solo and mute are evaluated in the
  // sequence that owns the tracks, never against a parent's or child's set.
  const audibleTracks = audibleTrackIds(tracks)
  for (const track of tracks) {
    for (const clip of track.clips) {
      out.push({ clip, track, offset, ancestors, audibleTracks })
      if (clip.sequenceId) {
        const sequence = findSequence(doc, clip.sequenceId)
        if (sequence) {
          walkClips(
            doc,
            sequence.tracks,
            offset + clip.start,
            [...ancestors, { clip, track, offset, audibleTracks }],
            out,
          )
        }
      }
    }
  }
}

/** True when `t` is inside the clip's window AND every ancestor container's. */
function withinAncestorWindows(
  t: number,
  start: number,
  end: number,
  ancestors: { clip: Clip; offset: number }[],
): boolean {
  if (t < start || t >= end) return false
  for (const ancestor of ancestors) {
    const aStart = ancestor.offset + ancestor.clip.start
    const aEnd = aStart + ancestor.clip.duration
    if (t < aStart || t >= aEnd) return false
  }
  return true
}

/**
 * Drift worth correcting. This must exceed the worst-case seek latency: a seek
 * that lands L seconds after it was issued leaves the element exactly L behind
 * the clock (the clock kept running while the decoder worked). With a threshold
 * below L, every landed seek looks like fresh drift and re-seeks forever: the
 * element never catches up and the preview stays black. 0.4 s covers unbuffered
 * seeks; ordinary playback drift (element clock vs audio clock) stays far below
 * it for a whole session.
 */
const DRIFT_THRESHOLD = 0.4
/**
 * How far a paused element may sit from the playhead before Play re-seeks it.
 * Resuming at the parked position must not start a decode that blanks the
 * monitor; a paused scrub that left a video element behind still seeks.
 */
const START_SEEK_THRESHOLD = 0.15
/**
 * Bound on the pre-play media warmup. A slow source must not block Play
 * forever; the normal sync path takes over after this.
 */
const PRIME_TIMEOUT_MS = 1_200
/**
 * A seek is not instantaneous: Chrome must demux + decode before the new frame
 * is present (the readback position updates immediately, the data does not).
 * A scrub that lands >1 s away takes hundreds of ms; until it lands the element
 * shows no drawable frame. While one is pending, every further seek restarts
 * the wait, so correction decisions made during that window are based on a
 * position the element has not reached yet.
 */
const SEEK_QUIET_MS = 350
/**
 * How far behind its read position a frame may sit and still be the frame the
 * element is showing. The presented frame's timestamp is at most one source
 * frame before the read, so a window this wide admits every sane source rate
 * (0.1 s covers down to 10 fps) while rejecting a frame left over from a seek
 * the element has not finished: blending against that stale frame would mix in
 * a distant part of the clip.
 */
const PRESENTED_STALE_WINDOW = 0.1
/**
 * Slack above a read position: a presented frame may sit marginally ahead of the
 * position reported for it, but a frame well ahead belongs to a position the
 * clip has already moved away from, which is not the frame to blend.
 */
const PRESENTED_LEAD_EPS = 1e-3
/**
 * How far a parked blend partner's target has to move before the paused path
 * re-seeks it. Much tighter than the primary element's 0.02 s dead zone in
 * `drawStill`: the partner read sits only a FRACTION of a source frame ahead of
 * the clip's own read (a quarter of one at 0.25x, a half at 0.5x), so with the
 * primary's threshold the partner would often never leave the frame the primary
 * shows, the pair would collapse onto one sample, and a scrubbed slow clip would
 * keep the very stepping this feature removes.
 */
const PARTNER_SEEK_EPS = 0.002
/**
 * How far INSIDE a frame a parked element is seeked, past the read it was asked
 * for (0.7.0).
 *
 * A read that lands exactly on a source frame's start timestamp is resolved
 * differently by the two decoders: the exporter's sample lookup keeps the last
 * sample with `timestamp <= t`, so the read shows the frame that STARTS there,
 * while an element seek to that same value can present the frame BEFORE it (the
 * position sits within float rounding of the boundary). Both the painted frame
 * and the blend weight depend on it: a partner left on the earlier frame
 * collapses the pair onto one sample (a blend the file has and the monitor does
 * not), and a primary left there matches the file against the wrong frame (a
 * blend the file does not have). Seeking a hair past the read removes the
 * ambiguity without changing which frame any read lands in: the offset is far
 * below every threshold the parked paths compare against (the tightest is half
 * of one output frame's source read, 5e-4 s at the slowest supported read).
 */
const SEEK_FRAME_NUDGE = 1e-4

/** How much source time the fallback skip crosses when no keyframe is used. */
const DECODE_SKIP_SOURCE_SECONDS = 6
/** Upper bound for a reload to become readable again. */
const RELOAD_TIMEOUT_MS = 5_000
/** Recovery attempts before the record becomes terminal. */
const MAX_RECOVERY_ATTEMPTS = 3
/** Scrub fallback attempts at the SAME timestamp before the neutral notice. */
export const SCRUB_FALLBACK_ATTEMPTS = 3
/** How long one scrub fallback attempt may take before it counts as failed. */
export const SCRUB_FALLBACK_TIMEOUT_MS = 250

/**
 * The position an element is parked at for a read: the read itself, a hair
 * inside the frame it names (see SEEK_FRAME_NUDGE). Every park goes through
 * this, because the played, stepped and still paths all have to agree on which
 * frame a read lands in; the dead zones that decide whether a park is needed
 * keep comparing the RAW read, so the offset never triggers a re-seek.
 */
function parkedTarget(read: number): number {
  return read + SEEK_FRAME_NUDGE
}

/**
 * The clip's effective CONSTANT rate, for elements that can follow one: the
 * static speed when no curve exists, the curve's flat value when it has one
 * (the curve overrides the static field). A real ramp returns undefined: no
 * constant rate can follow it, which is why ramped clips are stepped.
 */
function constantRateOf(clip: Clip): number {
  return constantTimeScaleRate(clip) ?? clamp(clip.speed ?? 1, SPEED_MIN, SPEED_MAX)
}

/** Applies a clip's clamped speed to its element (reversed clips are stepped). */
function applyPlaybackRate(el: HTMLMediaElement, clip: Clip): void {
  const rate = constantRateOf(clip)
  if (el.playbackRate !== rate) el.playbackRate = rate
}

/**
 * The shaping settings a clip's audio chain bakes in. EQ bands, compressor,
 * denoise and pan are node parameters set at build time, so a change to any of
 * them means the chain must be rebuilt for the edit to be audible.
 */
function shapingSignature(clip: Clip): string {
  const eq = clip.eq ? `${clip.eq.low}|${clip.eq.mid}|${clip.eq.high}` : ''
  return `${eq}/${clip.compressor ? 'c' : ''}/${clip.denoise ? 'n' : ''}/${clip.pan ?? 0}`
}

export class PlaybackCore {
  private ctx2d: CanvasRenderingContext2D | null
  private pool: ClipMediaPool
  private imageCache = new Map<string, HTMLImageElement>()

  private audio: AudioContext | null = null
  private masterGain: GainNode | null = null
  private streamDest: MediaStreamAudioDestinationNode | null = null
  /**
   * Per-clip gain node plus the shaping signature it was built for. EQ,
   * compressor and pan bake their settings into the node chain, so an edit
   * after the chain exists rebuilds it (see `applyGain`). `el` records the
   * element the chain was built from: a relink swaps the element under the
   * same clip id and signature, and the chain must follow it.
   */
  private clipGains = new Map<
    string,
    { gain: GainNode; sig: string; nodes: AudioNode[]; el: HTMLMediaElement }
  >()
  private masterVolume = 1
  /** EQ band frequencies for the three-band biquad stack. */
  private static readonly EQ_LO = 200
  private static readonly EQ_MID = 1000
  private static readonly EQ_HIGH = 4000

  private raf = 0
  private playingState = false
  private time = 0
  private anchorDoc = 0
  private anchorAudio = 0
  private anchorPerf = 0
  /**
   * Elements with a seek in flight, with the wall-clock time it started and
   * the `seeked` listener that clears it. While an element is here (or reports
   * `seeking`), it is left strictly alone: interrupting a pending seek
   * restarts the decode and can starve the element forever (observed: scrub
   * during playback kept the frame black for the rest of the timeline because
   * each rAF re-seeked a seek that never completed).
   */
  private seekingEls = new Map<HTMLMediaElement, { started: number; onSeeked: () => void }>()
  /**
   * The media timestamp of the frame each element last PRESENTED (0.7.0), from
   * requestVideoFrameCallback. Sub-frame-rate blending needs the timestamps of
   * the frames the decoder actually delivered, not the element's continuous read
   * position: the read of a slow clip sits between two source frames, and only
   * the pair's own timestamps give the weight the export computes. Browsers
   * without requestVideoFrameCallback never report one, and the preview then
   * keeps the stepped draw it always had.
   */
  private presentedTimes = new WeakMap<HTMLMediaElement, number>()
  /** Elements already registered with requestVideoFrameCallback. */
  private watchingFrames = new WeakSet<HTMLMediaElement>()

  /** Elements latched after a terminal decode error, one per failed range. */
  private terminalElements = new WeakSet<HTMLMediaElement>()
  /** Blend partners that errored; blending falls back to a single frame. */
  private failedPartners = new WeakSet<HTMLMediaElement>()
  private recoveryRecords = new Map<string, RecoveryState>()
  /** The range of the last notice shown for a clip, kept after the record clears. */
  private noticeRanges = new Map<string, { from: number; to: number }>()
  private recoveryInFlight: string | null = null
  /** The project epoch that owns the in-flight recovery. */
  private recoveryProjectEpoch: number | null = null
  /** The element and user-action epoch that own the in-flight recovery. */
  private recoveryElement: HTMLMediaElement | null = null
  private recoveryEpochOwner: number | null = null
  /** True when the last user action was a pause, which discards deferred work. */
  private recoveryCancelDiscard = false
  private deferredErrors = new Map<string, HTMLMediaElement>()
  private recoveryEpoch = 0
  private playToken = 0
  private refreshing = false
  private lastProjectEpoch = 0
  /** WebCodecs scrub frame source (0.18.0); null keeps the `<video>` path. */
  private scrub: ScrubFrameSource | null
  private scrubUnsubscribe: (() => void) | null = null
  /** Per-clip generation token; bumps when the effective URL changes. */
  private scrubGenerations = new Map<string, { url: string; token: number }>()
  /** Effective URL last sent for each asset, for release on relink/removal. */
  private scrubAssets = new Map<string, string>()
  /** Scrub fallback attempts at the same source time, per clip. */
  private scrubFallback = new Map<string, { attempts: number; sourceTime: number }>()
  /** Pending neutral-notice retries, one per clip (0.18.0). */
  private scrubRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** True while the current `drawStill` came from a scrub seek. */
  private scrubInProgress = false
  /**
   * Elements last drawn on the `<video>` scrub-fallback path, with the source
   * time they were parked on. The ownership outlives `refresh`: an error event
   * arrives asynchronously, after `scrubInProgress` is already false.
   */
  private scrubFallbackElements = new WeakMap<HTMLMediaElement, number>()
  private scrubRecovering = false

  constructor(private opts: PlaybackCoreOptions) {
    opts.canvas.width = opts.getDoc().project.width
    opts.canvas.height = opts.getDoc().project.height
    this.ctx2d = opts.canvas.getContext('2d')
    this.pool = new ClipMediaPool((clipId, el) => this.handleElementError(clipId, el))
    this.lastProjectEpoch = opts.getProjectEpoch?.() ?? 0
    this.scrub = opts.createScrubSource?.() ?? null
    if (this.scrub) {
      this.scrubUnsubscribe = this.scrub.onFallback(() => {
        // The asset's WebCodecs path failed: redraw through the `<video>`
        // fallback. `hasSink` now returns false for that URL.
        this.setScrubRecovering(false)
        if (!this.playingState) this.refresh(this.time)
      })
    }
  }

  /** Audio output stream (a capture destination; export mixes offline instead). */
  get audioStream(): MediaStream | null {
    return this.streamDest?.stream ?? null
  }

  get currentTime(): number {
    return this.time
  }

  get isPlaying(): boolean {
    return this.playingState
  }

  /** Creates + resumes the AudioContext. Call from a user gesture when possible. */
  async prepare(): Promise<void> {
    this.ensureAudio()
    if (this.audio && this.audio.state !== 'running') {
      try {
        await this.audio.resume()
      } catch {
        // autoplay policy — will retry on play()
      }
    }
  }

  async play(from?: number): Promise<void> {
    this.recoveryEpoch++
    this.playToken++
    this.scrubInProgress = false
    this.setScrubRecovering(false)
    if (this.recoveryInFlight !== null) this.recoveryCancelDiscard = false
    if (from !== undefined) this.clearRecoveryForSeek(from)
    return this.startPlayback(from, this.playToken, this.recoveryEpoch)
  }

  /**
   * The shared start path. A public play and a recovery both pass the epoch
   * they captured, so a user pause or seek during `prepare()` or the media
   * warmup wins.
   */
  private async startPlayback(
    from: number | undefined,
    token: number,
    expectedRecoveryEpoch?: number,
  ): Promise<void> {
    const doc = this.opts.getDoc()
    const duration = this.durationOf(doc)
    if (duration <= 0) return

    if (from !== undefined) this.time = from
    if (this.time >= duration - 1e-4) this.time = 0 // restart at the end

    await this.prepare()
    if (token !== this.playToken) return
    if (expectedRecoveryEpoch !== undefined && expectedRecoveryEpoch !== this.recoveryEpoch) return

    // Warm the active elements before the clock starts. The canvas keeps the
    // paused frame, so a slow load or a seek left behind by a paused scrub
    // cannot open playback on black, and the linked audio twin starts with
    // the picture instead of running ahead during the decode.
    await this.primePlayback(this.time)
    if (token !== this.playToken) return
    if (expectedRecoveryEpoch !== undefined && expectedRecoveryEpoch !== this.recoveryEpoch) return

    this.anchorDoc = this.time
    this.anchorAudio = this.audio ? this.audio.currentTime : 0
    this.anchorPerf = performance.now()
    this.playingState = true
    this.opts.onPlayingChange?.(true)
    this.tick()
  }

  /**
   * Positions and warms the elements that are active at `t` (0.18.0). The
   * paused preview uses WebCodecs and deliberately does not seek the `<video>`
   * element, so play must not start the clock until the element has caught up
   * or the first frames are black. An already-running seek is awaited first,
   * then corrected if it landed away from the playhead. Waiting here keeps the
   * paused frame on the canvas and keeps the A/V pair on the same start
   * position.
   */
  private async primePlayback(t: number): Promise<void> {
    if (!this.scrub) return
    const doc = this.opts.getDoc()
    const waits: Promise<void>[] = []
    for (const { clip, track, offset, ancestors } of this.activeClipList(doc)) {
      if (track.kind === 'text') continue
      if (clip.reverse || hasTimeScaleRamp(clip)) continue
      const asset = findMedia(doc, clip.mediaId)
      if (!mediaPlayable(asset)) continue
      const start = offset + clip.start
      if (!withinAncestorWindows(t, start, start + clip.duration, ancestors)) continue
      const el = this.pool.get(clip, asset, this.mediaUrl(asset))
      if (el.error) continue
      const expected = clampSourceTime(this.sourceTime(clip, t, offset), asset)
      el.playbackRate = constantRateOf(clip)
      waits.push(this.primeElement(el, expected))
    }
    await Promise.all(waits)
  }

  /**
   * Waits out a seek already in flight, then corrects the element if the
   * landed position is outside the start dead zone, and waits for that seek.
   * Comparing only before the wait would start the clock on the pre-seek
   * position when a paused scrub left an older seek running.
   */
  private async primeElement(el: HTMLMediaElement, expected: number): Promise<void> {
    if (this.trackingSeek(el)) await this.waitForMediaReady(el)
    if (el.error) return
    if (Math.abs(el.currentTime - expected) > START_SEEK_THRESHOLD) {
      this.seekElement(el, expected)
    }
    await this.waitForMediaReady(el)
  }

  /**
   * Resolves when an element can present a frame, or when the warmup bound
   * expires. `error` resolves too: the first sync must route it through the
   * normal recovery path instead of hanging Play.
   */
  private waitForMediaReady(el: HTMLMediaElement): Promise<void> {
    if (!el.seeking && el.readyState >= 2) return Promise.resolve()
    return new Promise((resolve) => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (): void => {
        if (done) return
        done = true
        el.removeEventListener('loadeddata', finish)
        el.removeEventListener('canplay', finish)
        el.removeEventListener('seeked', finish)
        el.removeEventListener('error', finish)
        if (timer !== undefined) clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(finish, PRIME_TIMEOUT_MS)
      el.addEventListener('loadeddata', finish)
      el.addEventListener('canplay', finish)
      el.addEventListener('seeked', finish)
      el.addEventListener('error', finish)
      // A synchronous seek (or a source that was already ready) can settle
      // between the first check and the listeners above.
      if (el.error || (!el.seeking && el.readyState >= 2)) finish()
    })
  }

  pause(): void {
    this.recoveryEpoch++
    this.playToken++
    if (this.recoveryInFlight !== null) this.recoveryCancelDiscard = true
    if (!this.playingState) return
    this.playingState = false
    cancelAnimationFrame(this.raf)
    this.pool.pauseAll()
    this.opts.onPlayingChange?.(false)
  }

  toggle(): void {
    if (this.playingState) this.pause()
    else void this.play()
  }

  seek(t: number): void {
    this.clearRecoveryForSeek(t)
    this.recoveryEpoch++
    if (this.recoveryInFlight !== null) this.recoveryCancelDiscard = false
    this.scrubInProgress = true
    try {
      this.applySeek(t)
    } finally {
      this.scrubInProgress = false
    }
  }

  /** Paused repaint for doc edits: no epoch bump, no recovery cancellation. */
  refresh(t: number, scrub = false): void {
    this.scrubInProgress = scrub
    this.refreshing = true
    try {
      this.applySeek(t)
    } finally {
      this.refreshing = false
    }
  }

  /** `forceSeek` makes a paused commit seek even inside the still dead zone. */
  private applySeek(t: number, forceSeek = false): void {
    const duration = this.durationOf(this.opts.getDoc())
    this.time = clamp(t, 0, duration)
    if (this.playingState) {
      this.anchorDoc = this.time
      this.anchorAudio = this.audio ? this.audio.currentTime : 0
      this.anchorPerf = performance.now()
      this.syncMedia(this.time, true)
    } else {
      this.drawStill(this.time, forceSeek)
    }
    this.opts.onFrame?.(this.time)
  }

  stepFrames(n: number): void {
    const { fps } = this.opts.getDoc().project
    const target = Math.max(0, Math.round(this.time * fps) + n) / fps
    this.pause()
    this.seek(target)
  }

  setMasterVolume(v: number): void {
    this.masterVolume = clamp(v, 0, 1)
    if (this.masterGain && this.audio) {
      this.masterGain.gain.setTargetAtTime(this.masterVolume, this.audio.currentTime, 0.02)
    }
  }

  /** Syncs canvas size with (possibly changed) project settings. */
  syncResolution(): void {
    const { width, height } = this.opts.getDoc().project
    if (this.opts.canvas.width !== width) this.opts.canvas.width = width
    if (this.opts.canvas.height !== height) this.opts.canvas.height = height
  }

  /**
   * The source time a clip should show at timeline time `t` (speed-aware).
   * `offset` is the absolute time the clip's sequence local 0 sits at, so a
   * nested clip reads its own local clock.
   */
  private sourceTime(clip: Clip, t: number, offset = 0): number {
    return sourceTimeAt(clip, t - offset - clip.start)
  }

  /** The active sequence's track list (root when no path is supplied). */
  private activeTracks(doc: Doc): readonly Track[] {
    return activeTracks(doc, this.opts.getActiveSequencePath?.() ?? [])
  }

  /**
   * The transport length: the root timeline at the project root, otherwise the
   * open compound sequence's local length (its own ruler).
   */
  private durationOf(doc: Doc): number {
    const path = this.opts.getActiveSequencePath?.() ?? []
    if (path.length === 0) return docDuration(doc)
    const sequence = findSequence(doc, path[path.length - 1])
    return sequence ? sequenceDuration(sequence) : docDuration(doc)
  }

  /** Every clip reachable from the active sequence, nested compounds included. */
  private activeClipList(doc: Doc): NestedClip[] {
    const out: NestedClip[] = []
    walkClips(doc, this.activeTracks(doc), 0, [], out)
    return out
  }

  /** True when the clip is inside its own window and every ancestor window. */
  private isClipActiveAt(clipId: string, t: number): boolean {
    const doc = this.opts.getDoc()
    const frame = frameToTime(1, doc.project.fps)
    for (const entry of this.activeClipList(doc)) {
      if (entry.clip.id !== clipId) continue
      const start = entry.offset + entry.clip.start
      const end = start + entry.clip.duration
      return withinAncestorWindows(t, start - frame, end + frame, entry.ancestors)
    }
    return false
  }

  /** True when the in-flight recovery belongs to a replaced project. */
  private recoveryIsStale(): boolean {
    return (
      this.recoveryInFlight !== null &&
      this.recoveryProjectEpoch !== (this.opts.getProjectEpoch?.() ?? 0)
    )
  }

  /** True while a terminal record's clip is on screen at `t`. */
  private activeTerminalAt(t: number): boolean {
    for (const [clipId, record] of this.recoveryRecords) {
      if (record.terminal && this.isClipActiveAt(clipId, t)) return true
    }
    return false
  }

  /** Clears recovery state when the whole project is replaced, never on an edit. */
  private checkProjectEpoch(): void {
    const epoch = this.opts.getProjectEpoch?.() ?? 0
    if (epoch === this.lastProjectEpoch) return
    this.lastProjectEpoch = epoch
    this.terminalElements = new WeakSet()
    this.failedPartners = new WeakSet()
    this.recoveryRecords.clear()
    this.noticeRanges.clear()
    this.deferredErrors.clear()
    this.scrub?.reset()
    for (const clipId of [...this.scrubRetryTimers.keys()]) this.clearScrubRetry(clipId)
    this.scrubGenerations.clear()
    this.scrubAssets.clear()
    this.scrubFallback.clear()
    this.setScrubRecovering(false)
    this.opts.onMediaError?.(null)
  }

  /** Releases one clip's element and its audio chain (recovery and cleanup share it). */
  private releaseClip(clipId: string): void {
    const el = this.pool.peek(clipId)
    if (el) {
      if (!el.paused) el.pause()
      this.endSeek(el)
    }
    const entry = this.clipGains.get(clipId)
    if (entry) {
      if (this.audio && entry.el) {
        try {
          // Use the element the chain was built for: the pool entry may
          // already be gone, but the old source node is still connected.
          this.pool.getSourceNode(entry.el, this.audio).disconnect()
        } catch {
          // already detached, or audio closed mid-teardown
        }
      }
      for (const n of entry.nodes) {
        try {
          n.disconnect()
        } catch {
          // already detached
        }
      }
      try {
        entry.gain.disconnect()
      } catch {
        // already detached
      }
      this.clipGains.delete(clipId)
    }
    this.pool.release(clipId)
  }

  /** Routes a media-element error into recovery, partner latch, or a deferral. */
  private handleElementError(clipId: string, el: HTMLMediaElement): void {
    if (this.terminalElements.has(el)) return
    const primary = this.pool.peek(clipId) === el
    const partner = this.pool.peekNext(clipId) === el
    if (!primary && !partner) return
    if (partner) {
      this.failedPartners.add(el)
      if (!el.paused) el.pause()
      return
    }
    if (!this.isClipActiveAt(clipId, this.time)) return
    // A paused element that was drawn on the scrub-fallback path keeps its
    // neutral retry budget even after `refresh` returns and `scrubInProgress`
    // clears. Without this, the error event that lands a moment later enters
    // damaged-media recovery and reports a source that only failed WebCodecs.
    const fallbackSourceTime = this.scrubFallbackElements.get(el)
    // A recovery that owns this clip keeps the element; the neutral path is
    // only for errors outside damaged-media recovery (the same rule drawStill
    // applies by skipping the clip it is recovering).
    const recoveringThisClip = this.recoveryInFlight === clipId && !this.recoveryIsStale()
    if (
      this.scrub &&
      fallbackSourceTime !== undefined &&
      !this.playingState &&
      !recoveringThisClip
    ) {
      this.noteScrubFallback(clipId, fallbackSourceTime, this.time)
      if (!el.paused) el.pause()
      this.endSeek(el)
      return
    }
    if (this.activeTerminalAt(this.time)) {
      this.deferredErrors.set(clipId, el)
      return
    }
    const code = el.error?.code ?? 0
    if (this.recoveryInFlight !== null) {
      const owns =
        this.recoveryInFlight === clipId &&
        !this.recoveryIsStale() &&
        this.recoveryElement === el &&
        this.recoveryEpochOwner === this.recoveryEpoch
      if (!owns) {
        this.deferredErrors.set(clipId, el)
        return
      }
      if (code === 3) return
      if (code === 4) {
        this.terminalizeRecovery(clipId, el, this.ensureTerminalRecord(clipId), this.time)
      }
      return
    }
    if (code === 4) {
      this.terminalizeRecovery(clipId, el, this.ensureTerminalRecord(clipId), this.time)
      return
    }
    if (code === 3) void this.recoverDecodeError(clipId, el)
  }

  /** Creates the exhausted record a code 4 needs, even mid-recovery. */
  private ensureTerminalRecord(clipId: string): RecoveryState {
    let record = this.recoveryRecords.get(clipId)
    if (!record) {
      record = {
        attempts: MAX_RECOVERY_ATTEMPTS,
        failedFrom: this.time,
        failedTo: this.time,
        terminal: false,
        committed: false,
      }
      this.recoveryRecords.set(clipId, record)
    }
    return record
  }

  /** The one terminal path: stop, latch, seek to failedFrom, report once. */
  private terminalizeRecovery(
    clipId: string,
    el: HTMLMediaElement,
    record: RecoveryState,
    extendTo?: number,
  ): void {
    record.terminal = true
    record.attempts = MAX_RECOVERY_ATTEMPTS
    if (extendTo !== undefined) {
      // failedFrom/failedTo are timeline positions. The transport advances
      // toward larger times even for a reversed clip, so a later error can
      // only extend the range.
      record.failedTo = Math.max(record.failedTo, extendTo)
    }
    const inFlight = this.recoveryInFlight === clipId
    if (inFlight) this.haltForTerminal()
    else this.pause()
    this.terminalElements.add(el)
    const partner = this.pool.peekNext(clipId)
    if (partner) this.endSeek(partner)
    this.pool.releaseNext(clipId)
    this.applySeek(record.failedFrom)
    if (!inFlight) {
      // No recovery finally runs for this terminalization, so drop errors
      // deferred behind the terminal, including ones requeued by the repaint.
      this.deferredErrors.clear()
    }
    this.noticeRanges.set(clipId, { from: record.failedFrom, to: record.failedTo })
    this.opts.onMediaError?.({
      clipId,
      code: el.error?.code ?? 3,
      time: record.failedFrom,
      terminal: true,
    })
  }

  /** Emits one skip notice and remembers its range for clip-owned clearing. */
  private emitSkipNotice(clipId: string, code: number, record: RecoveryState): void {
    this.noticeRanges.set(clipId, { from: record.failedFrom, to: record.failedTo })
    this.opts.onMediaError?.({
      clipId,
      code,
      time: record.failedFrom,
      skippedTo: record.failedTo,
      terminal: false,
    })
  }

  /** Stops playback without bumping the recovery epoch (not a user action). */
  private haltForTerminal(): void {
    this.playToken++
    const wasPlaying = this.playingState
    this.playingState = false
    cancelAnimationFrame(this.raf)
    this.pool.pauseAll()
    if (wasPlaying) this.opts.onPlayingChange?.(false)
  }

  /** Drops a nonterminal record once playback has passed its skipped range. */
  private clearPassedRecovery(t: number): void {
    const frame = frameToTime(1, this.opts.getDoc().project.fps)
    for (const [clipId, record] of [...this.recoveryRecords]) {
      if (record.terminal) continue
      const entry = this.activeClipList(this.opts.getDoc()).find((e) => e.clip.id === clipId)
      if (!entry) {
        this.recoveryRecords.delete(clipId)
        continue
      }
      // A failed reload has no committed skip: its record is the attempt
      // budget for the damaged range and must survive the resume, even though
      // the playhead advances past failedTo. Only a committed skip clears.
      if (!record.committed) continue
      // failedTo is a timeline time, and the transport always advances toward
      // larger sequence times, including for a reversed clip. Do not use the
      // source-time direction here: it would keep a reverse clip's record
      // forever.
      if (t - record.failedTo > frame) {
        // The attempt budget resets, but the notice stays until the user seeks
        // outside its range, dismisses it, or replaces the project.
        this.recoveryRecords.delete(clipId)
      }
    }
  }

  /** Releases any recovery record whose failed range no longer contains `t`. */
  private clearRecoveryForSeek(t: number): void {
    // A seek re-discovers active element errors through syncMedia/drawStill,
    // so an entry deferred at the old position must not be replayed later.
    this.deferredErrors.clear()
    const frame = frameToTime(1, this.opts.getDoc().project.fps)
    for (const [clipId, record] of [...this.recoveryRecords]) {
      const lo = Math.min(record.failedFrom, record.failedTo) - frame
      const hi = Math.max(record.failedFrom, record.failedTo) + frame
      if (t >= lo && t <= hi) continue
      const el = this.pool.peek(clipId)
      if (el) this.terminalElements.delete(el)
      const partner = this.pool.peekNext(clipId)
      if (partner) {
        this.failedPartners.delete(partner)
        this.endSeek(partner)
      }
      this.releaseClip(clipId)
      this.pool.releaseNext(clipId)
      this.recoveryRecords.delete(clipId)
      this.noticeRanges.delete(clipId)
      this.opts.onMediaError?.(null, clipId)
    }
    for (const [clipId, range] of [...this.noticeRanges]) {
      const lo = Math.min(range.from, range.to) - frame
      const hi = Math.max(range.from, range.to) + frame
      if (t >= lo && t <= hi) continue
      this.noticeRanges.delete(clipId)
      this.opts.onMediaError?.(null, clipId)
    }
  }

  /** Bounded keyframe lookup with a backstop timeout for injected fakes. */
  private async lookupKeyframe(url: string, sourceTime: number): Promise<number | undefined> {
    const lookup = this.opts.nextKeyframe?.(url, sourceTime)
    if (!lookup) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), KEYFRAME_TIMEOUT_MS)
    })
    try {
      return await Promise.race([lookup.catch(() => undefined), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Reloads an errored element and waits for metadata/canplay, or a failure. */
  private reloadElement(el: HTMLMediaElement): Promise<'ok' | 'error' | 'timeout'> {
    return new Promise((resolve) => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (result: 'ok' | 'error' | 'timeout'): void => {
        if (done) return
        done = true
        el.removeEventListener('loadedmetadata', onReady)
        el.removeEventListener('canplay', onReady)
        el.removeEventListener('error', onError)
        if (timer !== undefined) clearTimeout(timer)
        resolve(result)
      }
      const onReady = (): void => finish('ok')
      const onError = (): void => finish('error')
      el.addEventListener('loadedmetadata', onReady)
      el.addEventListener('canplay', onReady)
      el.addEventListener('error', onError)
      timer = setTimeout(() => finish('timeout'), RELOAD_TIMEOUT_MS)
      try {
        el.load()
      } catch {
        finish('error')
      }
    })
  }

  /** The bounded source-time nudge used when no verified keyframe is available. */
  private fallbackSource(sourceAtError: number, direction: number, asset: MediaAsset): number {
    return clampSourceTime(sourceAtError + direction * DECODE_SKIP_SOURCE_SECONDS, asset)
  }

  /** True when the target crosses at least one project frame of source time. */
  private sourceAdvances(
    target: number,
    sourceAtError: number,
    direction: number,
    frameSource: number,
    asset: MediaAsset,
  ): boolean {
    const clamped = clampSourceTime(target, asset)
    return (clamped - sourceAtError) * direction >= frameSource - 1e-9
  }

  /** Maps a source target through the shared inverse and into sequence time. */
  private mapSourceToTimeline(clip: Clip, offset: number, source: number): number {
    const local = clampedClipLocalTime(clip, source)
    return clamp(offset + clip.start + local, 0, this.durationOf(this.opts.getDoc()))
  }

  private async recoverDecodeError(clipId: string, el: HTMLMediaElement): Promise<void> {
    if (this.recoveryInFlight !== null) return
    this.recoveryInFlight = clipId
    this.recoveryElement = el
    this.recoveryEpochOwner = this.recoveryEpoch
    this.recoveryCancelDiscard = false
    // The error that starts this recovery must not be replayed from the
    // deferred queue when the recovery's finally drains it.
    this.deferredErrors.delete(clipId)
    let recoveryEpochAtStart = this.recoveryEpoch
    const projectEpoch = this.opts.getProjectEpoch?.() ?? 0
    this.recoveryProjectEpoch = projectEpoch
    try {
      const doc = this.opts.getDoc()
      const entry = this.activeClipList(doc).find((e) => e.clip.id === clipId)
      if (!entry) return
      const asset = findMedia(doc, entry.clip.mediaId)
      if (!mediaPlayable(asset)) return
      const wasPlaying = this.playingState
      const t = this.time
      this.pause()
      const epoch = this.recoveryEpoch
      recoveryEpochAtStart = epoch
      this.recoveryEpochOwner = epoch
      // The recovery's own pause must not look like a user pause.
      this.recoveryCancelDiscard = false
      let record = this.recoveryRecords.get(clipId)
      if (!record) {
        record = {
          attempts: 0,
          failedFrom: t,
          failedTo: t,
          terminal: false,
          committed: false,
        }
        this.recoveryRecords.set(clipId, record)
      }
      if (record.attempts >= MAX_RECOVERY_ATTEMPTS) {
        this.terminalizeRecovery(clipId, el, record)
        return
      }

      const code = el.error?.code ?? 3
      const frame = frameToTime(1, doc.project.fps)
      const sourceAtErrorAtLookup = clampSourceTime(
        this.sourceTime(entry.clip, t, entry.offset),
        asset,
      )
      const sourceAtNextFrame = this.sourceTime(entry.clip, t + frame, entry.offset)
      const direction = sourceAtNextFrame >= sourceAtErrorAtLookup ? 1 : -1
      const canUseKeyframe =
        !entry.clip.reverse && !hasTimeScaleRamp(entry.clip) && !(el instanceof HTMLAudioElement)

      const stillCurrent = (): 'ok' | 'cancelled' | 'stale' | 'terminal' => {
        if (this.recoveryEpoch !== epoch || (this.opts.getProjectEpoch?.() ?? 0) !== projectEpoch) {
          return 'cancelled'
        }
        if (this.pool.peek(clipId) !== el) return 'stale'
        if (!this.isClipActiveAt(clipId, this.time)) return 'stale'
        if (record!.terminal || this.terminalElements.has(el)) return 'terminal'
        return 'ok'
      }
      const currentEntry = (): NestedClip | undefined =>
        this.activeClipList(this.opts.getDoc()).find((e) => e.clip.id === clipId)
      const bail = (state: 'ok' | 'cancelled' | 'stale' | 'terminal'): boolean => state !== 'ok'

      let sourceTarget: number
      let keyframeTarget = false
      if (canUseKeyframe) {
        const keyframe = await this.lookupKeyframe(el.currentSrc || el.src, sourceAtErrorAtLookup)
        if (bail(stillCurrent())) return
        const now = currentEntry()
        if (!now) return
        const current = clampSourceTime(this.sourceTime(now.clip, this.time, now.offset), asset)
        const next = this.sourceTime(now.clip, this.time + frame, now.offset)
        const dirNow = next >= current ? 1 : -1
        const frameSource = Math.abs(next - current)
        // A verified keyframe only has to move at all: when the error lands on
        // the keyframe boundary, the keyframe plus epsilon is the recovery
        // point even though it is less than one frame ahead.
        const keyframeValid =
          keyframe !== undefined &&
          !now.clip.reverse &&
          !hasTimeScaleRamp(now.clip) &&
          Math.abs(current - sourceAtErrorAtLookup) <= frameSource &&
          this.sourceAdvances(keyframe, current, dirNow, 0, asset)
        keyframeTarget = keyframeValid
        sourceTarget = keyframeValid ? keyframe : this.fallbackSource(current, dirNow, asset)
      } else {
        sourceTarget = this.fallbackSource(sourceAtErrorAtLookup, direction, asset)
      }

      let now = currentEntry()
      if (!now) return
      let current = clampSourceTime(this.sourceTime(now.clip, this.time, now.offset), asset)
      let next = this.sourceTime(now.clip, this.time + frame, now.offset)
      let dirNow = next >= current ? 1 : -1
      let frameSource = Math.abs(next - current)
      if (
        !this.sourceAdvances(sourceTarget, current, dirNow, keyframeTarget ? 0 : frameSource, asset)
      ) {
        sourceTarget = this.fallbackSource(current, dirNow, asset)
        keyframeTarget = false
        if (!this.sourceAdvances(sourceTarget, current, dirNow, frameSource, asset)) {
          this.terminalizeRecovery(clipId, el, record)
          return
        }
      }
      let skipTo = this.mapSourceToTimeline(now.clip, now.offset, sourceTarget)
      if (skipTo < this.time + (keyframeTarget ? 1e-9 : frame - 1e-9)) {
        sourceTarget = this.fallbackSource(current, dirNow, asset)
        keyframeTarget = false
        if (!this.sourceAdvances(sourceTarget, current, dirNow, frameSource, asset)) {
          this.terminalizeRecovery(clipId, el, record)
          return
        }
        skipTo = this.mapSourceToTimeline(now.clip, now.offset, sourceTarget)
        if (skipTo < this.time + frame - 1e-9) {
          this.terminalizeRecovery(clipId, el, record)
          return
        }
      }

      const reload = await this.reloadElement(el)
      if (bail(stillCurrent())) return
      if (record.terminal) return
      if (reload !== 'ok') {
        record.attempts += 1
        this.releaseClip(clipId)
        this.pool.releaseNext(clipId)
        // The next sync creates a fresh element. Resume it now instead of
        // leaving playback silently stopped after a transient reload failure.
        // At the sequence end, stay paused: startPlayback would restart at 0.
        if (wasPlaying && this.time < this.durationOf(this.opts.getDoc()) - 1e-4) {
          try {
            await this.startPlayback(undefined, this.playToken, epoch)
          } catch {
            // A rejected play is not a second failure; the next user play retries.
          }
          if (
            this.recoveryEpoch !== epoch ||
            (this.opts.getProjectEpoch?.() ?? 0) !== projectEpoch
          ) {
            return
          }
        }
        return
      }

      now = currentEntry()
      if (!now) return
      current = clampSourceTime(this.sourceTime(now.clip, this.time, now.offset), asset)
      next = this.sourceTime(now.clip, this.time + frame, now.offset)
      dirNow = next >= current ? 1 : -1
      frameSource = Math.abs(next - current)
      if (
        !this.sourceAdvances(sourceTarget, current, dirNow, keyframeTarget ? 0 : frameSource, asset)
      ) {
        sourceTarget = this.fallbackSource(current, dirNow, asset)
        keyframeTarget = false
        if (!this.sourceAdvances(sourceTarget, current, dirNow, frameSource, asset)) {
          this.terminalizeRecovery(clipId, el, record)
          return
        }
      }
      skipTo = this.mapSourceToTimeline(now.clip, now.offset, sourceTarget)
      if (skipTo < this.time + (keyframeTarget ? 1e-9 : frame - 1e-9)) {
        sourceTarget = this.fallbackSource(current, dirNow, asset)
        keyframeTarget = false
        if (!this.sourceAdvances(sourceTarget, current, dirNow, frameSource, asset)) {
          this.terminalizeRecovery(clipId, el, record)
          return
        }
        skipTo = this.mapSourceToTimeline(now.clip, now.offset, sourceTarget)
        if (skipTo < this.time + frame - 1e-9) {
          this.terminalizeRecovery(clipId, el, record)
          return
        }
      }

      record.attempts += 1
      record.failedTo = skipTo
      record.committed = true
      this.pool.releaseNext(clipId)
      // Force the commit seek: a near-start keyframe can sit inside the still
      // seek dead zone, and a reload that left the element at zero must not be
      // mistaken for the keyframe.
      this.applySeek(skipTo, true)

      // A setter that rejected the seek leaves the element at its old read.
      // Only check a video element when the clip is actually on screen at the
      // target; a target past the clip end parks the playhead there without
      // seeking it, and audio-only elements are not positioned by drawStill.
      if (el instanceof HTMLVideoElement) {
        const targetEntry = currentEntry()
        if (targetEntry) {
          const start = targetEntry.offset + targetEntry.clip.start
          const activeAtTarget = withinAncestorWindows(
            skipTo,
            start,
            start + targetEntry.clip.duration,
            targetEntry.ancestors,
          )
          if (activeAtTarget) {
            const expected = clampSourceTime(
              this.sourceTime(targetEntry.clip, skipTo, targetEntry.offset),
              asset,
            )
            // The commit seek is forced, so the element has to be at the
            // target even when the keyframe is inside the still seek dead zone.
            if (Math.abs(el.currentTime - parkedTarget(expected)) > 1e-3) {
              this.terminalizeRecovery(clipId, el, record)
              return
            }
          }
        }
      }

      const duration = this.durationOf(this.opts.getDoc())
      if (record.terminal) return
      if (skipTo >= duration - 1e-4) {
        this.emitSkipNotice(clipId, code, record)
        return
      }
      if (wasPlaying) {
        try {
          await this.startPlayback(undefined, this.playToken, epoch)
        } catch {
          // A rejected play is not a second failure; the notice below is enough.
        }
        if (this.recoveryEpoch !== epoch || (this.opts.getProjectEpoch?.() ?? 0) !== projectEpoch) {
          return
        }
        if (bail(stillCurrent())) return
        // An ordinary edit can remove or retime the clip while the resume is
        // pending. Refresh skips the recovering element, so the committed
        // source target is stale even though the transport did not move.
        const resumed = currentEntry()
        if (!resumed) return
        const resumedSource = clampSourceTime(
          this.sourceTime(resumed.clip, skipTo, resumed.offset),
          asset,
        )
        if (Math.abs(resumedSource - sourceTarget) > Math.max(frameSource, 1e-6)) {
          // The clip's timeline mapping changed under the committed range, so
          // its failed range and consumed attempts no longer describe this
          // source content. Drop the record instead of reusing it later.
          if (this.recoveryRecords.get(clipId) === record) this.recoveryRecords.delete(clipId)
          return
        }
      }
      this.emitSkipNotice(clipId, code, record)
    } catch (error) {
      // Recovery is best-effort: an unexpected throw must not reject the void
      // call or leave the lock set. Expected lookup, reload, and play failures
      // are handled at their boundaries, so surface anything that reaches
      // here instead of hiding a stopped preview.
      console.error('[playback] decode recovery failed', clipId, error)
    } finally {
      if (this.recoveryInFlight === clipId) {
        this.recoveryInFlight = null
        this.recoveryProjectEpoch = null
        this.recoveryElement = null
        this.recoveryEpochOwner = null
      }
      // A pause drops the queue so the stale recovery cannot start another
      // one. A seek or play still wants the new position's errors handled, so
      // only a pause sets the discard flag. A project replacement alone also
      // drains the new project's errors.
      const userCancelled = this.recoveryEpoch !== recoveryEpochAtStart
      if (userCancelled && this.recoveryCancelDiscard) {
        this.deferredErrors.clear()
      } else if (this.activeTerminalAt(this.time)) {
        this.deferredErrors.clear()
      } else {
        const pending = [...this.deferredErrors]
        this.deferredErrors.clear()
        for (const [id, pendingEl] of pending) {
          if (this.pool.peek(id) === pendingEl && this.isClipActiveAt(id, this.time)) {
            this.handleElementError(id, pendingEl)
          }
        }
      }
      this.recoveryCancelDiscard = false
    }
  }

  dispose(): void {
    this.pause()
    this.pool.dispose()
    this.imageCache.clear()
    for (const el of [...this.seekingEls.keys()]) this.endSeek(el) // detach listeners too
    this.setScrubRecovering(false)
    for (const clipId of [...this.scrubRetryTimers.keys()]) this.clearScrubRetry(clipId)
    this.scrubUnsubscribe?.()
    this.scrubUnsubscribe = null
    this.scrub?.dispose()
    this.scrub = null
    this.scrubGenerations.clear()
    this.scrubAssets.clear()
    this.scrubFallback.clear()
    if (this.audio) {
      void this.audio.close().catch(() => undefined)
      this.audio = null
      this.masterGain = null
      this.streamDest = null
      this.clipGains.clear()
    }
  }

  // ————— internals —————

  private ensureAudio(): void {
    if (this.audio) return
    try {
      const Ctor: typeof AudioContext | undefined =
        typeof AudioContext !== 'undefined'
          ? AudioContext
          : (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      this.audio = new Ctor()
      this.masterGain = this.audio.createGain()
      this.masterGain.gain.value = this.masterVolume
      this.masterGain.connect(this.audio.destination)
      this.streamDest = this.audio.createMediaStreamDestination()
      this.masterGain.connect(this.streamDest)
    } catch {
      this.audio = null // element-volume fallback
    }
  }

  private tick = (): void => {
    if (!this.playingState) return
    const doc = this.opts.getDoc()
    const duration = this.durationOf(doc)

    const elapsed = this.audio
      ? this.audio.currentTime - this.anchorAudio
      : (performance.now() - this.anchorPerf) / 1000
    this.time = this.anchorDoc + elapsed

    if (this.time >= duration) {
      this.time = duration
      this.syncMedia(this.time)
      this.render(this.time)
      this.opts.onFrame?.(this.time)
      this.pause()
      this.opts.onEnd?.()
      return
    }

    this.syncMedia(this.time)
    this.render(this.time)
    this.opts.onFrame?.(this.time)
    this.raf = requestAnimationFrame(this.tick)
  }

  /**
   * Releases everything the engine still holds for clip ids that are no longer
   * in the doc (Delete, cut, undo, project replace): the doc iteration in
   * `syncMedia` only ever touches clips that ARE there, so without this a
   * deleted clip's element keeps playing audibly and its nodes keep feeding
   * masterGain for the rest of the session.
   */
  private releaseMissingClips(): void {
    const doc = this.opts.getDoc()
    const live = new Set<string>()
    const docIds = new Set<string>()
    for (const { clip } of this.activeClipList(doc)) {
      docIds.add(clip.id)
      // A clip whose media no longer resolves (its asset was removed from
      // the bin while the clip survives for undo/relink) is NOT live: the
      // doc keeps the clip, but keeping its element would let it play on
      // against a source nothing can resolve (the ghost-playback hole).
      // The SAME predicate gates syncMedia below (mediaPlayable), so the
      // two can never disagree.
      if (!mediaPlayable(findMedia(doc, clip.mediaId))) continue
      live.add(clip.id)
    }
    // Parked blend partners follow the same rule: a clip that is gone must not
    // keep a second decode alive.
    for (const id of this.pool.nextIds()) {
      if (live.has(id)) continue
      const partner = this.pool.peekNext(id)
      if (partner) this.endSeek(partner)
      this.pool.releaseNext(id)
    }
    for (const id of this.pool.ids()) {
      if (live.has(id)) continue
      this.releaseClip(id)
    }
    // A deleted clip must not keep recovery state or a deferred error alive.
    // A clip that merely lost its asset stays in `docIds` and keeps its state
    // for the relink.
    for (const id of new Set([
      ...this.recoveryRecords.keys(),
      ...this.noticeRanges.keys(),
      ...this.deferredErrors.keys(),
    ])) {
      if (docIds.has(id)) continue
      this.recoveryRecords.delete(id)
      this.noticeRanges.delete(id)
      this.deferredErrors.delete(id)
      this.opts.onMediaError?.(null, id)
    }
    // Scrub source (0.18.0): a deleted clip drops its sink and cached frame.
    // An asset whose effective URL changed (relink, proxy ready, proxy toggle)
    // or that left the bin releases its `Input`.
    for (const id of [...this.scrubGenerations.keys()]) {
      if (live.has(id)) continue
      this.clearScrubRetry(id)
      this.scrub?.releaseClip(id)
      this.scrubGenerations.delete(id)
      this.scrubFallback.delete(id)
    }
    for (const [assetId, url] of [...this.scrubAssets]) {
      const asset = findMedia(doc, assetId)
      if (asset && this.mediaUrl(asset) === url) continue
      this.scrub?.releaseAsset(assetId, url)
      this.scrubAssets.delete(assetId)
    }
  }

  /** Starts/stops elements, corrects drift, and updates per-clip gain. */
  private syncMedia(t: number, forceSeek = false): void {
    this.checkProjectEpoch()
    this.clearPassedRecovery(t)
    const doc = this.opts.getDoc()
    this.releaseMissingClips()
    for (const { clip, track, offset, ancestors, audibleTracks } of this.activeClipList(doc)) {
      if (track.kind === 'text') continue
      if (this.refreshing && this.recoveryInFlight === clip.id && !this.recoveryIsStale()) {
        continue
      }
      const asset = findMedia(doc, clip.mediaId)
      // Restored sessions keep assets without a URL ("missing" until
      // relinked). Elements for them are pure noise: error events, autoplay
      // attempts on an empty source, "playing" elements that can never show
      // or sound anything. Skip them entirely, via the same test
      // releaseMissingClips uses above, so a clip this loop refuses to
      // touch has always just had its element released. A compound container
      // (no media) falls through here too.
      if (!mediaPlayable(asset)) continue
      const start = offset + clip.start
      const active = withinAncestorWindows(t, start, start + clip.duration, ancestors)
      const el = this.pool.get(clip, asset, this.mediaUrl(asset))
      if (el.error) {
        if (!this.terminalElements.has(el)) this.handleElementError(clip.id, el)
        if (!el.paused) el.pause()
        this.endSeek(el)
        continue
      }
      // Clamped into the asset: a ramp may over-consume its source, and the
      // excess freezes on the last readable frame (mp4.ts clamps identically).
      const expected = clampSourceTime(this.sourceTime(clip, t, offset), asset)

      if (active) {
        // A pending seek must finish before the element is touched again. An
        // interrupted seek restarts its decode, so a loop of interrupted
        // seeks never yields a frame (black picture, no audio) even though
        // the playhead keeps advancing. `seeking` covers real browsers; the
        // map also carries fakes that never clear the flag. Inactive clips
        // still fall through to the pause below.
        if (this.trackingSeek(el)) continue

        if (clip.reverse || hasTimeScaleRamp(clip)) {
          // Two cases park the element and seek to the exact source position
          // every tick (stepped preview): a reversed clip cannot play
          // backwards in realtime, and a ramped clip's source position is a
          // curve integral that a constant playbackRate cannot follow (the
          // element would drift up to DRIFT_THRESHOLD behind the ramp, which
          // reads as the wrong speed for seconds). A flat curve is NOT
          // parked: its constant rate is applied below like a plain speed.
          // Neither case writes the curve into playbackRate; reverse's seek
          // walks backwards as the playhead advances.
          if (!el.paused) el.pause()
          if (forceSeek || Math.abs(el.currentTime - expected) > 1 / 60) {
            this.seekElement(el, expected)
          }
        } else if (el.paused) {
          // Resume at the parked position must not restart the decode: the
          // clock starts immediately, and a seek here blanks the monitor (and
          // delays the linked audio twin) for the whole seek. Only a real
          // offset, a paused scrub, or an explicit force-seek moves it.
          if (forceSeek || Math.abs(el.currentTime - expected) > START_SEEK_THRESHOLD) {
            this.seekElement(el, expected)
          }
          el.playbackRate = constantRateOf(clip)
          void el.play().catch(() => undefined)
        } else if (forceSeek || Math.abs(el.currentTime - expected) > DRIFT_THRESHOLD) {
          this.seekElement(el, expected)
          // A speed edit while the clip already plays must reach the element
          // without a pause first (reversed clips stay stepped).
          applyPlaybackRate(el, clip)
        } else {
          applyPlaybackRate(el, clip)
        }
        const gain = this.computeGain(doc, track, clip, t, offset, ancestors, audibleTracks)
        this.applyGain(clip.id, el, gain, clip)
      } else if (!el.paused) {
        el.pause()
        this.endSeek(el)
      }
      this.syncBlendElement(clip, asset, t, active, forceSeek, offset)
    }
  }

  /**
   * Positions (or drops) the parked blend partner of one clip (0.7.0).
   *
   * The partner is PARKED and seeked to the exact partner read, like a reversed
   * or ramped clip's element: it only has to hold one frame, and a second
   * element playing alongside the first would drift from it. While a seek is in
   * flight the element is left alone, because an interrupted seek restarts its
   * decode (see trackingSeek). A clip that no longer reads below the frame rate
   * (a speed edit) drops its partner: the element would otherwise keep a second
   * decode alive for a pair nothing will ask for.
   */
  private syncBlendElement(
    clip: Clip,
    asset: MediaAsset,
    t: number,
    active: boolean,
    forceSeek: boolean,
    offset = 0,
  ): void {
    const partner = blendPartnerTime(
      clip,
      t - offset - clip.start,
      asset,
      this.opts.getDoc().project.fps,
    )
    if (partner === undefined) {
      this.pool.releaseNext(clip.id)
      return
    }
    const el = this.pool.getNext(clip, asset, this.mediaUrl(asset))
    if (!el) return
    if (el.error) this.handleElementError(clip.id, el)
    if (this.failedPartners.has(el)) return
    this.watchPresentedFrames(el)
    if (!active) {
      if (!el.paused) el.pause()
      return
    }
    if (this.trackingSeek(el)) return
    const target = clampSourceTime(partner, asset)
    if (forceSeek || Math.abs(el.currentTime - target) > PARTNER_SEEK_EPS) {
      this.seekElement(el, target)
    }
  }

  /**
   * Tracks the media timestamp of the frame an element presents, through
   * requestVideoFrameCallback (0.7.0). The callback is one-shot, so it re-arms
   * itself; an element that never presents another frame (parked, or a browser
   * without the API) simply never reports one.
   */
  private watchPresentedFrames(el: HTMLMediaElement): void {
    const video = el as HTMLVideoElement
    if (typeof video.requestVideoFrameCallback !== 'function') return
    if (this.watchingFrames.has(el)) return
    this.watchingFrames.add(el)
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      this.presentedTimes.set(el, metadata.mediaTime)
      // A parked monitor repaints on the presented frame itself (0.7.0). `seeked`
      // fires when the position lands, which can be BEFORE the decoded frame
      // reaches the compositor: a draw at that moment pairs the newly presented
      // frame with the one before it, or falls back to a single frame, and
      // nothing else would revisit the parked canvas. One repaint per presented
      // frame, and none while playing (the render loop already repaints).
      if (!this.playingState) this.render(this.time)
      video.requestVideoFrameCallback(onFrame)
    }
    video.requestVideoFrameCallback(onFrame)
  }

  /**
   * The media timestamp of the frame an element is SHOWING near `target`, or
   * undefined when the element cannot vouch for one: nothing reported yet, a seek
   * still in flight (the element keeps displaying its OLD frame until the decode
   * lands), a frame from a position already moved away from, or a frame too far
   * behind the target to be the one the read asks for. Each case falls back to
   * the single-frame draw rather than blending against the wrong frame.
   */
  private presentedTime(el: HTMLMediaElement, target: number): number | undefined {
    if (el.seeking) return undefined
    const ts = this.presentedTimes.get(el)
    if (ts === undefined) return undefined
    if (ts > target + PRESENTED_LEAD_EPS) return undefined
    if (target - ts > PRESENTED_STALE_WINDOW) return undefined
    return ts
  }

  /**
   * The blend pair for one clip's sub-frame-rate read: the parked partner
   * element, plus the weight between the two frames the decoder is showing. The
   * weight comes from the shared `blendWeight`, so the preview and the export
   * compute it the same way; only its inputs differ (presented-frame timestamps
   * here, the exporter's decoded sample timestamps there).
   */
  private blendFor(
    clip: Clip,
    primary: HTMLMediaElement,
    asset: MediaAsset,
    local: number,
  ): FrameBlendSource | undefined {
    const { fps } = this.opts.getDoc().project
    const partnerTime = blendPartnerTime(clip, local, asset, fps)
    if (partnerTime === undefined) return undefined
    const partner = this.pool.peekNext(clip.id)
    if (
      !partner ||
      this.failedPartners.has(partner) ||
      this.terminalElements.has(primary) ||
      partner.readyState < 2
    ) {
      return undefined
    }
    // The primary's own read position is the reference for its frame: the
    // element plays on the element clock, so its presented frame can sit a hair
    // ahead of the playhead-derived source time.
    const a = this.presentedTime(primary, primary.currentTime)
    const b = this.presentedTime(partner, clampSourceTime(partnerTime, asset))
    if (a === undefined || b === undefined) return undefined
    const weight = blendWeight(sourceTimeAt(clip, local), a, b)
    // Strictly inside (0, 1): the ends reduce to a single frame, and the export
    // skips the pair there too.
    if (!(weight > 0 && weight < 1)) return undefined
    return { el: partner, weight }
  }

  /**
   * The still path's seek dead zone (0.7.0): HALF the source time one output
   * frame consumes at the playhead, capped at the old flat 0.02 s.
   *
   * A flat 0.02 s is 0.6 of a 30 fps source frame, so a clip reading slower than
   * realtime only re-seeked every few steps and the monitor held a frame the
   * export would already have moved past. Half of one frame's read keeps the
   * element on the frame the read falls in (a step of one output frame always
   * crosses it) while a sub-frame scrub jitter still does not restart a decode.
   */
  private stillSeekEps(clip: Clip, t: number, fps: number, offset = 0): number {
    const step = 1 / Math.max(1, fps)
    const perFrame = Math.abs(
      this.sourceTime(clip, t + step, offset) - this.sourceTime(clip, t, offset),
    )
    return Math.min(0.02, perFrame / 2)
  }

  /** True while the element has a seek in flight (and keeps tracking it). */
  private trackingSeek(el: HTMLMediaElement): boolean {
    if (el.seeking) return true
    const entry = this.seekingEls.get(el)
    if (!entry) return false
    if (performance.now() - entry.started > SEEK_QUIET_MS) {
      this.endSeek(el)
      return false
    }
    return true
  }

  /**
   * Assigns a new element position and tracks the seek until its decode lands.
   * Real browsers fire `seeked` when the frame is ready; the fake elements in
   * tests fire it synchronously on a value change, so only an assignment that
   * actually moves the position is tracked. A no-op assignment (same value)
   * never emits `seeked` there and must not leave a stale "seeking" entry.
   */
  private seekElement(el: HTMLMediaElement, expected: number): void {
    const prev = el.currentTime
    // Land inside the frame the read names rather than on its edge (see
    // SEEK_FRAME_NUDGE): the exporter resolves an exact frame start to the frame
    // that begins there, and an element seek to the bare value does not.
    const target = parkedTarget(expected)
    if (Math.abs(prev - target) <= 1e-9) return
    // Track BEFORE the assignment: a synchronous `seeked` (fake elements, or a
    // browser that completes instantly) then clears the entry within this call,
    // and an async browser keeps it until the decode lands.
    this.beginSeek(el)
    try {
      el.currentTime = target
    } catch {
      this.endSeek(el)
      return // seek before metadata: nothing to track
    }
    if (Math.abs(prev - target) <= 1e-9) this.endSeek(el)
  }

  private beginSeek(el: HTMLMediaElement): void {
    // A superseded seek whose decode lands later must not leave its listener
    // attached until the NEXT seek's `seeked`: the entry owns the handler and
    // `endSeek` removes it, so a re-seek replaces both atomically. The timeout
    // in `trackingSeek` stays only as a backstop for paths that never emit.
    this.endSeek(el)
    const entry: { started: number; onSeeked: () => void } = {
      started: performance.now(),
      onSeeked: () => this.endSeek(el),
    }
    this.seekingEls.set(el, entry)
    el.addEventListener('seeked', entry.onSeeked)
  }

  private endSeek(el: HTMLMediaElement): void {
    const entry = this.seekingEls.get(el)
    if (!entry) return
    el.removeEventListener('seeked', entry.onSeeked)
    this.seekingEls.delete(el)
  }

  /** volume curve × solo/mute audibility × clip mute × crossfade alpha; reversed clips are silent. */
  private computeGain(
    doc: Doc,
    track: Track,
    clip: Clip,
    t: number,
    offset = 0,
    ancestors: {
      clip: Clip
      track: Track
      offset: number
      audibleTracks: Set<string>
    }[] = [],
    audibleTracks: Set<string> = audibleTrackIds([track]),
  ): number {
    const local = t - offset - clip.start
    let gain = animatedValue(clip, 'volume', local)
    // A/V pairs: the audio twin is the group's sole sound carrier. The video
    // part keeps PLAYING (its element feeds the compositor frames) but its
    // embedded audio must be shadowed or the pair would double-play.
    // Reversed clips drop their audio (Premiere drops it too), and so does an
    // A/V pair whose rates disagree: a real ramp needs varispeed or a
    // resampler (neither exists here), and an effective rate (a curve's
    // constant or the plain static speed) that leaves the halves disagreeing
    // retimes the picture against the twin. A manual link without a carrier is
    // not an A/V pair and keeps its own audio. The check is DERIVED from the
    // rates (linkGroupChangesRate), so it can never go stale the way a stored
    // flag could; it covers both pair members.
    if (
      clip.muted ||
      !audibleTracks.has(track.id) ||
      clip.reverse ||
      linkGroupChangesRate(doc, clip) ||
      hasLinkedAudioTwin(doc, clip)
    ) {
      return 0
    }

    // Crossfade audio ramp on this clip's own track (sequence-local span).
    gain *= crossfadeFactor(track, clip, t - offset)
    // Every enclosing compound container applies its gain, mute, volume curve
    // and crossfade ONCE to the nested mix (its own track and local clock).
    for (const ancestor of ancestors) {
      if (ancestor.clip.muted || !ancestor.audibleTracks.has(ancestor.track.id)) return 0
      gain *= animatedValue(ancestor.clip, 'volume', t - ancestor.offset - ancestor.clip.start)
      gain *= crossfadeFactor(ancestor.track, ancestor.clip, t - ancestor.offset)
    }
    return clamp(gain, 0, 2)
  }

  private applyGain(clipId: string, el: HTMLMediaElement, value: number, clip: Clip): void {
    if (this.audio && this.masterGain) {
      const node = this.pool.getSourceNode(el, this.audio)
      const sig = shapingSignature(clip)
      let entry = this.clipGains.get(clipId)
      if (entry && (entry.sig !== sig || entry.el !== el)) {
        // Shaping changed (EQ / compressor / pan edit), or the ELEMENT changed:
        // a relink gives the asset a new url, `pool.get` swaps the element
        // under the same clip id, and the cached chain would keep feeding
        // masterGain from the old element's source node while the compositor
        // reads the new one. Tear the chain down so the new element (or the
        // new settings) are audible without restarting playback.
        for (const n of entry.nodes) {
          try {
            n.disconnect()
          } catch {
            // already detached
          }
        }
        try {
          entry.gain.disconnect() // the old chain's edge into masterGain
        } catch {
          // already detached
        }
        try {
          // Disconnect the OLD element's source node. Disconnecting `node`
          // here would tear down the NEW element's source before it is wired
          // into the replacement chain.
          this.pool.getSourceNode(entry.el, this.audio).disconnect()
        } catch {
          // already detached
        }
        this.clipGains.delete(clipId)
        entry = undefined
      }
      if (!entry) {
        const gain = this.audio.createGain()
        const nodes: AudioNode[] = []
        let head: AudioNode = node
        // Three-band EQ (low shelf / mid peak / high shelf) when configured.
        if (clip.eq) {
          const low = this.audio.createBiquadFilter()
          low.type = 'lowshelf'
          low.frequency.value = PlaybackCore.EQ_LO
          low.gain.value = clamp(clip.eq.low, EQ_DB_MIN, EQ_DB_MAX)
          const mid = this.audio.createBiquadFilter()
          mid.type = 'peaking'
          mid.frequency.value = PlaybackCore.EQ_MID
          mid.Q.value = 1
          mid.gain.value = clamp(clip.eq.mid, EQ_DB_MIN, EQ_DB_MAX)
          const high = this.audio.createBiquadFilter()
          high.type = 'highshelf'
          high.frequency.value = PlaybackCore.EQ_HIGH
          high.gain.value = clamp(clip.eq.high, EQ_DB_MIN, EQ_DB_MAX)
          head.connect(low)
          low.connect(mid)
          mid.connect(high)
          head = high
          nodes.push(low, mid, high)
        }
        if (clip.denoise) {
          for (const filter of denoiseFilters(this.audio)) {
            head.connect(filter)
            head = filter
            nodes.push(filter)
          }
        }
        if (clip.compressor) {
          const comp = this.audio.createDynamicsCompressor()
          comp.threshold.value = -24
          comp.knee.value = 12
          comp.ratio.value = 4
          comp.attack.value = 0.005
          comp.release.value = 0.18
          head.connect(comp)
          head = comp
          nodes.push(comp)
        }
        if ((clip.pan ?? 0) !== 0 && 'createStereoPanner' in this.audio) {
          const panner = this.audio.createStereoPanner()
          panner.pan.value = clamp(clip.pan ?? 0, -1, 1)
          head.connect(panner)
          head = panner
          nodes.push(panner)
        }
        head.connect(gain)
        gain.connect(this.masterGain)
        entry = { gain, sig, nodes, el }
        this.clipGains.set(clipId, entry)
      }
      entry.gain.gain.setTargetAtTime(value, this.audio.currentTime, 0.02)
    } else {
      // No Web Audio: fall back to element volume (single-digit dB precision).
      el.volume = clamp(value, 0, 1)
    }
  }

  private mediaUrl(asset: MediaAsset): string {
    return this.opts.resolveMediaUrl?.(asset) ?? asset.url
  }

  /**
   * The clip's scrub generation (0.18.0). It bumps when the effective URL
   * changes (relink, proxy ready, proxy toggle) or the clip's media id moves,
   * so a frame decoded from the old source can never be shown for the new one.
   */
  private scrubGeneration(clipId: string, assetId: string, url: string): number {
    const previousAssetUrl = this.scrubAssets.get(assetId)
    if (previousAssetUrl !== undefined && previousAssetUrl !== url) {
      this.scrub?.releaseAsset(assetId, previousAssetUrl)
      this.scrubFallback.delete(clipId)
    }
    this.scrubAssets.set(assetId, url)
    const previous = this.scrubGenerations.get(clipId)
    if (previous && previous.url === url) return previous.token
    const token = (previous?.token ?? 0) + 1
    this.scrubGenerations.set(clipId, { url, token })
    return token
  }

  /** Requests one scrub frame and repaints only when it is still current. */
  private requestScrubFrame(
    clipId: string,
    assetId: string,
    url: string,
    sourceTime: number,
    generation: number,
  ): void {
    if (!this.scrub) return
    const requestedAt = this.time
    this.scrub.request({ clipId, assetId, effectiveUrl: url, sourceTime, generation }, (result) => {
      if (this.playingState) return
      if (Math.abs(this.time - requestedAt) > 1e-3) return
      if (this.scrubGeneration(clipId, assetId, url) !== result.generation) return
      this.clearScrubFallback(clipId)
      this.render(this.time)
    })
  }

  private clearScrubFallback(clipId: string): void {
    this.clearScrubRetry(clipId)
    this.scrubFallback.delete(clipId)
    if (this.scrubRecovering && this.scrubFallback.size === 0) this.setScrubRecovering(false)
  }

  private clearScrubRetry(clipId: string): void {
    const timer = this.scrubRetryTimers.get(clipId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.scrubRetryTimers.delete(clipId)
  }

  /**
   * The `<video>` scrub fallback's own retry budget. It never calls
   * `handleElementError`: a normal scrub must not be reported as damaged media.
   */
  private noteScrubFallback(clipId: string, sourceTime: number, playhead: number): void {
    const fps = Math.max(1, this.opts.getDoc().project.fps)
    const previous = this.scrubFallback.get(clipId)
    const sameTime = previous && Math.abs(previous.sourceTime - sourceTime) <= 1 / fps
    const attempts = sameTime ? previous.attempts + 1 : 1
    this.clearScrubRetry(clipId)
    this.scrubFallback.set(clipId, { attempts, sourceTime })
    if (attempts >= SCRUB_FALLBACK_ATTEMPTS) {
      this.setScrubRecovering(true)
      return
    }
    const requestedAt = playhead
    const timer = setTimeout(() => {
      this.scrubRetryTimers.delete(clipId)
      if (this.playingState) return
      if (Math.abs(this.time - requestedAt) > 1e-3) return
      // Stay on the scrub path: a retry that still errors must advance the
      // fallback counter, never enter damaged-media recovery.
      this.refresh(this.time, true)
    }, SCRUB_FALLBACK_TIMEOUT_MS)
    this.scrubRetryTimers.set(clipId, timer)
  }

  private setScrubRecovering(recovering: boolean): void {
    if (this.scrubRecovering === recovering) return
    this.scrubRecovering = recovering
    this.opts.onPreviewRecovering?.(recovering)
  }

  private render(t: number): void {
    if (!this.ctx2d) return
    const doc = this.opts.getDoc()
    // A paused scrub must never clear the monitor while the next WebCodecs
    // frame is in flight. If any active video clip has a scrub sink but no
    // cached frame yet, leave the previous composite on the canvas.
    if (!this.playingState && this.scrub) {
      for (const { clip, track, offset, ancestors } of this.activeClipList(doc)) {
        if (track.kind === 'text' || track.kind === 'audio' || clip.audioOnly) continue
        const asset = findMedia(doc, clip.mediaId)
        if (!asset || asset.kind !== 'video' || asset.missing || !asset.url) continue
        const start = offset + clip.start
        if (!withinAncestorWindows(t, start, start + clip.duration, ancestors)) continue
        // A blend clip renders through the parked element pair, never the
        // single WebCodecs frame, so it never requests one. Requiring a cached
        // frame here would block the whole composite forever.
        if (blendPartnerTime(clip, t - offset - clip.start, asset, doc.project.fps) !== undefined) {
          continue
        }
        const url = this.mediaUrl(asset)
        if (!this.scrub.hasSink(asset.id, url)) continue
        const expected = clampSourceTime(this.sourceTime(clip, t, offset), asset)
        const generation = this.scrubGeneration(clip.id, asset.id, url)
        if (!this.scrub.peek(clip.id, expected, generation)) return
      }
    }
    drawFrame({
      ctx: this.ctx2d,
      doc,
      time: t,
      // The frame time is threaded through, never read back off the engine, so
      // one draw is internally consistent: the compositor, the still-frame
      // resolver and the blend pair all use the time this render was asked for.
      // A landing seek asks for the CURRENT playhead (see drawStill), never the
      // time its own seek was issued for, so a superseded seek cannot repaint a
      // stale frame over a newer one. The compositor hands the resolver each
      // clip's own LOCAL time, so a nested clip reads its sequence clock.
      resolve: (clip, local) => this.resolveClip(clip, local),
      tracks: this.activeTracks(doc),
    })
  }

  /**
   * Paused rendering: positions active video elements at their expected source
   * time and draws. A one-time `seeked` listener re-draws when the frame lands.
   */
  private drawStill(t: number, forceSeek = false): void {
    this.checkProjectEpoch()
    const doc = this.opts.getDoc()
    // Paused edits (Delete, undo, relink) never reach syncMedia, so the release
    // pass runs here too: a clip deleted while paused must not leave its
    // parked blend element holding a decode for the rest of the session.
    this.releaseMissingClips()
    // Handle errors after the paint. A terminal error calls `applySeek`, which
    // repaints at `failedFrom`; doing that inline would nest a second draw and
    // leave the outer `render(t)` painting a different time than the playhead.
    const pendingErrors: { clipId: string; el: HTMLMediaElement }[] = []
    for (const { clip, track, offset, ancestors } of this.activeClipList(doc)) {
      if (track.kind === 'text') continue
      if (this.refreshing && this.recoveryInFlight === clip.id && !this.recoveryIsStale()) {
        continue
      }
      const asset = findMedia(doc, clip.mediaId)
      if (!asset || asset.kind !== 'video') continue
      // Missing assets have no URL: pool.get would materialize a phantom
      // <video src=""> (decode error noise) for a still frame that can
      // never render. Same skip rule as syncMedia.
      if (asset.missing || !asset.url) continue
      const start = offset + clip.start
      const active = withinAncestorWindows(t, start, start + clip.duration, ancestors)
      if (!active) continue
      const url = this.mediaUrl(asset)
      // Clamped into the asset: a ramp may over-consume its source, and the
      // excess freezes on the last readable frame (mp4.ts clamps identically).
      const expected = clampSourceTime(this.sourceTime(clip, t, offset), asset)
      const generation = this.scrubGeneration(clip.id, asset.id, url)
      // A sub-frame-rate read needs the parked partner pair. The WebCodecs
      // cache holds one frame per clip, so taking that shortcut here would
      // silently drop the blend. Route these clips through the element path.
      const partner = blendPartnerTime(clip, t - offset - clip.start, asset, doc.project.fps)
      const sinkAvailable = this.scrub ? this.scrub.hasSink(asset.id, url) : false
      if (
        partner === undefined &&
        this.scrub &&
        !this.playingState &&
        !clip.audioOnly &&
        track.kind !== 'audio' &&
        sinkAvailable
      ) {
        // WebCodecs path (0.18.0): request the target and draw the cached or
        // last-good frame. Never assign `el.currentTime`; restarting the
        // element's seek on every move is what cleared the canvas to black.
        // Audio-only clips skip the request but still get their element below,
        // so their decode errors keep reaching the recovery path.
        this.requestScrubFrame(clip.id, asset.id, url, expected, generation)
        this.clearScrubFallback(clip.id)
        continue
      }
      const el = this.pool.get(clip, asset, url)
      // Reaching the element for a paused video clip while a scrub source
      // exists means this URL has no WebCodecs sink: it is the fallback. A
      // blend clip reaches the element with its sink intact, by design, so it
      // must not be recorded as a fallback.
      if (
        this.scrub &&
        !this.playingState &&
        !clip.audioOnly &&
        track.kind !== 'audio' &&
        !sinkAvailable
      ) {
        this.scrubFallbackElements.set(el, expected)
      }
      if (el.error) {
        // A scrub fallback (WebCodecs already failed for this asset) must not
        // reach the damaged-media path. It has its own counter and neutral
        // notice; genuine terminal damage still uses the existing path.
        if (this.scrubInProgress && this.scrub && !sinkAvailable) {
          this.noteScrubFallback(clip.id, expected, t)
          if (!el.paused) el.pause()
          this.endSeek(el)
          continue
        }
        if (!this.terminalElements.has(el)) pendingErrors.push({ clipId: clip.id, el })
        if (!el.paused) el.pause()
        this.endSeek(el)
        continue
      }
      const seekTarget = parkedTarget(expected)
      if (
        Math.abs(el.currentTime - seekTarget) > 1e-9 &&
        (forceSeek ||
          Math.abs(el.currentTime - expected) > this.stillSeekEps(clip, t, doc.project.fps, offset))
      ) {
        try {
          el.currentTime = seekTarget
        } catch {
          // ignore
        }
        el.addEventListener(
          'seeked',
          () => {
            // this.time, not t: a seek superseded by a later one still fires
            // its listener, and repainting the captured t would put a stale
            // frame back on screen after the newer seek already drew.
            this.clearScrubFallback(clip.id)
            this.setScrubRecovering(false)
            if (!this.playingState) this.render(this.time)
          },
          { once: true },
        )
      }
      // The blend partner is parked on its own frame here too, so a still
      // frame blends exactly like a playing one. Its seek landing has to
      // redraw: until it does, the pair falls back to the single frame.
      if (partner === undefined) {
        this.pool.releaseNext(clip.id)
        continue
      }
      const next = this.pool.getNext(clip, asset, this.mediaUrl(asset))
      if (!next) continue
      if (next.error) this.handleElementError(clip.id, next)
      if (this.failedPartners.has(next)) continue
      this.watchPresentedFrames(next)
      const target = clampSourceTime(partner, asset)
      if (Math.abs(next.currentTime - target) > PARTNER_SEEK_EPS) {
        try {
          next.currentTime = parkedTarget(target)
        } catch {
          // ignore
        }
        next.addEventListener(
          'seeked',
          () => {
            // Same rule as the primary element above.
            if (!this.playingState) this.render(this.time)
          },
          { once: true },
        )
      }
    }
    this.render(t)
    for (const { clipId, el } of pendingErrors) {
      if (this.pool.peek(clipId) === el) this.handleElementError(clipId, el)
    }
  }

  private resolveClip(
    clip: Clip,
    local: number,
  ):
    | {
        asset: MediaAsset
        el?: HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap
        blend?: FrameBlendSource
      }
    | undefined {
    const doc = this.opts.getDoc()
    const asset = findMedia(doc, clip.mediaId)
    if (!asset) return undefined
    if (asset.kind === 'image') {
      // Missing assets have no URL. An Image with src "" is a permanent
      // decode failure; skip so the frame plan falls through cleanly.
      if (asset.missing || !asset.url) return undefined
      let img = this.imageCache.get(asset.id)
      if (!img) {
        img = new Image()
        img.onload = () => {
          if (!this.playingState) this.render(this.time) // refresh once decoded
        }
        img.src = asset.url
        this.imageCache.set(asset.id, img)
      }
      return { asset, el: img.complete ? img : undefined }
    }
    if (asset.kind === 'video') {
      // Missing (restored) assets have no URL: never build an element for them.
      if (asset.missing || !asset.url) return undefined
      const url = this.mediaUrl(asset)
      // Paused/scrubbing frames come from WebCodecs (0.18.0). On the WebCodecs
      // path the cached frame IS the frame; a fallback asset keeps its last
      // good frame only while the `<video>` seek is still pending, because
      // clearing to black while it lands is the scrub regression this release
      // fixes. Once the seek lands, the element supplies the frame.
      let cached: CanvasImageSource | undefined
      if (
        !this.playingState &&
        this.scrub &&
        blendPartnerTime(clip, local, asset, doc.project.fps) === undefined
      ) {
        const expected = clampSourceTime(sourceTimeAt(clip, local), asset)
        const generation = this.scrubGeneration(clip.id, asset.id, url)
        const frame = this.scrub.peek(clip.id, expected, generation)
        if (this.scrub.hasSink(asset.id, url)) {
          return frame ? { asset, el: frame as HTMLCanvasElement | ImageBitmap } : { asset }
        }
        cached = frame
      }
      const el = this.pool.get(clip, asset, url) as HTMLVideoElement
      // A fallback asset keeps the last WebCodecs frame only while its seek is
      // still pending. Once the element is ready, the element is the truth.
      if (cached && (el.seeking || el.readyState < 2)) {
        return { asset, el: cached as HTMLCanvasElement | ImageBitmap }
      }
      if (this.terminalElements.has(el)) return { asset }
      this.watchPresentedFrames(el)
      // Sub-frame-rate reads hand the compositor the parked partner as well, so
      // the monitor blends the pair the exporter blends instead of holding a
      // source frame for two output frames.
      return { asset, el, blend: this.blendFor(clip, el, asset, local) }
    }
    return { asset } // audio-only
  }
}

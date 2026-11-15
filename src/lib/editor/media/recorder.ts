/**
 * recorder.ts: local voiceover, screen, and camera capture (0.27.0).
 *
 * Browser APIs live here, never in the pure state core. Every recording is a
 * plain File that goes back through `importFile`, so it becomes an ordinary
 * media asset with the normal OPFS persistence and reload behavior.
 *
 * Design decisions:
 * - Screen recording carries exactly one audio source (system, microphone, or
 *   none). System and microphone are never mixed, because a microphone hears
 *   the speakers and the mix would contain the system audio twice.
 * - Captures stop at 10 minutes or 512 MiB (whichever lands first), because
 *   MediaRecorder buffers every chunk in memory until stop. Explicit bitrates
 *   keep ten minutes under the byte cap.
 */

import {
  RECORDING_AUDIO_BITS_PER_SECOND,
  RECORDING_MAX_BYTES,
  RECORDING_MAX_SECONDS,
  RECORDING_SOFT_MAX_BYTES,
  RECORDING_VIDEO_BITS_PER_SECOND,
  RECORDING_WARN_RATIO,
} from '../constants'

export type RecordingKind = 'voiceover' | 'screen' | 'camera'

export type ScreenAudioSource = 'none' | 'system' | 'microphone'

export interface RecorderCapabilities {
  recorder: boolean
  microphone: boolean
  camera: boolean
  screen: boolean
  mimeType: string | null
}

export type RecordingLimitState = 'ok' | 'warning' | 'limit'

export interface RecorderHandlers {
  /** Called on every timer tick with the elapsed time and bytes buffered. */
  onTick?: (elapsedSeconds: number, bytes: number) => void
  onError?: (error: Error) => void
  /**
   * Called once when the take finalizes for ANY reason, including the cap or a
   * browser-side stop. The dialog imports through this so an automatic stop
   * still saves the take. A cancelled take reports null.
   */
  onFinished?: (file: File | null) => void
}

export interface LevelMeter {
  /** Current peak level, 0..1. */
  level(): number
  close(): void
}

const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
] as const

const AUDIO_MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'] as const

/** Video-only forms of the same containers, for a stream with no audio track. */
const VIDEO_ONLY_MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4',
] as const

/**
 * The MIME type to record a specific stream with. Firefox accepts a muxed
 * codec string like `vp8,opus` for a stream with no audio track, then emits no
 * data at all and never fires stop, so a video-only stream asks for the
 * video-only form of the same container instead.
 */
export function resolveRecordingMime(
  requested: string,
  hasAudio: boolean,
  isSupported: (type: string) => boolean = (type) => MediaRecorder.isTypeSupported(type),
): string {
  if (hasAudio || requested.startsWith('audio/')) return requested
  const container = requested.split(';')[0]
  const candidates =
    container === 'video/mp4'
      ? (['video/mp4;codecs=avc1', 'video/mp4'] as const)
      : VIDEO_ONLY_MIME_CANDIDATES
  return candidates.find((type) => isSupported(type)) ?? requested
}

/** How long a stop may wait for the browser's stop event before finalizing. */
const STOP_EVENT_TIMEOUT_MS = 20_000

/** Runtime capability report for a recording kind. */
export function recorderCapabilities(kind: RecordingKind): RecorderCapabilities {
  const recorder = typeof MediaRecorder !== 'undefined'
  const devices =
    typeof navigator !== 'undefined' && navigator.mediaDevices ? navigator.mediaDevices : undefined
  return {
    recorder,
    microphone: !!devices?.getUserMedia,
    camera: !!devices?.getUserMedia,
    screen: !!devices?.getDisplayMedia,
    mimeType: recorder ? pickMimeType(kind) : null,
  }
}

/** First MIME type this browser can record for the kind, or null. */
export function pickMimeType(
  kind: RecordingKind,
  isSupported: (type: string) => boolean = (type) => MediaRecorder.isTypeSupported(type),
): string | null {
  const candidates = kind === 'voiceover' ? AUDIO_MIME_CANDIDATES : VIDEO_MIME_CANDIDATES
  for (const type of candidates) {
    if (isSupported(type)) return type
  }
  return null
}

/**
 * A deterministic display name from the local clock. The timestamp is only a
 * name; nothing about it enters the document schema.
 */
export function recordingFileName(
  kind: RecordingKind,
  mimeType: string,
  now: Date = new Date(),
): string {
  const label =
    kind === 'voiceover' ? 'Voiceover' : kind === 'screen' ? 'Screen recording' : 'Camera recording'
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours(),
  )}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  const extension = mimeType.includes('mp4') ? 'mp4' : 'webm'
  return `${label} ${stamp}.${extension}`
}

/** Whether a take is near or at either recording cap. */
export function recordingLimitState(seconds: number, bytes: number): RecordingLimitState {
  const timeRatio = seconds / RECORDING_MAX_SECONDS
  const byteRatio = bytes / RECORDING_MAX_BYTES
  if (timeRatio >= 1 || byteRatio >= 1) return 'limit'
  if (timeRatio >= RECORDING_WARN_RATIO || byteRatio >= RECORDING_WARN_RATIO) return 'warning'
  return 'ok'
}

/** Stops every track in a stream. Safe on a missing or already-stopped stream. */
export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // A track that is already stopped throws in some browsers; nothing to do.
    }
  }
}

/** A track that is still producing data. */
function isLiveTrack(track: MediaStreamTrack): boolean {
  return track.readyState === 'live'
}

/** Microphone and camera lists, with permission-aware labels when available. */
export async function listRecordingDevices(): Promise<{
  microphones: MediaDeviceInfo[]
  cameras: MediaDeviceInfo[]
}> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return { microphones: [], cameras: [] }
  }
  let devices: MediaDeviceInfo[]
  try {
    devices = await navigator.mediaDevices.enumerateDevices()
  } catch {
    // Enumeration can be denied while default capture still works. The selects
    // fall back to their default entries instead of rejecting the dialog.
    return { microphones: [], cameras: [] }
  }
  return {
    microphones: devices.filter((device) => device.kind === 'audioinput'),
    cameras: devices.filter((device) => device.kind === 'videoinput'),
  }
}

function deviceConstraint(id: string | undefined): boolean | MediaTrackConstraints {
  return id ? { deviceId: { exact: id } } : true
}

/** Microphone-only stream for voiceover. */
export async function requestVoiceoverStream(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: deviceConstraint(deviceId) })
}

/** Camera stream, with an optional microphone track. */
export async function requestCameraStream(
  cameraId: string | undefined,
  microphoneId: string | undefined,
  microphone: boolean,
): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: deviceConstraint(cameraId),
    audio: microphone ? deviceConstraint(microphoneId) : false,
  })
}

/**
 * Screen stream with exactly one audio source. Microphone mode requests display
 * video without audio and adds the microphone track to the same MediaStream, so
 * MediaRecorder encodes one audio track and no mix is needed. A denied
 * microphone falls back to video-only with a warning instead of failing the
 * take. An abort signal stops the display while the microphone prompt is still
 * pending, so closing the dialog cannot leave screen capture running.
 */
export async function requestScreenStream(
  audioSource: ScreenAudioSource,
  microphoneId?: string,
  isCancelled?: () => boolean,
  signal?: AbortSignal,
): Promise<{ stream: MediaStream; warnings: string[] }> {
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30, max: 60 } },
    audio: audioSource === 'system',
  })
  let displayStopped = false
  const stopDisplay = () => {
    if (displayStopped) return
    displayStopped = true
    stopStream(display)
  }
  const cancelled = () => isCancelled?.() === true || signal?.aborted === true
  // The microphone prompt can stay open indefinitely. Release the display as
  // soon as the request is cancelled, not when the prompt finally settles.
  const onAbort = () => stopDisplay()
  signal?.addEventListener('abort', onAbort)
  try {
    if (cancelled()) {
      stopDisplay()
      throw new Error('Recording cancelled')
    }
    // A display can already be ended when the picker returns, for example after
    // an immediate stop-sharing. No audio mode can record without live video.
    if (!display.getVideoTracks().some(isLiveTrack)) {
      stopDisplay()
      throw new Error('Screen sharing ended before the recording started')
    }
    if (audioSource !== 'microphone') {
      const warnings =
        audioSource === 'system' && display.getAudioTracks().length === 0
          ? ['No system audio was shared. The recording has video only.']
          : []
      return { stream: display, warnings }
    }
    let microphone: MediaStream | null = null
    let microphoneWarning: string | null = null
    try {
      microphone = await navigator.mediaDevices.getUserMedia({
        audio: deviceConstraint(microphoneId),
      })
    } catch {
      microphoneWarning = 'Microphone was unavailable. The recording has video only.'
    }
    // Denial is a normal outcome, but cancellation and a display that ended
    // during the prompt still apply to the video-only path.
    if (cancelled()) {
      stopDisplay()
      stopStream(microphone)
      throw new Error('Recording cancelled')
    }
    // The user can stop sharing while the microphone prompt is open. There is no
    // video left to record, so abort instead of returning the ended display.
    if (!display.getVideoTracks().some(isLiveTrack)) {
      stopDisplay()
      stopStream(microphone)
      throw new Error('Screen sharing ended before the recording started')
    }
    if (!microphone) {
      return { stream: display, warnings: microphoneWarning ? [microphoneWarning] : [] }
    }
    const combined = new MediaStream([...display.getVideoTracks(), ...microphone.getAudioTracks()])
    return { stream: combined, warnings: [] }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Repairs a MediaRecorder container that has no duration in its header. Chrome
 * writes WebM without one, so the element reports `Infinity`; seeking far past
 * the end makes the browser compute the real value. Returns null when no finite
 * positive duration can be read, and the caller refuses the import.
 */
export async function readRecordingDuration(
  blob: Blob,
  createElement: () => HTMLVideoElement = () => document.createElement('video'),
): Promise<number | null> {
  const url = URL.createObjectURL(blob)
  const element = createElement()
  element.preload = 'metadata'
  element.muted = true
  element.src = url
  try {
    await waitForMediaEvent(element, 'loadedmetadata', 15_000)
    let duration = element.duration
    if (!Number.isFinite(duration) || duration <= 0) {
      element.currentTime = 1e101
      await waitForMediaEvent(element, 'timeupdate', 5_000)
      duration = element.duration
      element.currentTime = 0
    }
    return Number.isFinite(duration) && duration > 0 ? duration : null
  } catch {
    return null
  } finally {
    try {
      element.src = ''
      element.load()
    } catch {
      // Detached or already released; the URL is the only resource that matters.
    }
    URL.revokeObjectURL(url)
  }
}

function waitForMediaEvent(
  element: HTMLVideoElement,
  event: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${event}`))
    }, timeoutMs)
    const onOk = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new Error('Recording could not be decoded by the browser'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      element.removeEventListener(event, onOk)
      element.removeEventListener('error', onError)
    }
    element.addEventListener(event, onOk)
    element.addEventListener('error', onError)
  })
}

/** A simple analyser-backed level meter for the recording dialogs. */
export function createLevelMeter(stream: MediaStream): LevelMeter | null {
  if (typeof AudioContext === 'undefined') return null
  if (stream.getAudioTracks().length === 0) return null
  const context = new AudioContext()
  try {
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const data = new Uint8Array(analyser.fftSize)
    void context.resume().catch(() => undefined)
    return {
      level: () => {
        analyser.getByteTimeDomainData(data)
        let peak = 0
        for (const value of data) {
          const amplitude = Math.abs(value - 128) / 128
          if (amplitude > peak) peak = amplitude
        }
        return peak
      },
      close: () => {
        try {
          source.disconnect()
        } catch {
          // Already disconnected.
        }
        void context.close().catch(() => undefined)
      },
    }
  } catch {
    // Setup can fail for a stream the context cannot bind. Release the context
    // so a failed recording start does not leak it.
    void context.close().catch(() => undefined)
    return null
  }
}

/**
 * One MediaRecorder take. `stop()` is idempotent, cleanup stops every track and
 * the recorder exactly once, and the byte trigger stops the take from inside
 * the data handler. The crossing and final chunks are kept so the stream stays
 * decodable, unless one of them would cross the hard ceiling: that chunk is
 * dropped and the take ends with what was recorded before it.
 */
export class StreamRecorder {
  private readonly mediaRecorder: MediaRecorder
  private readonly chunks: Blob[] = []
  private bytes = 0
  private started = false
  private startedAt = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private meter: LevelMeter | null = null
  private finished = false
  private cancelled = false
  /** False after an error or cancel, so stop-triggered data cannot join the take. */
  private acceptingData = true
  /** True once the cap requested a stop; later chunks still complete the stream. */
  private stopping = false
  /** True when a chunk was dropped at the hard ceiling. */
  private byteLimitHit = false
  private stopPromise: Promise<File | null> | null = null
  private resolveStop: ((file: File | null) => void) | null = null
  private finishedFile: File | null = null
  private readonly mimeType: string
  private stopTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly stream: MediaStream,
    private readonly kind: RecordingKind,
    requestedMimeType: string,
    private readonly handlers: RecorderHandlers = {},
  ) {
    this.mimeType = resolveRecordingMime(requestedMimeType, stream.getAudioTracks().length > 0)
    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType: this.mimeType,
      videoBitsPerSecond: RECORDING_VIDEO_BITS_PER_SECOND,
      audioBitsPerSecond: RECORDING_AUDIO_BITS_PER_SECOND,
    })
    this.mediaRecorder.ondataavailable = (event) => this.onData(event)
    this.mediaRecorder.onerror = () => {
      this.fail(new Error('Recording stopped because the browser reported an error'))
    }
    this.mediaRecorder.onstop = () => this.finalize()
  }

  /** Elapsed seconds since `start()`, from a clock wall-clock changes cannot move. */
  get elapsedSeconds(): number {
    return this.started ? (this.now() - this.startedAt) / 1000 : 0
  }

  get bufferedBytes(): number {
    return this.bytes
  }

  /**
   * True when a chunk was dropped because keeping it would have crossed the
   * hard byte ceiling. The take is saved from the chunks before it, so its end
   * may be missing and the dialog says so.
   */
  get reachedByteLimit(): boolean {
    return this.byteLimitHit
  }

  start(): void {
    if (this.started || this.finished) return
    this.started = true
    this.startedAt = this.now()
    this.meter = createLevelMeter(this.stream)
    this.mediaRecorder.start(1000)
    this.timer = setInterval(() => this.tick(), 250)
    this.emitTick()
  }

  /** A monotonic timestamp; `Date` stays only for filenames. */
  private now(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()
  }

  /** Current input level, 0..1, or 0 when no meter is available. */
  level(): number {
    return this.meter?.level() ?? 0
  }

  /**
   * Stops and resolves with the recording, or null when there is nothing to
   * save. Calling it twice returns the same promise and stops the recorder once.
   * A take the browser already stopped resolves with the file it produced, so a
   * later Stop click cannot hang.
   */
  stop(): Promise<File | null> {
    if (this.finished) return Promise.resolve(this.finishedFile)
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = new Promise<File | null>((resolve) => {
      this.resolveStop = resolve
      this.clearTimer()
      this.meter?.close()
      this.meter = null
      if (this.mediaRecorder.state === 'inactive') this.finalize()
      else {
        // A browser can switch state without ever firing stop; Firefox did it
        // for a video-only stream. Bound the wait so the dialog cannot sit in
        // Saving forever and lose the take. Armed first because a fake or a
        // fast browser can fire stop synchronously.
        this.stopTimer = setTimeout(() => this.finalize(), STOP_EVENT_TIMEOUT_MS)
        try {
          this.mediaRecorder.stop()
        } catch {
          // A recorder that throws instead of stopping still owns its chunks.
          this.finalize()
        }
      }
    })
    return this.stopPromise
  }

  /** Abandons the take without producing a file. */
  cancel(): void {
    this.cancelled = true
    this.acceptingData = false
    this.chunks.length = 0
    this.bytes = 0
    void this.stop()
  }

  private tick(): void {
    const seconds = this.elapsedSeconds
    this.emitTick()
    if (!this.stopping && this.atCap()) {
      this.stopping = true
      void this.stop()
    }
  }

  private atCap(): boolean {
    return (
      this.bytes >= RECORDING_SOFT_MAX_BYTES ||
      recordingLimitState(this.elapsedSeconds, this.bytes) === 'limit'
    )
  }

  private emitTick(): void {
    this.handlers.onTick?.(this.elapsedSeconds, this.bytes)
  }

  private onData(event: BlobEvent): void {
    // A late chunk after finalize, a failure, or cancel must not repopulate the
    // buffers. A capped take still accepts its crossing and final chunks so the
    // completed stream stays contiguous and decodable.
    if (this.finished || this.cancelled || !this.acceptingData) return
    if (event.data && event.data.size > 0) {
      // Hard ceiling. The 480 MiB trigger usually leaves enough headroom for
      // the final chunks, but an unusually large flush must not push the take
      // past 512 MiB. Drop it, save what was recorded, and let the dialog say
      // the end may be missing.
      if (event.data.size > RECORDING_MAX_BYTES - this.bytes) {
        this.byteLimitHit = true
        this.finalize()
        try {
          this.mediaRecorder.stop()
        } catch {
          // Already stopped or never started; finalize owns the take.
        }
        return
      }
      this.chunks.push(event.data)
      this.bytes += event.data.size
    }
    this.emitTick()
    if (!this.stopping && this.atCap()) {
      this.stopping = true
      void this.stop()
    }
  }

  private fail(error: Error): void {
    this.acceptingData = false
    this.handlers.onError?.(error)
    this.chunks.length = 0
    this.bytes = 0
    void this.stop()
  }

  private finalize(): void {
    if (this.finished) return
    this.finished = true
    this.clearTimer()
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    this.meter?.close()
    this.meter = null
    stopStream(this.stream)
    const file = this.cancelled || this.chunks.length === 0 ? null : this.toFile()
    this.finishedFile = file
    this.chunks.length = 0
    this.bytes = 0
    const resolve = this.resolveStop
    this.resolveStop = null
    resolve?.(file)
    // A stop the dialog did not await (the cap, or the browser stopping the
    // recorder) still reaches the dialog here, so the take gets imported.
    this.handlers.onFinished?.(file)
  }

  private toFile(): File {
    const type = this.mimeType.split(';')[0] || 'video/webm'
    const blob = new Blob(this.chunks, { type })
    return new File([blob], recordingFileName(this.kind, this.mimeType), {
      type,
      lastModified: Date.now(),
    })
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }
}

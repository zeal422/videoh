'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Circle, Loader2, Mic, Monitor, Square, Video } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from '@/hooks/use-toast'

import { commandsToAddMedia } from '@/lib/editor/actions'
import { RECORDING_MAX_BYTES, RECORDING_MAX_SECONDS } from '@/lib/editor/constants'
import {
  listRecordingDevices,
  pickMimeType,
  readRecordingDuration,
  recorderCapabilities,
  requestCameraStream,
  requestScreenStream,
  requestVoiceoverStream,
  recordingLimitState,
  StreamRecorder,
  stopStream,
  type RecordingKind,
  type ScreenAudioSource,
} from '@/lib/editor/media/recorder'
import {
  currentProjectToken,
  importRecordedFile,
  isProjectTokenCurrent,
  type ProjectToken,
} from '@/lib/editor/project-io'
import { useEditorStore } from '@/lib/editor/store'
import { cn } from '@/lib/utils'

const KIND_TITLE: Record<RecordingKind, string> = {
  voiceover: 'Record voiceover',
  screen: 'Record screen',
  camera: 'Record camera',
}

const KIND_HINT: Record<RecordingKind, string> = {
  voiceover: 'Records the selected microphone into the media bin.',
  screen: 'Records a screen, window, or tab with one audio source.',
  camera: 'Records the selected camera, with optional microphone audio.',
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60)
  return `${String(minutes).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function labelFor(device: MediaDeviceInfo, index: number): string {
  return device.label || `Device ${index + 1}`
}

/**
 * Local capture dialog (0.27.0). One audio source at a time: the screen mode
 * records system audio or the microphone, never both, because a microphone
 * hears the speakers and the mix would duplicate the system sound. Every take
 * imports through the normal media path and stores its bytes in OPFS when the
 * browser accepts the write.
 */
export function RecordingDialog({
  open,
  kind,
  onOpenChange,
}: {
  open: boolean
  kind: RecordingKind | null
  onOpenChange: (open: boolean) => void
}) {
  const isOpen = open && kind !== null
  const [status, setStatus] = useState<'idle' | 'recording' | 'saving'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [bytes, setBytes] = useState(0)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([])
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  const [microphoneId, setMicrophoneId] = useState('')
  const [cameraId, setCameraId] = useState('')
  const [screenAudio, setScreenAudio] = useState<ScreenAudioSource>('system')
  const [cameraMic, setCameraMic] = useState(true)
  const [placeAtPlayhead, setPlaceAtPlayhead] = useState(true)
  const [starting, setStarting] = useState(false)

  const recorderRef = useRef<StreamRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const finishingRef = useRef(false)
  /** Set before the first await so repeated Start clicks cannot race a status update. */
  const startingRef = useRef(false)
  /** Bumped on teardown, so a permission request that lands later is discarded. */
  const sessionRef = useRef(0)
  /** The project the take belongs to, captured before capture starts. */
  const takeTokenRef = useRef<ProjectToken | null>(null)
  /** Aborts a screen request while a pending prompt still owns the display. */
  const abortRef = useRef<AbortController | null>(null)

  const clearLevelTimer = useCallback(() => {
    if (levelTimerRef.current === null) return
    clearInterval(levelTimerRef.current)
    levelTimerRef.current = null
  }, [])

  const teardown = useCallback(() => {
    // Invalidate any permission request still in flight before stopping what
    // exists, so a late stream is never recorded with the dialog closed.
    sessionRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    takeTokenRef.current = null
    startingRef.current = false
    setStarting(false)
    clearLevelTimer()
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder) {
      // The recorder's cleanup stops every track; a second stopStream would
      // stop each track twice and break idempotence.
      recorder.cancel()
    } else {
      stopStream(streamRef.current)
    }
    streamRef.current = null
  }, [clearLevelTimer])

  useEffect(() => {
    if (!isOpen) return
    // Reset on a microtask: the effect body must not set state synchronously
    // (cascading-render lint), and the reset already lands in a promise.
    void Promise.resolve().then(() => {
      finishingRef.current = false
      startingRef.current = false
      takeTokenRef.current = null
      setStarting(false)
      setStatus('idle')
      setElapsed(0)
      setBytes(0)
      setLevel(0)
      setError(null)
      setNote(null)
    })
    void listRecordingDevices().then(({ microphones: mics, cameras: cams }) => {
      setMicrophones(mics)
      setCameras(cams)
    })
    return teardown
  }, [isOpen, kind, teardown])

  // An unpermissioned browser reports a default device with an empty id.
  // SelectItem refuses an empty value, and the placeholder already means
  // "default", so those entries are not rendered.
  const microphoneOptions = microphones.filter((device) => device.deviceId !== '')
  const cameraOptions = cameras.filter((device) => device.deviceId !== '')
  const capabilities = kind ? recorderCapabilities(kind) : null
  const supported = (() => {
    if (!capabilities?.mimeType || !capabilities.recorder) return false
    if (kind === 'voiceover') return capabilities.microphone
    if (kind === 'screen') return capabilities.screen
    return capabilities.camera
  })()

  const finish = async () => {
    if (finishingRef.current) return
    const recorder = recorderRef.current
    if (!recorder || !kind) return
    const session = sessionRef.current
    const takeToken = takeTokenRef.current
    // A project replacement or a teardown while any await is in flight makes
    // this completion stale: the take must not attach to a later project.
    const stale = () =>
      session !== sessionRef.current || (takeToken !== null && !isProjectTokenCurrent(takeToken))
    finishingRef.current = true
    setStatus('saving')
    setLevel(0)
    clearLevelTimer()
    // Firefox writes audio-only WebM without a duration and cannot seek it, so
    // the take's own clock is the fallback when the container cannot be read.
    const measured = recorder.elapsedSeconds
    try {
      const file = await recorder.stop()
      // Read after stop: the hard ceiling drops a chunk inside the data handler
      // before the take finalizes, so the flag is settled here.
      const limitHit = recorder.reachedByteLimit
      recorderRef.current = null
      // The recorder's finalize already stopped the tracks.
      streamRef.current = null
      if (stale()) {
        setStatus('idle')
        return
      }
      if (!file) {
        // A first chunk larger than the whole ceiling leaves nothing to save;
        // silence here would look like a take that never started.
        if (limitHit) {
          setError(
            `The recording reached the ${Math.round(
              RECORDING_MAX_BYTES / (1024 * 1024),
            )} MB limit before a chunk could be saved. Try a shorter take or a smaller capture size.`,
          )
        }
        setStatus('idle')
        return
      }
      const duration = (await readRecordingDuration(file)) ?? (measured > 0 ? measured : null)
      if (stale()) {
        setStatus('idle')
        return
      }
      if (duration === null) {
        setError('The recording has no readable duration, so it was not added.')
        setStatus('idle')
        return
      }
      const asset = await importRecordedFile(file, duration)
      if (stale()) {
        setStatus('idle')
        return
      }
      if (!asset) {
        setError('The recording could not be added to the project.')
        setStatus('idle')
        return
      }
      if (limitHit) {
        toast({
          title: 'Recording stopped at the recording limit',
          description: `Your recording is ready to save. A chunk that would have crossed the ${Math.round(
            RECORDING_MAX_BYTES / (1024 * 1024),
          )} MB ceiling was left out, so its end may be missing.`,
        })
      }
      if (kind === 'voiceover' && placeAtPlayhead) {
        const store = useEditorStore.getState()
        const path = store.activeSequencePath
        let placed = true
        let reason = 'The recording is in the media bin.'
        try {
          const commands = commandsToAddMedia(
            store.doc,
            asset,
            store.playhead,
            undefined,
            store.untargetedTracks,
            path[path.length - 1],
          )
          if (!commands) placed = false
          else if (!store.apply(commands)) placed = false
        } catch (placeError) {
          placed = false
          reason = placeError instanceof Error ? placeError.message : String(placeError)
        }
        if (!placed) {
          toast({
            title: 'Recording saved but not placed',
            description: reason,
            variant: 'destructive',
          })
          setStatus('idle')
          onOpenChange(false)
          return
        }
      }
      if (!limitHit) toast({ title: 'Recording added', description: asset.name })
      setStatus('idle')
      onOpenChange(false)
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError))
      setStatus('idle')
      teardown()
    } finally {
      finishingRef.current = false
    }
  }

  const start = async () => {
    if (!kind || status !== 'idle' || startingRef.current) return
    startingRef.current = true
    setStarting(true)
    const session = ++sessionRef.current
    takeTokenRef.current = currentProjectToken()
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setNote(null)
    try {
      let stream: MediaStream
      let warnings: string[] = []
      if (kind === 'voiceover') {
        stream = await requestVoiceoverStream(microphoneId || undefined)
      } else if (kind === 'camera') {
        stream = await requestCameraStream(
          cameraId || undefined,
          microphoneId || undefined,
          cameraMic,
        )
      } else {
        const screen = await requestScreenStream(
          screenAudio,
          microphoneId || undefined,
          () => session !== sessionRef.current,
          controller.signal,
        )
        stream = screen.stream
        warnings = screen.warnings
      }
      if (session !== sessionRef.current) {
        // The dialog closed while permission was pending: release the late
        // stream and never construct a recorder.
        stopStream(stream)
        return
      }
      const mimeType = capabilities?.mimeType ?? pickMimeType(kind)
      if (!mimeType) {
        stopStream(stream)
        throw new Error('This browser cannot record in a supported format')
      }
      streamRef.current = stream
      if (warnings.length > 0) setNote(warnings.join(' '))
      const recorder = new StreamRecorder(stream, kind, mimeType, {
        onTick: (seconds, buffered) => {
          setElapsed(seconds)
          setBytes(buffered)
        },
        onFinished: () => {
          // The cap, the hard ceiling, or the browser itself can end the take
          // before Stop is pressed. A null file still resets the dialog, so a
          // take with nothing to save cannot sit there looking like it is
          // still recording.
          if (session !== sessionRef.current) return
          void finish()
        },
        onError: (recorderError) => {
          setError(recorderError.message)
          setStatus('idle')
          teardown()
        },
      })
      recorderRef.current = recorder
      // The browser's own stop-sharing control ends the video track; finish
      // the take once, exactly like the Stop button.
      for (const track of stream.getVideoTracks()) {
        track.addEventListener('ended', () => void finish())
      }
      recorder.start()
      setStatus('recording')
      levelTimerRef.current = setInterval(() => setLevel(recorder.level()), 100)
      void listRecordingDevices().then(({ microphones: mics, cameras: cams }) => {
        setMicrophones(mics)
        setCameras(cams)
      })
    } catch (startError) {
      if (session !== sessionRef.current) return
      teardown()
      setError(startError instanceof Error ? startError.message : String(startError))
    } finally {
      // A superseded start must not clear the flag for the take that replaced it.
      if (session === sessionRef.current) {
        startingRef.current = false
        setStarting(false)
      }
    }
  }

  const limit = recordingLimitState(elapsed, bytes)
  const micSelect = (
    <div className="space-y-1">
      <Label className="text-xs">Microphone</Label>
      <Select value={microphoneId} onValueChange={setMicrophoneId}>
        <SelectTrigger className="h-8" aria-label="Microphone">
          <SelectValue placeholder="Default microphone" />
        </SelectTrigger>
        <SelectContent>
          {microphoneOptions.map((device, index) => (
            <SelectItem key={device.deviceId} value={device.deviceId}>
              {labelFor(device, index)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (next) return
        // Closing mid-save would abandon an import that already left the
        // recorder; keep the dialog until the file lands.
        if (status === 'saving') return
        teardown()
        setStatus('idle')
        onOpenChange(false)
      }}
    >
      <DialogContent className="sm:max-w-md" data-testid="recording-dialog">
        <DialogHeader>
          <DialogTitle>{kind ? KIND_TITLE[kind] : 'Record'}</DialogTitle>
          <DialogDescription>{kind ? KIND_HINT[kind] : ''}</DialogDescription>
        </DialogHeader>

        {!supported && kind && (
          <p className="text-xs text-destructive" data-testid="recording-unsupported">
            This browser cannot record {kind === 'camera' ? 'from a camera' : kind}.
          </p>
        )}

        {supported && status === 'idle' && kind && (
          <div className="space-y-3">
            {kind === 'camera' && (
              <div className="space-y-1">
                <Label className="text-xs">Camera</Label>
                <Select value={cameraId} onValueChange={setCameraId}>
                  <SelectTrigger className="h-8" aria-label="Camera">
                    <SelectValue placeholder="Default camera" />
                  </SelectTrigger>
                  <SelectContent>
                    {cameraOptions.map((device, index) => (
                      <SelectItem key={device.deviceId} value={device.deviceId}>
                        {labelFor(device, index)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {kind === 'screen' && (
              <div className="space-y-1">
                <Label className="text-xs">Audio source</Label>
                <Select
                  value={screenAudio}
                  onValueChange={(value) => setScreenAudio(value as ScreenAudioSource)}
                >
                  <SelectTrigger className="h-8" aria-label="Screen audio source">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">System audio</SelectItem>
                    <SelectItem value="microphone" disabled={!capabilities?.microphone}>
                      {capabilities?.microphone ? 'Microphone' : 'Microphone (unavailable)'}
                    </SelectItem>
                    <SelectItem value="none">No audio</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  One source only. System audio and the microphone are not mixed.
                </p>
                {!capabilities?.microphone && (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    This browser cannot record microphone audio. Use system audio or no audio.
                  </p>
                )}
              </div>
            )}
            {(kind === 'voiceover' ||
              (kind === 'camera' && cameraMic) ||
              (kind === 'screen' && screenAudio === 'microphone')) &&
              micSelect}
            {kind === 'camera' && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={cameraMic}
                  onChange={(event) => setCameraMic(event.target.checked)}
                  aria-label="Record microphone with camera"
                />
                Record microphone with camera
              </label>
            )}
            {kind === 'voiceover' && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={placeAtPlayhead}
                  onChange={(event) => setPlaceAtPlayhead(event.target.checked)}
                  aria-label="Place voiceover at the playhead"
                />
                Place at the playhead after recording
              </label>
            )}
            {kind === 'screen' && (
              <p className="text-[11px] text-muted-foreground">
                Choosing system audio in the picker shares this tab, a window, or the whole screen.
              </p>
            )}
          </div>
        )}

        {status !== 'idle' && (
          <div className="space-y-3" data-testid="recording-progress">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Circle className="size-3 fill-rose-500 text-rose-500" />
                {status === 'recording' ? 'Recording' : 'Saving'}
              </span>
              <span className="text-sm tabular-nums">{formatClock(elapsed)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded bg-border">
              <div
                className="h-full bg-sky-400 transition-[width]"
                style={{ width: `${Math.round(level * 100)}%` }}
                aria-hidden="true"
              />
            </div>
            <p className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{formatSize(bytes)}</span>
              <span>
                Stops at {formatClock(RECORDING_MAX_SECONDS)} or{' '}
                {Math.round(RECORDING_MAX_BYTES / (1024 * 1024))} MB
              </span>
            </p>
            {limit === 'warning' && status === 'recording' && (
              <p className="text-[11px] text-amber-400">
                Approaching the recording limit. The take stops and saves automatically.
              </p>
            )}
          </div>
        )}

        {note && (
          <p className="text-xs text-amber-400" data-testid="recording-note">
            {note}
          </p>
        )}
        {error && (
          <p className="text-xs text-destructive" data-testid="recording-error">
            {error}
          </p>
        )}

        <DialogFooter>
          {status === 'recording' ? (
            <Button
              variant="destructive"
              className="gap-1.5"
              data-testid="recording-stop"
              onClick={() => void finish()}
            >
              <Square className="size-3.5" />
              Stop
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={status === 'saving'}
              >
                Cancel
              </Button>
              <Button
                className={cn('gap-1.5')}
                data-testid="recording-start"
                onClick={() => void start()}
                disabled={!supported || status === 'saving' || starting}
              >
                {status === 'saving' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : kind === 'voiceover' ? (
                  <Mic className="size-3.5" />
                ) : kind === 'camera' ? (
                  <Video className="size-3.5" />
                ) : (
                  <Monitor className="size-3.5" />
                )}
                Start recording
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

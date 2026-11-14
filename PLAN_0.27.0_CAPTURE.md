# 0.27.0 capture

**Created:** 2026-11-12
**Complexity:** High
**Effort:** L
**Schema:** 8, no bump
**Depends on:** 0.23.0 for media; sequenced after 0.26.0
**Status:** implemented, real-browser pass recorded in docs/testing.md, awaiting the manual hardware pass

## 1. Goal

Add local recording without a backend:

- Voiceover recording from the microphone.
- Screen recording with optional system audio.
- Camera recording with optional microphone audio.

Every recording becomes a normal media asset through the existing import pipeline and is stored in
OPFS. There is no new project field, no server, and no upload.

## 2. Anti-goals

- No teleprompter, countdown studio, or multi-scene recorder.
- No live streaming or remote guest recording.
- No cloud upload, transcription, noise removal, or auto captions on the recording.
- No editing while a recording is in progress.
- No background recording after the dialog closes.
- No new media kind. Recordings are ordinary video or audio assets.
- No schema bump.

## 3. Current state, verified

- The app has no `getUserMedia`, `getDisplayMedia`, or `MediaRecorder` usage. The old MediaRecorder
  export path was retired in favor of WebCodecs (`src/lib/editor/export/mp4.ts:86`).
- Import accepts `video/*`, `audio/*`, and `image/*` and probes WebM, MP4, MOV, and other containers
  (`src/lib/editor/media/probe.ts`).
- 0.23.0 provides OPFS persistence and rehydration, so a recording survives reload.
- Browser APIs belong in `src/lib/editor/media/`, not the pure state core.
- The media bin already imports files and adds assets. Recording should reuse that path, not add a
  second asset factory.

## 4. Technical approach

### Recorder module

Add a browser-bound recorder module under `src/lib/editor/media/`:

- Capability detection for `getUserMedia`, `getDisplayMedia`, and `MediaRecorder`.
- Device enumeration for microphones and cameras, with permission-aware labels.
- MIME type selection from `MediaRecorder.isTypeSupported`, with a documented fallback order.
- Start, pause if supported, stop, cancel, timer, and level meter hooks.
- A single cleanup function that stops every track and releases the stream.

Prefer WebM with VP9 or VP8 plus Opus for screen and camera, and WebM Opus for voiceover. If the
browser reports MP4 support, accept it. Do not transcode during recording.

### Duration metadata

MediaRecorder writes a WebM segment without a duration in its header, so a `<video>` element reports
`Infinity` and `sanitizeDuration` turns it into 0 (`src/lib/editor/media/probe.ts:160`). A recording
imported that way fails the minimum clip duration and is unusable.

Before import, obtain a finite duration:

1. Load the recording blob in a temporary video element.
2. If `duration` is not finite, seek to a very large time, wait for `timeupdate`, read the resulting
   duration, and reset the element to 0.
3. Build the `File` only after a finite duration exists. If it still cannot be read, refuse the import
   with a clear message and do not add the asset to the bin.

The blob's header is unchanged, so `importFile` would read the same `Infinity` and store 0. Pass the
verified duration as an explicit hint: extend `importFile(file, { durationHint })` and pass it into the
probe's video or audio import before `sanitizeDuration`. Read the raw `el.duration`: when it is finite
and positive, keep it; otherwise use the validated hint, then run `sanitizeDuration` as the final guard.
Validate the hint as finite and positive. Do not compare against the sanitized value, because 0 is
finite. The imported asset's serialized duration becomes the source of truth after import. Leave the
stored file header unchanged.

After reload, preview seeking and export must use that serialized duration. Exercise the playhead at
the start, middle, and end of a real recording, then export it. If seeking or export fails, fix the
playback or export duration plumbing; never rewrite the stored bytes to add a header.

MP4 recordings from Safari carry a duration and skip the repair. Test with a real MediaRecorder
fixture, not a synthetic WebM, so the missing header is actually covered.

### Voiceover

Flow:

1. Open a small dialog with a microphone select and a level meter.
2. Request microphone permission only when the user starts.
3. Record to chunks with a timer.
4. On stop, build a `File` with the detected MIME type and a clear name.
5. Import through `importFile`, which writes OPFS and probes duration and audio.
6. Add the asset to the media bin.
7. Offer to place it at the playhead on an audio track. If the user declines, it stays in the bin.

Do not create a clip until the import succeeds. If the user cancels, discard the chunks and stop the
stream.

### Screen recording

Flow:

1. Open a dialog with screen, microphone, and system-audio options. If every audio option is off,
   request video only and record without audio.
2. Call `getDisplayMedia` with video and, when supported, audio.
3. The user picks exactly one audio source: system audio, the microphone, or none. Microphone mode
   requests display video without audio and adds the microphone track to the same MediaStream.
   MediaRecorder then encodes one audio track, with no Web Audio mix and no echo.
4. Show a recording indicator and timer, and a stop control.
5. Stop when the user stops or when the shared track ends.
6. Import the result and add it to the bin.

Handle the browser's own stop-sharing control. The track `ended` event must stop the recorder and
finish the import once, not twice.

### Camera recording

Flow:

1. Open a dialog with camera and microphone selects and an audio toggle.
2. Request the camera always. When audio is on, request the microphone too; when off, request a
   video-only stream.
3. Record the selected tracks. With audio off, the result is a video-only asset with no audio track.
4. Stop, import, and add to the bin.

If the camera is unavailable, show the permission or device error. Do not silently fall back to audio.

### File naming and metadata

Use a deterministic name such as `Voiceover 2026-11-12 14-30-05.webm` or
`Screen recording 2026-11-12 14-30-05.webm`. Use the local time for the display name, not for any
persisted id. Do not put the recording date in the document schema.

### Memory and duration

MediaRecorder chunks live in memory until stop. Bound that memory with a hard recording limit: stop
capture at 10 minutes or 512 MiB of accumulated chunks, whichever comes first, and preserve the chunks
already recorded so the user can save them. Show the live duration and approximate size, warn at 80%
of either limit, and at the limit stop the recorder once, finalize the import, and show "Recording
stopped at the recording limit. Your recording is ready to save." The warning is not the safeguard;
the recorder must stop before the memory bound is exceeded. If a later release streams chunks to
OPFS, raise the cap only after that path is proven, and keep a documented limit until then.

### Cleanup

Every path, including permission denial, track end, dialog close, import failure, and component
unmount, must:

- Stop every track in the stream.
- Stop the recorder exactly once.
- Clear the timer and level meter.
- Drop the chunks after a successful or cancelled recording.
- Close the dialog and restore the editor state.

No stream may survive the dialog. Test this with mocks that count `stop()` calls.

## 5. File plan

New files:

- `src/lib/editor/media/recorder.ts`, the capability, stream, and MediaRecorder wrapper.
- UI components for the voiceover, screen, and camera dialogs.
- A small hook for the recording lifecycle if the dialog logic would otherwise duplicate.

Expected modified files:

- `src/components/editor/MediaBin.tsx` or the menu bar for recording entries.
- `src/lib/editor/media/probe.ts` for the optional `durationHint` parameter, or only if the recorded
  MIME type needs a new extension mapping. Keep the duration repair in the recorder module so
  `sanitizeDuration` stays a finite-only guard.
- `src/lib/editor/__tests__/` for the mocked recorder lifecycle and dialog states.
- `docs/architecture.md`, `docs/flows.md`, `README.md`, `docs/testing.md`, `docs/deployment.md`.

No changes to `Doc`, `SERIALIZATION_VERSION`, or the command catalog unless the placement reuses an
existing add-media action.

## 6. Phases and verification

### Phase 1: recorder wrapper

- Add capability detection, MIME selection, start, stop, duration repair, and cleanup.
- Write the mocked lifecycle tests first.
- Verify stop is idempotent.
- Verify every track is stopped on success, cancel, denial, and unmount.
- Verify a stream returned after cancel or unmount is stopped and the recorder never starts.
- Verify a MediaRecorder WebM with no duration header imports with a finite duration, and an
  unreadable duration refuses before the asset is added.
- Verify only a positive finite raw probe duration keeps the probe's value; zero, negative, and
  non-finite durations use the hint. Add an explicit zero-duration case and a durationless WebM.

### Phase 2: voiceover

- Add the dialog and microphone flow.
- Verify permission denial, device loss, cancel, and import failure.
- Verify a successful recording imports once and appears in the bin.
- Verify the optional placement uses the existing add-media path.

### Phase 3: screen recording

- Add the display picker, system audio option, and microphone option.
- Verify the `ended` event finishes once.
- Verify unsupported audio options are disabled, not silently ignored.
- Verify a cancelled picker leaves no stream.

### Phase 4: camera recording

- Add the camera and microphone flow.
- Verify camera denial, microphone denial, and combined recording.
- Verify every camera and microphone track is stopped and released on close.

### Phase 5: docs, manual proof, release cut

- Update the recording flow and browser support.
- Run `bun run check`.
- Run a headed browser proof with a fake or real device. Screen capture permissions may not be
  automatable; record what was manual.
- Run `bun run battery:pair` for the release verdict; keep the device proof manual.
- Apply the atomic 0.27.0 bump from the master plan.

## 7. Tests and locks

- Capability detection: missing API, missing recorder, unsupported MIME.
- Lifecycle: start, stop, cancel, unmount, permission denial, a permission request that resolves after
  cancel or unmount stops every late track and does not start recording, track ended, import failure,
  double stop.
- Cleanup: every track stopped, recorder stopped once, timer cleared, chunks dropped.
- Duration: a real MediaRecorder WebM with no duration header imports finite; the hint applies only
  when the raw probe duration is non-finite, and a finite probe duration wins; an unreadable duration
  refuses without adding an asset; after reload, seeking at the start, middle, and end and exporting
  all use the serialized duration, and the stored header is unchanged.
- Memory: the 80% warning appears, and the cap stops recording once, preserves the recorded chunks,
  and imports them.
- Voiceover: one asset, correct kind, OPFS write, optional clip placement.
- Screen: video track, optional system audio, microphone policy, ended event once.
- Camera: video and audio tracks when audio is on, video-only when audio is off, preview cleanup,
  device errors.
- Static locks: recording imports through `importFile`, not a second asset constructor.
- Manual proof: record a short voiceover, screen capture, and camera clip, reload, and play each.

## 8. Atomic release cut

Follow section 7 of `MASTER_PLAN.md`. The 0.27.0 commit must update:

- `package.json` to `0.27.0`.
- `src/lib/releases.ts` with four or more highlights and the actual ISO date.
- `CHANGELOG.md` with `## [0.27.0] - YYYY-MM-DD`.
- `ROADMAP.md` with the shipped row and intro sentence. No Premiere gap status change.
- `README.md` recording features and browser limitations.
- `docs/flows.md` voiceover, screen, and camera contracts.
- `docs/architecture.md` recorder module and media lifecycle notes.
- `docs/deployment.md` permissions and browser support.
- `docs/testing.md` for the mocked lifecycle tests and manual proof record.

Do not bump the schema. If a recording needs a persisted field, stop and re-plan.

## 9. Rollback

Revert the single release commit. Recordings already imported are ordinary assets and remain usable.
The recorder is an additive UI surface, so hiding its menu entries is a safe temporary mitigation.

## 10. Risks and decisions

- **Leaked streams.** The highest-risk defect. One cleanup function and tests that count stops.
- **WebM duration.** MediaRecorder output can report `Infinity`, and the probe turns that into 0.
  Repair the duration before import and test a real fixture. Do not special-case the editor's clip
  validation to accept a zero-length recording.
- **System audio support.** Browser and platform dependent. When the picker shares no audio track,
  the take records video only and the dialog says so. The option is never silently ignored.
- **Microphone mixing.** Decided: never mix. Screen capture carries one audio source, chosen in the
  dialog. A microphone hears the speakers, so a system-plus-mic mix would contain the system sound
  twice; without gain and monitoring it ships bad audio. The microphone track is added to the display
  stream directly, which needs no Web Audio and encodes one track.
- **Memory.** Decided: stop at 10 minutes or 512 MiB, warning at 80 percent. MediaRecorder buffers
  every chunk until stop, and building the File can roughly double peak memory, so 512 MiB already
  approaches 1 GiB transiently. Explicit bitrates of 6 Mbps video and 128 kbps audio keep ten minutes
  under the byte cap, which makes the time cap the normal stop. The trigger fires at 480 MiB so the
  final chunks normally fit, and a chunk that would still cross 512 MiB is dropped: the take keeps
  the chunks recorded before it and the dialog says its end may be missing. That keeps the buffer
  bounded even when a browser flushes one large final chunk.
- **Device proof.** Decided: the release verdict includes one real voiceover, screen, and camera take
  on the release machine. The OS pickers and hardware cannot be automated, so mocks prove the
  lifecycle but not the integration. A fake-device pass in Chromium 157 and Firefox 160 covered the
  dialogs, import, OPFS restore, playback, and one Chromium export; results are recorded in
  `docs/testing.md`. That pass found the Firefox muxed-codec failure, which is fixed by choosing the
  video-only MIME type for a video-only stream, and the audio-only duration gap, which falls back to
  the recorder clock.
- **Permissions.** A denied permission is a normal path with a clear message, not a crash.

## 11. Definition of done

- Voiceover, screen, and camera recordings import through the normal media path.
- Recordings are stored in OPFS and survive reload where the browser accepts the write; a session-only
  take offers Download a copy before reload.
- Every cancel, denial, ended track, and unmount cleans up completely.
- Unsupported audio and device options are disabled with a clear reason.
- `bun run check` and `bun run battery:pair` are green; the manual browser proof is recorded before
  the release commit.
- The 0.27.0 version bump is atomic in one commit.

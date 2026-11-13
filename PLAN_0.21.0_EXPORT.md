# 0.21.0 export and framing

**Created:** 2026-11-12
**Complexity:** Medium
**Effort:** L
**Schema:** 4, no bump
**Depends on:** 0.20.2
**Status:** implemented (2026-11-13)

## 1. Goal

Close the delivery gaps without touching the project format:

- Audio-only export as WAV, MP3 when the browser can encode it, and AAC in an MP4 container.
- MOV and MKV video export alongside MP4.
- Custom video bitrate and custom output resolution.
- Aspect ratio presets in Sequence Settings for 16:9, 9:16, 1:1, 4:5, 4:3, and 21:9.

The release is one commit and one version bump. It does not change `Doc` or `SERIALIZATION_VERSION`.

## 2. Anti-goals

- No WebM export. VP8, VP9, AV1, and Opus need a separate codec probe and test matrix.
- No GIF export. It needs an encoder dependency.
- No custom output frame rate. It changes frame count and audio duration.
- No auto reframe, smart crop, or subject tracking. Presets only change project dimensions.
- No new export presets UI beyond the controls above.
- No change to the existing H.264/AAC MP4 defaults.

## 3. Current state, verified

- `ExportOptions` carries only `quality`, `fileStream`, and `fileName` (`src/lib/editor/export/mp4.ts:110`).
- `createExportOutput` always builds `Mp4OutputFormat` (`src/lib/editor/export/mp4.ts:1036`).
- `exportTimeline` reads project width, height, and fps, creates a canvas at project size, adds a
  `CanvasSource` with codec `avc`, and adds audio only when `renderAudioMix` returns a buffer
  (`src/lib/editor/export/mp4.ts:1109`).
- `pickAudioCodec` chooses AAC when available, Opus otherwise (`src/lib/editor/export/mp4.ts:1281`).
- The dialog offers only low, medium, and high quality, and its file picker accepts only
  `video/mp4` (`src/components/editor/ExportDialog.tsx:67`, `:96`, `:208`).
- Sequence Settings edits name, width, height, and fps, with no presets
  (`src/components/editor/MenuBar.tsx:579`).
- The installed `mediabunny` 1.58.1 exports `MovOutputFormat`, `MkvOutputFormat`, `Mp3OutputFormat`,
  `WavOutputFormat`, and `Mp4OutputFormat`. Container support is not the blocker.

## 4. Technical approach

### Export options

Add a small pure format matrix that maps a container choice to its output format, file extension, MIME
type, and supported codecs. Keep it Node-testable and add it to the coverage include list if it becomes
its own module.

Proposed option surface:

- `container`: `mp4`, `mov`, `mkv`, `wav`, `mp3`, or `m4a`.
- `videoBitrate`: optional bits per second, clamped to a documented range.
- `width` and `height`: optional output dimensions, clamped and normalized to even numbers for H.264.
- `audioOnly`: derived from the container, not a separate toggle.

The existing `quality` presets remain the default bitrate source when `videoBitrate` is absent.

### Containers

- MP4 and MKV carry H.264 video with AAC audio or the existing Opus fallback. MKV with H.264/AAC is
  valid. Do not add a VP9 path in this release.
- MOV uses the same video source. Prefer AAC; when AAC is unavailable, either label the audio as Opus
  in the dialog or disable MOV for strict QuickTime compatibility. Do not silently imply plain MOV
  compatibility.
- Audio-only WAV uses a PCM audio source. MP3 is enabled only when the browser can encode MP3; probe
  it with the existing audio encoder probe pattern and disable the option when unsupported. M4A
  requires AAC; disable it when `canEncodeAudio('aac')` is false rather than muxing Opus under an
  `.m4a` name.
- The existing streamed sink writes `{ type: 'write', data, position }` through
  `FileSystemWritableFileStream`, so a WAV header can be backfilled after the samples. Keep the
  streamed path and its 100 MB hint. If a target cannot seek, fall back to the buffered sink and its
  existing size warning.
- Audio-only export must not require `VideoEncoder`. It should run when `AudioEncoder` exists even if
  video encoding is unavailable.
- Audio-only export requires an audible mix. When `renderAudioMix` returns `null`, disable WAV, MP3, and
  M4A in the dialog with an explanation, and keep a backstop refusal in the export path. Never write a
  WAV, MP3, or M4A container without an audio track. A silent timeline is exported as video or with
  audio added first.

### Custom resolution

Keep the frame plan and compositor at project dimensions. Render each frame to the project-size
canvas, then draw that canvas into an output-size canvas with a contain fit and black bars. Do not
stretch the picture. This keeps transitions, effects, mattes, and text geometry unchanged.

Normalize output width and height to even numbers. Reject non-finite, zero, negative, or over-cap
values at the dialog and again in the exporter. Choose one cap, document it, and test it.

### Aspect ratio presets

Add a preset select to Sequence Settings. A preset sets width and height only. It does not move,
scale, or reframe existing clips, and it does not touch the schema. Show a short note that existing
clip positions are absolute so the user is not surprised when a 16:9 edit is switched to 9:16.

Presets:

- 16:9 at 1920 by 1080
- 9:16 at 1080 by 1920
- 1:1 at 1080 by 1080
- 4:5 at 1080 by 1350
- 4:3 at 1440 by 1080
- 21:9 at 2560 by 1080

Keep the current custom width and height fields. The preset select is a shortcut, not a replacement.

### Dialog

Add container, resolution, and bitrate controls. Update the save picker types and suggested extension
for every container. Update the Download MIME type and filename. Keep the existing streamed export path
and its 100 MB hint.

Update the size estimate for the chosen bitrate and resolution, or label it approximate when the
estimate cannot account for the new controls.

## 5. File plan

New files, only if the format matrix is split out:

- `src/lib/editor/export/options.ts`, the pure container and option matrix.

Expected modified files:

- `src/lib/editor/export/mp4.ts`: container selection, audio-only path, resolution canvas, bitrate.
- `src/components/editor/ExportDialog.tsx`: controls, validation, picker types, filenames.
- `src/components/editor/MenuBar.tsx`: aspect ratio preset select.
- `src/lib/editor/export/offline.ts`: size estimate if the current estimate becomes misleading.
- `src/lib/editor/__tests__/export.test.ts` or the existing export test files.
- `src/lib/editor/__tests__/` UI locks for the dialog and Sequence Settings.
- `docs/flows.md`, `docs/architecture.md`, `README.md`, and `docs/testing.md`.

## 6. Phases and verification

### Phase 1: option matrix

- Add the pure container and option validation.
- Verify a red test fails before the matrix exists, then passes.
- Cover unsupported container, invalid dimensions, odd dimensions, invalid bitrate, and unknown values.

### Phase 2: audio-only

- Add WAV, MP3, and M4A paths without a video track.
- Verify an audio-only export succeeds with a mock `AudioEncoder` and no `VideoEncoder`.
- Verify a streamed WAV backfills a valid RIFF header and reopens with the expected duration and byte
  size; verify a non-seekable sink falls back to the buffered path with its size warning.
- Verify MP3 is disabled when the encoder probe fails.
- Verify WAV, MP3, and M4A are disabled when the timeline has no audible mix, and a forced export call
  refuses without writing a file.
- Verify progress and cancellation still work.

### Phase 3: MOV and MKV

- Add both containers through the existing H.264/AAC sources.
- Verify extension, MIME type, streamed filename, and Download blob type.
- Verify a short timeline exports and reopens in the artifact browser.

### Phase 4: resolution and bitrate

- Add the output canvas, contain fit, even-dimension normalization, and bitrate override.
- Verify project geometry is unchanged and the output dimensions match the request.
- Verify a non-matching aspect ratio produces black bars, not stretched content.
- Verify the bitrate is clamped and the quality preset remains the default.

### Phase 5: aspect presets

- Add the preset select and the absolute-position note.
- Verify each preset writes the expected width and height.
- Verify a custom width or height still works and the preset does not mutate clips.

### Phase 6: docs and release cut

- Update the export and project settings docs.
- Run `bun run check`.
- Run `bun run battery:pair`.
- Apply the atomic 0.21.0 bump from the master plan.

## 7. Tests and locks

- Format matrix: every container, extension, MIME type, audio-only flag, and unsupported combinations.
- Validation: non-finite, zero, negative, odd, over-cap width and height; non-finite and over-cap
  bitrate; unknown container.
- Audio-only: no video source is added, no `VideoEncoder` is required, audio is present, no audible
  mix disables the containers and refuses an export without writing a file, cancellation aborts the
  sink, a streamed WAV reopens with a valid header and size fields, a non-seekable sink falls back.
- Resolution: output canvas size, contain fit, black bars, even normalization, no change to the frame
  plan.
- Bitrate: override wins over the preset, preset remains the default, value is clamped.
- Dialog: container options, disabled MP3 when unsupported, disabled M4A when AAC is unavailable, MOV
  Opus label, filename and picker type, validation errors.
- Sequence Settings: presets set the expected dimensions, custom values survive, no clip mutation.
- Static locks: the dialog and menu use the shared option helpers, not duplicate mappings.

## 8. Atomic release cut

Follow section 7 of `MASTER_PLAN.md`. The 0.21.0 commit must update:

- `package.json` to `0.21.0`.
- `src/lib/releases.ts` with four or more highlights and the actual ISO date.
- `CHANGELOG.md` with `## [0.21.0] - YYYY-MM-DD`.
- `ROADMAP.md` with the shipped row and intro sentence. No Premiere gap status changes.
- `README.md` export and Sequence Settings paragraphs.
- `docs/flows.md` export flow, `docs/architecture.md` export module notes, and `docs/testing.md` if
  tests or coverage scope changed.
- `docs/seo.md` and `docs/deployment.md` only with the new battery record.

Do not bump the schema. Do not add WebM or GIF.

## 9. Rollback

Revert the single release commit. Exported files are plain media and have no migration to undo. If a
format path is broken in production, remove its option from the dialog first, then revert the commit.

## 10. Risks and decisions

- MP3 encoding may be unavailable in some browsers. The correct behavior is a disabled option, not a
  runtime failure after the user picks it.
- MOV and MKV playback compatibility varies by player. State the container support plainly in the
  dialog and docs.
- Custom resolution with a different aspect ratio is a fit, not a crop. Do not imply smart reframe.
- Aspect presets change the canvas only. Do not silently move clips.

## 11. Definition of done

- MP4, MOV, MKV, WAV, and M4A export pass in the mocked suite.
- MP3 is either proven available or cleanly disabled.
- Audio-only export works without a video encoder.
- Custom resolution and bitrate are validated at the UI and the exporter.
- Aspect presets set dimensions without mutating clips.
- `bun run check` and `bun run battery:pair` are green.
- The 0.21.0 version bump is atomic in one commit.

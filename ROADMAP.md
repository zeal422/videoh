# Roadmap: feature gaps vs Adobe Premiere Pro

How the app compares with a desktop NLE today, and what is still missing. Two
questions, two sections: what has shipped (so a closed gap is not listed twice)
and what remains, grouped by how often a working editor would feel it.

Research date: September 2026 (Premiere 26.x); every status re-verified against
the code on 2026-10-07, at 0.7.0. A gap moves to "Shipped" only once the release
that closed it is recorded in [CHANGELOG.md](CHANGELOG.md).

The editing core is not tracked as a gap: the multi-track timeline, trim / split
/ razor, A/V linking, ripple delete, cross-dissolves, text overlays, gain / mute,
undo and project save / load all exist today.

## Shipped so far

Newest first. Releases before 0.5.0 are in [CHANGELOG.md](CHANGELOG.md).

| Version   | What landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.7.0** | The rest of the Tier 1 bundle: 3D `.cube` LUT import (a project-level library, one copy per unique file, with 1D cubes applied as exact per-channel shapers and 3D cubes run through a shared per-frame pixel pass in the preview and the export alike), a waveform and a vectorscope beside the existing histogram and RGB-balance meters, and frame blending for sub-frame-rate clips in BOTH render paths (the export decodes the pair, the monitor parks a muted second element on it, and one shared weight function grades the two). With those three units the colour and offline-export rows close, and speed / time remapping loses its last partial cell. Three items are recorded as non-goals instead of built: ProRes (no browser encoder), HEVC (a value call, not a platform limit) and spectral or learned noise reduction. |
| **0.6.4** | The Keyframes gap closes: the Effect Controls graph draws every segment's real bezier curve, the active segment's two handles drag (or arrow-nudge) to shape it beyond the presets, and each property can store a default easing that stamps newly authored keyframes. The easing picker now edits the active segment's start keyframe and is visible on unanimated rows too.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **0.6.3** | Trust hardening on the export, the easing UI and the battery. A video clip with no linked twin exports its embedded audio, a manually linked video part keeps its own sound, and a timeline whose only clips are muted, reversed or rate-dropped exports no audio track at all, so the mix can no longer disagree with the preview. Auto-ducking resolves each dialogue clip once instead of once per sample, the eased-segment solve shares the bezier solver, and the battery asserts the exported stream layout before and after muting.                                                                                                                                                                                                                                                                                                 |
| **0.6.2** | Trust hardening on linked audio and the export gate. A/V pairs whose halves disagree on rate (a curve, a flat constant, or plain Speed) go silent in preview, export and ducking alike, while equal speeds keep playing; clips whose media stops resolving release their elements instead of ghosting; the export gate checks the clips the export uses rather than the media bin; a flat time-remap curve exports audio of the right length; and hydration drops a `timeScale` curve a picture-less clip could only ever silence. No Premiere gap closed.                                                                                                                                                                                                                                                                                  |
| **0.6.1** | Trust hardening on top of Tier 1: exact frames through reversed and time-remapped trims (head, tail, split and rate stretch), playback cleanup for deletes and relinks, an honest export (offline gate, encoder released on cancel, preview-matching EQ and eased volume), and speed / time-remapping controls that report the rate the engine applies.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **0.6.0** | The Tier 1 bundle: keyframe easing (easeIn / easeOut / easeInOut cubic bezier, editable per keyframe), speed curves (a keyframed `timeScale` with time-remap semantics, edited in Effect Controls, reversed clips included), temperature / tint grading (one SVG `feColorMatrix` shared by the preview and the export) with luma and RGB-balance scopes in the monitor, and broadband noise reduction (a fixed high-pass / low-pass / hiss-cut chain in both audio paths).                                                                                                                                                                                                                                                                                                                                                                  |
| **0.5.6** | Release-notes welcome modal (Help > What's new, once per version) and the running version in the menu bar. Workflow polish, no Premiere gap closed. Also fixed File > Open, broken since 0.3.0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **0.5.5** | Markers on the timeline and on clips, with a Marker menu, navigation keys and marker snapping. Project files become version 2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **0.5.4** | Marquee (box) selection with edge auto-scroll.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **0.5.3** | Trust hardening: offline-media detection and relinking, seek starvation fixed, restores and stale loads made safe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **0.5.2** | The preview no longer goes black after scrubbing during playback, restored sessions play after a relink, and a ruler scrub pauses first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **0.5.1** | Splits keep animation curves, the ducking release ramp, and the export gain schedule sorted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **0.5.0** | The first big bundle: offline MP4 export via WebCodecs (H.264 + AAC, Opus where the browser cannot encode AAC), keyframes with the Effect Controls panel, clip speed (fixed rate, rate stretch, reverse), a first colour pass (`ctx.filter`), and audio shaping (pan, 3-band EQ, compressor, auto-duck).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## What remains

The 0.7.0 bundle closes the rest of Tier 1, and with it every open cell in the
tier. Colour grading ships 3D `.cube` LUT import beside the waveform and
vectorscope scopes, frame blending for sub-frame-rate clips lands in the export
AND the monitor (so the preview parity cell on the speed row is closed), and the
release records HEVC plus ProRes as non-goals, with audio shaping recording
spectral or learned noise reduction the same way, so the fixed broadband chain is
its end state. Nothing in Tier 2 or Tier 3 has started.

### Tier 1: felt every day

| Gap                         | What Premiere does                 | Status                                                                                                                 | What is still open                                                      |
| --------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Clip speed / time remapping | Rate stretch, speed ramps, reverse | Complete (0.5.0 fixed rate / rate stretch / reverse, 0.6.0 curves, 0.7.0 frame blending in the preview and the export) | Nothing: both render paths blend the same frame pair at the same weight |

### Tier 2: workflow accelerators (longer edits)

- **Track targeting and select-by-lane.** Marquee selection shipped in 0.5.4, but
  there is no per-track targeting: `store.selections` is a list of clip ids.
- **Three-point editing.** In / out points on the source, then insert or
  overwrite into the sequence. Today only drag-and-drop and paste place a clip;
  there is no source monitor with in / out.
- **Nested sequences / compound clips.** Group clips into one reusable unit.
- **Proxies.** A lower-resolution preview path for smooth playback of 4K+ imports.
- **Insert / overwrite drop modes** that shift downstream clips. Today only
  explicit ripple delete closes gaps.
- **Bounded export memory.** The exporter assembles the whole MP4 in memory, so
  project length competes with the tab heap. A streaming write path would bound
  memory instead.

### Tier 3: content and polish

- **More transitions: wipe, slide, dip-to-black, push.** The span model in
  `transition.ts` already computes the overlap, but a wipe, slide or push also
  needs a spatial parameter (a mask or a position offset) that the model does not
  carry, so this is real work rather than one more enum value. Dip-to-black fits
  the existing alpha ramp and is the cheap first step.
- **Effects beyond opacity:** crop, blends, chroma key, track matte, motion blur.
- **Subtitles / captions:** a caption track plus SRT / VTT import and export. The
  web competitors (CapCut web, VEED) lead here and it matters for social cuts.
- **Title presets:** save and reuse styled text (Essential Graphics style).
  `TextStyle` already serializes, so this is mostly UI work.
- **AI assist** (text-based editing, auto captions, generative extend): needs a
  backend or a hosted model, which is out of scope while the no-server constraint
  stands. That constraint is itself a product feature.

## Deliberately not planned

- **Studio-scale workflows:** multicam editing, tape-style media management,
  productions / shared projects, hardware I/O. Not relevant to this product's lane.
- **Frame-accurate seeking of arbitrary codecs:** `<video>` cannot provide it. The
  WebCodecs exporter is what made export frame-exact, and the preview stays a
  stepped approximation for reversed and ramped clips.
- **ProRes export.** The muxer is not the limitation: mediabunny already carries
  ProRes fourCC profiles, and it gates every encode on `canEncodeVideo`, the same
  probe `export/mp4.ts` already uses for its audio codec. The encoder is: no
  shipping browser exposes a ProRes `VideoEncoder`. Per mediabunny's compatibility
  guide (<https://mediabunny.dev/guide/supported-formats-and-codecs>, checked
  2026-10-07), "ProRes is not supported by WebCodecs": decoding needs the
  `@mediabunny/prores` extension and encoding exists only server-side in
  `@mediabunny/server`. A shipped export path would be a promise the platform
  cannot keep.
- **HEVC export.** This one is a value call, not a platform claim. An encoder
  exists and `canEncodeVideo('hevc')` would gate an option safely, so the codec is
  reachable. It is not planned because H.264 at the shipped bitrates already covers
  the upload path, and the cost is real: a probe, a dialog option, and per-project
  even-dimension gating, since HEVC requires even dimensions while the project
  limits clamp only to 64..3840 by 64..2160. An option that appears and then fails
  the export is the platform promise this section exists to avoid.
- **Spectral or learned noise reduction** beyond the fixed broadband chain.
  "Learned" needs model hosting or shipped weights, which the no-server constraint
  rules out. "Spectral" is possible but not verifiable to this repo's own standard:
  the fixed chain is vindicated by a measured frequency-response test that runs in
  plain Node, and a spectral gate inside an `AudioWorklet` is browser-only, so the
  exact thing being changed would leave the Node-testable state core. A tunable
  broadband chain is a different item: the open cell asked for work beyond the
  fixed chain, so adjustable strengths would leave it just as open.

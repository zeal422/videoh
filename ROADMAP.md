# Roadmap: feature gaps vs Adobe Premiere Pro

How the app compares with a desktop NLE today, and what is still missing. Two
questions, two sections: what has shipped (so a closed gap is not listed twice)
and what remains, grouped by how often a working editor would feel it.

Research date: September 2026 (Premiere 26.x). Every status below is checked
against the code, and a gap moves to "Shipped" only once the release that closed
it is recorded in [CHANGELOG.md](CHANGELOG.md).

The editing core is not tracked as a gap: the multi-track timeline, trim / split
/ razor, A/V linking, ripple delete, cross-dissolves, text overlays, gain / mute,
undo and project save / load all exist today.

## Shipped so far

Newest first. Releases before 0.5.0 are in [CHANGELOG.md](CHANGELOG.md).

| Version   | What landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0.6.1** | Trust hardening on top of Tier 1: exact frames through reversed and time-remapped trims (head, tail, split and rate stretch), playback cleanup for deletes and relinks, an honest export (offline gate, encoder released on cancel, preview-matching EQ and eased volume), and speed / time-remapping controls that report the rate the engine applies.                                                                                                                    |
| **0.6.0** | The Tier 1 bundle: keyframe easing (easeIn / easeOut / easeInOut cubic bezier, editable per keyframe), speed curves (a keyframed `timeScale` with time-remap semantics, edited in Effect Controls, reversed clips included), temperature / tint grading (one SVG `feColorMatrix` shared by the preview and the export) with luma and RGB-balance scopes in the monitor, and broadband noise reduction (a fixed high-pass / low-pass / hiss-cut chain in both audio paths). |
| **0.5.6** | Release-notes welcome modal (Help > What's new, once per version) and the running version in the menu bar. Workflow polish, no Premiere gap closed. Also fixed File > Open, broken since 0.3.0.                                                                                                                                                                                                                                                                            |
| **0.5.5** | Markers on the timeline and on clips, with a Marker menu, navigation keys and marker snapping. Project files become version 2.                                                                                                                                                                                                                                                                                                                                             |
| **0.5.4** | Marquee (box) selection with edge auto-scroll.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **0.5.3** | Trust hardening: offline-media detection and relinking, seek starvation fixed, restores and stale loads made safe.                                                                                                                                                                                                                                                                                                                                                         |
| **0.5.2** | The preview no longer goes black after scrubbing during playback, restored sessions play after a relink, and a ruler scrub pauses first.                                                                                                                                                                                                                                                                                                                                   |
| **0.5.1** | Splits keep animation curves, the ducking release ramp, and the export gain schedule sorted.                                                                                                                                                                                                                                                                                                                                                                               |
| **0.5.0** | The first big bundle: offline MP4 export via WebCodecs (H.264 + AAC), keyframes with the Effect Controls panel, clip speed (fixed rate, rate stretch, reverse), a first colour pass (`ctx.filter`), and audio shaping (pan, 3-band EQ, compressor, auto-duck).                                                                                                                                                                                                             |

## What remains

Every Tier 1 gap is now **partial**: a usable slice ships, and the last column
names what is left. One of them, offline export, is partial on purpose: MP4 /
H.264 + AAC is done and the other codecs are deliberately out (see the last
section). Nothing in Tier 2 or Tier 3 has started.

### Tier 1: felt every day

| Gap                         | What Premiere does                                                            | Status                                                                            | What is still open                                                                    |
| --------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Keyframes                   | Animate opacity, position, scale, volume; Effect Controls with a graph editor | Partial (0.5.0 curves, 0.6.0 easing)                                              | Custom bezier editing beyond the three presets, per-property easing presets           |
| Clip speed / time remapping | Rate stretch, speed ramps, reverse                                            | Partial (0.5.0 fixed rate / rate stretch / reverse, 0.6.0 curves)                 | Frame blending at speed-ramp discontinuities; ramped audio is dropped by design today |
| Colour correction / grading | Lumetri: exposure, contrast, saturation, temperature, LUTs, scopes            | Partial (0.5.0 colour set, 0.6.0 temperature / tint, luma and RGB-balance meters) | LUT import (.cube), waveform and vectorscope scopes                                   |
| Audio shaping               | Essential Sound: auto-duck, EQ, compression, pan                              | Partial (0.5.0 pan / EQ / compressor / auto-duck, 0.6.0 the fixed denoise chain)  | Spectral or learned noise reduction beyond the fixed broadband chain                  |
| Offline export              | Offline render, any codec (H.264, HEVC, ProRes)                               | Partial (MP4 / H.264 + AAC)                                                       | HEVC and ProRes: no reliable browser encoder, see "Deliberately not planned"          |

### Tier 2: workflow accelerators (longer edits)

- **Track targeting and select-by-lane.** Marquee selection shipped in 0.5.4, but
  there is no per-track targeting: `store.selections` is a list of clip ids.
- **Three-point editing.** In / out points on the source, then insert or
  overwrite into the sequence. Today only drag-and-drop exists.
- **Nested sequences / compound clips.** Group clips into one reusable unit.
- **Proxies.** A lower-resolution preview path for smooth playback of 4K+ imports.
- **Insert / overwrite drop modes** that shift downstream clips. Today only
  explicit ripple delete closes gaps.

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
- **Codecs outside MP4 / H.264 + AAC:** HEVC and ProRes have no reliable browser
  encoder, so a shipped export path for them would be a promise the platform
  cannot keep.

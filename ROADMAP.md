# Roadmap: feature gaps vs Adobe Premiere Pro

What the app lacks compared to a desktop NLE, grouped in tiers by how much
editors feel the absence, with the order we plan to close the gaps. Research
date: September 2026 (Premiere 26.x). The editing core (multi-track timeline,
trim/split/razor, A/V linking, ripple delete, crossfades, text, gain/mute,
undo, project save/load) is covered and not repeated here.

## Implementation order

1. **DONE (0.5.0).** WebCodecs offline export (Tier 1): Mediabunny MP4,
   H.264 + AAC (Opus where the browser cannot encode AAC), frame-accurate
   decode, no MediaRecorder; fixes the missing WebM duration header. Wall
   time now tracks decode speed instead of the old realtime capture.
2. **DONE (0.5.0).** Keyframes (Tier 1): opacity, position, scale, volume and
   the color set; Effect Controls panel with a light graph; linear
   interpolation.
3. **DONE (0.5.0).** Clip speed control (Tier 1): fixed rate 0.25x to 4x,
   Alt-drag rate stretch, reverse with frame-accurate export. Speed curves are
   still open.
4. **DONE (0.5.0).** Basic color pass (Tier 1): exposure, contrast, saturation,
   brightness, hue via `ctx.filter`. Temperature and LUTs are still open.
5. **PARTLY DONE (marquee).** Marquee (box) selection (Tier 2) shipped; markers are the
   remaining half and stay next up.
6. More transitions (Tier 3). Incremental on the existing span/alpha model.

Remaining from the 0.5.0 bundle, not done: speed ramps (curves), keyframe
ease/bezier interpolation, noise reduction, temperature/tint, LUTs, scopes.

## Tier 1: felt every day

| Gap                           | What Premiere does                                                                          | Status in 0.5.0                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keyframes                     | Animate opacity, position, scale, volume over time; Effect Controls panel with graph editor | Done (linear). Ease/bezier and speed ramps open                                                                                                      |
| Clip speed / time remapping   | Rate stretch, speed ramps, reverse                                                          | Done (fixed rate, rate stretch, reverse). Speed curves open                                                                                          |
| Color correction / grading    | Lumetri: exposure, contrast, saturation, temperature, LUTs, scopes                          | Done for the `ctx.filter` set. Temperature, LUTs, scopes open                                                                                        |
| Offline (non-realtime) export | Offline render, any codec (H.264, HEVC, ProRes)                                             | Done for MP4 / H.264 + AAC (Opus where AAC encode is unavailable) via WebCodecs. HEVC and ProRes have no reliable browser encoders, deliberately out |
| Audio ducking + shaping       | Essential Sound: auto-duck under dialogue, EQ, compression, pan                             | Done (pan, 3-band EQ, compressor, auto-duck). Noise reduction out                                                                                    |

## Tier 2: workflow accelerators (longer edits)

- Markers on timeline and clips.
- Track targeting and select-by-lane (marquee/box selection shipped).
- Three-point editing: in/out on source, insert/overwrite into the sequence.
  Currently only drag-and-drop exists.
- Nested sequences / compound clips (group clips into one reusable unit).
- Proxies / low-res preview path for smooth playback of 4K+ imports.
- Insert/overwrite drop modes that shift downstream clips (today only
  explicit ripple delete closes gaps).

## Tier 3: content and polish

- Effects beyond opacity: crop, blends, chroma key, track matte, motion blur.
  (Position/scale animation shipped in 0.5.0.)
- Transitions beyond crossfade: wipe, slide, dip-to-black, push. The
  `transition.ts` span/alpha model already supports the math.
- Subtitles / captions: caption track plus SRT/VTT import-export; the web
  competitors (CapCut web, VEED) lead here and it matters for social cuts.
- Title presets: save/reuse styled text (Essential Graphics style); the
  TextStyle object already serializes, presets are mostly UI work.
- AI assist (text-based editing, auto captions, generative extend): only
  relevant with a backend or hosted model; out of scope for the no-server
  constraint, which is itself a product feature.

## Structural gaps (deliberately not planned)

Studio-scale workflows: multicam editing, tape-style media management,
productions/shared projects, hardware I/O. Not relevant to this product's
lane. Also frame-accurate seeking of arbitrary codecs, which `<video>`
seeking cannot give; the WebCodecs exporter is the path that fixed it.

# Feature backlog

Non-AI features seen in competitor browser editors that this editor does not have. Gathered from
public competitor pages on 2026-11-12. This is a backlog, not a commitment. Some items now have
tentative plans and version targets in [MASTER_PLAN.md](MASTER_PLAN.md); those targets can move, and an
item without a plan is still unscoped.

AI features are intentionally excluded: auto captions, transcript editing, silence removal, audio
cleanup, text to speech, dubbing, background removal, eye contact correction, and auto reframe.

## Timeline and transform

- [ ] Monitor transform gizmo: drag, resize, and rotate a clip directly on the canvas. Seen in FreeCut, CapCut, Clipchamp.
- [ ] Rotate and flip or mirror a clip. Seen in Clipchamp (up to 360 degrees) and CapCut.
- [ ] Freeze frame from the playhead. Seen in Flixier and FreeCut.
- [ ] Join two adjacent clips into one. Seen in FreeCut. Tentative target: 0.22.0, see [PLAN_0.22.0_TIMELINE.md](PLAN_0.22.0_TIMELINE.md).
- [ ] Close gaps on a track in one action. Seen in FreeCut. Tentative target: 0.22.0, see [PLAN_0.22.0_TIMELINE.md](PLAN_0.22.0_TIMELINE.md).
- [ ] Track groups that share mute, lock, and visibility. Seen in FreeCut.

## Text and graphics

- [ ] Font family picker plus custom font upload. `TextStyle.fontFamily` already exists in the model. Seen in Clipchamp, CapCut, Kapwing, FreeCut.
- [ ] Shape layers: rectangle, circle, triangle, star, polygon, heart. Seen in FreeCut and Clipchamp.
- [ ] Sticker and emoji overlays. Seen in Clipchamp and CapCut.
- [ ] Animated text and caption presets, authored with keyframes. Seen in Kapwing and VEED.
- [ ] Brand kit with saved colors, fonts, and logos. Seen in Clipchamp, Kapwing, Flixier.

## Audio and recording

- [ ] Voiceover recording into the timeline. Seen in Clipchamp, Flixier, Descript.
- [ ] Screen, camera, and microphone recording in the browser. Seen in Clipchamp, Flixier, Descript.

## Export and project handling

- [ ] WebM export alongside MP4, MOV, and MKV. Seen in FreeCut. `mediabunny` already ships these output formats.
- [ ] GIF export. Seen in Flixier and Clipchamp.
- [ ] Custom export frame rate. Seen in CapCut. Custom resolution and bitrate ship in 0.21.0.
- [ ] Project bundle as a ZIP with media included. Seen in FreeCut. Tentative target: 0.28.0, see [PLAN_0.28.0_BUNDLE.md](PLAN_0.28.0_BUNDLE.md).
- [ ] Persist imported media in the browser with OPFS or IndexedDB so a reload does not require relinking. Seen in FreeCut.
- [ ] ProRes proxy workflow. Seen in FreeCut. `ROADMAP.md` currently lists ProRes as a deliberate non-goal, so this needs a product decision first.

## Content and collaboration

These need a content provider, a backend, or licensing, so they do not fit the current local-only model
without a separate decision.

- [ ] Stock footage, music, and sound effects library. Seen in Clipchamp, CapCut, Flixier, VEED.
- [ ] Template gallery. Seen in every competitor checked. Can start as local project templates.
- [ ] Cloud projects and real-time collaboration. Seen in Kapwing, VEED, Descript, Flixier, CapCut.

## Notes

- Competitor presence comes from public feature pages and FreeCut's README, not from hands-on testing.
- Plan gating and regional availability were not checked, so a listed feature may be paid or limited.
- Existing coverage that overlaps with this list: compound clips can act like grouped clips, text
  presets exist without a font picker, and captions can already be imported and exported as SRT or VTT.

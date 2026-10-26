# Structure — Web Video Editor

A map of the repository. For behavior read [flows.md](flows.md); for the module-level API read
[architecture.md](architecture.md). Sibling docs: [docs index](README.md) ·
[testing.md](testing.md) · [design-system.md](design-system.md) · [deployment.md](deployment.md).

## Repository root

```text
.
├── src/                     # all application code
├── public/
│   ├── google80671fa4533bcad3.html  # Search Console verification file
│   ├── screenshots/editor.png       # real editor screenshot for the hero
│   ├── robots.txt           # allow all plus the sitemap URL
│   └── samples/             # bundled demo media: sample-video.mp4, sample-audio.mp3, sample-image.png
├── e2e/
│   ├── battery.sh           # scripted UI battery (63 steps) driven by agent-browser
│   ├── battery.timing.sh    # battery copy that records per-step timing
│   └── run-battery.sh       # runner: dev server, session cleanup, strict verdict
├── docs/                    # this documentation set, including seo.md
├── next.config.ts           # output: "standalone", preview X-Robots-Tag
├── vitest.config.ts         # node env, @ alias, coverage include + thresholds
├── eslint.config.mjs        # eslint-config-next flat config
├── postcss.config.mjs       # @tailwindcss/postcss
├── components.json          # shadcn/ui CLI config (new-york, neutral, lucide)
├── tsconfig.json            # strict, noEmit, "@/*" → "./src/*"
├── package.json             # scripts, dependencies, MIT license (run with Bun)
├── bun.lock                 # dependency lockfile
├── LICENSE                  # MIT license
├── CONTRIBUTING.md          # Bun setup, checks, contribution terms
├── README.md                # product overview + keyboard map
├── ROADMAP.md               # Premiere gap analysis
├── CHANGELOG.md             # released + unreleased changes
├── AGENTS.md                # AI coding-agent instructions
├── .env.example             # optional public analytics template
└── .prettierrc              # no semicolons, single quotes, 100 cols
```

There is no data backend or database. The editor runs entirely in the browser (object URLs, canvas,
Web Audio, WebCodecs). The public site is server-rendered at `/`, and the editor is a client-only boot
at `/editor`. The only optional integration is GoatCounter analytics, configured by
`NEXT_PUBLIC_GOATCOUNTER_URL`.

## `src/app/` — Next.js App Router

```text
src/app/
├── (site)/
│   ├── layout.tsx          # public header/footer, skip link, Instrument Serif display variable
│   ├── page.tsx            # indexable hero at / plus both JSON-LD blocks
│   ├── about/page.tsx
│   ├── privacy/page.tsx
│   ├── terms/page.tsx
│   └── contact/page.tsx
├── editor/page.tsx    # server wrapper with noindex metadata around EditorBoot
├── layout.tsx        # root metadata: Geist fonts, dark <html>, <Toaster>, GoatCounter
├── sitemap.ts        # MetadataRoute.Sitemap from INDEXABLE_ROUTES
├── opengraph-image.tsx # 1200x630 social card
├── globals.css       # Tailwind 4 entry + tokens + public-site motion + editor scrollbars
└── icon.svg          # favicon (Next.js file convention)
```

## `src/components/` — UI

```text
src/components/
├── site/                         # public site, no editor store or browser-engine imports
│   ├── SiteHeader.tsx            #   transparent favicon bars + wordmark, About, GitHub, tracked Open editor CTA
│   ├── SiteFooter.tsx            #   public links, contact mailto, MIT license
│   ├── Hero.tsx                  #   hero, screenshot, features, FAQ, final CTA
│   ├── TimelineHero.tsx          #   CSS-only timeline strip with one rose playhead
│   ├── LegalPage.tsx             #   shared legal page shell
│   ├── TrackedLink.tsx           #   plain anchor that calls trackClick
│   └── GoatCounter.tsx           #   optional page-view script
├── editor/                       # editor UI (see architecture.md for responsibilities)
│   ├── EditorBoot.tsx            #   client-only shell import, 3.2s preloader, retry/reload
│   ├── EditorShell.tsx           #   panel workspace layout + autosave/restore + gesture safety net + release-notes auto-open
│   ├── MenuBar.tsx               #   Premiere-style menu bar + dialogs + right-edge fullscreen toggle + version label
│   ├── AppearanceDialog.tsx      #   View > Appearance palette picker, applies and persists immediately
│   ├── apply-theme.ts            #   writes/removes `data-palette` on `<html>`
│   ├── ReleaseNotesModal.tsx     #   welcome modal: last five versions, Help > What is new
│   ├── Preloader.tsx             #   boot ripple grid behind the editor chunk import
│   ├── PanelShell.tsx            #   resizable/collapsible panel frame
│   ├── NamedSlider.tsx           #   slider wrapper that names the thumb
│   ├── Toolbar.tsx               #   tools, history, tracks, save/open, export
│   ├── MediaBin.tsx              #   import, samples, relink, drag source, bin row selection
│   ├── SourcePanel.tsx           #   source monitor: preview, transport, mark In/Out
│   ├── PreviewPanel.tsx          #   program monitor + transport + text drag
│   ├── ColorFilterDefs.tsx       #   hidden SVG grade/LUT filter host
│   ├── ScopesPanel.tsx           #   histogram, RGB balance, waveform, vectorscope
│   ├── InspectorPanel.tsx        #   clip properties / project settings
│   ├── effect-controls/
│   │   ├── EffectControlsPanel.tsx   # keyframes, graph, audio shaping, speed/reverse
│   │   └── AppliedEffectsSection.tsx # effect stack, picker, matte/keyer controls
│   ├── CaptionsPanel.tsx         #   captions: cue list, SRT import/export, VTT export, New Cue
│   ├── StatusBar.tsx             #   pinned footer
│   ├── ExportDialog.tsx          #   export: quality, progress, preview, download
│   └── timeline/
│       ├── TimelinePanel.tsx     #   lanes, playhead, drop targets, zoom, track menu
│       ├── Ruler.tsx             #   canvas time ruler + scrubbing
│       ├── ClipView.tsx          #   clip: move/trim gestures, context menu, link badge
│       ├── SequenceMarkers.tsx   #   ruler marker tabs + drag/edit menu
│       ├── ClipMarkers.tsx       #   clip marker tabs (source-anchored)
│       ├── MarkerDialog.tsx      #   marker name/color/notes editor
│       └── Waveform.tsx          #   per-clip waveform canvas
└── ui/                           # 18 shadcn/ui primitives (trimmed to what the editor uses)
```

`src/components/ui/` is generated by the shadcn CLI — use the primitives, don't hand-edit them. The
preinstalled set was trimmed to the 18 the editor actually reaches; `bunx shadcn add <name>` restores
any of them. The editor's own components live in `src/components/editor/`.

## `src/hooks/`

```text
src/hooks/
├── editor/useEditorKeyboard.ts   # global keyboard map (Premiere-verified); see README
├── use-mobile.ts                 # responsive breakpoint hook (shadcn)
└── use-toast.ts                  # toast store (shadcn)
```

## `src/lib/`: outside the editor core

````text
src/lib/
├── releases.ts           # hand-curated release notes for the welcome modal (version-locked to package.json)
├── seo.ts                # site constants, canonical, pageMetadata, INDEXABLE_ROUTES, JSON-LD
├── analytics.ts          # GoatCounter custom events, click beacon, first-export marker
└── utils.ts              # shadcn `cn()` class-merge helper

## `src/lib/editor/` — the editor core

The heart of the app. Everything here is plain TypeScript with no React dependency except the zustand
stores. This is the layer that unit tests target.

```text
src/lib/editor/
├── types.ts              # Doc / Project / Track / Clip / MediaAsset / TextStyle
├── constants.ts          # all tuning constants and limits
├── factories.ts          # uid + create* constructors, finders, compatibility checks, sourceTimeAt
├── time.ts               # clamp, formatTime/Timecode, frame stepping, rulerStep
├── commands.ts           # the 57 EditorCommand variants + applyCommand(s), direction-aware split spans
├── trim.ts               # pure trim/split math: source-fitting bisection, timeScale curve rebases
├── snap.ts               # snap-point computation and application
├── srt.ts                # SRT parse/serialize + the caption cue collector (pure)
├── vtt.ts                # WebVTT serialize (escape, timestamps, document) over shared SrtCue (pure)
├── clip-gesture.ts       # pure clip-gesture decisions: lane drop, move/trim/rate-stretch math, partner shifts
├── sequence-ops.ts       # insert/overwrite placement planner + source in/out range helpers (pure)
├── marquee.ts            # marquee (box) selection: lane-space rect math + group resolution (pure)
├── markers.ts            # markers: source-anchored clip mapping, navigation, colors, selection (pure)
├── keyframes.ts          # keyframe evaluation (linear + eased, from exact data or preset names), sanitize/clamp, split redistribution
├── ease-segment.ts       # per-segment easing DATA: bezier quad storage + exact de Casteljau subdivision
├── bezier.ts             # pure cubic-bezier timing solver for the easing presets
├── ducking.ts            # auto-duck keyframe analysis from waveform peaks
├── color.ts              # the shared ctx.filter builder, the temperature/tint matrix, the scope samplers (pure)
├── lut.ts                # `.cube` parsing/storage/budget (pure) + the 3D trilinear pixel pass
├── frame-blend.ts        # sub-frame-rate blend math: the partner read + the pair weight BOTH render paths share
├── offline.ts            # offline-media detection for the monitor (pure)
├── transition.ts         # transition span + alpha math (crossfade, dip to black) + spatial geometry (wipe, slide, push)
├── effects.ts            # effect-stack math: order rule, sample derivation, crop/matte/blur geometry, blend set (pure)
├── chroma-key.ts         # Ultra-Key-lite math: chroma distance, key ramp, despill, mask values (pure)
├── links.ts              # multi-selection / A/V link-group helpers
├── clipboard.ts          # copy / cut / paste (module memory, outside undo)
├── actions.ts            # multi-command UI actions (add media/text, group ops, ripple delete)
├── store.ts              # zustand store: doc, history, transients, selection, playhead, zoom
├── serialization.ts      # .veproj.json v4 (v1, v2 and v3 still load): serialize / parse / hydrate
├── persistence.ts        # debounced localStorage autosave + restore
├── workspace.ts          # panel layout state (pure)
├── workspace-store.ts    # zustand wrapper over workspace.ts
├── theme.ts              # appearance palette ids/labels + preference read/write (pure)
├── menus.ts              # menu bar model (pure)
├── project-io.ts         # save / open / import-media / sample browser helpers
├── sample-media.ts       # bundled sample list + load plan (fresh adds, offline relinks)
├── timeline-drop.ts      # drop-target geometry for drop-between-tracks
├── tracks.ts             # removes the tracks an edit leaves empty (prune)
├── timeline-scroll.ts    # drag edge auto-scroll geometry (pure)
├── proxy.ts              # pure proxy planning: dimensions, bitrate, eligibility
├── media/
│   ├── probe.ts          # importFile: probe duration/size, thumbnail, waveform peaks, hasAudio
│   ├── relink.ts         # relinkPatchFrom: patch fields a relink carries (file handle included)
│   ├── elements.ts       # ClipMediaPool: per-clip media elements, source nodes, the parked blend partner
│   └── proxies.ts        # session proxy build/revoke and effective media URL
├── playback/
│   ├── core.ts           # PlaybackCore: clock, media pool, drift correction, Web Audio graph, live rate, blend partner
│   ├── compositor.ts     # drawFrame + the draws the exporter shares: contain-fit geometry, text, crossfade, blends, the 3D LUT pass
│   ├── denoise.ts        # noise-reduction biquad chain, shared by the preview mixer and the export mix
│   ├── preview.ts        # preview engine singleton (attach/detach)
│   ├── source-preview.ts # source monitor element singleton (attach/detach, one owner of sourcePlayhead)
│   ├── engine-ref.ts     # PlaybackController ref shared by all UI
│   └── text-box.ts       # text-box measurement (twins the compositor's text renderer)
├── export/
│   ├── offline.ts        # pure frame/audio export plan + gain/crossfade schedules (Node-testable)
│   └── mp4.ts            # WebCodecs MP4 pipeline + downloadBlob
└── __tests__/            # 77 test files (1603 tests) in `src/lib/editor/__tests__/`: see testing.md
    └── mocks/
        └── browser-mocks.ts   # FakeAudioContext / media elements / canvas / presented-frame queue
````

`src/lib/utils.ts` holds the shadcn `cn()` class-merge helper.

## Conventions

- Tests are colocated under `src/lib/editor/__tests__/` and named `*.test.ts(x)`. Component behavior
  uses jsdom render tests plus static-source locks for code-shape guarantees (see
  [testing.md](testing.md)).
- The pure state core must stay browser-free so it runs in Vitest's Node environment. Browser APIs
  live in `media/`, `playback/`, and `export/`, plus the browser-bound `persistence.ts`,
  `project-io.ts`, and `analytics.ts` helpers. Their tests use mocked storage, File inputs, or mocked
  analytics APIs; the DOM-only persistence and project-io paths are covered by the battery, and the
  analytics DOM paths are covered in jsdom.
- Nothing under `src/lib/editor/` imports from `src/components/`.

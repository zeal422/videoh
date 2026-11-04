# Design System — Web Video Editor

Tokens, theming, layout, and UI conventions. Sibling docs: [docs index](README.md) ·
[architecture.md](architecture.md) · [structure.md](structure.md) · [flows.md](flows.md) ·
[testing.md](testing.md) · [deployment.md](deployment.md).

## Theming

- **Dark base, curated palettes.** `src/app/layout.tsx` puts `className="dark"` on `<html>`, so every
  Radix portal (menu, select, dialog, tooltip, toast), which mounts at `document.body` outside any
  component tree, resolves the dark tokens. Do not add a `dark` wrapper inside the shell.
- **Tokens live in CSS.** `src/app/globals.css` declares `:root` (light reference plus the shared
  `--radius`) and `.dark` (the default applied theme). A `@theme inline` block maps each CSS variable
  to a Tailwind utility (`--color-background` → `bg-background`, etc.), and `@custom-variant dark
(&:is(.dark *))` wires the `dark:` variant. This is Tailwind 4's CSS-first configuration; there is
  no `tailwind.config.ts`.
- **Native widgets follow the theme.** `.dark` sets `color-scheme: dark` so number-input spinners,
  scrollbars, and checkboxes render dark chrome instead of flashing white.
- **Palettes layer on top.** View > Appearance stores an allowlisted id under
  `web-video-editor:theme:v1` and sets `data-palette` on `<html>`. The boot effect in
  `src/components/editor/EditorBoot.tsx` applies it behind the opaque preloader. The `:root[data-palette='<id>']` blocks
  override only the 17 chrome tokens below. Default is the absence of the attribute, so no
  `data-palette="default"` block exists.
- **No theming dependency.** No `next-themes` or other theme library is installed; the switch is CSS
  custom properties plus `localStorage`.

## Palettes

The curated set is Default plus thirteen tinted palettes, ordered by hue from Garnet 350, Blush 15,
Ember 45, Honey 75, Olive 105, Forest 150, Lagoon 180, Ocean 210, Steel 230, Midnight 255, Indigo 275,
Plum 305, and Orchid 330. The full ids and labels live in `THEMES`. Every block declares the same 17
tokens:

`--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`,
`--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`,
`--muted-foreground`, `--accent`, `--accent-foreground`, `--border`, `--input`, `--ring`.

They leave the fixed chrome alone: clip kind colours, playhead and selection rose, snap amber,
marker swatches, the monitor and scopes zinc, the boot splash, `--destructive`, and the
chart/sidebar/radius tokens. The release-notes emerald accents stay fixed too.

`theme.test.ts` locks the unique ids and labels, the block set, the exact token set per block, and the
contrast floors: 4.5:1 for foreground, muted foreground, primary text, and destructive text, and 3:1
for the focus ring.
The destructive text pair is declared explicitly (`--destructive-foreground`), so warning text does
not inherit a tinted `--foreground`. Palette borders and inputs stay at the fixed 10% and 15% alpha
whites, which the token test also locks. The dialog caps itself at `calc(100vh - 2rem)` and scrolls,
so short windows never clip; the list is a two-column grid and native radios keep arrow-key order.

The boot splash stays pure black with the violet ripple. A tinted palette contrasts with it at
reveal; that is accepted, not a defect.

## Tokens

| Token                                          | Meaning                                                      |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `--background` / `--foreground`                | page surface and default text                                |
| `--card` / `--popover` (+ `-foreground`)       | raised surfaces and portaled surfaces                        |
| `--primary` / `--primary-foreground`           | primary buttons and accents                                  |
| `--secondary`, `--muted`, `--accent` (+ `-fg`) | subtle fills, disabled text, hover states                    |
| `--destructive` (+ `-foreground`)              | destructive actions, errors                                  |
| `--border`, `--input`, `--ring`                | borders, form fields, focus rings                            |
| `--chart-1..5`                                 | chart palette (unused by the editor, kept for shadcn parity) |
| `--sidebar-*`                                  | unused sidebar tokens (shadcn parity)                        |
| `--radius`                                     | corner radius; `--radius-sm/md/lg/xl` derive from it         |

All colours are authored in `oklch()`. Use the semantic utilities (`bg-background`, `text-foreground`,
`border-border`, `text-muted-foreground`, …) — never hardcode hex values for surfaces or text.

## Typography

- **Geist Sans** for UI (`--font-geist-sans` → `--font-sans`) and **Geist Mono** for timecodes,
  shortcut hints, and numeric readouts (`--font-geist-mono` → `font-mono`), loaded via
  `next/font/google` in `layout.tsx`.
- **Instrument Serif** is the public-site display face (`--font-instrument-serif` →
  `--font-display`). It is loaded in `src/app/(site)/layout.tsx` and scoped there, so the editor keeps
  Geist Sans for controls and panels.

## Public site

The public site at `/` shares the editor's dark base, rose playhead, and amber secondary accent, but it
is not the editor shell. It is a server-rendered landing page with its own header, footer, hero,
product proof, privacy story, CTA, FAQ, and legal pages.

- **Site palette.** `.site-theme` in `globals.css` scopes the marketing palette: `--site-bg` (#080512),
  `--site-panel`, `--site-border`, the muted text pair, and the rose, pink, amber, orange, violet, and
  emerald accents. These are the public-site exception to the editor's semantic tokens. Use the
  `--site-*` variables for landing surfaces instead of hardcoded hex values.
- **Composition.** A cinematic "editing room at 2 a.m." direction: near-black surfaces, rose and
  violet radial glows, a CSS-only grain overlay, and one angled timeline card. The card uses the
  editor's kind colours (emerald video, amber audio, violet text), exactly one rose playhead, a
  right-side orange rim, and a concentrated orange glow at its bottom right. It sits on a darker
  offset back plate with a warm edge, a top-edge highlight, and a deeper contact shadow so it reads
  as a physical slab rather than a flat panel. A small lavender "Your edit, in real time." note with
  a thin violet SVG arrow sits above the card, floating clear of its top edge. Amber stays a small
  secondary accent, never a second playhead.
- **Sections.** The landing page is one server-rendered composition in `Hero.tsx`: hero, four-item
  feature strip, product showcase, full-bleed gradient tools band, privacy panel, closing CTA, and
  FAQ. The hero is at least `100svh` minus the header, so the product section starts below the fold.
  The feature strip follows the hero copy with a small gap. A minimal scroll cue sits under the
  strip and links to the product section; its chevron bobs with motion-safe and the click scrolls
  smoothly, or jumps instantly when reduced motion is requested. The FAQ follows the privacy panel,
  and the CTA closes the page after it.
- **Display type.** Instrument Serif is the documented public-site exception. The hero H1 uses
  `font-display` at `clamp(4.5rem, 8.5vw, 7.625rem)` with a tight `0.72` line height and a
  pink-to-orange gradient on the italic line. The FAQ and CTA headings also use `font-display`; body
  text stays Geist Sans. Do not apply the serif to editor controls.
- **Wordmark.** The header and footer pair transparent favicon bars with the Instrument Serif wordmark
  inside the same home link. The favicon keeps its dark tile; the header mark has no tile. The bars are
  decorative, 32px in the footer and 36px in the header, with no separate accessible name.
- **Feature strip.** Four promises sit in a `gap-px` grid: the outer white/6 surface shows through as
  a one-pixel divider, and each item uses the dark site panel. The strip is four columns on desktop,
  two on tablet, and one on mobile.
- **Product showcase.** The real `src/assets/editor-screenshot.png` capture at 1921x1079 sits in the
  wide right column with `next/image`, explicit dimensions, `sizes`, `loading="lazy"`, and descriptive
  alt text. The 0.18.0 capture uses the Climbing-Vlog project: one video track with filmstrips, two
  audio tracks with waveforms, a text track, the climb in the program monitor, and the Effect
  Controls inspector. There is no third-party credit. Recapture it when the editor chrome or demo
  project changes.
- **Replacing the capture.** Replace `src/assets/editor-screenshot.png` at 1921x1079 and update
  `SCREENSHOT_ALT` and the `width`/`height` in `ProductShowcase.tsx`. The static import emits a
  content-hashed URL, so a new file gets a new URL automatically and cannot reuse the old optimized
  WebP variant. Rebuild the production output after the swap (`bun run check` or `bun run build`).
- **Tools band.** A self-contained full-bleed gradient band with the sampled purple-to-red palette, a
  warm glow at the top right, a field of small coloured particles with a few larger drifting motes,
  and five gradient-bordered tiles. The particle field lives on the band's `::before`; the blurred
  motes live on `::after` and drift on an 18s `motion-safe` loop. The tile borders use the
  padding-box/border-box technique; each tile sets `--tile-a`, `--tile-b`, and its icon colour. It is
  its own section, with no cross-section fade.
- **Privacy panel.** The panel carries a faint dot grid, two device cards, dashed connectors with
  emerald checks, and a gradient shield. The shield uses the same lucide Shield silhouette as the
  "Your data is yours" feature icon, scaled up, with a smaller copy of the same path inset as the
  inner shield. It is rendered at 170x180 so it reads as a security shield, not a crest. The copy
  keeps the local-media promise and discloses optional analytics.
- **FAQ.** The visible FAQ is a two-column definition list with bordered rows. It stays on the page
  because the home route emits FAQPage JSON-LD; do not move the questions behind a client-only
  accordion or remove them without removing the structured data.
- **CTA border.** The closing panel's 2px border is a warm rose-pink-orange-amber conic gradient
  with a brighter highlight band, driven by the `--cta-border-angle` custom property. The highlight
  keeps the slow rotation visible. The 8s loop drifts slowly for 2s, surges for 0.7s, then settles
  for the rest of the cycle. Reduced motion keeps the border static.
- **Primary CTA.** The header, hero, and closing "Open editor" links share `.site-cta-button`: a
  `--site-cream` pill with a 2px `--site-rose` rim and a 2px `--site-bg` inset ring. On hover or
  keyboard focus the fill floods to solid rose over 200ms and the rim pops outward as a fading ring.
  The label stays dark until 140ms, then switches to cream over 70ms, so it never blanks during a
  fast hover. Nothing shifts: the header and hero are text-only, and the closing CTA keeps its
  single arrow. The release takes 240ms. Reduced motion makes the state change instant and
  suppresses the ring pop.
- **Motion.** Every animation class is `motion-safe:`. The hero rises, clips settle with a stagger, and
  the playhead sweeps once in a loop. Reduced motion leaves the same composition static. There is no
  bare animation fallback.
- **Grain.** The grain is a CSS pseudo-element with a tiled SVG noise data URI and low opacity. It is
  decorative, pointer-events-none, and sits behind content.
- **Focus and keyboard.** The site layout starts with a skip link to `#main`. Primary CTAs use the
  `.site-cta-button` outline (2px `--ring` at a 3px offset); secondary CTAs keep
  `focus-visible:ring-2`. Plain links keep the browser focus outline. Navigation uses plain anchors,
  so no router test scaffolding is needed.
- **Responsive.** The hero stacks below `lg`; the feature strip is four, two, then one column; the
  product showcase, tools band, privacy panel, CTA, and FAQ stack below `lg`. The tools tiles stay
  five across but shrink, the tools heading wraps below 360px, and the privacy panel becomes a
  vertical stack. The privacy heading wraps below `xl` and stays on one line at `xl`, where the left
  column widens. The header wraps rather than clipping.
- **No editor chrome.** The public site never imports the editor store, media, playback, or export
  modules. It does not reuse the resizable workspace shell.

## Editor chrome (deliberate exceptions)

The video surfaces stay dark regardless of the palette, the way an NLE's monitor does. The appearance
palettes change only the 17 chrome tokens above; these surfaces and semantic accents do not follow
them:

- The program monitor and transport bar use fixed zinc (`bg-zinc-950`, `border-zinc-800`,
  `text-zinc-300`) so the preview canvas reads as a monitor, not a page.
- **The clip palette is intentionally colour-coded by kind**, mirroring Premiere-style track colours:
  - video → emerald, audio → amber, text → violet
  - selection ring and playhead → rose; snap guide → amber-300
  - drop indicators take the dragged media's kind colour (`+ V2` emerald, `+ A2` amber)
- **Filmstrip layer.** Video and image clips paint a `Filmstrip` layer at the bottom of the clip
  body: sampled source cells for video, the image itself for an image, and the poster behind while a
  strip loads. Only the visible tile of a long clip is generated, at layout density. A top and
  bottom black scrim keeps the label readable. The layer never takes pointer events; the label,
  badges, waveform, trim handles, and markers stay above it, and the strip is clipped by the clip's
  rounded border. While a strip is generating, a thin progress bar sits at the clip bottom after
  300 ms, and the timeline header carries the global `Thumbnails 12/24` readout.
- **Automation envelopes.** Audio-bearing clips paint volume as a 1.5px white line with
  `stroke-white/90` and 6px white dots inside 12px hit targets; picture clips use the same component
  for opacity, mapped 0..100% instead of the dB domain. The curve is deliberately not the selection
  rose: rose stays the selection/playhead signal. The plot spans the full clip height, is inset 8px
  from the trim handles, sits above the waveform and below the label and z-10 trim handles, and only
  the dots and the 10px transparent hit path take pointer events. Dot centers sit on the value line
  at the clip edges, and the 12px hit target is clamped fully inside the endpoints. A muted clip dims
  the volume layer to 50% but keeps it editable; opacity is not an audio property and never dims on
  mute. On a solo video under the Pen the opacity instance owns the line and the volume overlay sets
  `dotsOnly`: the visible volume path is hidden and only its dots stay live. The shared
  `KeyframeGraph` draws the same volume curve in its dB mode, with 7px `-inf`, `-6 dB`, and `0 dB`
  labels over the muted graph background. The graph defaults to 80px for dB and 40px for linear,
  resizes 32..240px per property from its bottom handle, and stores that height in the workspace
  rather than the Doc. Its dots and easing handles read the same dB mapping as the curve, so a unity
  point sits on the 0 dB line.
- **Marker swatches** use the eight-colour Premiere palette (`MARKER_COLOR_VALUES` in
  `markers.ts`, Tailwind 500-family values) applied as an inline `backgroundColor`. They are content
  data (the colour the user picked) and stay fixed across themes.
- The kind colours and the marker swatch palette are the only places non-token palette values are
  expected, plus the boot splash below; surfaces, text, and controls still use tokens.
- **The boot splash** is a fullscreen exception in the monitor's spirit: a pure black field
  (`bg-black`) matching the pitch-black reference, with a violet cell base (`hsl(270, 100%, 50%)`,
  the reference's start hue) that the wrapper hue-rotates through the full wheel. No token can
  express a full-hue cycle, so the base stays a literal, the way the monitor stays zinc.

## Layout conventions

- **Panels are flex chains.** Every panel root is `flex min-h-0 min-w-0 flex-1 flex-col`, and
  `PanelShell`'s content wrapper is `flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden`. This matters:
  react-resizable-panels renders its `Panel` as a plain block box, so a child that does not opt into
  `flex` never inherits the panel height and gets clipped instead of scrolling.
- **Fixed-height transport.** The preview transport is `h-12 shrink-0`; the canvas area above it is the
  only part that gives up space (`flex-1 min-h-0`). This keeps the transport visible at every panel size.
- **Container queries, not viewport queries, inside panels.** The master-volume slider shows at
  `@lg:flex` against the panel's own width (`@container` on the preview section), so a narrow panel
  hides the slider rather than clipping the transport buttons.
- **Responsive shell.** At ≥768 px the shell is the resizable panel workspace; below 768 px it falls
  back to a fixed stacked layout. Panel sizes and visibility persist via `workspace.ts`. Every
  desktop panel header carries a panel menu with `Close Panel`; the Window menu restores it. A solo
  group fills its row, and the empty state replaces the workspace when all six panels are closed.
  Double-click a resize handle to reset its neighbor, or use Window > Reset Workspace Layout; the
  action is enabled whenever the layout deviates from the default.
- **The Source monitor is one of the six workspace panels** (`panel-source`, the upper row is
  `media | source | preview`), built like the inspector: a `PanelShell` plus a `HandleWithReset`
  inside the upper `ResizablePanelGroup`. The Source Monitor sits before the Program Monitor because
  the preview is the row's auto-sized remainder; the observer maps Media and Source by their visible
  order. It follows the flex-chain rule above.
  Its root is `flex min-h-0 flex-1 flex-col`, the preview host is `aspect-video shrink-0`, and the
  transport/marks rows sit under it. Desktop-only: the mobile `CompactLayout` mounts no workspace
  panels. Empty state is muted text ("No source selected"); the marked-span readout turns
  `text-rose-400` and sets `data-invalid` on an inverted or sub-floor range. A timed asset gets the
  singleton `<video data-testid="source-preview">`; a still renders as
  `<img data-testid="source-image">` inside the same `aspect-video` black host instead, because a
  `<video>` cannot decode a PNG (left alone it showed a black box with a demuxer error).
- **The bottom row is timeline plus captions, below the top row.** The Captions panel docks
  to the right of the timeline (`panel-captions`, same flex chain as every other panel). The timeline
  fills the horizontal remainder with no stored width (like the Program Monitor upstairs); only the
  captions width persists, capped at 45 while both panels share the row, while `sizes.timeline` keeps
  meaning the bottom group's vertical share (15 to 72 while both rows are visible). Solo rows fill.
  The inspector shares the top row with the workspace, so the bottom row spans the full width below
  it. It follows the flex-chain rule above.
- **Reference geometry.** The desktop panel tree is `(media | source | preview | inspector) over
(timeline | captions)`, with the inspector in the top row. Panel defaults are `PANEL_BOUNDS` shares
  of their own group: media 32 (about 24% of the full viewport beside the 26% inspector), source 24,
  inspector 26 (top row), timeline 50 (stacked workspace height), captions 24. The Program Monitor
  uses the same 28px `PanelShell` header as the other panels, with its canvas, scopes, and transport
  inside `PreviewPanel`.
  Track rows are 44px video, 40px audio, and 36px text, with a 168px sticky header. The header holds
  the kind icon, the truncated name, and three 24px controls: visibility/mute on video and text lanes,
  or `M`/`S` text buttons on audio lanes, plus the lock button everywhere. The clip count and a header
  target button are deliberately absent (targeting lives in the context menu). The header uses
  `gap-1.5` so the name keeps readable width beside the controls, and hit targets never shrink below
  24px.
- **Solo and lock controls.** Audio `M`/`S` are pressed-state text buttons: mute tints rose, solo tints
  amber. The lock button shows `LockOpen` in the muted-foreground token and `Lock` in amber with a
  translucent amber fill when set, so a locked lane is visible without hovering. The header and lane
  carry `data-locked`, and the lane is NOT dimmed as a whole: a locked lane is still inspectable, and
  dimming would read as disabled. The context menu mirrors both as checkbox items (`Solo Track` on
  audio only, `Lock Track` on every lane) beside Target Track.
- **Track eyeball dims the whole lane.** The header eye (video/text lanes only) toggles `visible`;
  the lane div carries `data-visible` and dims with the header, so a hidden lane reads as one unit.
  Audio lanes get no eye; muting stays on the track mute toggle.
- **Editor wordmark.** A compact `videoh` link sits before the File menu, outside `role="menubar"`,
  and points at `/`. It hides below `md` so the File through Help triggers keep their room; the
  full-screen button and version stay pinned at the right edge.
- **Media cards.** The thumbnail is 64x40 (`h-10 w-16`, `object-cover`) from the existing 160px JPEG,
  followed by the truncated file name and one muted line with kind and duration or dimensions plus
  proxy state. The selected ring, offline styling, and hover actions (add, remove, proxy, relink)
  stay unchanged.
- **Status bar.** The left side shows the project name, resolution and fps, and the compact timeline
  duration. The right side shows the multi-selection count or the single-clip range
  (`00:00–00:04.2` with an en dash) plus its duration (`4.2s`), video and audio track counts for the
  active sequence (text tracks omitted, `hidden xl:inline`), and the always-visible autosave
  indicator. `px/s` and undo-step counts are debug data and stay out of the footer.
- **Time formats.** The transport uses padded total minutes (`00:02.7`, `61:01.2`); the ruler uses
  padded `mm:ss` under an hour and `h:mm:ss` at or over it. Everything else (status duration,
  inspector, markers, tooltips, export dialog) keeps the compact `formatTime` form.
- **The placement-mode control is a segmented group, not three tool buttons.** It renders as one
  `role="group" aria-label="Placement mode"` bordered box with three square-cornered `Button`s
  (`placement-mode-place|insert|overwrite`); the active one takes `variant="secondary"` and
  `aria-pressed="true"`, the others stay `ghost`. It is session-only state, so the control never
  implies persistence, and the one-shot `,` / `.` keys work regardless of the toggle. The group is
  `shrink-0`; below 1280 px Export is icon-only and the toolbar scrolls horizontally when needed, so
  Overwrite never clips.
- **Toolbar tooltips open below.** Every custom toolbar tooltip sets `side="bottom"` on its content,
  so the bubble stays clear of the menu bar and uses the room under the top toolbar. Panel-header
  controls use native `title` tooltips and keep browser-managed placement.
- **The proxy badge is a state, not a control.** The Media bin row shows `proxy` / `proxy…` /
  `proxy failed` in the existing status line, and the build action is a ghost `IconMiniButton` (the
  `Gauge` icon) shown only for a live heavy source. `View > Use Proxies` is a checkbox menu item, so the
  on/off posture sits where every other session toggle lives.
- **Scrollbars.** Editor scroll containers use the `.editor-scroll` class (thin dark thumb).
  `[data-timeline-scroll]` disables text selection while dragging clips.
- **Tool cursors.** The razor sets `cursor-crosshair` on the clip body. Slip sets
  `cursor-ew-resize` on the body and falls the edge handles back to the default cursor, because
  they do not trim. Ripple keeps `cursor-ew-resize` on the edge handles; the body does not move.
  The Pen keeps the normal pointer over the clip body and falls the edge handles back to the default
  cursor, because it only selects; its line hit path shows `cursor-crosshair`. Razor, ripple, and
  slip make the automation envelope inert, so the modal tool owns the pointer. The Pen keeps its
  target curve live and leaves a solo video's volume dots directly draggable.
- **Blocked drop target.** `[data-drop-blocked='true']` outlines a lane in `--destructive` with a
  `not-allowed` cursor — set by `ClipView` for the duration of a drag whose clip cannot land on that
  lane. It is the only lane-level state style; the outline is drawn inside the lane (`outline-offset:
-1px`) so the row geometry, and therefore the drop maths, does not shift.
- **Effects stack cards reuse inspector rows.** The Applied Effects section lists one card per entry
  (enable toggle, expand, delete, reset); static params render as the same labelled-slider rows the
  color and transform sections use, so effect controls never invent their own spacing. The Add effect
  picker is a menu, with the track-matte sources as a submenu listing only video/text lanes above the
  clip.
- **Blend mode sits under Opacity.** The `Clip blend mode` dropdown lives in the Clip tab directly
  below the opacity control (Premiere placement), Normal default, clearing back to absent.
- **Track eyeball dims the whole lane.** The header eye (video/text lanes only) toggles `visible`;
  the lane div carries `data-visible` and dims with the header, so a hidden lane reads as one unit.
  Audio lanes get no eye; muting stays on the track mute toggle.

## Components

- `src/components/ui/` holds the **18 shadcn/ui** primitives the editor uses (style `new-york`, base
  colour `neutral`, icons from `lucide-react`, per `components.json`). The preinstalled 48-primitive
  set was trimmed to exactly these; `bunx shadcn add <name>` restores any of them on demand.
  **Use them; do not hand-edit them.**
- Class merging goes through `cn()` in `src/lib/utils.ts` (`clsx` + `tailwind-merge`).
- Editor-specific components live in `src/components/editor/` and compose the primitives.
- Icons come from `lucide-react` only.
- A compound clip wears a `COMPOUND` badge on its timeline body and opens on double-click; the timeline
  shows a breadcrumb above the lanes only while a child sequence is open, and each crumb is a plain
  button in the standard muted/foreground token pair.

## Accessibility

- **Icon-only buttons carry `aria-label`s**; regions are labelled (`aria-label="Preview"`,
  `aria-label="Inspector"`, the timeline scroll surface) so the E2E battery and screen readers can
  address them.
- Keyboard support is first-class: the resize handles are focusable and arrow-resizable
  (react-resizable-panels), transport controls are real buttons, and the inspector uses labelled Radix
  primitives.
- The keyboard map is documented in the [README](../README.md); shortcuts are ignored while typing in
  inputs, textareas, selects, and content-editable elements.
- **Sliders are named on the thumb.** Radix reads a thumb's accessible name from the thumb's own
  props (the element with `role="slider"` is the thumb, not the labelled root), and the generated
  shadcn Slider spreads root props onto the root only. The editor's `NamedSlider` composes the
  primitive with the same markup and puts the caller's `aria-label` on the thumb of a single-value
  slider, so `src/components/ui/slider.tsx` stays untouched. Tests and the E2E battery address those
  sliders by role and name; a CSS walk into the root would pass even while the control stayed
  unnamed.

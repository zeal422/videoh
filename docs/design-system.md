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
  `src/app/page.tsx` applies it behind the opaque preloader. The `:root[data-palette='<id>']` blocks
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
  back to a fixed stacked layout. Panel sizes, collapsed state, and visibility persist via
  `workspace.ts`.
- **The Source monitor is one of the six workspace panels** (`panel-source`, the upper row is
  `source | preview | inspector`), built exactly like the inspector: a `PanelShell` plus a
  `HandleWithReset` inside the upper `ResizablePanelGroup`. The Source Monitor sits FIRST, not in the
  middle: in a shared row a collapsible panel's freed space can only flow into the panel to its right,
  so a collapsible panel placed first flows into the unbounded Program Monitor and always collapses
  cleanly, while one placed in the middle depends on its neighbour's headroom and can refuse. It
  follows the flex-chain rule above.
  Its root is `flex min-h-0 flex-1 flex-col`, the preview host is `aspect-video shrink-0`, and the
  transport/marks rows sit under it. Desktop-only: the mobile `CompactLayout` mounts no workspace
  panels. Empty state is muted text ("No source selected"); the marked-span readout turns
  `text-rose-400` and sets `data-invalid` on an inverted or sub-floor range. A timed asset gets the
  singleton `<video data-testid="source-preview">`; a still renders as
  `<img data-testid="source-image">` inside the same `aspect-video` black host instead, because a
  `<video>` cannot decode a PNG (left alone it showed a black box with a demuxer error).
- **The bottom row is timeline plus captions.** The Captions panel docks to the
  right of the timeline (`panel-captions`, `side="bottom"`, same flex chain as
  every other panel). The timeline fills the horizontal remainder with no
  stored width (like the Program Monitor upstairs); only the captions width
  persists, while `sizes.timeline` keeps meaning the bottom group's vertical
  share. It follows the flex-chain rule above.
- **The placement-mode control is a segmented group, not three tool buttons.** It renders as one
  `role="group" aria-label="Placement mode"` bordered box with three square-cornered `Button`s
  (`placement-mode-place|insert|overwrite`); the active one takes `variant="secondary"` and
  `aria-pressed="true"`, the others stay `ghost`. It is session-only state, so the control never
  implies persistence, and the one-shot `,` / `.` keys work regardless of the toggle. The group is
  `shrink-0`; below 1024 px Export is icon-only and the toolbar scrolls horizontally when needed, so
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

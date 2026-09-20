# Design System — Web Video Editor

Tokens, theming, layout, and UI conventions. Sibling docs: [docs index](README.md) ·
[architecture.md](architecture.md) · [structure.md](structure.md) · [flows.md](flows.md) ·
[testing.md](testing.md) · [deployment.md](deployment.md).

## Theming

- **Dark-only.** `src/app/layout.tsx` renders `<html lang="en" className="dark">` — the theme lives on
  `<html>` so every Radix portal (menu, select, dialog, tooltip, toast), which mounts at `document.body`
  outside any component tree, resolves the dark tokens. Do not add a `dark` wrapper inside the shell.
- **Tokens live in CSS.** `src/app/globals.css` declares `:root` (light reference) and `.dark` (the
  applied theme). A `@theme inline` block maps each CSS variable to a Tailwind utility
  (`--color-background` → `bg-background`, etc.), and `@custom-variant dark (&:is(.dark *))` wires the
  `dark:` variant. This is Tailwind 4's CSS-first configuration; there is no `tailwind.config.ts`.
- **Native widgets follow the theme.** `.dark` sets `color-scheme: dark` so number-input spinners,
  scrollbars, and checkboxes render dark chrome instead of flashing white.
- **There is no theming dependency.** No `next-themes` (or any other theme library) is installed and
  no switcher is rendered — dark is the application's only theme.

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

The video surfaces stay dark regardless of the token theme, the way an NLE's monitor does:

- The program monitor and transport bar use fixed zinc (`bg-zinc-950`, `border-zinc-800`,
  `text-zinc-300`) so the preview canvas reads as a monitor, not a page.
- **The clip palette is intentionally colour-coded by kind**, mirroring Premiere-style track colours:
  - video → emerald, audio → amber, text → violet
  - selection ring and playhead → rose; snap guide → amber-300
  - drop indicators take the dragged media's kind colour (`+ V2` emerald, `+ A2` amber)
- These kind colours are the only place non-token palette classes are expected; surfaces, text, and
  controls still use tokens.

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
- **Scrollbars.** Editor scroll containers use the `.editor-scroll` class (thin dark thumb).
  `[data-timeline-scroll]` disables text selection while dragging clips.
- **Blocked drop target.** `[data-drop-blocked='true']` outlines a lane in `--destructive` with a
  `not-allowed` cursor — set by `ClipView` for the duration of a drag whose clip cannot land on that
  lane. It is the only lane-level state style; the outline is drawn inside the lane (`outline-offset:
-1px`) so the row geometry, and therefore the drop maths, does not shift.

## Components

- `src/components/ui/` holds the **18 shadcn/ui** primitives the editor uses (style `new-york`, base
  colour `neutral`, icons from `lucide-react`, per `components.json`). The preinstalled 48-primitive
  set was trimmed to exactly these; `bunx shadcn add <name>` restores any of them on demand.
  **Use them; do not hand-edit them.**
- Class merging goes through `cn()` in `src/lib/utils.ts` (`clsx` + `tailwind-merge`).
- Editor-specific components live in `src/components/editor/` and compose the primitives.
- Icons come from `lucide-react` only.

## Accessibility

- **Icon-only buttons carry `aria-label`s**; regions are labelled (`aria-label="Preview"`,
  `aria-label="Inspector"`, the timeline scroll surface) so the E2E battery and screen readers can
  address them.
- Keyboard support is first-class: the resize handles are focusable and arrow-resizable
  (react-resizable-panels), transport controls are real buttons, and the inspector uses labelled Radix
  primitives.
- The keyboard map is documented in the [README](../README.md); shortcuts are ignored while typing in
  inputs, textareas, selects, and content-editable elements.
- Radix renders some `aria-label`s on the slider root rather than the thumb; tests target those via CSS
  selectors instead of role+name.

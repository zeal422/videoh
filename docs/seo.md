# SEO and measurement - videoh

Purpose: make the public editor discoverable and measure whether people reach a successful export. This page covers the public routes, metadata, search setup, analytics, and the release checklist.

Last reviewed: 2026-10-26.

## Scope

- English only.
- No comparison pages, use-case pages, country pages, or localized routes.
- No custom domain. The canonical origin is `https://videoh.vercel.app`.
- No GA4, advertising pixels, or cookie banner.
- The editor stays at `/editor` and is deliberately `noindex, follow`; the hero at `/` is the indexable product page.

## Audiences and search intent

1. Open-source contributors looking for a readable browser editor.
2. Individual creators who want a quick edit without an upload or account.
3. Students and educators who need a free, local-first tool.

The content answers practical questions: cost, privacy, export format, and browser support. It does not claim parity with desktop NLEs.

## Primary outcome and conversion

- Primary outcome: weekly successful MP4 exports (`export-success`).
- Primary conversion: the first observed successful MP4 export per browser profile while the local marker persists (`first-export`).
- Secondary signals: editor opened (`open-editor`), every export (`export-success`), GitHub source clicks (`view-source`), contact clicks (`contact-email`), and GitHub stars.
- Leading indicator: organic clicks and organic impressions in Search Console.
- The editor-open page view and the CTA click are the usable proxies for intent. There is no account or server-side funnel.

## Keyword map

The public copy targets a small set of honest phrases:

| Intent            | Query shape                                     | Page       |
| ----------------- | ----------------------------------------------- | ---------- |
| Product discovery | browser video editor, open source video editor  | `/`        |
| Privacy           | video editor without upload, local video editor | `/`        |
| Export            | browser video editor MP4, WebCodecs editor      | `/`        |
| Trust and license | videoh license, videoh open source              | `/about`   |
| Privacy detail    | videoh privacy, GoatCounter analytics           | `/privacy` |
| Terms             | videoh terms, MIT license                       | `/terms`   |
| Contact           | videoh contact                                  | `/contact` |

Do not add thin pages for every query. The hero, About, Privacy, Terms, and Contact pages cover the useful surface.

## Public page inventory

| Route      | Indexable | Purpose                                                |
| ---------- | --------- | ------------------------------------------------------ |
| `/`        | yes       | Hero, screenshot, features, FAQ, and conversion CTAs   |
| `/about`   | yes       | Product story, open source, privacy, contact           |
| `/privacy` | yes       | Local media, browser storage, GoatCounter, Vercel      |
| `/terms`   | yes       | Free service, MIT license, no warranty, acceptable use |
| `/contact` | yes       | Email and GitHub                                       |
| `/editor`  | no        | Client-only editor, `noindex, follow`                  |

## Technical checklist

- [x] Root metadata sets `metadataBase`, the title template, description, application name, authors, creator, robots, Open Graph, Twitter, and icons.
- [x] The home page uses an absolute title so the root template does not append a second brand.
- [x] Each non-root page sets its own canonical and `openGraph.url`.
- [x] The five indexable routes appear in `sitemap.xml`; `/editor` does not.
- [x] `robots.txt` allows all crawlers and names the sitemap.
- [x] The Search Console verification file is public and byte-exact.
- [x] `/editor` carries `noindex, follow`.
- [x] Preview deployments carry `X-Robots-Tag: noindex, nofollow`; production does not.
- [x] The home page renders `SoftwareApplication` and `FAQPage` JSON-LD.
- [x] The social image is 1200x630 with a stable alt.
- [x] The hero screenshot has descriptive alt text and uses `next/image` with `preload`.

## Search Console

1. Open Search Console with the Google account that owns the property.
2. Add a URL-prefix property for `https://videoh.vercel.app/`. Do not use a Domain property without DNS control.
3. Confirm `https://videoh.vercel.app/google80671fa4533bcad3.html` returns 200 and the exact verification line.
4. Verify the property with the HTML file method.
5. Submit `https://videoh.vercel.app/sitemap.xml`.
6. Check the Pages report after a few days. Expect `/` to be indexed and `/editor` to be excluded by its robots tag.
7. Keep the verification file in place after verification.

Search Console is the source for impressions and clicks. Do not infer those from GoatCounter.

## GoatCounter

GoatCounter is the only analytics service. It is cookieless and supports custom events.

### Setup

1. Create a site at `https://videoh.goatcounter.com` if the name is available. If not, use another slug and update the URL.
2. Set `NEXT_PUBLIC_GOATCOUNTER_URL=https://videoh.goatcounter.com/count` in Vercel Production only.
3. Leave Preview and Development empty so local and preview traffic do not pollute production data.
4. Add the optional public variable to `.env.example`.

### Events

| Event            | When it fires                                   | Transport                       |
| ---------------- | ----------------------------------------------- | ------------------------------- |
| `open-editor`    | Header, hero, and final CTA                     | `TrackedLink` then `trackClick` |
| `view-source`    | GitHub CTA                                      | `TrackedLink` then `trackClick` |
| `contact-email`  | Footer mailto and contact page mailto           | `TrackedLink` then `trackClick` |
| `first-export`   | First successful MP4 export per browser profile | `trackExportSuccess`            |
| `export-success` | Every successful MP4 export                     | `trackExportSuccess`            |
| Page view        | Public pages and `/editor`                      | GoatCounter script              |

Every custom event is sent with `event: true`. Export events also use `no_session: true` so rapid exports are counted individually.

### Limits

- GoatCounter cannot measure cross-day return visits without persistent identifiers. Do not invent a return-visit metric.
- Ad blockers can block GoatCounter. Search Console remains the source for search impressions and clicks.
- Clearing site data, private windows, and new browser profiles reset the first-export marker, so the conversion can count again.
- Events fired before the script is ready are queued in memory. Each event gets its own five-second retry window from when it is queued. If the script loads before that event's bound, it is handed off once. If it never loads, each event is dropped after its own bound. Delivery is best effort.
- A click before React hydration is not tracked. This is an accepted boundary.
- A not-ready click uses `navigator.sendBeacon` so navigation does not drop the event. If `sendBeacon` is unavailable or returns false, the click falls back to the queue.
- If the page unloads before a queued `first-export` flushes, the marker remains and that conversion is lost. This is the at-most-once boundary.

## English only

The launch is English only. Do not add localized pages, hreflang, or country landing pages until there is a maintained translation process and a real audience for it.

## No comparison pages

Comparison pages tend to age badly and invite claims the project cannot verify. The hero and About page explain the product directly. Revisit comparisons only if there is a durable editorial owner and a source for every claim.

## GitHub as a supporting channel

GitHub is a credibility and contribution channel, not the primary acquisition goal. Keep the repository description, topics, homepage, and social preview current. Link the source from the hero and footer. GitHub stars are a secondary signal, not the outcome.

## Release checklist

- [x] `bun run check` is green.
- [x] The dev and artifact batteries are 63/63 with a terminal `BATTERY_EXIT=0`.
- [ ] `robots.txt`, `sitemap.xml`, and the verification file return 200 in production.
- [ ] The production metadata check passes for `/` and `/editor`.
- [ ] Preview returns `X-Robots-Tag`; production does not.
- [ ] Search Console verifies the property and accepts the sitemap.
- [ ] GoatCounter receives a test page view and a test event, or analytics is intentionally disabled.
- [x] Privacy and Terms copy is approved.

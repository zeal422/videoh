# Deployment - videoh

Build, run, and verify. Sibling docs: [docs index](README.md) · [architecture.md](architecture.md) ·
[structure.md](structure.md) · [flows.md](flows.md) · [testing.md](testing.md) ·
[design-system.md](design-system.md) · [seo.md](seo.md).

## Requirements

- **Bun** (the package manager and runner, never npm/pnpm/yarn). `bun run dev` and `bun run build` are
  the entry points.
- A **current Chromium-based browser** for the full feature set (WebCodecs + Web Audio + canvas).
  Export needs WebCodecs: Chromium and Edge, plus Firefox 130+ and Safari 26+; playback alone works
  in older browsers.
- No database and no data backend. The editor is client-side. The server serves the public pages, the
  editor shell, the sitemap, and the static verification file.
- Optional GoatCounter analytics through `NEXT_PUBLIC_GOATCOUNTER_URL`. Leave it empty to disable
  analytics, including in Preview and Development.

## Routes

| Route                          | Behavior                                      |
| ------------------------------ | --------------------------------------------- |
| `/`                            | Public hero, indexable, static                |
| `/editor`                      | Editor boot, `noindex, follow`                |
| `/about`                       | Public, indexable                             |
| `/privacy`                     | Public, indexable                             |
| `/terms`                       | Public, indexable                             |
| `/contact`                     | Public, indexable                             |
| `/robots.txt`                  | Public crawler policy                         |
| `/sitemap.xml`                 | Public sitemap with the five indexable routes |
| `/google80671fa4533bcad3.html` | Search Console verification file              |

The site is public and has no login route. The old access path must return 404.

## Scripts

| Script                  | What it does                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `bun install`           | install dependencies (updates `bun.lock`)                               |
| `bun run dev`           | Next.js dev server on `:3000`, output mirrored to `dev.log`             |
| `bun run build`         | `next build` (standalone) then copies `.next/static` + `public` into it |
| `bun run start`         | runs the standalone server (`.next/standalone/server.js`) on `:3000`    |
| `bun run lint`          | ESLint                                                                  |
| `bun run typecheck`     | `tsc --noEmit`                                                          |
| `bun run test`          | Vitest single pass (never bare `bun test`)                              |
| `bun run test:watch`    | Vitest watch mode                                                       |
| `bun run test:coverage` | Vitest with enforced coverage thresholds                                |
| `bun run format`        | Prettier write (`src/`, docs, root config files)                        |
| `bun run format:check`  | Prettier check (`src/`, docs, root config files)                        |
| `bun run battery`       | the scripted UI battery ([below](#end-to-end-battery))                  |
| `bun run check`         | the full verification gate (below)                                      |

## The verification gate - `bun run check`

```bash
bun run check
# = format:check → lint → typecheck → test → build
```

Order is deliberate: fail on the cheapest, most mechanical problems first so the slower steps never run
on code that would fail anyway.

1. **`format:check`** - Prettier over `src/**/*.{ts,tsx}`, the root config files, and `docs/**/*.md`.
   Cheapest signal.
2. **`lint`** - ESLint (`eslint-config-next` flat config).
3. **`typecheck`** - `tsc --noEmit` over the whole project. (`next build` also type-checks, so this is
   the earlier, faster signal, not the only place types are enforced.)
4. **`test`** - Vitest. See [testing.md](testing.md) for the inventory and coverage thresholds.
5. **`build`** - the production build. Fastest way to catch a broken import graph or a page that fails
   to prerender.

Green here means the gate is green. Run it after every change.

## Production build

`next.config.ts` sets `output: "standalone"`, so `bun run build` produces a self-contained server at
`.next/standalone/server.js`. The `build` script additionally copies `.next/static` and `public` into
the standalone folder so `bun run start` can serve assets without a reverse proxy.

The public pages and metadata are server-rendered. The editor mounts client-only through the manual
effect import in `src/components/editor/EditorBoot.tsx`, because the starter document contains random
ids that would otherwise mismatch between server and client. The preloader stays up for the 3.2s
minimum show while the editor chunk loads.

Preview deployments add `X-Robots-Tag: noindex, nofollow` through `next.config.ts` when
`VERCEL_ENV=preview`. Production, development, and unset environments return no such header. A unit
test locks that behavior.

## Environment

- `NEXT_PUBLIC_GOATCOUNTER_URL` is optional and public. Set it in Vercel Production only, for example
  `https://videoh.goatcounter.com/count`.
- Leave Preview and Development empty so their traffic does not pollute production analytics.
- Do not put secrets in `NEXT_PUBLIC_*` variables. The editor has no server-side secrets.
- `.env.example` documents the optional variable.

## End-to-end battery

The scripted UI battery runs against a live server (see [testing.md](testing.md#end-to-end-battery)):

```bash
bun run battery                               # starts/reuses a dev server, then stops what it started
DETACH=1 bun run battery                       # detached, for harnesses that clean up their children
```

It requires `agent-browser` on `PATH` and writes `PASS`/`FAIL` lines to `$OUT` (`results.txt` by
default). It exits nonzero on a `FAIL` and on a run that produced fewer results than the battery's own
`step` lines, so a partial run is never a pass. The first step loads the public hero and asserts the
Open editor link; the second opens `/editor`; the third clears storage and opens a fresh editor.
`results*.txt` and `tool-results/` are gitignored.

The dev server is not the shipped artifact. To verify the build that actually ships, serve the
standalone output and let the runner reuse it (it starts a server only on the default port when
nothing is serving it):

```bash
bun run build && bun run start
bun run battery                  # reuses the server above and starts nothing
```

The 0.11.0 dev and artifact runs on 2026-10-26 were both 63 passed, 0 failed with terminal
`BATTERY_EXIT=0`. Earlier 0.9.0 through 0.10.3 records covered both the dev server and the
standalone artifact build. See [testing.md](testing.md#end-to-end-battery).

See [testing.md](testing.md#end-to-end-battery) for the A/B two-tree recipe and the runner's full
environment.

## Hosting

Vercel runs the Next.js app and serves the static files copied from `public/`. No database or object
storage is required because projects and media stay in the browser.

Before promoting a production deployment, check the candidate deployment, not the production domain:

1. Confirm the build came from the approved tree and the Privacy and Terms copy is approved.
2. Run the same status, metadata, sitemap, robots, and verification-file checks against the Vercel preview URL with `BASE_URL=<candidate-url>`.
3. Confirm `/` and `/editor` are `200`, the old access path is `404`, and `/editor` carries `noindex, follow`.
4. Confirm the preview carries `X-Robots-Tag: noindex, nofollow`. Do not apply the production header-absence check to the preview.
5. Leave Search Console verification and GoatCounter event checks for after promotion, because those point at production.

After promotion, run the full production check block with `BASE_URL=https://videoh.vercel.app`:

1. Confirm the statuses, exact metadata, sitemap, robots, verification file, and both JSON-LD blocks.
2. Confirm production has no `X-Robots-Tag` on `/` or `/editor`.
3. Confirm Search Console verifies the URL-prefix property and accepts the sitemap.
4. Confirm GoatCounter receives a page view and a custom event, or is intentionally disabled.
5. Keep the Search Console verification file public after verification.

Rollback: promote the last known-good Vercel deployment or redeploy the restored `HEAD`, then rerun the
expectation set that matches the release now deployed. Do not apply the 0.11.0 checks to a pre-0.11.0
release.

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
- Recording uses the browser permission prompts for the microphone, the camera, and screen
  capture, and needs `MediaRecorder`. A denied permission is reported inside the recording dialog.
  System audio is platform and picker dependent: when the picker shares no audio track, the take is
  video only and the dialog says so. Nothing is uploaded; the take is imported and stored like any
  other media file.

## Media storage

- Imported media is stored on the visitor's device in OPFS (Origin Private File System), under
  `<project-id>/<content-hash>` plus a MIME sidecar and immutable claim shards. Nothing is uploaded;
  there is still no server-side media backend.
- OPFS needs a secure context and a browser that implements `navigator.storage.getDirectory`. When it
  is unavailable, a quota is exceeded, or private mode blocks the write, the import still works for
  the session, warns, and needs relinking after a reload. The storage dialog shows the usage and offers
  a persistent-storage request; clearing site data removes stored media along with autosave.
- Clean Unused Media uses the Web Locks API to refuse while another tab has the project open. Without
  Web Locks it refuses outright. If a project still has stored bytes but its claims directory is gone,
  saved-copy records are treated as lost: clean stays blocked and saves refuse until Clear All Stored
  Media resets that project. Clear All Stored Media runs behind a second confirmation and refuses while
  another tab has the project open; without Web Locks there is no cross-tab coordination, so it refuses
  rather than report a partial clear as complete.
- Project bundles (`.vebundle.zip`) carry the project, every stored media entry, and every project
  font. Export streams through `showSaveFilePicker` when the browser offers it; otherwise the bundle
  is built in memory and a bundle over 512 MiB is refused before the build. Open needs OPFS for the
  promoted bytes, localStorage for the install registry and autosave ownership, and BroadcastChannel
  for the cross-tab pause. Web Locks serializes ownership and the slot; without it one IndexedDB
  transaction does, and the pause falls back to a short acknowledgement window. Without either
  primitive, or when an IndexedDB open or transaction fails, bundle import and install-record writes
  refuse instead of racing another tab; normal editing still uses the slot. Import refuses a
  newer project version, missing media, a hash mismatch, or an extra entry, and warns when a font is
  missing. The store-only reader caps an archive at 4096 entries, 512 MiB per entry, and 1 GiB
  total as a memory budget, and rejects an oversized manifest entry before reading its bytes.
- A `.veproj.json` file references media by hash; it is not a media backup, and a timeline export
  is a rendered file that preserves neither the original sources nor the media references. Keep
  separate copies of the original media and of any generated file before clearing site data.

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

Every response carries the safe security headers from `next.config.ts`: `X-Content-Type-Options:
nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `X-Frame-Options: DENY`.
`poweredByHeader: false` keeps the standalone server from advertising Next. Production enforces the
full resource policy in `Content-Security-Policy`, including `worker-src 'self' blob:` for
mediabunny's blob workers; `script-src` still allows inline scripts. Development and test keep the
narrow `frame-ancestors 'none'; base-uri 'self'; object-src 'none'` policy so HMR and the dev overlay
are not blocked. No response carries `Content-Security-Policy-Report-Only`. The GoatCounter endpoint
origin is added to `connect-src` when `NEXT_PUBLIC_GOATCOUNTER_URL` is set. If enforcement fails,
restore the full policy to `Content-Security-Policy-Report-Only`, keep the narrow enforced policy, and
redeploy the previous release.

Preview deployments add `X-Robots-Tag: noindex, nofollow` through `next.config.ts` when
`VERCEL_ENV=preview`. Production, development, and unset environments return no such header. A unit
test locks that behavior.

`headers()` is evaluated at build time and baked into the routes manifest. Verify the header set
against a real production build or preview deployment, not only the unit test.

## Environment

- `NEXT_PUBLIC_GOATCOUNTER_URL` is optional and public. Set it in Vercel Production only, for example
  `https://vmedia.goatcounter.com/count`.
- Leave Preview and Development empty so their traffic does not pollute production analytics.
- Do not put secrets in `NEXT_PUBLIC_*` variables. The editor has no server-side secrets.
- `.env.example` documents the optional variable.

## End-to-end battery

The scripted UI battery runs against a live server (see [testing.md](testing.md#end-to-end-battery)):

```bash
bun run battery                               # starts/reuses a dev server, then stops what it started
DETACH=1 bun run battery                       # detached, for harnesses that clean up their children
bun run battery:pair                          # dev + artifact concurrently, with a strict pair verdict
```

It requires `agent-browser` on `PATH` and writes `PASS`/`FAIL` lines to `$OUT` (`results.txt` by
default). It exits nonzero on a `FAIL` and on a run that produced fewer results than the battery's own
`step` lines, so a partial run is never a pass. The first step loads the public hero and asserts the
Open editor link; the second opens `/editor`; the third clears storage and opens a fresh editor.
`results*.txt` and `tool-results/` are gitignored.

`bun run battery:pair` runs both legs concurrently. Build first. It starts the standalone artifact on
`:3100`, requires `:3000` free for the dev leg, and requires both server-type lines plus both strict
verdicts. It writes `PAIR_LOG` and a terminal `PAIR_EXIT`, and stops only the artifact server it
started. It is a clean-gate command, not a local check while a dev server is running. Each leg runs
four shards by default (`PAIR_SHARDS=4`), one browser session per shard, and still requires the same
74/74. `PAIR_SHARDS=1` runs the registered sequential order as the rollback. The sharded pair targets
under 300s wall clock; the first four-shard map measured 198s and 200s, and the rebalanced map
measured 163s, 164s, and 165s across three runs; every run was 70/70 on both legs. The partition, seeds, and
per-shard times are in [testing.md](testing.md#sharded-release-run).

The runner reuses any HTTP server already on port 3000, so each run needs a server-type preflight.
Before the dev run, confirm `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000` prints
`000`, and require `starting the dev server` in the log. Before the artifact run, start the
standalone server yourself and require `using the server already serving` with no
`starting the dev server` line. A 74/74 result on the wrong server type is not a valid result.

The dev server is not the shipped artifact. To verify the build that actually ships, serve the
standalone output and let the runner reuse it (it starts a server only on the default port when
nothing is serving it):

```bash
bun run build && bun run start
bun run battery                  # reuses the server above and starts nothing
```

The 0.16.2 dev and artifact runs on 2026-10-28 were both 66 passed, 0 failed with terminal
`BATTERY_EXIT=0`. The 0.16.3 dev and artifact runs on 2026-10-29 were both 67 passed, 0 failed with
terminal `BATTERY_EXIT=0`. The 0.16.4 dev and artifact runs on 2026-10-31 were both 67 passed, 0
failed with terminal `BATTERY_EXIT=0`. The final 0.17.0 dev and artifact runs on 2026-11-01 were both
67 passed, 0 failed with terminal `BATTERY_EXIT=0`. The 0.18.0 dev and artifact runs on 2026-11-01
were also both 67 passed, 0 failed with terminal `BATTERY_EXIT=0`. The 0.19.0 dev and artifact runs on
2026-11-04 were both 70 passed, 0 failed with terminal `BATTERY_EXIT=0`. The 0.19.1 dev and artifact
runs on 2026-11-04 were also both 70 passed, 0 failed with terminal `BATTERY_EXIT=0`. The 0.19.2 dev
and artifact runs on 2026-11-05 were also both 70 passed, 0 failed with terminal `BATTERY_EXIT=0`. The
0.19.3 dev run on 2026-11-06 started its own dev server and passed 70/70 with `BATTERY_EXIT=0`; the
artifact run reused the standalone server and also passed 70/70 with `BATTERY_EXIT=0`. The 0.19.4 dev
run on 2026-11-07 started its own dev server and passed 70/70 with `BATTERY_EXIT=0`; the artifact run
reused the standalone server and also passed 70/70 with `BATTERY_EXIT=0`. The 0.19.5 dev run on
2026-11-09 started its own dev server and passed 70/70 with `BATTERY_EXIT=0`; the artifact run reused
the standalone server and also passed 70/70 with `BATTERY_EXIT=0`. The 0.20.0 artifact run on
2026-11-09 reused the standalone server and passed 70/70 with `BATTERY_EXIT=0`. The 0.20.1 median pair, measured on 2026-11-10, was 569s across three runs (568s, 572s, 569s),
against a 1166s median baseline (1171s, 1166s, 1156s), a 51.2 percent reduction. All six runs started the
dev server or reused the standalone artifact as required, passed 70/70 with `BATTERY_EXIT=0`, and the
optimized runs reported `PAIR_EXIT=0`. At 0.20.2 on 2026-11-11, the four-shard pair measured 163s; the same map's earlier runs were
164s and 165s, all with 70/70 on both legs and `PAIR_EXIT=0`. At 0.21.0 on 2026-11-13, the four-shard
pair measured 167s; the dev leg started its own server and the artifact leg reused the standalone
server, and both legs passed 70/70 with `PAIR_EXIT=0`. At 0.24.0 on 2026-11-13 the four-shard pair
measured 166s on the final tree, with the same server split and 70/70 on both legs with `PAIR_EXIT=0`.
At 0.25.0 the same day the four-shard pair measured 178s, with the same server split and 74/74 on
both legs with `PAIR_EXIT=0`. At 0.26.0 on 2026-11-14 the four-shard pair measured 182s, with the
dev leg starting its own server, the artifact leg reusing the standalone server, and 74/74 on both
legs with `PAIR_EXIT=0`.
At 0.27.0 on 2026-11-14 the four-shard pair measured 181s on the final
tree, with the same server split and 74/74 on both legs with `PAIR_EXIT=0`.
At 0.28.0 on 2026-11-15 the four-shard pair measured 179s on the final
tree, with the same server split and 74/74 on both legs with `PAIR_EXIT=0`.
At 0.28.1 on 2026-11-15 the four-shard pair measured 183s on the final
tree, with the same server split and 74/74 on both legs with `PAIR_EXIT=0`.
Earlier 0.9.0
through 0.11.0 records covered both the dev server and the standalone artifact build. See [testing.md](testing.md#end-to-end-battery).

See [testing.md](testing.md#end-to-end-battery) for the A/B two-tree recipe and the runner's full
environment.

## Hosting

Vercel runs the Next.js app and serves the static files copied from `public/`. No database or object
storage is required because projects and media stay in the browser. The repository's `vercel.json`
installs Bun 1.4.x explicitly and runs `bun install --frozen-lockfile`: a package/lockfile mismatch
fails the build instead of re-resolving, and the explicit install is required because the committed
`bun.lock` is `lockfileVersion: 3`, which Bun older than 1.4 cannot read.

Before promoting a production deployment, check the candidate deployment, not the production domain:

1. Confirm the build came from the approved tree and the Privacy and Terms copy is approved.
2. Run the same status, metadata, sitemap, robots, and verification-file checks against the Vercel preview URL with `BASE_URL=<candidate-url>`.
3. Confirm `/` and `/editor` are `200`, the old access path is `404`, and `/editor` carries `noindex, follow`.
4. Confirm the preview carries `X-Robots-Tag: noindex, nofollow`. Do not apply the production header-absence check to the preview.
5. Leave Search Console verification and GoatCounter event checks for after promotion, because those point at production.

After promotion, run the full production check block with `BASE_URL=https://videoh.vercel.app`:

1. Confirm the statuses, exact metadata, sitemap, robots, verification file, and both JSON-LD blocks.
2. Confirm production has no `X-Robots-Tag` on `/` or `/editor`.
3. Confirm `/` and `/editor` return `X-Content-Type-Options: nosniff`, `Referrer-Policy:
strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, and a `Content-Security-Policy`
   containing `frame-ancestors 'none'`.
4. Confirm the production artifact returns the full enforced `Content-Security-Policy`, no
   `Content-Security-Policy-Report-Only`, and no `X-Powered-By`.
5. Confirm Search Console verifies the URL-prefix property and accepts the sitemap.
6. Confirm GoatCounter receives a page view and a custom event, or is intentionally disabled.
7. Keep the Search Console verification file public after verification.

Rollback: promote the last known-good Vercel deployment or redeploy the restored `HEAD`, then rerun the
expectation set that matches the release now deployed. Do not apply the 0.11.0 checks to a pre-0.11.0
release.

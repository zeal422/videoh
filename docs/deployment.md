# Deployment — Web Video Editor

Build, run, and verify. Sibling docs: [docs index](README.md) · [architecture.md](architecture.md) ·
[structure.md](structure.md) · [flows.md](flows.md) · [testing.md](testing.md) ·
[design-system.md](design-system.md).

## Requirements

- **Bun** (the package manager and runner — never npm/pnpm/yarn). `bun run dev` and `bun run build` are
  the entry points.
- A **current Chromium-based browser** for the full feature set (MediaRecorder + Web Audio + canvas
  `captureStream`). Firefox/Safari lack parts of the export pipeline.
- No database, no server-only application code. The editor itself is a client-side app; the only
  server pieces are the Next.js process that serves the static shell and the **access gate**
  (see [Access gate](#access-gate) below).

## Access gate

The deployment can sit behind a password gate (`src/proxy.ts`, Next 16's renamed middleware): every
request without a valid session cookie is redirected to `/gate`. Only the two routes that make login
work (`/gate` itself and `POST /api/gate-login`, plus Next's dev-only hot-reload endpoint) are served
without a session; static assets (`/_next/static`, `/_next/image`, `favicon.ico`, `icon.svg`) are
excluded by the proxy's matcher. The app bundle never reaches an unauthenticated client.

- **Setup:** set `GATE_PASSWORD` and `GATE_SECRET` (see `.env.example`; on Vercel: Project Settings →
  Environment Variables). The password is the human credential; the secret is an independent random
  value (`openssl rand -base64 32`) mixed into the session-cookie key. The server **refuses to boot**
  in production without `GATE_SECRET`; local dev falls back to password-only signing with a console
  warning. When `GATE_PASSWORD` is unset the gate is open — a checkout without the variable must not
  turn into a mystery outage.
- **Sessions:** a correct login sets a signed HttpOnly cookie valid for 24 hours (daily re-login).
  The cookie key is `HMAC(GATE_SECRET, GATE_PASSWORD)` — neither value alone can mint or verify a
  cookie, a stolen cookie cannot be brute-forced for the password (the attacker lacks the secret),
  and rotating the password still invalidates every live session at once.
- **Throttle:** failed attempts are counted in a second signed cookie; after 3 free tries each
  further attempt inside the penalty window is refused without comparing the password (15 s doubling
  to 15 min). Clearing cookies resets the counter — accepted, because the password's entropy plus the
  signing secret are the real defence and the deployment is not a public target.
- The E2E battery logs in as its `g0` step when the gate is active (`GATE_PASSWORD` env var).
- Local dev uses the same gate: copy `.env.example` to `.env.local` and set the password there.

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
| `bun run test:coverage` | Vitest with enforced coverage thresholds                                |
| `bun run format`        | Prettier write (`src/`, docs, root config files)                        |
| `bun run format:check`  | Prettier check (`src/`, docs, root config files)                        |
| `bun run check`         | the full verification gate (below)                                      |

## The verification gate — `bun run check`

```bash
bun run check
# = format:check → lint → typecheck → test → build
```

Order is deliberate: fail on the cheapest, most mechanical problems first so the slower steps never run
on code that would fail anyway.

1. **`format:check`** — Prettier over `src/**/*.{ts,tsx}`, the root config files, and `docs/**/*.md`.
   Cheapest signal.
2. **`lint`** — ESLint (`eslint-config-next` flat config).
3. **`typecheck`** — `tsc --noEmit` over the whole project. (`next build` also type-checks — the
   "Running TypeScript" build step — so this rung is the earlier, faster signal, not the only
   place types are enforced.)
4. **`test`** — Vitest. See [testing.md](testing.md) for the inventory and coverage thresholds.
5. **`build`** — the production build. Fastest way to catch a broken import graph or a page that fails
   to prerender.

Green here means the gate is green. Run it after every change.

## Production build

`next.config.ts` sets `output: "standalone"`, so `bun run build` produces a self-contained server at
`.next/standalone/server.js`. The `build` script additionally copies `.next/static` and `public` into
the standalone folder so `bun run start` can serve assets without a reverse proxy.

The app is fully static-shell: the editor mounts client-only (`dynamic(..., { ssr: false })` in
`src/app/page.tsx`) because the starter document contains random ids, which would otherwise mismatch
between server and client.

## End-to-end battery

The scripted UI battery runs against a live server (see [testing.md](testing.md#end-to-end-battery)):

```bash
bun run dev                                   # in one terminal
BASE_URL=http://localhost:3000 OUT=results.txt bash e2e/battery.sh
```

It requires `agent-browser` on `PATH` and writes `PASS`/`FAIL` lines to `$OUT`. `results*.txt` and
`tool-results/` are gitignored.

## Hosting

Any host that can run the standalone Node/Bun server works (a container, a VM, or a Node runtime
platform). Because there is no backend or persistence beyond `localStorage`, no database, object
storage, or secret configuration is required — serve the built server and the static assets together.

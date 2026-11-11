import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * battery-runner.test.ts: locks the two safety promises of e2e/run-battery.sh.
 *
 * The runner exists because a battery that dies halfway still leaves a PASS
 * list behind, and a PASS list is what gets read as the verdict. A killed run
 * is not a hypothetical: a harness that cleans up the background children it
 * spawned when its session ends takes both the dev server and the battery with
 * it, which is exactly how a 17-of-48 results file came to look like a result.
 *
 * The suite cannot drive the runner end to end (that needs the dev server and a
 * browser), so these are static-source assertions on the properties whose
 * removal would quietly restore the old failure mode. The runner's verdict
 * logic was also exercised against stub batteries: all-pass exits 0, a FAIL
 * exits 1, a crashed battery exits 1, and 3 registered steps with 2 results
 * exits 1 with INCOMPLETE.
 */
const ROOT = resolve(__dirname, '..', '..', '..', '..')
const RUNNER_PATH = join(ROOT, 'e2e', 'run-battery.sh')
const BATTERY_PATH = join(ROOT, 'e2e', 'battery.sh')
const runner = readFileSync(RUNNER_PATH, 'utf8')
const PAIR_PATH = join(ROOT, 'e2e', 'run-battery-pair.sh')
const battery = readFileSync(BATTERY_PATH, 'utf8')
const pair = readFileSync(PAIR_PATH, 'utf8')

describe('the battery runner', () => {
  it('drives the real battery script by default', () => {
    expect(existsSync(BATTERY_PATH)).toBe(true)
    expect(runner).toContain('BATTERY_SH="${BATTERY_SH:-e2e/battery.sh}"')
    expect(runner).toContain('bash "$BATTERY_SH"')
  })

  it('derives the expected step count from the battery script, not a literal', () => {
    // A hardcoded count would drift away from the steps that exist; the same
    // `^step ` shape docs-drift.test.ts counts is what the runner counts.
    expect(runner).toContain(`grep -c '^step ' "$BATTERY_SH"`)
    const registered = (readFileSync(BATTERY_PATH, 'utf8').match(/^step /gm) ?? []).length
    expect(registered).toBeGreaterThan(0)
  })

  it('fails an incomplete run instead of reporting the steps that did pass', () => {
    expect(runner).toContain('INCOMPLETE')
    expect(runner).toMatch(/ran=\$\(\(passed \+ failed\)\)/)
    expect(runner).toMatch(/if \[ "\$ran" -ne "\$EXPECTED" \]; then[\s\S]*?rc=1/)
  })

  it('truncates the results file before the battery runs and can detach under setsid', () => {
    const truncateAt = runner.indexOf(': >"$OUT"')
    const batteryAt = runner.indexOf('bash "$BATTERY_SH"')
    // Truncate first: if the battery fails to parse it never touches OUT, and a
    // stale green file from an earlier run would be counted as this verdict.
    expect(truncateAt).toBeGreaterThan(-1)
    expect(batteryAt).toBeGreaterThan(truncateAt)
    // Detached mode puts the run in its own session so session cleanup cannot
    // kill a half-finished validation.
    expect(runner).toMatch(/DETACHED=1 SESSION="\$SESSION" OUT="\$OUT" setsid nohup bash "\$SELF"/)
  })

  it('gives each detached run its own results file and browser session', () => {
    // Two concurrent detached runs must not truncate each other's OUT or close
    // each other's SESSION: the launcher derives one per-run id and hands both
    // to the child, so the child's cleanup closes exactly the session it was
    // given. An explicit SESSION or OUT is preserved as given.
    expect(runner).toMatch(/OUT="\$\{OUT:-results-[^"]*\.txt\}"/)
    expect(runner).toMatch(/SESSION="\$\{SESSION:-battery-[^"]*\}/)
    expect(runner).toMatch(/DETACHED=1 SESSION="\$SESSION" OUT="\$OUT" setsid nohup bash "\$SELF"/)
  })

  it('refuses to launch a detached run when the log cannot be written', () => {
    // The old form ignored a failed truncation and still printed a detached
    // pid and exit 0, so the caller polled a log that was never created. The
    // guard must run before the child is spawned and exit nonzero, and the
    // launcher flag is already set so the failed launcher owns nothing to
    // clean up.
    const truncateAt = runner.indexOf(': >"$LOG"')
    expect(truncateAt).toBeGreaterThan(-1)
    expect(runner).toMatch(/: >"\$LOG" \|\| \{[\s\S]*?exit 9/)
    // The header comment also mentions `LAUNCHER=1`, so anchor on a code line:
    // the ordering claim is about the assignment the detach block runs, not the
    // prose above it.
    const launcherAt = runner.search(/^\s*LAUNCHER=1\s*$/m)
    expect(launcherAt).toBeGreaterThan(-1)
    expect(launcherAt).toBeLessThan(truncateAt)
  })

  it('writes a terminal BATTERY_EXIT verdict through the cleanup trap on every run exit path', () => {
    const cleanupStart = runner.indexOf('cleanup() {')
    const cleanupEnd = runner.indexOf('\n}', cleanupStart)
    expect(cleanupStart).toBeGreaterThan(-1)
    expect(cleanupEnd).toBeGreaterThan(cleanupStart)
    const cleanup = runner.slice(cleanupStart, cleanupEnd)
    // Setup failures (no browser, nothing serving, no steps), signals and
    // normal exits all pass through the EXIT trap, so a detached caller
    // polling the log always finds the outcome instead of an open-ended tail.
    expect(cleanup).toMatch(/echo "BATTERY_EXIT=\$rc"/)
    // The detached LAUNCHER must not print a verdict: its exit 0 only says the
    // child started, and it must not stop a server or close a session it does
    // not own.
    expect(cleanup).toMatch(/LAUNCHER:-0/)
    expect(runner).toMatch(/LAUNCHER=1[\s\S]*?exit 0/)
    // The trap is armed before the cd that can fail, so even a bad working
    // directory produces a verdict.
    const trapAt = runner.indexOf('trap cleanup EXIT')
    const cdAt = runner.indexOf('cd "$(dirname "$SELF")/.."')
    expect(trapAt).toBeGreaterThan(-1)
    expect(cdAt).toBeGreaterThan(-1)
    expect(trapAt).toBeLessThan(cdAt)
  })

  it('defaults the detached log to a unique path, prints it, and preserves an explicit LOG', () => {
    // Two detached runs must not truncate each other's log; the default carries
    // the start time and the pid.
    expect(runner).toMatch(/LOG="\$\{LOG:-\/tmp\/run-battery-[^"]*\.log\}"/)
    expect(runner).toMatch(/echo "detached: pid \$!, log \$LOG, results \$OUT"/)
    // The printed hint names the terminal line callers poll for.
    expect(runner).toMatch(/BATTERY_EXIT=<code>/)
  })

  it('checks port occupancy apart from the HTTP probe and keeps the started child alive', () => {
    // A probe of "000" is not proof the port is free: a dev server mid-start
    // times out, and a second one would die on EADDRINUSE while the readiness
    // loop reads the other server's responses.
    expect(runner).toContain('port_busy()')
    expect(runner).toMatch(/\/dev\/tcp\//)
    expect(runner).toMatch(/if port_busy; then/)
    expect(runner).toMatch(/kill -0 "\$DEV_PID"/)
  })
  it('owns timing behind an opt-in flag and has no stale copy', () => {
    expect(battery).toContain('TIMING="${TIMING:-0}"')
    expect(battery).toContain('TIMING must be 0 or 1')
    expect(battery).toContain('date +%s.%N')
    expect(battery).toContain('TIMING_OUT')
    expect(battery).toContain('[ "$OUT" -ef "$TIMING_OUT" ]')
    expect(existsSync(join(ROOT, 'e2e', 'battery.timing.sh'))).toBe(false)

    const dir = mkdtempSync(join(tmpdir(), 'battery-timing-'))
    try {
      const result = spawnSync('bash', [BATTERY_PATH], {
        cwd: ROOT,
        env: { ...process.env, TIMING: '2', OUT: join(dir, 'out.txt') },
        encoding: 'utf8',
      })
      expect(result.status, result.stderr).toBe(9)
      expect(result.stderr).toContain('TIMING must be 0 or 1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('hardens the battery helpers and the no-setsid cleanup paths', () => {
    expect(battery).toContain('js_string()')
    expect(battery).toMatch(/const want = \$want/)
    expect(battery).not.toMatch(/const want = \\"\$1\\"/)
    const hideAll = battery.slice(
      battery.indexOf('panels_hide_all() {'),
      battery.indexOf('panels_close_all() {'),
    )
    expect(hideAll).toMatch(/panel_close 'Inspector panel menu' inspector/)
    expect(pair).toContain('readlink -f --')
    expect(runner).toMatch(/set -m[\s\S]{0,200}DEV_GROUP="-\$DEV_PID"/)
    expect(pair).toMatch(/set -m[\s\S]{0,200}ART_GROUP="-\$ART_PID"/)
  })

  it('starts only the artifact server and requires both strict verdicts', () => {
    expect(pair).toContain('ART_PORT')
    expect(pair).toContain('PORT="$ART_PORT"')
    expect(pair).toContain('bash e2e/run-battery.sh')
    expect(pair).toContain('PAIR_LOG')
    expect(pair).toContain('EXPECTED=$(grep -c')
    expect(pair).toContain('DETACH=0')
    expect(pair).toContain('TIMING_OUT_DEV')
    expect(pair).toContain('TIMING_OUT_ART')
    expect(pair).toContain('PAIR_TEST_LEG_CMD')
    expect(pair).toContain('check_same')
    expect(pair).not.toMatch(/bun run dev/)
    // A stalled readiness request must not outlive the retry loop.
    expect(pair).toMatch(/curl -fsS --max-time 3 "\$ART_BASE_URL\/"/)
    // Hardlinks share an inode but not a canonical path.
    expect(pair).toContain('[ "$2" -ef "$4" ]')
  })

  it('keeps the launcher silent and cleans only its own artifact server', () => {
    const cleanupStart = pair.indexOf('cleanup() {')
    const cleanupEnd = pair.indexOf('\n}', cleanupStart)
    expect(cleanupStart).toBeGreaterThan(-1)
    expect(cleanupEnd).toBeGreaterThan(cleanupStart)
    const cleanup = pair.slice(cleanupStart, cleanupEnd)
    expect(cleanup).toMatch(/LAUNCHER:-0/)
    expect(cleanup).toMatch(/PAIR_EXIT=\$rc/)
    expect(cleanup).toMatch(/ART_GROUP/)
    expect(cleanup).toMatch(/kill -TERM "\$group"/)
    expect(cleanup).not.toMatch(/pkill/)
    expect(cleanup).not.toMatch(/agent-browser close/)
    expect(pair).toContain('start_grouped')
    expect(pair).toContain('DEV_RUN_GROUP')
    expect(pair).toContain('ART_RUN_GROUP')
    expect(pair).toMatch(/trap cleanup EXIT[\s\S]*?cd "\$\(dirname "\$SELF"\)\/\.\."/)
    expect(pair).toMatch(/LAUNCHER=1[\s\S]*?exit 0/)
  })

  it('refuses to detach when setsid is unavailable', () => {
    // Without setsid the background launch fails asynchronously, but the old
    // launcher still printed a detached pid and exited 0, so the caller
    // polled a log that never received a verdict.
    const dir = mkdtempSync(join(tmpdir(), 'battery-pair-setsid-'))
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      for (const name of ['basename', 'bash', 'dirname']) {
        const found = spawnSync('bash', ['-c', `command -v ${name}`], { encoding: 'utf8' })
        expect(found.status, `${name}: ${found.stderr}`).toBe(0)
        symlinkSync(found.stdout.trim(), join(bin, name))
      }
      const result = spawnSync('bash', [PAIR_PATH], {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: bin,
          DETACH: '1',
          DETACHED: '0',
          RUN_ID: 'setsid-test',
          PAIR_LOG: join(dir, 'pair.log'),
          OUT_DEV: join(dir, 'dev.txt'),
          OUT_ART: join(dir, 'art.txt'),
        },
        encoding: 'utf8',
      })
      expect(result.status, result.stderr).toBe(9)
      expect(result.stderr).toContain('setsid')
      expect(result.stdout).not.toContain('detached:')
      expect(existsSync(join(dir, 'pair.log'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('validates the battery script before it starts the artifact server', () => {
    // A missing or malformed BATTERY_SH must fail before the expensive
    // artifact server starts, not after it is already answering.
    const readableAt = pair.indexOf('[ -r "$BATTERY_SH" ]')
    const expectedAt = pair.indexOf('EXPECTED=$(grep -c')
    const startAt = pair.indexOf('bun run start')
    expect(readableAt).toBeGreaterThan(-1)
    expect(expectedAt).toBeGreaterThan(readableAt)
    expect(startAt).toBeGreaterThan(expectedAt)
    expect(pair).toContain(`case "$EXPECTED" in '' | *[!0-9]*)`)
    expect(pair).toContain('registers no steps')

    const dir = mkdtempSync(join(tmpdir(), 'battery-pair-input-'))
    try {
      writeFileSync(join(dir, 'empty.sh'), '# no steps yet\n')
      const base = {
        ...process.env,
        PAIR_TEST: '1',
        PAIR_TEST_LEG_CMD: join(dir, 'absent-stub.sh'),
        DETACH: '0',
        DETACHED: '0',
        TIMING: '0',
        TIMING_OUT: '',
        ART_PORT: '3100',
        DEV_BASE_URL: 'http://localhost:3000',
        SESSION_DEV: 'input-dev',
        SESSION_ART: 'input-art',
        OUT_DEV: join(dir, 'dev.txt'),
        OUT_ART: join(dir, 'art.txt'),
        TIMING_OUT_DEV: join(dir, 'dev.timing.txt'),
        TIMING_OUT_ART: join(dir, 'art.timing.txt'),
        LOG_DEV: join(dir, 'dev.log'),
        LOG_ART: join(dir, 'art.log'),
        LOG_ART_SERVER: join(dir, 'server.log'),
        PAIR_LOG: join(dir, 'pair.log'),
      }
      const cases = [
        ['missing', join(dir, 'missing.sh'), 'cannot read BATTERY_SH'],
        ['directory', dir, 'cannot read BATTERY_SH'],
        ['empty', join(dir, 'empty.sh'), 'registers no steps'],
      ] as const
      for (const [name, batteryPath, message] of cases) {
        const result = spawnSync('bash', [PAIR_PATH], {
          cwd: ROOT,
          env: { ...base, BATTERY_SH: batteryPath },
          encoding: 'utf8',
        })
        expect(result.status, `${name}: ${result.stderr}`).toBe(9)
        expect(result.stderr).toContain(message)
        expect(readFileSync(join(dir, 'pair.log'), 'utf8').trimEnd().split('\n').at(-1)).toBe(
          'PAIR_EXIT=9',
        )
        expect(existsSync(join(dir, 'dev.txt')), `${name}: dev leg started`).toBe(false)
        expect(existsSync(join(dir, 'art.txt')), `${name}: artifact leg started`).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects colliding or conflicting pair inputs with PAIR_EXIT=9', () => {
    const dir = mkdtempSync(join(tmpdir(), 'battery-pair-guards-'))
    try {
      const cases: Array<{
        name: string
        env: (run: string) => Record<string, string>
        message: string
      }> = [
        {
          name: 'duplicate-results',
          env: (run) => ({ OUT_DEV: join(run, 'same.txt'), OUT_ART: join(run, 'same.txt') }),
          message: 'OUT_DEV and OUT_ART refer to the same file',
        },
        {
          name: 'timing-results-collision',
          env: (run) => ({ OUT_DEV: join(run, 'dev.txt'), TIMING_OUT_DEV: join(run, 'dev.txt') }),
          message: 'OUT_DEV and TIMING_OUT_DEV refer to the same file',
        },
        {
          name: 'artifact-port-is-dev-port',
          env: () => ({ ART_PORT: '3000' }),
          message: 'ART_PORT must differ from the dev port 3000',
        },
        {
          name: 'duplicate-sessions',
          env: () => ({ SESSION_DEV: 'same-session', SESSION_ART: 'same-session' }),
          message: 'SESSION_DEV and SESSION_ART must differ',
        },
        {
          name: 'timing-out-set',
          env: (run) => ({ TIMING_OUT: join(run, 'timing.txt') }),
          message: 'set TIMING_OUT_DEV and TIMING_OUT_ART, not TIMING_OUT',
        },
        {
          name: 'non-numeric-artifact-port',
          env: () => ({ ART_PORT: '31o0' }),
          message: 'ART_PORT must be numeric',
        },
        {
          name: 'artifact-port-zero',
          env: () => ({ ART_PORT: '0' }),
          message: 'ART_PORT must be between 1 and 65535',
        },
        {
          name: 'artifact-port-too-high',
          env: () => ({ ART_PORT: '65536' }),
          message: 'ART_PORT must be between 1 and 65535',
        },
        {
          name: 'leading-zero-artifact-port-is-dev-port',
          env: () => ({ ART_PORT: '03000' }),
          message: 'ART_PORT must differ from the dev port 3000',
        },
        {
          name: 'unsupported-dev-base-url',
          env: () => ({ DEV_BASE_URL: 'http://localhost:4000' }),
          message: 'DEV_BASE_URL must be http://localhost:3000 or http://127.0.0.1:3000',
        },
        {
          name: 'dev-log-is-dev-results',
          env: (run) => ({ LOG_DEV: join(run, 'dev.txt') }),
          message: 'LOG_DEV and OUT_DEV refer to the same file',
        },
        {
          name: 'artifact-log-is-artifact-timing',
          env: (run) => ({ LOG_ART: join(run, 'art.timing.txt') }),
          message: 'LOG_ART and TIMING_OUT_ART refer to the same file',
        },
        {
          name: 'artifact-server-log-is-artifact-results',
          env: (run) => ({ LOG_ART_SERVER: join(run, 'art.txt') }),
          message: 'LOG_ART_SERVER and OUT_ART refer to the same file',
        },
        {
          name: 'pair-log-is-dev-timing',
          env: (run) => ({ PAIR_LOG: join(run, 'dev.timing.txt') }),
          message: 'PAIR_LOG and TIMING_OUT_DEV refer to the same file',
        },
        {
          name: 'artifact-server-log-is-dev-log',
          env: (run) => ({ LOG_ART_SERVER: join(run, 'dev.log') }),
          message: 'LOG_DEV and LOG_ART_SERVER refer to the same file',
        },
        {
          name: 'dev-log-is-dev-server-log',
          env: () => ({ LOG_DEV: 'dev.log' }),
          message: 'LOG_DEV and DEV_SERVER_LOG refer to the same file',
        },
        {
          name: 'artifact-log-is-server-log',
          env: () => ({ LOG_ART: 'server.log' }),
          message: 'LOG_ART and ARTIFACT_SERVER_LOG refer to the same file',
        },
        {
          name: 'artifact-results-is-server-log',
          env: () => ({ OUT_ART: 'server.log' }),
          message: 'OUT_ART and ARTIFACT_SERVER_LOG refer to the same file',
        },
      ]
      for (const { name, env, message } of cases) {
        const run = join(dir, name)
        mkdirSync(run, { recursive: true })
        const overrides = env(run)
        const pairLog = overrides.PAIR_LOG ?? join(run, 'pair.log')
        const result = spawnSync('bash', [PAIR_PATH], {
          cwd: ROOT,
          env: {
            ...process.env,
            PAIR_TEST: '1',
            PAIR_TEST_LEG_CMD: join(dir, 'absent-stub.sh'),
            DETACH: '0',
            DETACHED: '0',
            TIMING: '0',
            TIMING_OUT: '',
            ART_PORT: '3100',
            DEV_BASE_URL: 'http://localhost:3000',
            SESSION_DEV: 'guard-dev',
            SESSION_ART: 'guard-art',
            OUT_DEV: join(run, 'dev.txt'),
            OUT_ART: join(run, 'art.txt'),
            TIMING_OUT_DEV: join(run, 'dev.timing.txt'),
            TIMING_OUT_ART: join(run, 'art.timing.txt'),
            LOG_DEV: join(run, 'dev.log'),
            LOG_ART: join(run, 'art.log'),
            LOG_ART_SERVER: join(run, 'server.log'),
            PAIR_LOG: join(run, 'pair.log'),
            BATTERY_SH: 'e2e/battery.sh',
            ...overrides,
          },
          encoding: 'utf8',
        })
        expect(result.status, `${name}: ${result.stderr}`).toBe(9)
        expect(result.stderr).toContain(message)
        expect(result.stdout).toContain('PAIR_EXIT=9')
        expect(existsSync(pairLog), `${name}: early failure wrote the pair log`).toBe(false)
        expect(existsSync(join(run, 'dev.txt')), `${name}: dev leg started`).toBe(false)
        expect(existsSync(join(run, 'art.txt')), `${name}: artifact leg started`).toBe(false)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a pair-log collision before truncating the existing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'battery-pair-alias-'))
    try {
      const shared = join(dir, 'dev.log')
      const sentinel = 'keep this line\n'
      const base = {
        ...process.env,
        PAIR_TEST: '1',
        PAIR_TEST_LEG_CMD: join(dir, 'absent-stub.sh'),
        DETACHED: '0',
        TIMING: '0',
        TIMING_OUT: '',
        ART_PORT: '3100',
        DEV_BASE_URL: 'http://localhost:3000',
        SESSION_DEV: 'alias-dev',
        SESSION_ART: 'alias-art',
        OUT_DEV: join(dir, 'dev.txt'),
        OUT_ART: join(dir, 'art.txt'),
        TIMING_OUT_DEV: join(dir, 'dev.timing.txt'),
        TIMING_OUT_ART: join(dir, 'art.timing.txt'),
        LOG_DEV: shared,
        LOG_ART: join(dir, 'art.log'),
        LOG_ART_SERVER: join(dir, 'server.log'),
        PAIR_LOG: shared,
        BATTERY_SH: 'e2e/battery.sh',
      }
      for (const detach of ['0', '1']) {
        writeFileSync(shared, sentinel)
        const result = spawnSync('bash', [PAIR_PATH], {
          cwd: ROOT,
          env: { ...base, DETACH: detach },
          encoding: 'utf8',
        })
        expect(result.status, `detach=${detach}: ${result.stderr}`).toBe(9)
        expect(result.stderr).toContain('PAIR_LOG and LOG_DEV refer to the same file')
        expect(result.stdout).not.toContain('detached:')
        expect(readFileSync(shared, 'utf8')).toBe(sentinel)
      }
      const hard = join(dir, 'dev-hard.log')
      writeFileSync(shared, sentinel)
      linkSync(shared, hard)
      for (const detach of ['0', '1']) {
        writeFileSync(shared, sentinel)
        const result = spawnSync('bash', [PAIR_PATH], {
          cwd: ROOT,
          env: { ...base, PAIR_LOG: hard, DETACH: detach },
          encoding: 'utf8',
        })
        expect(result.status, `hardlink detach=${detach}: ${result.stderr}`).toBe(9)
        expect(result.stderr).toContain('PAIR_LOG and LOG_DEV refer to the same file')
        expect(result.stdout).not.toContain('detached:')
        expect(readFileSync(shared, 'utf8')).toBe(sentinel)
        expect(readFileSync(hard, 'utf8')).toBe(sentinel)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs the normal pair path with stub legs and returns the verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'battery-pair-'))
    try {
      const stepCount = (battery.match(/^step /gm) ?? []).length
      expect(stepCount).toBeGreaterThan(0)
      const stub = join(dir, 'stub-leg.sh')
      writeFileSync(
        stub,
        `#!/usr/bin/env bash
set -u
out="\${OUT:?}"
role="\${PAIR_ROLE:?}"
fix="\${PAIR_FIXTURE:-green}"
line='starting the dev server'
[ "$role" = 'artifact' ] && line='using the server already serving'
pass=${stepCount}
rc=0
fail_row=0
case "$fix:$role" in
  failed:dev) pass=$((pass - 1)); rc=1; fail_row=1 ;;
  incomplete:artifact) pass=$((pass - 1)) ;;
  wrong-server:artifact) line='starting the dev server' ;;
esac
i=0
while [ "$i" -lt "$pass" ]; do
  i=$((i + 1))
  printf 'PASS stub step %s\\n' "$i" >>"$out"
done
[ "$fail_row" = "1" ] && printf 'FAIL stub missing steps\\n' >>"$out"
printf '%s\\n' "$line"
printf 'BATTERY_EXIT=%s\\n' "$rc"
exit "$rc"
`,
      )
      const childExits: Record<string, [string, string]> = {
        green: [
          `dev ${stepCount}/${stepCount} passed, 0 failed (exit 0)`,
          `artifact ${stepCount}/${stepCount} passed, 0 failed (exit 0)`,
        ],
        failed: [
          `dev ${stepCount - 1}/${stepCount} passed, 1 failed (exit 1)`,
          `artifact ${stepCount}/${stepCount} passed, 0 failed (exit 0)`,
        ],
        incomplete: [
          `dev ${stepCount}/${stepCount} passed, 0 failed (exit 0)`,
          `artifact ${stepCount - 1}/${stepCount} passed, 0 failed (exit 0)`,
        ],
        'wrong-server': [
          `dev ${stepCount}/${stepCount} passed, 0 failed (exit 0)`,
          `artifact ${stepCount}/${stepCount} passed, 0 failed (exit 0)`,
        ],
      }
      const failureReasons: Record<string, string[]> = {
        green: [],
        failed: [
          'pair: dev runner exited 1',
          `pair: dev passed ${stepCount - 1} of ${stepCount} steps`,
          'pair: dev recorded 1 failed step(s)',
          'pair: dev log does not end with BATTERY_EXIT=0',
        ],
        incomplete: [`pair: artifact passed ${stepCount - 1} of ${stepCount} steps`],
        'wrong-server': [
          'pair: artifact log is missing using the server already serving',
          'pair: artifact log contains starting the dev server',
        ],
      }
      const cases = [
        ['green', 0],
        ['failed', 1],
        ['incomplete', 1],
        ['wrong-server', 1],
      ] as const
      for (const [fixture, expected] of cases) {
        const run = join(dir, fixture)
        mkdirSync(run, { recursive: true })
        const env = {
          ...process.env,
          PAIR_TEST: '1',
          PAIR_TEST_LEG_CMD: stub,
          PAIR_FIXTURE: fixture,
          DETACH: '0',
          DETACHED: '0',
          TIMING: '0',
          TIMING_OUT: '',
          ART_PORT: '3100',
          DEV_BASE_URL: 'http://localhost:3000',
          SESSION_DEV: 'stub-dev',
          SESSION_ART: 'stub-art',
          OUT_DEV: join(run, 'dev.txt'),
          OUT_ART: join(run, 'art.txt'),
          TIMING_OUT_DEV: join(run, 'dev.timing.txt'),
          TIMING_OUT_ART: join(run, 'art.timing.txt'),
          LOG_DEV: join(run, 'dev.log'),
          LOG_ART: join(run, 'art.log'),
          LOG_ART_SERVER: join(run, 'server.log'),
          PAIR_LOG: join(run, 'pair.log'),
          BATTERY_SH: 'e2e/battery.sh',
        }
        const result = spawnSync('bash', [PAIR_PATH], { cwd: ROOT, env, encoding: 'utf8' })
        expect(result.status, `${fixture}: ${result.stderr}`).toBe(expected)
        const log = readFileSync(join(run, 'pair.log'), 'utf8')
        expect(log).toContain(`pair: ${childExits[fixture][0]}`)
        expect(log).toContain(`pair: ${childExits[fixture][1]}`)
        for (const reason of failureReasons[fixture]) {
          expect(log, `${fixture}: ${reason}`).toContain(reason)
        }
        const failLines = (out: string) =>
          (readFileSync(join(run, out), 'utf8').match(/^FAIL/gm) ?? []).length
        expect(failLines('dev.txt'), `${fixture}: dev FAIL rows`).toBe(fixture === 'failed' ? 1 : 0)
        expect(failLines('art.txt'), `${fixture}: artifact FAIL rows`).toBe(0)
        expect(log.trimEnd().split('\n').at(-1)).toBe(`PAIR_EXIT=${expected}`)
        if (expected === 0) {
          expect(log).toContain('PAIR_EXIT=0')
        } else {
          expect(log).not.toContain('PAIR_EXIT=0')
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

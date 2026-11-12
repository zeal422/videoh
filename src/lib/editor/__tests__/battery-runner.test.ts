import { describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
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
    const aggregateTruncateAt = runner.indexOf(': >"$OUT"')
    // Each shard truncates its own result file inside run_shard before its child
    // starts, and the aggregate OUT is truncated before any shard launches.
    const runShardStart = runner.indexOf('run_shard() {')
    const runShardEnd = runner.indexOf('\n}', runShardStart)
    expect(runShardStart).toBeGreaterThan(-1)
    expect(runShardEnd).toBeGreaterThan(runShardStart)
    const runShard = runner.slice(runShardStart, runShardEnd)
    const shardTruncateAt = runShard.indexOf(': >"$out"')
    const shardBatteryAt = runShard.indexOf('bash "$BATTERY_SH"')
    expect(shardTruncateAt).toBeGreaterThan(-1)
    expect(shardBatteryAt).toBeGreaterThan(shardTruncateAt)
    const shardLaunchAt = runner.indexOf('run_shard "$n"')
    // Truncate first: if the battery fails to parse it never touches OUT, and a
    // stale green file from an earlier run would be counted as this verdict.
    expect(aggregateTruncateAt).toBeGreaterThan(-1)
    expect(shardLaunchAt).toBeGreaterThan(-1)
    expect(shardLaunchAt).toBeGreaterThan(aggregateTruncateAt)
    // Detached mode puts the run in its own session so session cleanup cannot
    // kill a half-finished validation.
    expect(runner).toMatch(
      /DETACHED=1 RUN_ID="\$RUN_ID" SESSION="\$SESSION" OUT="\$OUT" LOG="\$LOG"[\s\\]+setsid nohup bash "\$SELF"/,
    )
  })

  it('gives each detached run its own results file and browser session', () => {
    // Two concurrent detached runs must not truncate each other's OUT or close
    // each other's SESSION: the launcher derives one per-run id and hands both
    // to the child, so the child's cleanup closes exactly the session it was
    // given. An explicit SESSION or OUT is preserved as given.
    expect(runner).toMatch(/OUT="\$\{OUT:-results-[^"]*\.txt\}"/)
    expect(runner).toMatch(/SESSION="\$\{SESSION:-battery-[^"]*\}/)
    expect(runner).toMatch(
      /DETACHED=1 RUN_ID="\$RUN_ID" SESSION="\$SESSION" OUT="\$OUT" LOG="\$LOG"[\s\\]+setsid nohup bash "\$SELF"/,
    )
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
    // The first signal starts cleanup; a second must be ignored instead of
    // re-entering the trap and exiting through the CLEANED guard.
    expect(cleanup).toContain("trap '' INT TERM")
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
    // A TERM trap that only removes temp files lets a signalled battery keep
    // running after the coordinator that owns its session has exited.
    expect(battery).toMatch(/trap 'cleanup_temps; exit 130' INT TERM/)
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
    // The first signal starts cleanup; a second must be ignored instead of
    // re-entering the trap and exiting through the CLEANED guard.
    expect(cleanup).toContain("trap '' INT TERM")
    // A leg is signalled once through its group. The pid fallback applies only
    // when that leg had no group, so it cannot send a second TERM during the
    // runner's cleanup.
    expect(cleanup).toMatch(/\[ -n "\$DEV_RUN_PID" \] && \[ -z "\$DEV_RUN_GROUP" \]/)
    expect(cleanup).not.toMatch(
      /for pid in "\$DEV_RUN_PID" "\$ART_RUN_PID"; do\s*\[ -n "\$pid" \] \|\| continue\s*if kill -0 "\$pid" 2>\/dev\/null; then kill -TERM/,
    )
    expect(cleanup).toMatch(/ART_GROUP/)
    expect(cleanup).toMatch(/kill -TERM "\$group"/)
    // A leg that ignores TERM is killed after the grace period, not left to
    // finish after PAIR_EXIT.
    expect(cleanup).toMatch(/kill -KILL "\$group"/)
    expect(cleanup).not.toContain('leaving its cleanup to its trap')
    // Shards are in their own process groups, so the leg needs more time than
    // the runner's shard grace to kill them before the pair kills the leg.
    const runnerCleanupStart = runner.indexOf('cleanup() {')
    const runnerCleanupEnd = runner.indexOf('\n}', runnerCleanupStart)
    const runnerCleanup = runner.slice(runnerCleanupStart, runnerCleanupEnd)
    const runnerGrace = /for _ in \$\(seq 1 (\d+)\)/.exec(runnerCleanup)
    const pairGrace = /for _ in \$\(seq 1 (\d+)\)/.exec(cleanup)
    expect(runnerGrace).not.toBeNull()
    expect(pairGrace).not.toBeNull()
    expect(Number(pairGrace?.[1])).toBeGreaterThan(Number(runnerGrace?.[1]))
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
      for (const name of ['basename', 'bash', 'date', 'dirname']) {
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

      // The single runner must refuse the same way: without setsid the
      // launcher's background child never starts, so it must not print a pid.
      const runnerResult = spawnSync('bash', [RUNNER_PATH], {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: bin,
          DETACH: '1',
          DETACHED: '0',
          RUN_ID: 'runner-setsid-test',
          LOG: join(dir, 'runner.log'),
          OUT: join(dir, 'runner.txt'),
          SESSION: 'runner-setsid',
          BATTERY_SH: join(ROOT, 'e2e', 'battery.sh'),
        },
        encoding: 'utf8',
      })
      expect(runnerResult.status, runnerResult.stderr).toBe(9)
      expect(runnerResult.stderr).toContain('setsid')
      expect(runnerResult.stdout).not.toContain('detached:')
      expect(existsSync(join(dir, 'runner.log'))).toBe(false)
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
        {
          name: 'dev-shard-result-is-artifact-results',
          env: (run) => ({
            OUT_DEV: join(run, 'dev.txt'),
            OUT_ART: join(run, 'dev.s1.txt'),
          }),
          message: 'pair: dev shard 1 result and OUT_ART refer to the same file',
        },
        {
          name: 'dev-shard-timing-is-artifact-results',
          env: (run) => ({
            OUT_ART: join(run, 'dev.timing.s1.txt'),
          }),
          message: 'pair: dev shard 1 timing and OUT_ART refer to the same file',
        },
        {
          name: 'dev-shard-result-is-battery-script',
          env: (run) => ({ BATTERY_SH: join(run, 'dev.s1.txt') }),
          message: 'pair: dev shard 1 result and BATTERY_SH refer to the same file',
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
      // The battery script is a source, not an output: a pair log that aliases
      // it would truncate the script before the legs read it.
      const script = join(dir, 'battery-source.sh')
      const scriptText = '#!/usr/bin/env bash\nstep "stub" stub\n'
      writeFileSync(script, scriptText)
      for (const detach of ['0', '1']) {
        const result = spawnSync('bash', [PAIR_PATH], {
          cwd: ROOT,
          env: { ...base, BATTERY_SH: script, PAIR_LOG: script, DETACH: detach },
          encoding: 'utf8',
        })
        expect(result.status, `script detach=${detach}: ${result.stderr}`).toBe(9)
        expect(result.stderr).toContain('BATTERY_SH and PAIR_LOG refer to the same file')
        expect(result.stdout).not.toContain('detached:')
        expect(readFileSync(script, 'utf8')).toBe(scriptText)
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

  it('assigns every registered step to exactly one shard', () => {
    // The four shards must partition the 70 `step` lines: a missing function
    // silently drops a step from a sharded run, and a duplicate puts one step in
    // two browser sessions. The summary counts pin the intended cut points.
    const registered = (battery.match(/^step\s+"[^"]+"\s+([a-z0-9_]+)\s*$/gm) ?? []).map(
      (line) => /([a-z0-9_]+)\s*$/.exec(line)?.[1] ?? '',
    )
    expect(registered).toHaveLength(70)
    const start = battery.indexOf('shard_of() {')
    const end = battery.indexOf('\n}', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = battery.slice(start, end)
    const pairs: Array<[string, number]> = []
    let pending: string[] = []
    for (const line of body.split('\n')) {
      const arm = /^\s{4}([a-z0-9_ |]+)\)\s*$/.exec(line)
      if (arm) {
        pending = arm[1]
          .split('|')
          .map((name) => name.trim())
          .filter(Boolean)
        continue
      }
      const echo = /^\s+echo ([1-4])\s*$/.exec(line)
      if (echo && pending.length > 0) {
        for (const name of pending) pairs.push([name, Number(echo[1])])
        pending = []
      }
    }
    expect(pending).toEqual([])
    const names = pairs.map(([name]) => name)
    expect(names.slice().sort()).toEqual(registered.slice().sort())
    expect(new Set(names).size).toBe(names.length)
    const counts = [1, 2, 3, 4].map((shard) => pairs.filter(([, s]) => s === shard).length)
    expect(counts).toEqual([30, 12, 14, 14])
    expect(pairs.find(([name]) => name === 'console_clean')?.[1]).toBe(4)
    // The coordinator collapses the four console rows under the registered
    // name; a drift there would write a row no step registered.
    const consoleName = /^step "(console:[^"]*)"/m.exec(battery)?.[1]
    expect(consoleName).toBe('console: zero page errors across battery')
    expect(runner).toContain(`local console_name='${consoleName}'`)
  })

  it('validates shard inputs before touching a browser', () => {
    const dir = mkdtempSync(join(tmpdir(), 'battery-shard-env-'))
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      const fake = join(bin, 'agent-browser')
      const agentLog = join(dir, 'agent-closes.log')
      writeFileSync(
        fake,
        `#!/bin/sh
if [ -n "\${AGENT_LOG:-}" ] && [ "$3" = "close" ]; then
  printf '%s\\n' "$2" >> "\${AGENT_LOG:?}"
fi
exit 1
`,
      )
      chmodSync(fake, 0o755)
      // A detached-case failure must not spawn a real child during the test.
      const fakeSetsid = join(bin, 'setsid')
      writeFileSync(fakeSetsid, '#!/bin/sh\nexit 1\n')
      chmodSync(fakeSetsid, 0o755)
      // Force the portable path-identity fallback: realpath fails and the
      // readlink shim rejects -f while still resolving a single link.
      const realReadlink = spawnSync('bash', ['-c', 'command -v readlink'], {
        encoding: 'utf8',
      })
      expect(realReadlink.status, realReadlink.stderr).toBe(0)
      const fakeRealpath = join(bin, 'realpath')
      writeFileSync(fakeRealpath, '#!/bin/sh\nexit 1\n')
      chmodSync(fakeRealpath, 0o755)
      const fakeReadlink = join(bin, 'readlink')
      writeFileSync(
        fakeReadlink,
        `#!/bin/sh
if [ "$1" = "-f" ]; then exit 1; fi
exec "${realReadlink.stdout.trim()}" "$@"
`,
      )
      chmodSync(fakeReadlink, 0o755)
      const base = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        OUT: join(dir, 'out.txt'),
        TIMING: '0',
      }
      const batteryCases: Array<[string, Record<string, string>, string]> = [
        ['zero-count', { BATTERY_SHARDS: '0' }, 'BATTERY_SHARDS must be 1 or 4'],
        ['two-count', { BATTERY_SHARDS: '2' }, 'BATTERY_SHARDS must be 1 or 4'],
        ['eight-count', { BATTERY_SHARDS: '8' }, 'BATTERY_SHARDS must be 1 or 4'],
        ['non-numeric-count', { BATTERY_SHARDS: 'x' }, 'BATTERY_SHARDS must be 1 or 4'],
        [
          'zero-shard',
          { BATTERY_SHARDS: '4', BATTERY_SHARD: '0' },
          'BATTERY_SHARD must be between 1 and 4',
        ],
        [
          'five-shard',
          { BATTERY_SHARDS: '4', BATTERY_SHARD: '5' },
          'BATTERY_SHARD must be between 1 and 4',
        ],
        [
          'non-numeric-shard',
          { BATTERY_SHARDS: '4', BATTERY_SHARD: 'x' },
          'BATTERY_SHARD must be an integer from 1 to 4',
        ],
        [
          'overflow-shard',
          { BATTERY_SHARDS: '4', BATTERY_SHARD: '18446744073709551617' },
          'BATTERY_SHARD must be between 1 and 4',
        ],
      ]
      for (const [name, env, message] of batteryCases) {
        const result = spawnSync('bash', [BATTERY_PATH], {
          cwd: ROOT,
          env: { ...base, ...env },
          encoding: 'utf8',
        })
        expect(result.status, `${name}: ${result.stderr}`).toBe(9)
        expect(result.stderr).toContain(message)
      }
      // The middle values must stay accepted: shard 2 is not one of the two
      // configured counts, but it is a valid shard of four.
      const accepted = spawnSync('bash', [BATTERY_PATH], {
        cwd: ROOT,
        env: { ...base, BATTERY_SHARDS: '4', BATTERY_SHARD: '2' },
        encoding: 'utf8',
      })
      expect(accepted.status, accepted.stderr).toBe(1)
      expect(accepted.stderr).toContain('shard 2 seed failed')

      writeFileSync(agentLog, '')
      const runnerResult = spawnSync('bash', [RUNNER_PATH], {
        cwd: ROOT,
        env: {
          ...base,
          BASE_URL: 'http://127.0.0.1:9',
          SHARDS: '2',
          OUT: join(dir, 'runner.txt'),
          AGENT_LOG: agentLog,
        },
        encoding: 'utf8',
      })
      expect(runnerResult.status, runnerResult.stderr).toBe(9)
      expect(runnerResult.stderr).toContain('SHARDS must be 1 or 4')
      expect(runnerResult.stdout).toContain('BATTERY_EXIT=9')
      // Validation failed before any session was recorded. Cleanup must not
      // close the configured SESSION speculatively.
      expect(readFileSync(agentLog, 'utf8').trim()).toBe('')

      // The standalone sharded runner derives one result, timing, and log per
      // shard, and the aggregate writes OUT/TIMING_OUT after they run. A
      // derived file that aliases another writer is truncated, so reject it
      // before the first truncation rather than corrupting the verdict.
      const collide = spawnSync('bash', [RUNNER_PATH], {
        cwd: ROOT,
        env: {
          ...base,
          BASE_URL: 'http://127.0.0.1:9',
          SHARDS: '4',
          OUT: join(dir, 'collide.txt'),
          SHARD_LOG_BASE: join(dir, 'collide.txt'),
          TIMING: '0',
          TIMING_OUT: '',
        },
        encoding: 'utf8',
      })
      expect(collide.status, collide.stderr).toBe(9)
      expect(collide.stderr).toContain('shard 1 log and shard 1 result refer to the same file')
      expect(existsSync(join(dir, 'collide.txt'))).toBe(false)
      expect(existsSync(join(dir, 'collide.s1.txt'))).toBe(false)

      // The battery script is a source, not an output. A results path that
      // aliases it must fail before the runner truncates OUT.
      const script = join(dir, 'battery-source.sh')
      const scriptText = '#!/usr/bin/env bash\nstep "stub" stub\n'
      writeFileSync(script, scriptText)
      const scriptCollision = spawnSync('bash', [RUNNER_PATH], {
        cwd: ROOT,
        env: {
          ...base,
          BASE_URL: 'http://127.0.0.1:9',
          SHARDS: '4',
          OUT: script,
          BATTERY_SH: script,
        },
        encoding: 'utf8',
      })
      expect(scriptCollision.status, scriptCollision.stderr).toBe(9)
      expect(scriptCollision.stderr).toContain('BATTERY_SH and OUT refer to the same file')
      expect(readFileSync(script, 'utf8')).toBe(scriptText)

      // The detached launcher truncates LOG before the child's checks run. A
      // log that aliases the battery script would destroy it before the child
      // reads a single step.
      const detachScript = join(dir, 'detach-source.sh')
      const detachText = '#!/usr/bin/env bash\nstep "stub" stub\n'
      writeFileSync(detachScript, detachText)
      const detachCollision = spawnSync('bash', [RUNNER_PATH], {
        cwd: ROOT,
        env: {
          ...base,
          DETACH: '1',
          DETACHED: '0',
          LOG: detachScript,
          BATTERY_SH: detachScript,
          OUT: join(dir, 'detach-out.txt'),
        },
        encoding: 'utf8',
      })
      expect(detachCollision.status, detachCollision.stderr).toBe(9)
      expect(detachCollision.stderr).toContain('LOG and BATTERY_SH refer to the same file')
      expect(detachCollision.stdout).not.toContain('detached:')
      expect(readFileSync(detachScript, 'utf8')).toBe(detachText)

      // The launcher also protects the fixed dev-server log.
      const devLogCollision = spawnSync('bash', [RUNNER_PATH], {
        cwd: ROOT,
        env: {
          ...base,
          DETACH: '1',
          DETACHED: '0',
          LOG: 'dev.log',
          OUT: join(dir, 'dev-log-out.txt'),
        },
        encoding: 'utf8',
      })
      expect(devLogCollision.status, devLogCollision.stderr).toBe(9)
      expect(devLogCollision.stderr).toContain('LOG and dev.log refer to the same file')
      expect(devLogCollision.stdout).not.toContain('detached:')

      // The detached child includes LOG in its derived-path sweep.
      const childOut = join(dir, 'child-out.txt')
      const childLog = join(dir, 'child-out.s1.txt')
      const childCollision = spawnSync('bash', [RUNNER_PATH], {
        cwd: ROOT,
        env: {
          ...base,
          BASE_URL: 'http://127.0.0.1:9',
          SHARDS: '4',
          DETACH: '0',
          DETACHED: '1',
          LOG: childLog,
          OUT: childOut,
          SHARD_LOG_BASE: join(dir, 'child-shard.logs'),
          TIMING: '0',
          TIMING_OUT: '',
        },
        encoding: 'utf8',
      })
      expect(childCollision.status, childCollision.stderr).toBe(9)
      expect(childCollision.stderr).toContain('shard 1 result and LOG refer to the same file')
      expect(existsSync(childLog)).toBe(false)

      // The launcher truncates LOG before the child's derived-path check, so it
      // must reject a LOG that aliases a shard result itself.
      const launcherOut = join(dir, 'launcher-out.txt')
      const launcherLog = join(dir, 'launcher-out.s1.txt')
      const launcherCollision = spawnSync('bash', [RUNNER_PATH], {
        cwd: ROOT,
        env: {
          ...base,
          DETACH: '1',
          DETACHED: '0',
          SHARDS: '4',
          OUT: launcherOut,
          TIMING_OUT: '',
          LOG: launcherLog,
          SHARD_LOG_BASE: join(dir, 'launcher-shard.logs'),
        },
        encoding: 'utf8',
      })
      expect(launcherCollision.status, launcherCollision.stderr).toBe(9)
      expect(launcherCollision.stderr).toContain('LOG and shard 1 result refer to the same file')
      expect(launcherCollision.stdout).not.toContain('detached:')
      expect(existsSync(launcherLog)).toBe(false)

      // The portable path-identity fallback must follow a dangling final
      // symlink. -ef cannot catch it because the target does not exist.
      const symlinkTarget = join(dir, 'symlink-target.txt')
      const symlinkOut = join(dir, 'symlink-out.txt')
      symlinkSync(symlinkTarget, symlinkOut)
      const symlinkCollision = spawnSync('bash', [RUNNER_PATH], {
        cwd: ROOT,
        env: {
          ...base,
          BASE_URL: 'http://127.0.0.1:9',
          SHARDS: '1',
          OUT: symlinkOut,
          TIMING_OUT: symlinkTarget,
        },
        encoding: 'utf8',
      })
      expect(symlinkCollision.status, symlinkCollision.stderr).toBe(9)
      expect(symlinkCollision.stderr).toContain('OUT and TIMING_OUT refer to the same file')
      expect(existsSync(symlinkTarget)).toBe(false)

      // The runners keep standalone copies of the path helpers. Lock the
      // bodies so one copy cannot drift from the other.
      const functionBody = (source: string, name: string) => {
        const start = source.indexOf(`${name}() {`)
        const end = source.indexOf('\n}', start)
        expect(start, name).toBeGreaterThan(-1)
        expect(end, name).toBeGreaterThan(start)
        return source.slice(start, end)
      }
      expect(functionBody(runner, 'path_id')).toBe(functionBody(pair, 'path_id'))
      for (const name of ['check_same', 'check_same_cached']) {
        expect(functionBody(runner, name).replaceAll('battery:', 'pair:')).toBe(
          functionBody(pair, name),
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('aggregates shard results into one strict 70-row verdict', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'battery-shard-aggregate-'))
    // The stub server must live in another process: spawnSync blocks this
    // process's event loop, so an in-process server could never answer the
    // runner's readiness probe.
    const server = spawn(
      process.execPath,
      [
        '-e',
        "const http=require('node:http');const s=http.createServer((q,r)=>{r.writeHead(200);r.end('ok')});s.listen(0,'127.0.0.1',()=>console.log(s.address().port))",
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    const port = await new Promise<number>((resolve, reject) => {
      let buffer = ''
      server.stdout?.on('data', (chunk) => {
        buffer += String(chunk)
        const match = /^(\d+)\n/.exec(buffer)
        if (match) resolve(Number(match[1]))
      })
      server.once('error', reject)
      server.once('exit', (code) => reject(new Error(`stub server exited ${code}`)))
    })
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      const fake = join(bin, 'agent-browser')
      const agentLog = join(dir, 'closed-sessions.log')
      writeFileSync(
        fake,
        `#!/bin/sh
if [ "$3" = "close" ]; then
  printf '%s\\n' "$2" >> "\${AGENT_LOG:?}"
fi
exit 0
`,
      )
      chmodSync(fake, 0o755)
      const registrations = Array.from({ length: 70 }, (_, i) => `step "stub ${i + 1}" noop`).join(
        '\n',
      )
      const stub = join(dir, 'stub-battery.sh')
      writeFileSync(
        stub,
        `#!/usr/bin/env bash
set -u
out="\${OUT:?}"
shard="\${BATTERY_SHARD:-1}"
shards="\${BATTERY_SHARDS:-1}"
if [ "$shards" = "1" ]; then
  n=69
else
  case "$shard" in
    1 | 2 | 3) n=18 ;;
    4) n=15 ;;
    *) n=0 ;;
  esac
fi
i=0
while [ "$i" -lt "$n" ]; do
  i=$((i + 1))
  if [ "\${STUB_FAIL_SHARD:-}" = "$shard" ] && [ "$i" = "1" ]; then
    echo "FAIL stub step $shard-$i" >>"$out"
  else
    echo "PASS stub step $shard-$i" >>"$out"
  fi
done
echo "PASS console: zero page errors across battery" >>"$out"
if [ "\${TIMING:-0}" = "1" ]; then
  printf 'shard %s\\n' "$shard" >>"\${TIMING_OUT:?}"
fi
exit 0
${registrations}
`,
      )
      const run = (
        name: string,
        shards: string,
        failShard = '',
        timing = '0',
        timingOut = '',
        session = `shard-${name}`,
      ) => {
        const runDir = join(dir, name)
        mkdirSync(runDir)
        return spawnSync('bash', [RUNNER_PATH], {
          cwd: ROOT,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            BASE_URL: `http://127.0.0.1:${port}`,
            SESSION: session,
            OUT: join(runDir, 'results.txt'),
            SHARD_LOG_BASE: join(runDir, 'battery.log'),
            BATTERY_SH: stub,
            SHARDS: shards,
            TIMING: timing,
            TIMING_OUT: timingOut,
            STUB_FAIL_SHARD: failShard,
            AGENT_LOG: agentLog,
          },
          encoding: 'utf8',
        })
      }
      const rows = (file: string) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => /^(PASS|FAIL) /.test(line))

      const sequential = run('sequential', '1')
      expect(sequential.status, sequential.stderr).toBe(0)
      expect(rows(join(dir, 'sequential', 'results.txt'))).toHaveLength(70)

      const green = run('green', '4')
      expect(green.status, green.stderr).toBe(0)
      const greenRows = rows(join(dir, 'green', 'results.txt'))
      expect(greenRows).toHaveLength(70)
      expect(greenRows.filter((line) => line.includes('console:'))).toHaveLength(1)
      expect(greenRows.every((line) => line.startsWith('PASS'))).toBe(true)

      const red = run('red', '4', '2')
      expect(red.status, red.stderr).toBe(1)
      const redRows = rows(join(dir, 'red', 'results.txt'))
      expect(redRows).toHaveLength(70)
      expect(redRows.filter((line) => line.startsWith('FAIL'))).toEqual(['FAIL stub step 2-1'])

      // Paths with spaces are legal inputs. Each shard result and timing must
      // stay one array element; word-splitting drops every PASS row and empties
      // the aggregated timing file.
      const spaced = run('spaced results', '4')
      expect(spaced.status, spaced.stderr).toBe(0)
      expect(rows(join(dir, 'spaced results', 'results.txt'))).toHaveLength(70)

      const timingDir = join(dir, 'spaced timing')
      mkdirSync(timingDir)
      const spacedTiming = run('plain', '4', '', '1', join(timingDir, 'timing out.txt'))
      expect(spacedTiming.status, spacedTiming.stderr).toBe(0)
      expect(
        readFileSync(join(timingDir, 'timing out.txt'), 'utf8').split('\n').filter(Boolean),
      ).toHaveLength(4)

      // A session name may contain spaces. Every shard session must reach
      // agent-browser close as one argument, not as words split by the cleanup.
      writeFileSync(agentLog, '')
      const spacedSession = run('spaced-session', '4', '', '0', '', 'session with spaces')
      expect(spacedSession.status, spacedSession.stderr).toBe(0)
      expect(rows(join(dir, 'spaced-session', 'results.txt'))).toHaveLength(70)
      expect(readFileSync(agentLog, 'utf8').trim().split('\n')).toEqual([
        'session with spaces-s1',
        'session with spaces-s2',
        'session with spaces-s3',
        'session with spaces-s4',
      ])
    } finally {
      server.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kills and reaps a shard that ignores TERM before reporting the verdict', async () => {
    // The coordinator's verdict is final: a shard still writing results or
    // driving a browser after BATTERY_EXIT is the failure this locks out.
    // A TERM-only cleanup reached the shard's trap and then let it continue.
    const dir = mkdtempSync(join(tmpdir(), 'battery-shard-stubborn-'))
    const server = spawn(
      process.execPath,
      [
        '-e',
        "const http=require('node:http');const s=http.createServer((q,r)=>{r.writeHead(200);r.end('ok')});s.listen(0,'127.0.0.1',()=>console.log(s.address().port))",
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    )
    const port = await new Promise<number>((resolve, reject) => {
      let buffer = ''
      server.stdout?.on('data', (chunk) => {
        buffer += String(chunk)
        const match = /^(\d+)\n/.exec(buffer)
        if (match) resolve(Number(match[1]))
      })
      server.once('error', reject)
      server.once('exit', (code) => reject(new Error(`stub server exited ${code}`)))
    })
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      const fake = join(bin, 'agent-browser')
      writeFileSync(fake, '#!/bin/sh\nexit 0\n')
      chmodSync(fake, 0o755)
      const marker = join(dir, 'shard-marker.log')
      const stub = join(dir, 'stubborn-battery.sh')
      // Ignore TERM in the shell and stay alive without a child process, so
      // only the coordinator's escalation can stop it. `done` appears after 5s,
      // well past the cleanup grace period.
      writeFileSync(
        stub,
        `#!/usr/bin/env bash
set -u
trap '' TERM
echo started >> "\${MARKER:?}"
end=$((SECONDS + 5))
while [ "$SECONDS" -lt "$end" ]; do :; done
echo done >> "\${MARKER:?}"
step "stub" noop
`,
      )
      chmodSync(stub, 0o755)
      const child = spawn('bash', [RUNNER_PATH], {
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          BASE_URL: `http://127.0.0.1:${port}`,
          SESSION: 'stubborn-shard',
          OUT: join(dir, 'results.txt'),
          SHARD_LOG_BASE: join(dir, 'battery.log'),
          BATTERY_SH: stub,
          SHARDS: '4',
          MARKER: marker,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      const startedAt = Date.now()
      while (!existsSync(marker) || !readFileSync(marker, 'utf8').includes('started')) {
        if (Date.now() - startedAt > 5000) {
          throw new Error(`the stub shard never started: ${stderr}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      child.kill('SIGTERM')
      // A pair leg receives the group TERM and, in the old code, a second TERM
      // aimed at the runner pid. The second signal must not abort the running
      // cleanup before it kills the shard groups.
      await new Promise((resolve) => setTimeout(resolve, 100))
      child.kill('SIGTERM')
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
      expect(code, stderr).toBe(130)
      // Past the stub's sleep: a TERM-only cleanup leaves it alive to write
      // this line after the terminal verdict.
      await new Promise((resolve) => setTimeout(resolve, 5200))
      expect(readFileSync(marker, 'utf8')).not.toContain('done')
    } finally {
      server.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  it('kills a pair leg that ignores TERM before writing PAIR_EXIT', async () => {
    // The pair owns both legs' process groups. A leg that survives the TERM
    // grace must be killed and reaped, not left running after PAIR_EXIT.
    const dir = mkdtempSync(join(tmpdir(), 'battery-pair-stubborn-'))
    try {
      const marker = join(dir, 'leg-marker.log')
      const leg = join(dir, 'stubborn-leg.sh')
      writeFileSync(
        leg,
        `#!/usr/bin/env bash
set -u
trap '' TERM
echo started >> "\${MARKER:?}"
end=$((SECONDS + 8))
while [ "$SECONDS" -lt "$end" ]; do :; done
echo done >> "\${MARKER:?}"
`,
      )
      chmodSync(leg, 0o755)
      const batteryStub = join(dir, 'battery-stub.sh')
      writeFileSync(batteryStub, '#!/usr/bin/env bash\nstep "stub" noop\n')
      const child = spawn('bash', [PAIR_PATH], {
        cwd: ROOT,
        env: {
          ...process.env,
          PAIR_TEST: '1',
          PAIR_TEST_LEG_CMD: leg,
          BATTERY_SH: batteryStub,
          PAIR_SHARDS: '1',
          ART_PORT: '31999',
          MARKER: marker,
          OUT_DEV: join(dir, 'dev.txt'),
          OUT_ART: join(dir, 'artifact.txt'),
          LOG_DEV: join(dir, 'dev.log'),
          LOG_ART: join(dir, 'artifact.log'),
          LOG_ART_SERVER: join(dir, 'artifact-server.log'),
          PAIR_LOG: join(dir, 'pair.log'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      const startedAt = Date.now()
      while (!existsSync(marker) || !readFileSync(marker, 'utf8').includes('started')) {
        if (Date.now() - startedAt > 5000) {
          throw new Error(`the stub leg never started: ${stderr}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      child.kill('SIGTERM')
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
      expect(code, stderr).toBe(130)
      await new Promise((resolve) => setTimeout(resolve, 9500))
      expect(readFileSync(marker, 'utf8')).not.toContain('done')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30000)

  it('skips steps owned by another shard and runs the console check everywhere', () => {
    // Execute the real step() source against stub step functions: this is the
    // behavioral lock on "an unowned step writes no row", not just a shape
    // assertion. console_clean is mapped to shard 4 yet must still run in shard 2.
    const start = battery.indexOf('step() {')
    const end = battery.indexOf('\n}', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const stepFunction = battery.slice(start, end + 2)
    const dir = mkdtempSync(join(tmpdir(), 'battery-shard-step-'))
    try {
      const out = join(dir, 'out.txt')
      const script = join(dir, 'step.sh')
      writeFileSync(
        script,
        `#!/usr/bin/env bash
set -uo pipefail
OUT="$1"
TIMING=0
BATTERY_SHARDS=4
BATTERY_SHARD=2
shard_of() {
  case "$1" in
    owned_step) echo 2 ;;
    other_step) echo 1 ;;
    console_clean) echo 4 ;;
    *) return 1 ;;
  esac
}
owned_step() { return 0; }
other_step() { return 0; }
console_clean() { return 0; }
${stepFunction}
: >"$OUT"
step "owned" owned_step
step "other" other_step
step "console" console_clean
step "unmapped" mystery_step
exit 0
`,
      )
      const result = spawnSync('bash', [script, out], { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      const lines = readFileSync(out, 'utf8').trimEnd().split('\n')
      expect(lines).toEqual([
        'PASS owned',
        'PASS console',
        'FAIL unmapped (no shard owns mystery_step)',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

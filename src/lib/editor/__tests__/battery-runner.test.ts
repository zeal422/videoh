import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
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
})

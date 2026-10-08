#!/usr/bin/env bash
# e2e/run-battery.sh: take the UI battery from a cold start to a verdict.
#
# e2e/battery.sh needs a live server, a gate password and a browser session, and
# leaves a dev server and a headless Chrome behind if you run it by hand. This
# runner owns all of that, and it closes the failure mode that matters most: a
# harness that kills the background children it spawned when its session ends
# takes a half-finished run with it, and a partial PASS list still looks like a
# result. DETACH=1 re-execs this script under setsid, so the run owns its own
# session and survives. The launcher prints the unique log path and exits 0
# (child started, NOT a verdict); the RUN's outcome is the terminal
# `BATTERY_EXIT=<code>` line written to that log on every exit path, plus the
# results file. Poll the log for BATTERY_EXIT instead of the launcher's exit.
#
# The verdict is strict: BATTERY_EXIT=0 only when every `step` line in the
# battery script produced a PASS. A FAIL fails, and so does a run that produced
# fewer result lines than there are registered steps, which is what a killed or
# crashed run looks like. Setup failures (nothing serving, no browser) exit
# nonzero before the battery starts, and still leave a terminal verdict line.
#
# Usage:
#   bash e2e/run-battery.sh                  # foreground
#   DETACH=1 bash e2e/run-battery.sh         # detached, survives session cleanup
#   OUT=results-a.txt SESSION=ab-a bash e2e/run-battery.sh
#
# Env:
#   BASE_URL      server under test          (default http://localhost:3000)
#   SESSION       agent-browser session      (default battery; detached runs get battery-<date>-<pid>)
#   OUT           results file, gitignored   (default results.txt; detached runs get results-<date>-<pid>.txt)
#   BATTERY_SH    battery script to drive    (default e2e/battery.sh)
#   DETACH        1 = re-exec detached under setsid
#   LOG           detached log path          (default /tmp/run-battery-<date>-<pid>.log, unique per run)
#   KEEP_DEV      1 = leave a server this run started running
#   KEEP_SESSION  1 = leave the browser session open
set -uo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

# Lifecycle state is declared, and the EXIT trap armed, BEFORE the cd below:
# every run exit path (a bad working directory included, and every setup failure
# further down) then leaves the terminal BATTERY_EXIT verdict in the log. The
# detached LAUNCHER sets LAUNCHER=1 and exits before doing any work: it must not
# close a session or stop a server it does not own, and it prints no verdict,
# because its own exit 0 only says the child was spawned.
DEV_PID=''
DEV_GROUP=''
CLEANED=''
LAUNCHER=''
cleanup() {
  local rc=$?
  [ -n "$CLEANED" ] && exit "$rc"
  CLEANED=1
  if [ "${LAUNCHER:-0}" = "1" ]; then exit "$rc"; fi
  if [ -n "$DEV_PID" ] && [ "${KEEP_DEV:-0}" != "1" ]; then
    # setsid gave the server its own process group, so the group kill reaches
    # next-server and its workers, not just the wrapper bun run dev.
    if [ -n "$DEV_GROUP" ]; then
      kill -TERM "$DEV_GROUP" 2>/dev/null || kill -TERM "$DEV_PID" 2>/dev/null
    else
      kill -TERM "$DEV_PID" 2>/dev/null
    fi
    sleep 1
    kill -KILL "$DEV_PID" 2>/dev/null
    if [ -n "$DEV_GROUP" ]; then kill -KILL "$DEV_GROUP" 2>/dev/null; fi
    echo "dev server stopped (pid $DEV_PID)"
  fi
  if [ "${KEEP_SESSION:-0}" != "1" ]; then
    # ${SESSION:-battery}: the launcher can reach cleanup before the default is
    # resolved, but it exits at the LAUNCHER guard above; this only keeps the
    # function safe under set -u if that guard is ever consulted another way.
    agent-browser --session "${SESSION:-battery}" close >/dev/null 2>&1
  fi
  # Terminal verdict: last line of every run's log, setup failures and signals
  # included, so a detached caller polling the log always sees the outcome.
  echo "BATTERY_EXIT=$rc"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cd "$(dirname "$SELF")/.." || exit 9

# The detached launcher decides its own defaults BEFORE the foreground ones
# below resolve: the shared default would otherwise already be in place, and
# two detached runs would write one results file and share one browser session
# (one run's cleanup could then close the other run's session mid-step). One
# per-run id names all three side-effecting outputs; an explicit LOG, OUT or
# SESSION is preserved as given. SESSION and OUT are handed to the child
# explicitly, so the child resolves no default of its own and its cleanup
# closes exactly the session it was given. LAUNCHER=1 short-circuits the
# cleanup trap: this process owns no server or session, and its own exit says
# the child was spawned, not how the run ended.
if [ "${DETACH:-0}" = "1" ] && [ "${DETACHED:-0}" != "1" ]; then
  RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
  LOG="${LOG:-/tmp/run-battery-$RUN_ID.log}"
  OUT="${OUT:-results-$RUN_ID.txt}"
  SESSION="${SESSION:-battery-$RUN_ID}"
  LAUNCHER=1
  # Checked BEFORE the child is spawned: a log that cannot be written would
  # otherwise print a pid and exit 0 for a run whose verdict can never be seen.
  : >"$LOG" || {
    echo "cannot write the detached log $LOG" >&2
    exit 9
  }
  DETACHED=1 SESSION="$SESSION" OUT="$OUT" setsid nohup bash "$SELF" >"$LOG" 2>&1 </dev/null &
  echo "detached: pid $!, log $LOG, results $OUT"
  echo "poll: tail -f $LOG (terminal verdict: BATTERY_EXIT=<code>, 0 = green)"
  exit 0
fi

BASE_URL="${BASE_URL:-http://localhost:3000}"
SESSION="${SESSION:-battery}"
OUT="${OUT:-results.txt}"
BATTERY_SH="${BATTERY_SH:-e2e/battery.sh}"

command -v agent-browser >/dev/null 2>&1 || {
  echo "agent-browser is not on PATH; the battery drives the real UI" >&2
  exit 9
}
command -v curl >/dev/null 2>&1 || {
  echo "curl is not on PATH; it probes the dev server for readiness" >&2
  exit 9
}

probe() { curl -s --max-time 3 -o /dev/null -w '%{http_code}' "$BASE_URL/" 2>/dev/null; }

# Is SOMETHING accepting TCP on the BASE_URL port? A probe result of "000"
# (timeout, refused, non-HTTP service) is not proof the port is free: a dev
# server still starting can time out, and a second dev server would then die on
# EADDRINUSE while the readiness loop reads the OTHER server's responses.
port_busy() {
  local host port
  host=${BASE_URL#*://}
  host=${host%%[:/]*}
  port=${BASE_URL##*:}
  port=${port%%/*}
  case "$port" in '' | *[!0-9]*) return 1 ;; esac
  [ -n "$host" ] || return 1
  (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null
}

code=$(probe)
if [ -n "$code" ] && [ "$code" != "000" ]; then
  echo "using the server already serving $BASE_URL (http $code)"
elif [ "$BASE_URL" = "http://localhost:3000" ] || [ "$BASE_URL" = "http://127.0.0.1:3000" ]; then
  if port_busy; then
    echo "$BASE_URL is occupied but did not answer HTTP (probe: ${code:-none}); refusing to start a second dev server" >&2
    echo "wait for that server to finish starting (or stop it), then rerun" >&2
    exit 9
  fi
  echo "starting the dev server (bun run dev)"
  if command -v setsid >/dev/null 2>&1; then
    setsid bun run dev >dev.log 2>&1 &
    DEV_PID=$!
    DEV_GROUP="-$DEV_PID"
  else
    bun run dev >dev.log 2>&1 &
    DEV_PID=$!
  fi
  for _ in $(seq 1 60); do
    # A dead child cannot be "ready": without this, a server that crashed on
    # startup would let the loop accept ANOTHER process's answer for the port.
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "the dev server process exited before becoming ready; see dev.log" >&2
      exit 9
    fi
    code=$(probe)
    if [ -n "$code" ] && [ "$code" != "000" ]; then break; fi
    sleep 1
  done
  if [ -z "$code" ] || [ "$code" = "000" ] || ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "the dev server did not come up; see dev.log" >&2
    exit 9
  fi
  echo "dev server ready (http $code, pid $DEV_PID)"
else
  echo "nothing is serving $BASE_URL, and this runner only starts the default port" >&2
  echo "start a server yourself or point BASE_URL at a live one" >&2
  exit 9
fi

if [ -z "${GATE_PASSWORD:-}" ] && [ -f .env.local ]; then
  GATE_PASSWORD=$(grep -E '^GATE_PASSWORD=' .env.local | head -1 | cut -d= -f2- |
    sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")
  if [ -n "$GATE_PASSWORD" ]; then echo "gate password read from .env.local"; fi
fi

EXPECTED=$(grep -c '^step ' "$BATTERY_SH")
if [ "$EXPECTED" -eq 0 ]; then
  echo "$BATTERY_SH registers no steps; refusing to run" >&2
  exit 9
fi

# Truncate first. If the battery script fails to parse it never touches OUT, and
# a stale green file from an earlier run would then be counted as this verdict.
: >"$OUT"
echo "running $EXPECTED steps from $BATTERY_SH into $OUT"

BASE_URL="$BASE_URL" SESSION="$SESSION" OUT="$OUT" GATE_PASSWORD="${GATE_PASSWORD:-}" \
  bash "$BATTERY_SH"
BATTERY_RC=$?

passed=$(grep -c '^PASS' "$OUT")
failed=$(grep -c '^FAIL' "$OUT")
ran=$((passed + failed))
echo "results: $passed/$EXPECTED passed, $failed failed (battery exit $BATTERY_RC)"
if [ "$failed" -gt 0 ]; then grep '^FAIL' "$OUT"; fi

rc=0
if [ "$BATTERY_RC" -ne 0 ]; then rc=1; fi
if [ "$failed" -gt 0 ]; then rc=1; fi
if [ "$ran" -ne "$EXPECTED" ]; then
  rc=1
  echo "INCOMPLETE: $BATTERY_SH registers $EXPECTED steps but $ran produced a result" >&2
fi
# The cleanup trap prints the terminal BATTERY_EXIT line (last line of the log).
exit "$rc"

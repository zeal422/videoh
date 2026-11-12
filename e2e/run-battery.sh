#!/usr/bin/env bash
# e2e/run-battery.sh: take the UI battery from a cold start to a verdict.
#
# e2e/battery.sh needs a live server and a browser session, and leaves a dev
# server and a headless Chrome behind if you run it by hand. This runner owns
# all of that, and it closes the failure mode that matters most: a
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
#   SHARDS        1 = one sequential battery, 4 = four shard children (default 1)
#   SHARD_LOG_BASE per-shard log path base   (default the run's LOG)
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
SHARD_SESSIONS=()
SHARD_PIDS=()
SHARD_GROUPS=()
cleanup() {
  local rc=$?
  # A second INT/TERM while cleanup runs must not re-enter the trap and exit
  # through the CLEANED guard before the shards are signalled and reaped.
  trap '' INT TERM
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
  # A shard child outliving the coordinator would keep a browser session and a
  # results file alive after the terminal verdict. Usually they are already
  # reaped; on a signal or an early abort this stops them and their own traps
  # remove any temp files. Each shard runs in its own process group, so the
  # group signal reaches the battery and the browser command it is waiting on,
  # not just the shell. A shard that ignores TERM is killed after a short grace,
  # then reaped, so none can outlive the verdict.
  if [ "${#SHARD_PIDS[@]}" -gt 0 ]; then
    for group in "${SHARD_GROUPS[@]}"; do
      kill -TERM "$group" 2>/dev/null
    done
    # One shared grace deadline: waiting per pid would multiply it by the shard
    # count and let the last shard keep running far past the verdict.
    for _ in $(seq 1 15); do
      alive=''
      for pid in "${SHARD_PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then alive=1; fi
      done
      [ -n "$alive" ] || break
      sleep 0.2
    done
    for group in "${SHARD_GROUPS[@]}"; do
      kill -KILL "$group" 2>/dev/null
    done
    for pid in "${SHARD_PIDS[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi
  if [ "${KEEP_SESSION:-0}" != "1" ] && [ "${#SHARD_SESSIONS[@]}" -gt 0 ]; then
    # SHARD_SESSIONS holds only sessions this run recorded before launching a
    # shard or the sequential battery. A validation failure can exit before
    # launch; the configured SESSION may belong to an earlier run, so never
    # close it speculatively.
    for session in "${SHARD_SESSIONS[@]}"; do
      agent-browser --session "$session" close >/dev/null 2>&1
    done
  fi
  # Terminal verdict: last line of every run's log, setup failures and signals
  # included, so a detached caller polling the log always sees the outcome.
  echo "BATTERY_EXIT=$rc"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cd "$(dirname "$SELF")/.." || exit 9

# -ef catches hardlinks, which path_id cannot distinguish; path_id catches
# aliases and paths that do not exist yet. Defined before the detached launcher
# because that launcher truncates LOG before the child runs its checks. The
# body is kept identical in run-battery-pair.sh; battery-runner.test.ts compares
# them so the two copies cannot drift.
path_id() {
  local p=$1 dir base r target hops
  if command -v realpath >/dev/null 2>&1; then
    if r=$(realpath -m -- "$p" 2>/dev/null); then printf '%s\n' "$r"; return 0; fi
  fi
  if command -v readlink >/dev/null 2>&1; then
    if r=$(readlink -f -- "$p" 2>/dev/null); then printf '%s\n' "$r"; return 0; fi
  fi
  # Portable fallback: resolve a final-component symlink chain with plain
  # readlink, then canonicalize the parent. A loop or an unreadable link is an
  # identity that cannot be established, so fail instead of returning the
  # link's own name as if it were the target.
  hops=0
  while [ -L "$p" ]; do
    hops=$((hops + 1))
    if [ "$hops" -gt 40 ]; then
      echo "path_id: symlink loop at $1" >&2
      return 1
    fi
    target=$(readlink -- "$p" 2>/dev/null) || {
      echo "path_id: cannot read symlink $p" >&2
      return 1
    }
    case "$target" in
      /*) p=$target ;;
      *) p=$(dirname -- "$p")/$target ;;
    esac
  done
  dir=$(dirname -- "$p")
  base=$(basename -- "$p")
  if [ -d "$dir" ]; then printf '%s/%s\n' "$(cd "$dir" && pwd -P)" "$base"; else printf '%s\n' "$p"; fi
}

check_same() { # check_same <name1> <path1> <name2> <path2>
  local id1 id2
  if [ "$2" -ef "$4" ]; then
    echo "battery: $1 and $3 refer to the same file ($2, $4)" >&2
    exit 9
  fi
  id1=$(path_id "$2") || {
    echo "battery: cannot establish path identity for $2" >&2
    exit 9
  }
  id2=$(path_id "$4") || {
    echo "battery: cannot establish path identity for $4" >&2
    exit 9
  }
  if [ "$id1" = "$id2" ]; then
    echo "battery: $1 and $3 refer to the same file ($2, $4)" >&2
    exit 9
  fi
}

# check_same with the canonical ids precomputed, for the derived-path sweep.
check_same_cached() { # check_same_cached <name1> <path1> <id1> <name2> <path2> <id2>
  if [ "$2" -ef "$5" ] || [ "$3" = "$6" ]; then
    echo "battery: $1 and $4 refer to the same file ($2, $5)" >&2
    exit 9
  fi
}

# Insert `.s<n>` before the extension: a.txt -> a.s1.txt, a.log -> a.s1.log.
# Kept identical in run-battery-pair.sh; battery-runner.test.ts locks the shape.
shard_path() { # shard_path <path> <n>
  local p=$1 n=$2 dir name base ext
  dir=${p%/*}
  [ "$dir" = "$p" ] && dir=''
  name=${p##*/}
  case "$name" in
    ?*.*) base=${name%.*}; ext=.${name##*.} ;;
    *) base=$name; ext='' ;;
  esac
  if [ -n "$dir" ]; then
    printf '%s/%s.s%s%s\n' "$dir" "$base" "$n" "$ext"
  else
    printf '%s.s%s%s\n' "$base" "$n" "$ext"
  fi
}

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
  command -v setsid >/dev/null 2>&1 || { echo "detach needs setsid on PATH" >&2; exit 9; }
  # The launcher truncates LOG before the child reaches its path checks, and
  # redirects the child's stdout there. Keep it clear of the battery script, the
  # child's result files, and the fixed server log.
  check_same LOG "$LOG" BATTERY_SH "${BATTERY_SH:-e2e/battery.sh}"
  check_same LOG "$LOG" OUT "$OUT"
  check_same LOG "$LOG" TIMING_OUT "${TIMING_OUT:-${OUT%.txt}.timing.txt}"
  check_same LOG "$LOG" dev.log dev.log
  # SHARDS=4 makes the child write one result, timing, and log per shard. The
  # launcher truncates LOG before the child can run its derived-path checks, so
  # reject a LOG that aliases any of those files here.
  if [ "${SHARDS:-1}" = "4" ]; then
    timing_out="${TIMING_OUT:-${OUT%.txt}.timing.txt}"
    shard_log_base="${SHARD_LOG_BASE:-$LOG}"
    for n in 1 2 3 4; do
      check_same LOG "$LOG" "shard $n result" "$(shard_path "$OUT" "$n")"
      check_same LOG "$LOG" "shard $n timing" "$(shard_path "$timing_out" "$n")"
      check_same LOG "$LOG" "shard $n log" "$(shard_path "$shard_log_base" "$n")"
    done
  fi
  # Checked BEFORE the child is spawned: a log that cannot be written would
  # otherwise print a pid and exit 0 for a run whose verdict can never be seen.
  : >"$LOG" || {
    echo "cannot write the detached log $LOG" >&2
    exit 9
  }
  DETACHED=1 RUN_ID="$RUN_ID" SESSION="$SESSION" OUT="$OUT" LOG="$LOG" \
    setsid nohup bash "$SELF" >"$LOG" 2>&1 </dev/null &
  echo "detached: pid $!, log $LOG, results $OUT"
  echo "poll: tail -f $LOG (terminal verdict: BATTERY_EXIT=<code>, 0 = green)"
  exit 0
fi

BASE_URL="${BASE_URL:-http://localhost:3000}"
SESSION="${SESSION:-battery}"
OUT="${OUT:-results.txt}"
BATTERY_SH="${BATTERY_SH:-e2e/battery.sh}"
SHARDS="${SHARDS:-1}"
case "$SHARDS" in
  1 | 4) ;;
  *)
    echo "SHARDS must be 1 or 4" >&2
    exit 9
    ;;
esac
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
# The shard children write one log each. The base is the leg's log path so the
# pair can derive and collision-check the same names; SHARDS=1 never uses it.
SHARD_LOG_BASE="${SHARD_LOG_BASE:-${LOG:-/tmp/run-battery-$RUN_ID.log}}"

TIMING="${TIMING:-0}"
case "$TIMING" in 0 | 1) ;; *) echo "TIMING must be 0 or 1" >&2; exit 9 ;; esac
TIMING_OUT="${TIMING_OUT:-${OUT%.txt}.timing.txt}"

# The runner writes OUT, TIMING_OUT, dev.log, and the per-shard result, timing,
# and log files; the battery script is an input. Reject an alias in either
# direction before the first truncation, or the writer destroys the file the
# verdict, the run, or the script depends on.
check_same BATTERY_SH "$BATTERY_SH" OUT "$OUT"
check_same BATTERY_SH "$BATTERY_SH" TIMING_OUT "$TIMING_OUT"
check_same BATTERY_SH "$BATTERY_SH" dev.log dev.log
check_same OUT "$OUT" TIMING_OUT "$TIMING_OUT"
check_same OUT "$OUT" dev.log dev.log
check_same TIMING_OUT "$TIMING_OUT" dev.log dev.log
if [ "$SHARDS" = "4" ]; then
  SHARD_PATHS=()
  SHARD_LABELS=()
  SHARD_IDS=()
  for n in 1 2 3 4; do
    for kind in result timing log; do
      case "$kind" in
        result) p=$(shard_path "$OUT" "$n") ;;
        timing) p=$(shard_path "$TIMING_OUT" "$n") ;;
        *) p=$(shard_path "$SHARD_LOG_BASE" "$n") ;;
      esac
      SHARD_PATHS+=("$p")
      SHARD_LABELS+=("shard $n $kind")
      p_id=$(path_id "$p") || {
        echo "battery: cannot establish path identity for $p" >&2
        exit 9
      }
      SHARD_IDS+=("$p_id")
    done
  done
  CFG_NAMES=(OUT TIMING_OUT BATTERY_SH dev.log)
  CFG_PATHS=("$OUT" "$TIMING_OUT" "$BATTERY_SH" dev.log)
  # The detached launcher passes its LOG explicitly so the child can reject a
  # LOG that aliases a derived shard result, timing, or log. A non-detached run
  # writes no detached log, so it is not part of that sweep.
  if [ "${DETACHED:-0}" = "1" ] && [ -n "${LOG:-}" ]; then
    CFG_NAMES+=(LOG)
    CFG_PATHS+=("$LOG")
  fi
  CFG_IDS=()
  for p in "${CFG_PATHS[@]}"; do
    p_id=$(path_id "$p") || {
      echo "battery: cannot establish path identity for $p" >&2
      exit 9
    }
    CFG_IDS+=("$p_id")
  done
  for i in "${!SHARD_PATHS[@]}"; do
    for k in "${!CFG_PATHS[@]}"; do
      check_same_cached "${SHARD_LABELS[$i]}" "${SHARD_PATHS[$i]}" "${SHARD_IDS[$i]}" \
        "${CFG_NAMES[$k]}" "${CFG_PATHS[$k]}" "${CFG_IDS[$k]}"
    done
    for j in "${!SHARD_PATHS[@]}"; do
      [ "$j" -lt "$i" ] || continue
      check_same_cached "${SHARD_LABELS[$i]}" "${SHARD_PATHS[$i]}" "${SHARD_IDS[$i]}" \
        "${SHARD_LABELS[$j]}" "${SHARD_PATHS[$j]}" "${SHARD_IDS[$j]}"
    done
  done
fi

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
    # Job control puts the background job in its own process group, so the
    # cleanup can signal the server and its children without setsid. The
    # monitor window covers only the launch and the pid/group assignments.
    set -m
    bun run dev >dev.log 2>&1 &
    DEV_PID=$!
    DEV_GROUP="-$DEV_PID"
    set +m
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

EXPECTED=$(grep -c '^step ' "$BATTERY_SH")
if [ "$EXPECTED" -eq 0 ]; then
  echo "$BATTERY_SH registers no steps; refusing to run" >&2
  exit 9
fi

# One shard child. The battery owns the filter and the seed; the coordinator
# owns one session, one result file, one timing file, and one log per shard.
SHARD_OUTS=()
SHARD_TIMINGS=()
run_shard() { # run_shard <n>
  local n=$1 out timing log
  out=$(shard_path "$OUT" "$n")
  timing=$(shard_path "$TIMING_OUT" "$n")
  log=$(shard_path "$SHARD_LOG_BASE" "$n")
  : >"$out" || {
    echo "cannot write the shard results file $out" >&2
    return 1
  }
  : >"$log" || {
    echo "cannot write the shard log $log" >&2
    return 1
  }
  if [ "$TIMING" = "1" ]; then
    : >"$timing" || {
      echo "cannot write the shard timing file $timing" >&2
      return 1
    }
  fi
  SHARD_SESSIONS+=("$SESSION-s$n")
  SHARD_OUTS+=("$out")
  SHARD_TIMINGS+=("$timing")
  # Each shard gets its own process group, so cleanup can stop the battery and
  # the browser command it is waiting on together. Job control is the fallback
  # when setsid is unavailable, matching the dev-server launch above.
  if command -v setsid >/dev/null 2>&1; then
    setsid env BASE_URL="$BASE_URL" SESSION="$SESSION-s$n" OUT="$out" TIMING="$TIMING" \
      TIMING_OUT="$timing" BATTERY_SHARD="$n" BATTERY_SHARDS=4 bash "$BATTERY_SH" \
      >"$log" 2>&1 &
  else
    set -m
    BASE_URL="$BASE_URL" SESSION="$SESSION-s$n" OUT="$out" TIMING="$TIMING" \
      TIMING_OUT="$timing" BATTERY_SHARD="$n" BATTERY_SHARDS=4 bash "$BATTERY_SH" \
      >"$log" 2>&1 &
    set +m
  fi
  SHARD_PIDS+=("$!")
  SHARD_GROUPS+=("-$!")
}

# Collapse the four per-shard console rows back into the one registered step.
# A shard that produced no console row (it died before the last step) makes the
# collapsed row FAIL; the non-console rows still feed the strict count.
aggregate_shards() {
  local shard_out line console_ok=1
  local console_name='console: zero page errors across battery'
  : >"$OUT"
  for shard_out in "${SHARD_OUTS[@]}"; do
    grep -E '^(PASS|FAIL) ' "$shard_out" 2>/dev/null | grep -vE '^(PASS|FAIL) console:' >>"$OUT"
    line=$(grep -E '^(PASS|FAIL) console:' "$shard_out" 2>/dev/null | tail -n 1)
    if [ -z "$line" ]; then
      console_ok=0
    else
      console_name=${line#* }
      case "$line" in FAIL*) console_ok=0 ;; esac
    fi
  done
  if [ "$console_ok" = "1" ]; then
    echo "PASS $console_name" >>"$OUT"
  else
    echo "FAIL $console_name" >>"$OUT"
  fi
}

# Truncate first. If the battery script fails to parse it never touches OUT, and
# a stale green file from an earlier run would then be counted as this verdict.
: >"$OUT"
echo "running $EXPECTED steps from $BATTERY_SH into $OUT"

if [ "$SHARDS" = "1" ]; then
  SHARD_SESSIONS=("$SESSION")
  # The sequential rollback path: one battery, the registered 1-70 order, no
  # filter, no seed, and the same session and result-file names as before.
  BASE_URL="$BASE_URL" SESSION="$SESSION" OUT="$OUT" TIMING="$TIMING" TIMING_OUT="$TIMING_OUT" \
    BATTERY_SHARD=1 BATTERY_SHARDS=1 bash "$BATTERY_SH"
  BATTERY_RC=$?
else
  SHARD_SESSIONS=()
  SHARD_PIDS=()
  SHARD_GROUPS=()
  echo "shards: $SHARDS per leg (results and logs next to $OUT and $SHARD_LOG_BASE)"
  for n in 1 2 3 4; do
    run_shard "$n" || exit 9
  done
  BATTERY_RC=0
  for pid in "${SHARD_PIDS[@]}"; do
    shard_rc=0
    wait "$pid" || shard_rc=$?
    if [ "$shard_rc" -ne 0 ] && [ "$BATTERY_RC" -eq 0 ]; then
      BATTERY_RC=$shard_rc
    fi
  done
  aggregate_shards
  if [ "$TIMING" = "1" ]; then
    : >"$TIMING_OUT"
    for timing in "${SHARD_TIMINGS[@]}"; do
      [ -s "$timing" ] && cat "$timing" >>"$TIMING_OUT"
    done
  fi
fi

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

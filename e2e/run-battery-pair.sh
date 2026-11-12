#!/usr/bin/env bash
# e2e/run-battery-pair.sh: run the dev and artifact battery legs concurrently.
#
# The single runner owns one server and one session. This wrapper owns two:
# it starts only the standalone artifact server, launches one `run-battery.sh`
# per leg with distinct BASE_URL, SESSION, OUT, and LOG values, requires both
# strict verdicts, and stops only the artifact server it started.
#
# The dev leg must start its own server on http://localhost:3000 or
# http://127.0.0.1:3000 so its log contains `starting the dev server`. The
# artifact leg reuses the server on ART_PORT (default 3100) and its log must
# contain `using the server already serving` with no dev-server start.
#
# Usage:
#   bash e2e/run-battery-pair.sh
#   DETACH=1 bash e2e/run-battery-pair.sh
#   PAIR_TEST=1 PAIR_TEST_LEG_CMD=/tmp/stub-leg.sh bash e2e/run-battery-pair.sh
#
# Env:
#   ART_PORT       artifact port                 (default 3100; 1-65535)
#   DEV_BASE_URL   dev origin                    (default http://localhost:3000;
#                  must be localhost or 127.0.0.1 on port 3000)
#   OUT_DEV        dev results file              (default results-dev-<run id>.txt)
#   OUT_ART        artifact results file         (default results-artifact-<run id>.txt)
#   TIMING_OUT_DEV dev timing file               (default next to OUT_DEV)
#   TIMING_OUT_ART artifact timing file          (default next to OUT_ART)
#   SESSION_DEV    dev browser session           (default battery-dev-<run id>)
#   SESSION_ART    artifact browser session      (default battery-artifact-<run id>)
#   LOG_DEV        dev runner log                (default /tmp/battery-dev-<run id>.log)
#   LOG_ART        artifact runner log           (default /tmp/battery-artifact-<run id>.log)
#   LOG_ART_SERVER artifact server log           (default /tmp/battery-artifact-server-<run id>.log)
#   PAIR_LOG       pair log                      (default /tmp/battery-pair-<run id>.log)
#   TIMING         1 = per-step timing files     (default 0)
#   BATTERY_SH     battery script                (default e2e/battery.sh)
#   PAIR_SHARDS    1 = sequential legs, 4 = four shards per leg (default 4)
#   DETACH         1 = re-exec detached under setsid
#   KEEP_ART       1 = leave the artifact server running (test/debug only)
#   PAIR_TEST      1 = test mode: no preflight, no artifact server, stub legs
#   PAIR_TEST_LEG_CMD stub leg command for PAIR_TEST=1
#   PAIR_FIXTURE   fixture name passed to the stub leg
set -uo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

# Lifecycle state is declared before the cd and the trap is armed before any
# work, so every exit path writes a terminal PAIR_EXIT. The detached launcher
# sets LAUNCHER=1 and exits before doing work: it owns no server or session and
# must not print a verdict.
DEV_RUN_PID=''
ART_RUN_PID=''
DEV_RUN_GROUP=''
ART_RUN_GROUP=''
ART_PID=''
ART_GROUP=''
PAIR_LOG_OK=''
CLEANED=''
LAUNCHER=''
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$$}"
PAIR_LOG="${PAIR_LOG:-/tmp/battery-pair-$RUN_ID.log}"

log_pair() {
  printf '%s\n' "$*"
  if [ "${PAIR_LOG_OK:-0}" = "1" ] && [ "${DETACHED:-0}" != "1" ]; then
    printf '%s\n' "$*" >>"$PAIR_LOG"
  fi
}

cleanup() {
  local rc=$?
  # A second INT/TERM while cleanup runs must not re-enter the trap and exit
  # through the CLEANED guard before the legs are signalled and reaped.
  trap '' INT TERM
  [ -n "$CLEANED" ] && exit "$rc"
  CLEANED=1
  if [ "${LAUNCHER:-0}" = "1" ]; then exit "$rc"; fi
  # Signal each leg's process group, which includes the runner and the battery
  # child it launched. Their traps close their sessions and, for the dev
  # runner, stop its server. Give the trap a short grace, then kill whatever is
  # left and reap it: a child that ignores TERM must not outlive PAIR_EXIT.
  for group in "$DEV_RUN_GROUP" "$ART_RUN_GROUP"; do
    [ -n "$group" ] || continue
    if kill -0 "$group" 2>/dev/null; then kill -TERM "$group" 2>/dev/null; fi
  done
  # Fall back to a runner pid only when its leg had no group. Signalling the
  # group and then the leader sends a second TERM while the runner is already
  # cleaning up, which could abort its shard cleanup.
  if [ -n "$DEV_RUN_PID" ] && [ -z "$DEV_RUN_GROUP" ]; then
    kill -TERM "$DEV_RUN_PID" 2>/dev/null
  fi
  if [ -n "$ART_RUN_PID" ] && [ -z "$ART_RUN_GROUP" ]; then
    kill -TERM "$ART_RUN_PID" 2>/dev/null
  fi
  # One shared grace deadline for both legs, then kill whatever is left: a
  # per-group wait would multiply the grace and let the last leg outlive
  # PAIR_EXIT. Keep this longer than run-battery.sh's 15-tick shard grace: the
  # leg must finish killing its own shard groups before the pair kills the leg.
  for _ in $(seq 1 30); do
    alive=''
    for group in "$DEV_RUN_GROUP" "$ART_RUN_GROUP"; do
      [ -n "$group" ] || continue
      if kill -0 "$group" 2>/dev/null; then alive=1; fi
    done
    for pid in "$DEV_RUN_PID" "$ART_RUN_PID"; do
      [ -n "$pid" ] || continue
      if kill -0 "$pid" 2>/dev/null; then alive=1; fi
    done
    [ -n "$alive" ] || break
    sleep 0.2
  done
  for group in "$DEV_RUN_GROUP" "$ART_RUN_GROUP"; do
    [ -n "$group" ] || continue
    if kill -0 "$group" 2>/dev/null; then
      echo "pair: process group $group did not exit; killing it" >&2
      kill -KILL "$group" 2>/dev/null
    fi
  done
  for pid in "$DEV_RUN_PID" "$ART_RUN_PID"; do
    [ -n "$pid" ] || continue
    if kill -0 "$pid" 2>/dev/null; then
      echo "pair: child $pid did not exit; killing it" >&2
      kill -KILL "$pid" 2>/dev/null
    fi
    wait "$pid" 2>/dev/null || true
  done
  if [ -n "$ART_PID" ] && [ "${KEEP_ART:-0}" != "1" ]; then
    if [ -n "$ART_GROUP" ]; then
      kill -TERM "$ART_GROUP" 2>/dev/null || kill -TERM "$ART_PID" 2>/dev/null
    else
      kill -TERM "$ART_PID" 2>/dev/null
    fi
    sleep 1
    if [ -n "$ART_GROUP" ]; then
      kill -KILL "$ART_GROUP" 2>/dev/null || true
    else
      kill -KILL "$ART_PID" 2>/dev/null || true
    fi
  fi
  log_pair "PAIR_EXIT=$rc"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cd "$(dirname "$SELF")/.." || exit 9

ART_PORT="${ART_PORT:-3100}"
DEV_BASE_URL="${DEV_BASE_URL:-http://localhost:3000}"
ART_BASE_URL="http://localhost:$ART_PORT"
OUT_DEV="${OUT_DEV:-results-dev-$RUN_ID.txt}"
OUT_ART="${OUT_ART:-results-artifact-$RUN_ID.txt}"
TIMING_OUT_DEV="${TIMING_OUT_DEV:-${OUT_DEV%.txt}.timing.txt}"
TIMING_OUT_ART="${TIMING_OUT_ART:-${OUT_ART%.txt}.timing.txt}"
SESSION_DEV="${SESSION_DEV:-battery-dev-$RUN_ID}"
SESSION_ART="${SESSION_ART:-battery-artifact-$RUN_ID}"
LOG_DEV="${LOG_DEV:-/tmp/battery-dev-$RUN_ID.log}"
LOG_ART="${LOG_ART:-/tmp/battery-artifact-$RUN_ID.log}"
LOG_ART_SERVER="${LOG_ART_SERVER:-/tmp/battery-artifact-server-$RUN_ID.log}"
TIMING="${TIMING:-0}"
BATTERY_SH="${BATTERY_SH:-e2e/battery.sh}"
PAIR_SHARDS="${PAIR_SHARDS:-4}"
PAIR_TEST="${PAIR_TEST:-0}"
PAIR_TEST_LEG_CMD="${PAIR_TEST_LEG_CMD:-}"
PAIR_FIXTURE="${PAIR_FIXTURE:-}"
# Fixed files written by the server runners and the package start script.
DEV_SERVER_LOG='dev.log'
ARTIFACT_SERVER_LOG='server.log'

# Kept identical to run-battery.sh's path_id and check_same condition;
# battery-runner.test.ts compares the bodies so the copies cannot drift.
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

# -ef catches hardlinks, which path_id cannot distinguish; path_id catches
# aliases and paths that do not exist yet.
check_same() { # check_same <name1> <path1> <name2> <path2>
  local id1 id2
  if [ "$2" -ef "$4" ]; then
    echo "pair: $1 and $3 refer to the same file ($2, $4)" >&2
    exit 9
  fi
  id1=$(path_id "$2") || {
    echo "pair: cannot establish path identity for $2" >&2
    exit 9
  }
  id2=$(path_id "$4") || {
    echo "pair: cannot establish path identity for $4" >&2
    exit 9
  }
  if [ "$id1" = "$id2" ]; then
    echo "pair: $1 and $3 refer to the same file ($2, $4)" >&2
    exit 9
  fi
}

# check_same with the canonical ids precomputed, for the O(n^2) derived-path
# sweep: one realpath per path instead of one per comparison.
check_same_cached() { # check_same_cached <name1> <path1> <id1> <name2> <path2> <id2>
  if [ "$2" -ef "$5" ] || [ "$3" = "$6" ]; then
    echo "pair: $1 and $4 refer to the same file ($2, $5)" >&2
    exit 9
  fi
}

if [ -n "${TIMING_OUT:-}" ]; then
  echo "pair: set TIMING_OUT_DEV and TIMING_OUT_ART, not TIMING_OUT" >&2
  exit 9
fi
[ "$TIMING" = "0" ] || [ "$TIMING" = "1" ] || { echo "pair: TIMING must be 0 or 1" >&2; exit 9; }
case "$PAIR_SHARDS" in
  1 | 4) ;;
  *)
    echo "pair: PAIR_SHARDS must be 1 or 4" >&2
    exit 9
    ;;
esac

# Same naming rule as run-battery.sh: `.s<n>` before the extension. The pair
# derives the per-shard logs here so they participate in the collision checks
# before any leg starts (a shard log that aliases a result file would corrupt
# both the counts and the terminal verdict).
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
case "$ART_PORT" in '' | *[!0-9]*) echo "pair: ART_PORT must be numeric" >&2; exit 9 ;; esac
if [ "${#ART_PORT}" -gt 6 ] || [ "$ART_PORT" -lt 1 ] || [ "$ART_PORT" -gt 65535 ]; then
  echo "pair: ART_PORT must be between 1 and 65535" >&2
  exit 9
fi
# Compare and launch the numeric value, not the spelling: 03000 is port 3000.
ART_PORT=$((10#$ART_PORT))
case "$DEV_BASE_URL" in
  http://localhost:3000 | http://127.0.0.1:3000) ;;
  *)
    echo "pair: DEV_BASE_URL must be http://localhost:3000 or http://127.0.0.1:3000" >&2
    exit 9
    ;;
esac

dev_host=${DEV_BASE_URL#*://}
dev_host=${dev_host%%[:/]*}
dev_port=${DEV_BASE_URL##*:}
dev_port=${dev_port%%/*}
case "$dev_port" in '' | *[!0-9]*) dev_port=3000 ;; esac
[ "$ART_PORT" = "$dev_port" ] && { echo "pair: ART_PORT must differ from the dev port $dev_port" >&2; exit 9; }
[ "$SESSION_DEV" = "$SESSION_ART" ] && { echo "pair: SESSION_DEV and SESSION_ART must differ" >&2; exit 9; }

check_same OUT_DEV "$OUT_DEV" OUT_ART "$OUT_ART"
check_same OUT_DEV "$OUT_DEV" TIMING_OUT_DEV "$TIMING_OUT_DEV"
check_same OUT_DEV "$OUT_DEV" TIMING_OUT_ART "$TIMING_OUT_ART"
check_same OUT_ART "$OUT_ART" TIMING_OUT_DEV "$TIMING_OUT_DEV"
check_same OUT_ART "$OUT_ART" TIMING_OUT_ART "$TIMING_OUT_ART"
check_same TIMING_OUT_DEV "$TIMING_OUT_DEV" TIMING_OUT_ART "$TIMING_OUT_ART"
# A log that shares a path with a result or timing file is truncated by the
# writer, corrupting both the counts and the terminal verdict.
for log_name in LOG_DEV LOG_ART LOG_ART_SERVER PAIR_LOG; do
  for out_name in OUT_DEV OUT_ART TIMING_OUT_DEV TIMING_OUT_ART; do
    check_same "$log_name" "${!log_name}" "$out_name" "${!out_name}"
  done
done
check_same LOG_DEV "$LOG_DEV" LOG_ART "$LOG_ART"
check_same PAIR_LOG "$PAIR_LOG" LOG_DEV "$LOG_DEV"
check_same PAIR_LOG "$PAIR_LOG" LOG_ART "$LOG_ART"
check_same LOG_DEV "$LOG_DEV" LOG_ART_SERVER "$LOG_ART_SERVER"
check_same LOG_ART "$LOG_ART" LOG_ART_SERVER "$LOG_ART_SERVER"
check_same PAIR_LOG "$PAIR_LOG" LOG_ART_SERVER "$LOG_ART_SERVER"
# The dev server writes dev.log and the artifact start script tees server.log
# in the repo root; every configured output must stay clear of both.
for out_name in OUT_DEV OUT_ART TIMING_OUT_DEV TIMING_OUT_ART LOG_DEV LOG_ART LOG_ART_SERVER PAIR_LOG; do
  check_same "$out_name" "${!out_name}" DEV_SERVER_LOG "$DEV_SERVER_LOG"
  check_same "$out_name" "${!out_name}" ARTIFACT_SERVER_LOG "$ARTIFACT_SERVER_LOG"
done
# The battery script is an input, not an output. A configured path that aliases
# it is truncated before a leg reads it, so reject it with the other collisions.
for out_name in OUT_DEV OUT_ART TIMING_OUT_DEV TIMING_OUT_ART LOG_DEV LOG_ART LOG_ART_SERVER PAIR_LOG; do
  check_same BATTERY_SH "$BATTERY_SH" "$out_name" "${!out_name}"
done
check_same BATTERY_SH "$BATTERY_SH" DEV_SERVER_LOG "$DEV_SERVER_LOG"
check_same BATTERY_SH "$BATTERY_SH" ARTIFACT_SERVER_LOG "$ARTIFACT_SERVER_LOG"
# Every per-shard file each leg derives from its configured paths: the result
# and timing next to OUT and TIMING_OUT, and the log next to SHARD_LOG_BASE.
# A derived name that aliases any configured or derived file is truncated by
# whichever writer runs second, so all of them are checked before either leg
# launches.
if [ "$PAIR_SHARDS" = "4" ]; then
  SHARD_PATHS=()
  SHARD_LABELS=()
  SHARD_IDS=()
  for leg in dev artifact; do
    case "$leg" in
      dev)
        leg_out=$OUT_DEV
        leg_timing=$TIMING_OUT_DEV
        leg_log=$LOG_DEV
        ;;
      *)
        leg_out=$OUT_ART
        leg_timing=$TIMING_OUT_ART
        leg_log=$LOG_ART
        ;;
    esac
    for n in 1 2 3 4; do
      for kind in result timing log; do
        case "$kind" in
          result) p=$(shard_path "$leg_out" "$n") ;;
          timing) p=$(shard_path "$leg_timing" "$n") ;;
          *) p=$(shard_path "$leg_log" "$n") ;;
        esac
        SHARD_PATHS+=("$p")
        SHARD_LABELS+=("$leg shard $n $kind")
        p_id=$(path_id "$p") || {
          echo "pair: cannot establish path identity for $p" >&2
          exit 9
        }
        SHARD_IDS+=("$p_id")
      done
    done
  done
  CFG_NAMES=(OUT_DEV OUT_ART TIMING_OUT_DEV TIMING_OUT_ART LOG_DEV LOG_ART LOG_ART_SERVER PAIR_LOG DEV_SERVER_LOG ARTIFACT_SERVER_LOG BATTERY_SH)
  CFG_PATHS=("$OUT_DEV" "$OUT_ART" "$TIMING_OUT_DEV" "$TIMING_OUT_ART" "$LOG_DEV" "$LOG_ART" "$LOG_ART_SERVER" "$PAIR_LOG" "$DEV_SERVER_LOG" "$ARTIFACT_SERVER_LOG" "$BATTERY_SH")
  CFG_IDS=()
  for p in "${CFG_PATHS[@]}"; do
    p_id=$(path_id "$p") || {
      echo "pair: cannot establish path identity for $p" >&2
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
# Validation is complete, so the pair log may now be created and appended.
PAIR_LOG_OK=1

if [ "${DETACH:-0}" = "1" ] && [ "${DETACHED:-0}" != "1" ]; then
  LAUNCHER=1
  command -v setsid >/dev/null 2>&1 || { echo "detach needs setsid on PATH" >&2; exit 9; }
  : 2>/dev/null >"$PAIR_LOG" || { echo "cannot write the pair log $PAIR_LOG" >&2; exit 9; }
  DETACH=0 DETACHED=1 RUN_ID="$RUN_ID" ART_PORT="$ART_PORT" DEV_BASE_URL="$DEV_BASE_URL" \
    OUT_DEV="$OUT_DEV" OUT_ART="$OUT_ART" TIMING_OUT_DEV="$TIMING_OUT_DEV" TIMING_OUT_ART="$TIMING_OUT_ART" \
    SESSION_DEV="$SESSION_DEV" SESSION_ART="$SESSION_ART" LOG_DEV="$LOG_DEV" LOG_ART="$LOG_ART" \
    LOG_ART_SERVER="$LOG_ART_SERVER" PAIR_LOG="$PAIR_LOG" TIMING="$TIMING" BATTERY_SH="$BATTERY_SH" \
    PAIR_TEST="$PAIR_TEST" PAIR_TEST_LEG_CMD="$PAIR_TEST_LEG_CMD" PAIR_FIXTURE="$PAIR_FIXTURE" \
    PAIR_SHARDS="$PAIR_SHARDS" \
    setsid nohup bash "$SELF" >"$PAIR_LOG" 2>&1 </dev/null &
  echo "detached: pid $!, log $PAIR_LOG, results $OUT_DEV $OUT_ART"
  echo "poll: tail -f $PAIR_LOG (terminal verdict: PAIR_EXIT=<code>, 0 = green)"
  exit 0
fi

: 2>/dev/null >"$PAIR_LOG" || { echo "cannot write the pair log $PAIR_LOG" >&2; exit 9; }


# Validate the battery script before starting the artifact server or either
# leg: a missing script or an unusable count must fail fast, not after the
# server is already answering. `grep -c` exits 1 for a valid empty file, so a
# zero count stays the separate "registers no steps" failure.
[ -f "$BATTERY_SH" ] && [ -r "$BATTERY_SH" ] || { echo "pair: cannot read BATTERY_SH at $BATTERY_SH" >&2; exit 9; }
EXPECTED=$(grep -c '^step ' "$BATTERY_SH" 2>/dev/null || true)
case "$EXPECTED" in '' | *[!0-9]*) echo "pair: cannot count steps in $BATTERY_SH" >&2; exit 9 ;; esac
if [ "$EXPECTED" -eq 0 ]; then
  echo "pair: $BATTERY_SH registers no steps" >&2
  exit 9
fi

port_busy() {
  local host=$1 port=$2
  [ -n "$host" ] || return 1
  (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null
}

if [ "$PAIR_TEST" = "1" ]; then
  [ -n "$PAIR_TEST_LEG_CMD" ] || { echo "pair: PAIR_TEST=1 needs PAIR_TEST_LEG_CMD" >&2; exit 9; }
  [ -f "$PAIR_TEST_LEG_CMD" ] || { echo "pair: stub leg not found: $PAIR_TEST_LEG_CMD" >&2; exit 9; }
else
  command -v agent-browser >/dev/null 2>&1 || { echo "pair: agent-browser is not on PATH" >&2; exit 9; }
  command -v curl >/dev/null 2>&1 || { echo "pair: curl is not on PATH" >&2; exit 9; }
  command -v bun >/dev/null 2>&1 || { echo "pair: bun is not on PATH" >&2; exit 9; }
  [ -f .next/standalone/server.js ] || { echo "pair: run bun run build first" >&2; exit 9; }
  if port_busy "$dev_host" "$dev_port"; then
    echo "pair: dev port $dev_port is occupied; stop that server or use the sequential procedure" >&2
    exit 9
  fi
  if port_busy localhost "$ART_PORT"; then
    echo "pair: artifact port $ART_PORT is occupied" >&2
    exit 9
  fi
  if command -v setsid >/dev/null 2>&1; then
    setsid env PORT="$ART_PORT" bun run start >"$LOG_ART_SERVER" 2>&1 &
    ART_PID=$!
    ART_GROUP="-$ART_PID"
  else
    # Job control puts the background job in its own process group, so the
    # cleanup can signal the server and its children without setsid. The
    # monitor window covers only the launch and the pid/group assignments.
    set -m
    env PORT="$ART_PORT" bun run start >"$LOG_ART_SERVER" 2>&1 &
    ART_PID=$!
    ART_GROUP="-$ART_PID"
    set +m
  fi
  ready=0
  for _ in $(seq 1 60); do
    if ! kill -0 "$ART_PID" 2>/dev/null; then
      echo "pair: artifact server exited before becoming ready" >&2
      tail -n 20 "$LOG_ART_SERVER" >&2 || true
      exit 9
    fi
    if curl -fsS --max-time 3 "$ART_BASE_URL/" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  if [ "$ready" != "1" ]; then
    echo "pair: artifact server did not answer on $ART_BASE_URL" >&2
    tail -n 20 "$LOG_ART_SERVER" >&2 || true
    exit 9
  fi
fi

STARTED_PID=''
STARTED_GROUP=''
start_grouped() { # start_grouped <log> <command...>
  local log=$1
  shift
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@" >"$log" 2>&1 &
  else
    # Job control gives the leg its own process group, so termination reaches
    # the runner and the battery child it launched.
    set -m
    "$@" >"$log" 2>&1 &
    set +m
  fi
  STARTED_PID=$!
  STARTED_GROUP="-$STARTED_PID"
}

start_leg() { # start_leg <role> <out> <log> <session> <base> <timing_out>
  local role=$1 out=$2 log=$3 session=$4 base=$5 timing_out=$6
  if [ "$PAIR_TEST" = "1" ]; then
    start_grouped "$log" env DETACH=0 TIMING="$TIMING" PAIR_ROLE="$role" PAIR_FIXTURE="$PAIR_FIXTURE" OUT="$out" \
      bash "$PAIR_TEST_LEG_CMD"
  else
    start_grouped "$log" env DETACH=0 TIMING="$TIMING" BASE_URL="$base" SESSION="$session" OUT="$out" \
      BATTERY_SH="$BATTERY_SH" TIMING_OUT="$timing_out" SHARDS="$PAIR_SHARDS" SHARD_LOG_BASE="$log" \
      bash e2e/run-battery.sh
  fi
}

start_leg dev "$OUT_DEV" "$LOG_DEV" "$SESSION_DEV" "$DEV_BASE_URL" "$TIMING_OUT_DEV"
DEV_RUN_PID=$STARTED_PID
DEV_RUN_GROUP=$STARTED_GROUP
start_leg artifact "$OUT_ART" "$LOG_ART" "$SESSION_ART" "$ART_BASE_URL" "$TIMING_OUT_ART"
ART_RUN_PID=$STARTED_PID
ART_RUN_GROUP=$STARTED_GROUP

STARTED_AT=$(date +%s)
DEV_RC=0
ART_RC=0
wait "$DEV_RUN_PID" || DEV_RC=$?
wait "$ART_RUN_PID" || ART_RC=$?
ENDED_AT=$(date +%s)
ELAPSED=$((ENDED_AT - STARTED_AT))

counts() {
  local out=$1 p f
  p=$(grep -c '^PASS' "$out" 2>/dev/null || true); p=${p:-0}
  f=$(grep -c '^FAIL' "$out" 2>/dev/null || true); f=${f:-0}
  printf '%s %s' "$p" "$f"
}
read -r PASS_DEV FAIL_DEV <<<"$(counts "$OUT_DEV")"
read -r PASS_ART FAIL_ART <<<"$(counts "$OUT_ART")"

ok=1
pair_fail() {
  log_pair "pair: $*"
  ok=0
}
[ "$DEV_RC" -eq 0 ] || pair_fail "dev runner exited $DEV_RC"
[ "$ART_RC" -eq 0 ] || pair_fail "artifact runner exited $ART_RC"
[ "$PASS_DEV" -eq "$EXPECTED" ] || pair_fail "dev passed $PASS_DEV of $EXPECTED steps"
[ "$PASS_ART" -eq "$EXPECTED" ] || pair_fail "artifact passed $PASS_ART of $EXPECTED steps"
[ "$FAIL_DEV" -eq 0 ] || pair_fail "dev recorded $FAIL_DEV failed step(s)"
[ "$FAIL_ART" -eq 0 ] || pair_fail "artifact recorded $FAIL_ART failed step(s)"
[ "$(tail -n 1 "$LOG_DEV" 2>/dev/null || true)" = "BATTERY_EXIT=0" ] || pair_fail "dev log does not end with BATTERY_EXIT=0"
[ "$(tail -n 1 "$LOG_ART" 2>/dev/null || true)" = "BATTERY_EXIT=0" ] || pair_fail "artifact log does not end with BATTERY_EXIT=0"
grep -q 'starting the dev server' "$LOG_DEV" 2>/dev/null || pair_fail "dev log is missing starting the dev server"
grep -q 'using the server already serving' "$LOG_ART" 2>/dev/null || pair_fail "artifact log is missing using the server already serving"
grep -q 'starting the dev server' "$LOG_ART" 2>/dev/null && pair_fail "artifact log contains starting the dev server"

log_pair "pair: dev $PASS_DEV/$EXPECTED passed, $FAIL_DEV failed (exit $DEV_RC)"
log_pair "pair: artifact $PASS_ART/$EXPECTED passed, $FAIL_ART failed (exit $ART_RC)"
log_pair "pair: wall clock ${ELAPSED}s"
if [ "$ok" = "1" ]; then
  log_pair "pair: server types ok (dev started, artifact reused)"
  exit 0
fi
for f in "$OUT_DEV" "$OUT_ART"; do
  [ -f "$f" ] && grep '^FAIL' "$f" 2>/dev/null | sed "s#^#pair: $f: #"
done
exit 1

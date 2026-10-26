#!/usr/bin/env bash
# e2e/battery.sh — scripted end-to-end feature battery ("A" run vs "B" run).
#
# Usage:
#   BASE_URL=http://localhost:3000 SESSION=ab-a OUT=results-a.txt bash e2e/battery.sh
#   BASE_URL=http://localhost:3100 SESSION=ab-b OUT=results-b.txt bash e2e/battery.sh
#
# Drives the real UI through every product feature and records PASS/FAIL per
# step. Identical script, identical order on both trees — then diff results.
#
# Flow notes (they matter for determinism):
# - quick-add places clips at the END of the timeline → zoom out twice so every
#   clip stays reachable in the a11y snapshot.
# - split requires a SELECTED clip and the playhead strictly inside it → select,
#   go to start, frame-step 60 frames (= 2.0s), press Ctrl+K (Premiere Add Edit;
#   S now toggles snapping like Premiere).
# - addTransition PULLS the next clip left → the tail clip's label shifts.
# - the Inspector and the timeline are scroll areas shorter than their content →
#   a target below the fold has no clickable screen coordinates, so a blind click
#   lands on whatever is painted at that point instead (the Timeline header, the
#   footer, or nothing at all when it is off-screen entirely). Every such target is
#   scrolled into view before it is touched — insp() for Inspector controls,
#   click_clip() for clips — so results do not depend on the window height. This is
#   why f03/f05 failed on a short viewport, and why enabling the crossfade (the new
#   transition lane pushes the lower tracks down) could break the later audio steps.
# - the marquee step needs empty lane space beyond the last clip: it computes its
#   own points from live geometry and stays outside the 24px auto-scroll bands,
#   so the box drag cannot scroll the view under the later steps.
# - the marker steps run before any split/trim work: the sequence flow clears the
#   clip selection (so M targets the timeline), adds at 1.0s, checks Shift+M and
#   Ctrl+Shift+M against the transport, drags the tab and undoes the drag; the
#   clip flow selects the video clip and edits the marker through the Marker menu.
#   Every delete is undone and redone, so no marker is left behind for the
#   snapping-sensitive steps that follow.
# - the 0.5.6 welcome modal greets a fresh visitor and, while open, Radix hides
#   the whole app from the a11y snapshot. Both fresh-start steps dismiss it like
#   a user would (Escape) before asserting, and two steps lock the greeting
#   itself (Help > What's new opens; a recorded version stays silent on reload).
# - the reversed-trim frame proof (f05_reverse_frame) rides on f02_trim's exact
#   result (the first video part at 0.00..1.50): it reverses that clip, parks on
#   the timeline frame at 0.60s, samples the composited canvas, drags the trim
#   end handle LEFT by a fixed 40px (= 0.5s at the battery's zoom) and re-parks
#   on the same timeline time. Keeping a local frame must keep the source frame
#   it showed, so the two samples must be equal. PARK FIRST, then park again
#   after each mutation: the preview is a parked-seek stepper, so only a fresh
#   seek re-composites the frame.
# - the real-file steps feed bytes the app does not own: a generated PNG goes
#   through `agent-browser upload` into the media bin's hidden import input
#   (probe, dedup, thumbnail path), and the save/open roundtrip captures the
#   toolbar's .veproj.json download with `agent-browser download`, starts a NEW
#   project, and reopens the file through the toolbar's hidden input. Since
#   0.5.6 the open path hydrates the bundled samples itself, so the reopened
#   project comes back ONLINE (the step asserts no offline overlay).
# - the clipboard/link steps run after f05 and respect link-group semantics:
#   duplicate and paste move exactly the clicked clip's link group, read LIVE
#   from the selection ring, and Shift+Delete ripples the pasted copy away.
# - the blend-parity step (0.7.0) runs while the quick-added clips are still in
#   their import layout (video first, so its 0-6s span is alone on screen at the
#   parked frames it samples). It sets the video clip to 0.25x, steps 12 output
#   frames, and undoes the speed edit before ANY exit (the success path and
#   every failure path route through one restore, and a failed restore fails
#   the step), so every later step sees the timeline it left behind.
# - the color-grade proof spans two existing steps (0.6.0). f06 parks on a
#   deterministic frame (18 frames = 0.6s), samples the monitor's red/blue
#   balance, drives the Temperature slider to +100 and samples again; the
#   ratio must rise, which is the only browser proof that the shared SVG
#   feColorMatrix reaches the canvas. f07 then renders the SAME sequence
#   twice, at +100 and at -100 (End and Home on the same slider), samples the
#   red channel of the decoded MP4 at one doc time in both, and requires the
#   warm export to carry at least 1.25x the red of the cool one. A ratio
#   (not a level) is what makes that valid: the two exports differ ONLY in the
#   grade, and an ungraded export would score 1.0. The SAME two renders carry
#   the export stream-layout proof (0.6.3): the warm export must include an
#   audio track (one sample-audio copy is still audible), then every
#   audio-capable clip is muted and the cool export must carry NO audio track.
#   A silent AAC track where "no track" belongs is invisible to pixels and to
#   the a11y snapshot, so export_track_kinds reads the result file's
#   moov/trak/mdia/hdlr boxes directly, and it runs BEFORE the mute so the
#   present-track assertion also proves the parser reads non-empty kinds.
# - the scopes-fill step (0.7.0) runs next to last: it sets the project square
#   (1080x1080) so the waveform sample is 144 columns against the 256px meter,
#   opens the scopes and reads the meter canvas's first and last columns (both
#   must be painted). It leaves the project square; no later step depends on the
#   dimensions.
# - the LUT proofs (0.7.0) share ONE generated .cube whose green and blue tables
#   are zero, so a graded frame turns pure red and the collapse of the green
#   channel is the oracle (no content-dependent level or ratio can fake it).
#   f07's export round renders a third time with the cube on the video clip,
#   under the SAME -100 grade and muted mix as the cool render, asserts the
#   channel signature, and undoes the import+assignment batch. The separate
#   f06_lut step runs after the relink flow (only the console check follows it)
#   and repeats the proof on the monitor: it parks again, selects the first
#   video part, imports the cube through the Inspector's real hidden file input,
#   asserts the green collapse, and undoes the one-step batch so the panel reads
#   None and the frame comes back.

# `pipefail` (with the `set -u` below): every assertion is a `snap | grep`
# pipeline, and a failed, timed-out or empty snapshot must abort the step rather
# than read as "feature absent". `snap()` and `evaln()` keep agent-browser's
# exit status, so the pipeline reports it instead of the grep's. Still no
# `set -e`: a failing grep is an expected, handled outcome in most steps.
set -uo pipefail
BASE_URL="${BASE_URL:-http://localhost:3000}"
SESSION="${SESSION:-battery}"
OUT="${OUT:-results.txt}"
: > "$OUT"

# The project-file capture (f08_capture_project) lives at a unique mktemp path
# and is normally consumed by f07_open_project. Any step's early return between
# the two must not leak the file, so an EXIT/INT/TERM trap removes it, by the
# VARIABLE, never a glob: a glob could delete a PARALLEL battery run's capture
# (the runner documents A/B runs against two trees).
PROJECT_CAPTURE=''
# The generated .cube fixture the LUT proofs upload (f06_lut and f07_export).
# Like the capture it is removed on every exit path, by VARIABLE, never a glob,
# so a parallel A/B run's fixture is never deleted.
LUT_FIXTURE=''
# The captions downloads (c02_captions_export) live at unique mktemp paths and
# are removed on every in-function exit path. A killed run still needs the
# trap below to clean them, by VARIABLE like the two above, never a glob:
# /tmp/battery-captions.* is shared with parallel A/B runs.
CAPTIONS_TMPS=''
# The pasted copy's label time, recorded by f02_copy_paste and consumed by
# f08_ripple_delete: it depends on the clip layout the earlier steps leave, so
# it is read back live instead of hardcoded.
PASTED_START=''
trap '[ -n "$PROJECT_CAPTURE" ] && rm -f "$PROJECT_CAPTURE"; [ -n "$LUT_FIXTURE" ] && rm -f "$LUT_FIXTURE"; [ -n "$CAPTIONS_TMPS" ] && rm -f $CAPTIONS_TMPS' INT TERM EXIT

ab() { agent-browser --session "$SESSION" "$@"; }
snap() { ab snapshot -i -c 2>/dev/null; }
refs() { snap | grep -E "$1" | grep -oE 'ref=e[0-9]+' | cut -d= -f2; }
spinrefs() { snap | grep -- '- spinbutton' | grep -oE 'ref=e[0-9]+' | cut -d= -f2; }
firstref() { refs "$1" | head -1; }
evaln() { ab eval "$1" 2>/dev/null | tr -d '"'; }
# Timeline clips only. Counting by aria-label (the old form, `[aria-label^="Clip "]`)
# also counted the Inspector's own slider labels (`Clip opacity percent`, `Clip
# gain percent`, `Clip pan`, `Clip speed`, and the grade rows' `Clip temperature`
# / `Clip tint` before 0.6.0 renamed them to their visible labels), so every
# exact-count assertion silently depended on WHICH clip was selected. The two
# grade sliders broke f02_duplicate, which reads its baseline before switching
# the selection. The badges nested in a clip, the context menu and the
# clip-marker tabs are not clips either.
clipcount() {
  evaln '[...document.querySelectorAll("[data-testid^=clip-]")].filter((e) => {
    const id = e.dataset.testid || "";
    return id !== "clip-context-menu" && id !== "clip-marker" && !id.endsWith("badge");
  }).length' 2>/dev/null
}
sleeps() { sleep "${1:-0.4}"; }
# In-page ArrowRight stepping with a delivery lock (battery speedup item 4).
# Dispatches N real KeyboardEvents on the focused element (the input guard in
# useEditorKeyboard.ts still applies) and fails closed unless every event
# reached window's bubble listener AND was handled (defaultPrevented, which
# the editor's ArrowRight branch sets; the guard-swallow paths never do).
# A tenths-text gross check backstops it: no move or a materially different
# count fails, since adjacent counts alias at 0.1s resolution. Async IIFE:
# the dispatches update the store synchronously but React re-renders async,
# so a same-task DOM read would see the pre-dispatch text; the readout is
# polled in-page instead (ab eval awaits the promise).
step_frames() { # step_frames <n>
  local n="$1"
  case "$n" in '' | *[!0-9]*) echo "step_frames: bad count ($n)" >&2; return 1 ;; esac
  local res
  res=$(evaln "(async () => {
    const N = Number(\"$n\");
    const el = document.activeElement || document.body;
    const tag = ((el && el.tagName) || \"BODY\").toUpperCase();
    if (tag === \"INPUT\" || tag === \"TEXTAREA\" || tag === \"SELECT\" || (el && el.isContentEditable)) return \"ineligible-target\";
    const read = () => {
      const t = ((document.querySelector(\"[data-testid=time-display]\") || {}).innerText || \"\").split(\"/\")[0].trim();
      const m = /(\d+):(\d+\.\d+)/.exec(t);
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const t0 = read();
    if (t0 === null) return \"no-t0\";
    let got = 0, handled = 0;
    const h = (e) => { got += 1; if (e.defaultPrevented) handled += 1; };
    window.addEventListener(\"keydown\", h);
    try {
      for (let i = 0; i < N; i++) {
        el.dispatchEvent(new KeyboardEvent(\"keydown\", { key: \"ArrowRight\", shiftKey: false, bubbles: true, cancelable: true }));
      }
    } finally {
      window.removeEventListener(\"keydown\", h);
    }
    if (got !== N || handled !== N) return \"delivery:\" + got + \"/\" + handled + \"/\" + N;
    const want = N / 30;
    const deadline = Date.now() + 3000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 50));
      const t1 = read();
      if (t1 !== null && Math.abs(t1 - t0 - want) <= 0.11) return \"ok\";
      if (Date.now() > deadline) return \"gross:\" + t0 + \">\" + (t1 === null ? \"none\" : t1);
    }
  })()")
  case "$res" in
    ok) return 0 ;;
    *)
      echo "step_frames: in-page dispatch failed ($res, n=$n)" >&2
      return 1
      ;;
  esac
}
step() {
  local name="$1"; shift
  if "$@" >>"$OUT" 2>&1; then echo "PASS $name" >>"$OUT"; else echo "FAIL $name" >>"$OUT"; fi
}

# Scroll an Inspector control into view before touching it — see the header note.
# Never assume a control is on screen just because the a11y snapshot lists it.
insp() { # insp <selector inside the Inspector>
  ab scrollintoview "aside[aria-label=Inspector] $1" >/dev/null 2>&1
  sleeps 0.3
}

# Drive a Radix Select by keyboard: no battery step clicks into a portal,
# so the trigger is scrolled into view and clicked to open the menu, then
# arrows move from the current value and Enter commits. <downs> counts how
# many options below the current one to move. The insp selector must be raw
# CSS (an a11y "combobox" query is not a selector and scrolls nothing,
# which leaves the click landing off-target below the fold).
select_option() { # select_option <combobox-name> <downs>
  local r; r=$(firstref "combobox \"$1\"")
  [ -n "$r" ] || { echo "select_option: no combobox $1" >&2; return 1; }
  insp "[aria-label=\"$1\"]"
  ab click "@$r" >/dev/null 2>&1 && sleeps 0.5
  # A closed menu here means the trigger was not actually in view: surface
  # it instead of blindly arrowing into the page body.
  snap | grep -q 'listbox' || { echo "select_option: menu did not open for $1" >&2; return 1; }
  local i=0
  while [ "$i" -lt "$2" ]; do ab press ArrowDown >/dev/null 2>&1; i=$((i + 1)); done
  sleeps 0.3
  ab press Enter >/dev/null 2>&1 && sleeps 0.5
}

click_clip() { # click_clip <name-regex>
  local r; r=$(firstref "button \"Clip $1")
  [ -n "$r" ] || return 1
  # The timeline is a scroll area too — a clip can sit below its visible edge,
  # where a blind click lands on the footer instead of selecting the clip.
  ab scrollintoview "@$r" >/dev/null 2>&1 && sleeps 0.2
  ab click "@$r" >/dev/null 2>&1 && sleeps 0.5
}

# The 0.5.6 welcome modal greets every fresh visit; while it is open the rest
# of the app is aria-hidden (Radix) and invisible to the a11y snapshot. Close
# it the way a user does before touching anything else. A failed eval MUST
# abort the step, not fall through as "no modal": the script runs without
# set -e, so an empty result would leave the modal open and fail later at a
# confusing step (same class as the menus_open fix in 0.5.5).
dismiss_greeting() {
  local n
  n=$(evaln 'document.querySelectorAll("[data-testid=release-notes-modal]").length')
  [ -n "$n" ] || { sleep 0.5; n=$(evaln 'document.querySelectorAll("[data-testid=release-notes-modal]").length'); }
  [ -n "$n" ] || { echo "dismiss_greeting: eval failed, refusing to guess" >&2; return 1; }
  if [ "$n" = "1" ]; then
    ab press Escape >/dev/null 2>&1
    sleeps 0.5
  fi
}
fill_timing() { # fill_timing <start> <duration> — Timing spinbuttons of a selected clip
  local n; n=$(snap | grep -c -- '- spinbutton')
  if [ "$n" != "2" ]; then
    echo "fill_timing: no clip selected (spinbuttons=$n)" >&2
    return 1
  fi
  local s d
  s=$(spinrefs | sed -n '1p')
  d=$(spinrefs | sed -n '2p')
  ab scrollintoview "@$s" >/dev/null 2>&1 && sleeps 0.2
  ab fill "@$s" "$1" >/dev/null 2>&1 && ab press Enter >/dev/null 2>&1 && sleeps 0.3
  ab scrollintoview "@$d" >/dev/null 2>&1 && sleeps 0.2
  ab fill "@$d" "$2" >/dev/null 2>&1 && ab press Enter >/dev/null 2>&1 && sleeps 0.4
  return 0
}

# ————— 0. public entry and editor boot —————
s01_public() {
  ab open "$BASE_URL" >/dev/null || return 1
  local hero=0
  local deadline=$((SECONDS + 60))
  while [ "$hero" != "1" ] && [ "$SECONDS" -lt "$deadline" ]; do
    hero=$(evaln '(() => document.querySelector("[data-testid=hero]") ? "1" : "0")()')
    [ "$hero" = "1" ] || { hero=0; sleep 0.25; }
  done
  [ "$hero" = "1" ] || { echo "no public hero after navigation (url=$(evaln 'location.href' 2>/dev/null))" >&2; return 1; }
  local href
  href=$(evaln '(() => { const a = document.querySelector("[data-testid=open-editor]"); return a ? a.getAttribute("href") : ""; })()')
  [ "$href" = "/editor" ] || { echo "open-editor href=$href" >&2; return 1; }
}

# Boot poll: after any navigation the 3.2s preloader hold (plus dev-server
# compile on a cold box) means a fixed sleep cannot land past the reveal.
# Poll the mounted menubar with a 60s deadline instead; the deadline only
# binds on failure. A DOM query, not the a11y snapshot: an open welcome
# modal hides the chrome from snap while the page is fine.
wait_boot() {
  local boot=0
  local deadline=$((SECONDS + 60))
  while [ "$boot" != "1" ] && [ "$SECONDS" -lt "$deadline" ]; do
    boot=$(evaln '(() => { const d = document; return (d.querySelector("[role=menubar]") || d.querySelector("[data-testid=release-notes-modal]")) ? "1" : "0"; })()')
    [ "$boot" = "1" ] || { boot=0; sleep 0.25; }
  done
  [ "$boot" = "1" ] || { echo "no editor boot after navigation (url=$(evaln 'location.href' 2>/dev/null))" >&2; return 1; }
}

s02_boot() {
  ab click '[data-testid=open-editor]' >/dev/null || return 1
  wait_boot || return 1
  dismiss_greeting || return 1
  snap | grep -q 'Load sample media'
}

s03_fresh() {
  ab eval 'localStorage.clear()' >/dev/null || return 1
  ab open "$BASE_URL/editor" >/dev/null || return 1
  wait_boot || return 1
  dismiss_greeting || return 1
  snap | grep -q 'Load sample media'
}

# ----- 0.5.6 welcome modal (Help > What's new) -----
f11_whatsnew_opens() {
  local r; r=$(firstref 'menuitem "Help"')
  [ -n "$r" ] || return 1
  ab click "@$r" >/dev/null && sleeps 0.4
  local entry; entry=$(firstref "menuitem \"What's new in")
  [ -n "$entry" ] || { ab press Escape >/dev/null 2>&1; return 1; }
  ab click "@$entry" >/dev/null && sleeps 0.5
  local ok
  ok=$(evaln 'document.querySelectorAll("[data-testid=release-notes-modal]").length')
  ab press Escape >/dev/null 2>&1
  [ "$ok" = "1" ]
}
f11_whatsnew_once() {
  # The version was recorded by the greeting earlier in the run, so a reload
  # must NOT greet again. The reload surfaces the autosave restore banner
  # (edits happened); the banner must not bring the greeting back, and the
  # session must continue on the RESTORED doc for the steps that follow.
  ab reload >/dev/null
  wait_boot || return 1
  local n
  n=$(evaln 'document.querySelectorAll("[data-testid=release-notes-modal]").length')
  [ "$n" = "0" ] || return 1
  ab find role button click --name 'Restore' >/dev/null 2>&1 && sleep 1.5
  [ "$(clipcount)" -ge 3 ]
}

# ————— F1 import —————
f01_import() {
  ab find role button click --name 'Load sample media' >/dev/null && sleep 2.5
  [ "$(ab get count '[aria-label="Add to timeline"]')" = "3" ]
}

# ————— F2 quick-add —————
f02_add() {
  for r in $(refs 'Add to timeline'); do ab click "@$r" >/dev/null 2>&1; sleep 0.4; done
  sleep 0.5
  [ "$(clipcount)" -ge 3 ]
}
zoom_out() { # keep every quick-added clip inside the visible snapshot
  ab find role button click --name 'Zoom out (−)' >/dev/null && sleep 0.3
  ab find role button click --name 'Zoom out (−)' >/dev/null && sleep 0.4
  snap | grep -q 'Clip sample-audio'
}

# F2b three-point insert (, / I / O)
# The bin selection feeds the Source monitor, I/O mark the source range at the
# source monitor's own playhead, and `,` inserts that range at the sequence
# playhead. Nothing here drags or scrolls, so the step is keyboard-driven end to
# end and cannot depend on the window height like the clip/Inspector targets do.
# The source time moves the way the app itself owns it: the preview element's
# `seeked` callback writes sourcePlayhead, so `o` records a real seeked position
# instead of a value poked into the store.
clip_start() { # clip_start <aria-label substring> -> the clip's start seconds ("" when absent)
  evaln '(() => {
    const label = [...document.querySelectorAll("[data-testid^=clip-]")]
      .map((e) => e.getAttribute("aria-label") || "")
      .find((l) => l.indexOf("'"$1"'") >= 0);
    const m = label && label.match(/from ([0-9.]+) to ([0-9.]+) seconds/);
    return m ? m[1] : "";
  })()'
}
f02b_insert_place() {
  # Load the sample video into the Source monitor by clicking its bin row.
  ab eval '(() => {
    const row = [...document.querySelectorAll("[data-testid^=media-item-]")]
      .find((r) => (r.textContent || "").indexOf("sample-video") >= 0);
    if (!row) return "no-bin-row";
    row.click();
    return "clicked";
  })()' >/dev/null 2>&1
  sleeps 0.6
  local sel
  sel=$(evaln 'document.querySelector("[data-testid=source-panel]")?.getAttribute("data-selected-asset") || ""')
  [ -n "$sel" ] || { echo "f02b: the Source monitor did not load the sample" >&2; return 1; }

  # Mark In at the source head (selecting an asset resets the source time to 0).
  ab press i >/dev/null 2>&1
  sleeps 0.3

  # Seek the source element to 0.50s, then wait for its own callback to land.
  ab eval 'document.querySelector("[data-testid=source-preview]").currentTime = 0.5' >/dev/null 2>&1
  local t='' k
  for k in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    t=$(evaln 'document.querySelector("[data-testid=source-time]").textContent')
    [ "$t" = "0.50s" ] && break
    sleeps 0.3
  done
  [ "$t" = "0.50s" ] || { echo "f02b: source seek did not land (readout=$t)" >&2; return 1; }
  ab press o >/dev/null 2>&1
  sleeps 0.3
  local span
  span=$(evaln 'document.querySelector("[data-testid=source-span]").textContent')
  case "$span" in
    *'In 0.00s'*'Out 0.50s'*) ;;
    *) echo "f02b: I/O did not record the marks (span reads: $span)" >&2; return 1 ;;
  esac

  # Park the sequence playhead at the head, then measure the downstream clip.
  ab find role button click --name 'Go to start (Home)' >/dev/null 2>&1
  sleeps 0.4
  local before_c before_t after_c after_t back_c back_t
  before_c=$(clipcount)
  before_t=$(clip_start 'sample-image')
  [ -n "$before_t" ] || { echo "f02b: no sample-image clip to measure" >&2; return 1; }

  # The key is spelled `,` on purpose: agent-browser's `Comma` key name arrives
  # with an EMPTY `e.key` (verified against a keydown listener), so the app's
  # `case ','` never matches and the placement silently does nothing.
  ab press , >/dev/null 2>&1
  sleeps 0.7
  after_c=$(clipcount)
  after_t=$(clip_start 'sample-image')
  # The placed pair lands at the playhead: video part + audio twin.
  [ "$after_c" = "$((before_c + 2))" ] || {
    echo "f02b: placement added $((after_c - before_c)) clips, expected 2" >&2; return 1; }
  # Every downstream clip moves right by exactly the marked span (0.50s).
  awk -v b="$before_t" -v a="$after_t" 'BEGIN { d = a - b; exit !(d > 0.48 && d < 0.52) }' || {
    echo "f02b: downstream clip moved $before_t -> $after_t, expected the 0.50s span" >&2
    return 1; }

  # One undo removes the whole placement (displacement + placement, one entry).
  ab press Control+z >/dev/null 2>&1
  sleeps 0.6
  back_c=$(clipcount)
  back_t=$(clip_start 'sample-image')
  [ "$back_c" = "$before_c" ] || { echo "f02b: undo left $back_c clips, expected $before_c" >&2; return 1; }
  awk -v b="$before_t" -v r="$back_t" 'BEGIN { exit !(r == b) }' || {
    echo "f02b: undo did not restore the shift ($before_t -> $back_t)" >&2; return 1; }
}

# ————— F9 marquee (box) selection —————
selected_ids() { # testids of clips wearing the selection ring (the a11y snapshot cannot see it)
  # `:not([data-testid$=badge])` drops the link/speed/reverse badges nested in
  # the clip element: only the clip root gets the selection ring.
  evaln '[...document.querySelectorAll("[data-testid^=clip-]:not([data-testid$=badge]).ring-rose-400")].map((e) => e.dataset.testid).sort().join(",")'
}
# Points for a box that sweeps every clip: start on empty lane space in one
# row beyond the last clip, release inside the row opposite the start (so the
# rect spans every row). Computed from live geometry, so the window size cannot
# break the step, and deliberately outside the 24px auto-scroll bands, so the
# drag cannot scroll the view under the later steps. The start x is clamped to
# the LANE's right edge (the lane element, not the scroll container), so the
# first candidate is never past the content even when the content is narrower
# than the viewport.
marquee_points() {
  evaln '(() => {
    const sc = document.querySelector("[data-timeline-scroll]");
    const lanes = [...document.querySelectorAll("[data-lane-id]")];
    if (!sc || !lanes.length) return "none";
    const sr = sc.getBoundingClientRect();
    const rows = lanes.map((l) => l.getBoundingClientRect());
    const boxes = [...document.querySelectorAll("[data-testid^=clip-]:not([data-testid$=badge])")].map((c) => c.getBoundingClientRect());
    let start = null;
    for (let i = 0; i < rows.length && !start; i++) {
      const y = (rows[i].top + rows[i].bottom) / 2;
      const laneRight = Math.min(sr.right - 30, rows[i].right - 30);
      for (let x = laneRight; x > rows[i].left + 20; x -= 10) {
        if (!boxes.some((b) => x > b.left - 4 && x < b.right + 4 && y > b.top - 4 && y < b.bottom + 4)) {
          start = [x, y, i];
          break;
        }
      }
    }
    if (!start) return "none";
    const endRow = start[2] === 0 ? rows.length - 1 : 0;
    const endY = Math.min(rows[endRow].bottom - 10, rows[endRow].top + 10);
    return [Math.round(start[0]), Math.round(start[1]), Math.round(rows[0].left + 40), Math.round(endY)].join(",");
  })()'
}
marquee_covered_ids() { # testids of timeline clips whose boxes overlap the drag rect, sorted
  # Selector note: timeline clips carry a `clip-` testid; the Inspector's
  # `Clip opacity/gain percent` sliders only LOOK like clips by aria-label.
  # `:not([data-testid$=badge])` drops the link/speed/reverse badges nested in
  # the clip element: only the clip root can be selected.
  evaln "(() => {
    const left = Math.min($1, $3), right = Math.max($1, $3);
    const top = Math.min($2, $4), bottom = Math.max($2, $4);
    return [...document.querySelectorAll(\"[data-testid^=clip-]:not([data-testid$=badge])\")].filter((c) => {
      const b = c.getBoundingClientRect();
      return right > b.left && left < b.right && bottom > b.top && top < b.bottom;
    }).map((c) => c.dataset.testid).sort().join(\",\");
  })()"
}
f09_marquee() {
  local pts; pts=$(marquee_points)
  [ "$pts" != "none" ] || { echo "f09: no empty lane space found for the box drag" >&2; return 1; }
  local sx sy ex ey want got box
  IFS=',' read -r sx sy ex ey <<<"$pts"
  ab mouse move "$sx" "$sy" >/dev/null 2>&1
  ab mouse down >/dev/null 2>&1
  # Two moves: the first clears the 3px click threshold, the second spans the rows.
  ab mouse move "$(((sx + ex) / 2))" "$(((sy + ey) / 2))" >/dev/null 2>&1
  sleeps 0.2
  ab mouse move "$ex" "$ey" >/dev/null 2>&1
  sleeps 0.2
  # The overlay must exist while the drag is live — checked BEFORE the release.
  box=$(evaln 'document.querySelectorAll("[data-testid=marquee-rect]").length')
  if [ "$box" != "1" ]; then
    ab mouse up >/dev/null 2>&1 # never hand a dangling pressed pointer to later steps
    echo "f09: marquee rectangle absent during the drag (box drawn: $box)" >&2
    return 1
  fi
  ab mouse up >/dev/null 2>&1
  sleeps 0.4
  want=$(marquee_covered_ids "$sx" "$sy" "$ex" "$ey"); got=$(selected_ids)
  local covered_n
  covered_n=$(awk -F, '{print NF}' <<<"$want")
  if [ "$got" != "$want" ] || [ -z "$want" ] || [ "$covered_n" -lt 3 ]; then
    echo "f09: selection mismatch: selected [$got] vs covered [$want] (points $pts)" >&2
    return 1
  fi
}
f09_marquee_clear() {
  local pts sx sy
  pts=$(marquee_points)
  [ "$pts" != "none" ] || return 1
  IFS=',' read -r sx sy _ <<<"$pts"
  ab mouse move "$sx" "$sy" >/dev/null 2>&1
  ab mouse down >/dev/null 2>&1
  ab mouse up >/dev/null 2>&1 # no movement: a plain click on empty space
  sleeps 0.4
  [ -z "$(selected_ids)" ]
}

# ————— F10 markers —————
seq_marker_time() {
  evaln 'document.querySelector("[data-testid=sequence-marker]")?.dataset.markerTime ?? "none"'
}
between() { awk -v t="$1" -v lo="$2" -v hi="$3" 'BEGIN { exit !(t > lo && t < hi) }'; }
# The transport shows "<playhead> / <duration>", so compare a prefix.
time_display_is() {
  evaln "document.querySelector('[data-testid=time-display]').innerText.trim().startsWith('$1')"
}
# Playhead seconds from the transport readout ("m:ss.s / ..."), "" when unreadable.
playhead_seconds() {
  local t
  t=$(evaln "document.querySelector('[data-testid=time-display]').innerText")
  awk -v t="${t%%/*}" 'BEGIN { split(t, p, ":"); if (p[1] == "" || p[2] == "") exit 1; printf "%.3f", p[1]*60+p[2] }'
}
f10_markers_sequence() {
  ab press Control+Shift+a >/dev/null 2>&1   # no live clip selection -> M targets the timeline
  ab find role button click --name 'Go to start (Home)' >/dev/null && sleep 0.4
  step_frames 30 || return 1 # 30 frames = 1.0s, in-page with delivery lock
  sleeps 0.3
  ab press m >/dev/null 2>&1 && sleeps 0.5
  local n tm
  n=$(evaln 'document.querySelectorAll("[data-testid=sequence-marker]").length')
  [ "$n" = "1" ] || { echo "f10: sequence marker not added (count=$n)" >&2; return 1; }
  [ "$(evaln 'document.querySelectorAll("[data-testid=clip-marker]").length')" = "0" ] || {
    echo "f10: a marker with no clip selected landed on a clip" >&2
    return 1
  }
  tm=$(seq_marker_time)
  between "$tm" 0.99 1.01 || { echo "f10: marker at $tm, expected 1.0" >&2; return 1; }
  # Shift+M from the start and Ctrl+Shift+M from the end both land on the marker.
  ab find role button click --name 'Go to start (Home)' >/dev/null && sleeps 0.4
  ab press Shift+m >/dev/null 2>&1 && sleeps 0.4
  [ "$(time_display_is '0:01.')" = "true" ] || {
    echo "f10: Shift+M did not land on the marker" >&2
    return 1
  }
  ab find role button click --name 'Go to end (End)' >/dev/null && sleeps 0.4
  ab press Control+Shift+m >/dev/null 2>&1 && sleeps 0.4
  [ "$(time_display_is '0:01.')" = "true" ] || {
    echo "f10: Ctrl+Shift+M did not land on the marker" >&2
    return 1
  }
  # Drag the tab 60px: one undo entry, so Ctrl+Z restores the time.
  local rect x y
  rect=$(evaln '(() => {
    const el = document.querySelector("[data-testid=sequence-marker]");
    if (!el) return "none";
    const r = el.getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)].join(",");
  })()')
  [ "$rect" != "none" ] || { echo "f10: marker tab missing before the drag" >&2; return 1; }
  IFS=',' read -r x y <<<"$rect"
  ab mouse move "$x" "$y" >/dev/null 2>&1
  ab mouse down >/dev/null 2>&1
  ab mouse move "$((x + 20))" "$y" >/dev/null 2>&1
  ab mouse move "$((x + 60))" "$y" >/dev/null 2>&1
  sleeps 0.2
  ab mouse up >/dev/null 2>&1
  sleeps 0.4
  tm=$(seq_marker_time)
  between "$tm" 1.3 5 || { echo "f10: drag left the marker at $tm" >&2; return 1; }
  ab press Control+z >/dev/null 2>&1 && sleeps 0.5
  tm=$(seq_marker_time)
  between "$tm" 0.99 1.01 || { echo "f10: undo did not restore the marker time ($tm)" >&2; return 1; }
  # Click selects, Delete removes; undo restores it and redo removes it for good.
  ab mouse move "$x" "$y" >/dev/null 2>&1
  ab mouse down >/dev/null 2>&1
  ab mouse up >/dev/null 2>&1
  sleeps 0.4
  ab press Delete >/dev/null 2>&1 && sleeps 0.5
  [ "$(evaln 'document.querySelectorAll("[data-testid=sequence-marker]").length')" = "0" ] || {
    echo "f10: Delete did not remove the selected marker" >&2
    return 1
  }
  ab press Control+z >/dev/null 2>&1 && sleeps 0.5
  [ "$(evaln 'document.querySelectorAll("[data-testid=sequence-marker]").length')" = "1" ] || {
    echo "f10: undo did not restore the deleted marker" >&2
    return 1
  }
  ab press Control+Shift+z >/dev/null 2>&1 && sleeps 0.5
  [ "$(evaln 'document.querySelectorAll("[data-testid=sequence-marker]").length')" = "0" ] || {
    echo "f10: redo did not remove the marker again" >&2
    return 1
  }
}
f10_markers_clip() {
  click_clip 'sample-video' || { echo "f10: video clip not found" >&2; return 1; }
  ab find role button click --name 'Go to start (Home)' >/dev/null && sleep 0.4
  step_frames 30 || return 1 # 1.0s inside the clip, in-page with delivery lock
  sleeps 0.3
  ab press m >/dev/null 2>&1 && sleeps 0.5
  local n tm rect x y
  n=$(evaln 'document.querySelectorAll("[data-testid=clip-marker]").length')
  [ "$n" = "1" ] || { echo "f10: clip marker not added (count=$n)" >&2; return 1; }
  [ "$(evaln 'document.querySelectorAll("[data-testid=sequence-marker]").length')" = "0" ] || {
    echo "f10: a marker with a clip selected landed on the timeline" >&2
    return 1
  }
  tm=$(evaln 'document.querySelector("[data-testid=clip-marker]").dataset.markerTime')
  between "$tm" 0.99 1.01 || { echo "f10: clip marker at $tm, expected source 1.0" >&2; return 1; }
  # Adding does not select, so click the tab (seek + select), then edit through
  # the Marker menu: name, red swatch, notes.
  rect=$(evaln '(() => {
    const el = document.querySelector("[data-testid=clip-marker]");
    if (!el) return "none";
    const r = el.getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)].join(",");
  })()')
  [ "$rect" != "none" ] || { echo "f10: clip marker tab missing before the edit" >&2; return 1; }
  IFS=',' read -r x y <<<"$rect"
  ab mouse move "$x" "$y" >/dev/null 2>&1
  ab mouse down >/dev/null 2>&1
  ab mouse up >/dev/null 2>&1
  sleeps 0.4
  ab find role menuitem click --name 'Marker' >/dev/null 2>&1 && sleeps 0.4
  ab find role menuitem click --name 'Edit Selected Marker' >/dev/null 2>&1 && sleeps 0.6
  n=$(evaln 'document.querySelectorAll("[data-testid=marker-dialog]").length')
  [ "$n" = "1" ] || {
    echo "f10: marker dialog did not open (count=$n)" >&2
    ab press Escape >/dev/null 2>&1
    return 1
  }
  ab fill '[data-testid=marker-name-input]' 'Beat' >/dev/null 2>&1
  ab find role radio click --name 'Marker color red' >/dev/null 2>&1 && sleeps 0.2
  [ "$(evaln 'document.querySelector("[data-testid=marker-color-red]").getAttribute("aria-checked")')" = "true" ] || {
    echo "f10: the red swatch did not become the checked color" >&2
    ab press Escape >/dev/null 2>&1
    return 1
  }
  ab fill '[data-testid=marker-notes-input]' 'First hit' >/dev/null 2>&1
  # Save by testid: find-by-name also matches the toolbar's "Save project" behind
  # the modal, and that outside click just dismisses the dialog without saving.
  ab click '[data-testid=marker-save]' >/dev/null 2>&1 && sleeps 0.5
  [ "$(evaln 'document.querySelectorAll("[data-testid=marker-dialog]").length')" = "0" ] || {
    echo "f10: the marker dialog did not close on Save" >&2
    return 1
  }
  [ "$(evaln '(() => {
    const el = document.querySelector("[data-testid=clip-marker]");
    const label = el ? el.getAttribute("aria-label") : "";
    return label.includes("Beat") && label.includes("First hit");
  })()')" = "true" ] || { echo "f10: the saved name/notes are not on the clip marker" >&2; return 1; }
  # Delete (the marker owns the key while selected), undo, redo.
  ab press Delete >/dev/null 2>&1 && sleeps 0.5
  [ "$(evaln 'document.querySelectorAll("[data-testid=clip-marker]").length')" = "0" ] || {
    echo "f10: Delete did not remove the selected clip marker" >&2
    return 1
  }
  ab press Control+z >/dev/null 2>&1 && sleeps 0.5
  [ "$(evaln 'document.querySelectorAll("[data-testid=clip-marker]").length')" = "1" ] || {
    echo "f10: undo did not restore the clip marker" >&2
    return 1
  }
  ab press Control+Shift+z >/dev/null 2>&1 && sleeps 0.5
  [ "$(evaln 'document.querySelectorAll("[data-testid=clip-marker]").length')" = "0" ] || {
    echo "f10: redo did not remove the clip marker again" >&2
    return 1
  }
}

# ----- F1b real file import (bytes the app does not bundle) -----
# A tiny valid PNG (1x1, embedded as base64 and PIL-verified equivalent) goes
# through the media bin's hidden multi-file input: the same importFile probe,
# dedup and thumbnail path a user's file picker feeds. Success = a 4th
# "Add to timeline" asset.
f01b_import_real_file() {
  local png; png="${TMPDIR:-/tmp}/battery-pixel-$$.png"
  printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$png"
  ab upload 'aside[aria-label="Media bin"] input[type=file][multiple]' "$png" >/dev/null 2>&1 || {
    echo "f01b: upload into the media bin failed" >&2
    rm -f "$png"
    return 1
  }
  sleep 2.5
  rm -f "$png"
  [ "$(ab get count '[aria-label="Add to timeline"]')" = "4" ] || return 1
  # Remove the throwaway again: only the bundled samples can re-hydrate after a
  # project roundtrip, so this asset would come back OFFLINE, and one offline
  # asset in the bin disables the export dialog's Start button
  # (hasOfflineMedia). That is what blocked f07's post-roundtrip export: the
  # dialog never left its setup phase. Left in the bin it would also quick-add a
  # stray clip below (the next step clicks every row), stretching the sequence.
  local item
  item=$(evaln '(() => {
    const el = [...document.querySelectorAll("[data-testid^=media-item-]")]
      .find((e) => e.textContent.includes("battery-pixel-"));
    return el ? el.getAttribute("data-testid") : "none";
  })()')
  [ "$item" != "none" ] || { echo "f01b: the imported pixel is not in the bin" >&2; return 1; }
  ab click "[data-testid=$item] button[aria-label=\"Remove from bin\"]" >/dev/null 2>&1
  sleeps 0.5
  [ "$(ab get count '[aria-label="Add to timeline"]')" = "3" ]
}

# The red/blue balance of a canvas, as the ratio sum(red)/sum(blue). A ratio
# (not a sum) is what makes the preview monitor and the exported frame
# comparable: resolution, letterboxing and alpha fades scale both channels
# together, while the temperature grade moves red against blue. "" on failure.
canvas_ratio() { # canvas_ratio <css selector for the canvas>
  local rb
  rb=$(evaln "(() => {
    const c = document.querySelector('$1');
    if (!c || !c.width || !c.height) return '0 0';
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let r = 0, b = 0;
    for (let i = 0; i < d.length; i += 40) { r += d[i]; b += d[i + 2]; }
    return r + ' ' + b;
  })()")
  awk -v v="${rb:-0 0}" 'BEGIN {
    split(v, a, " ");
    if (a[1] <= 0 || a[2] <= 0) { print ""; exit }
    printf "%.6f", a[1] / a[2]
  }'
}

# Brightness of one frame: a stride sum over the composited canvas. Equality
# (not a ratio) between two parked seeks of the SAME timeline time is what the
# reversed-trim step asserts, so the raw sum is the value it stores.
frame_sum() { # frame_sum <css selector for the canvas>
  evaln "(() => {
    const c = document.querySelector('$1');
    if (!c || !c.width || !c.height) return '0';
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let s = 0; for (let i = 0; i < d.length; i += 40) s += d[i] + d[i+1] + d[i+2];
    return s;
  })()"
}

# A settled frame sum: polls until two consecutive reads agree (a parked
# seek composites asynchronously, and a single read can catch a transitional
# frame). Echoes the stable sum, or "" after ~4s of disagreement.
settled_sum() { # settled_sum <css selector for the canvas>
  local a b i
  a=$(frame_sum "$1")
  for i in $(seq 1 8); do
    sleep 0.5
    b=$(frame_sum "$1")
    if [ -n "$a" ] && [ "$a" = "$b" ]; then echo "$b"; return 0; fi
    a="$b"
  done
  echo ""
  return 1
}

# Per-channel sums of one canvas as "r g b" (the same stride-40 sample frame_sum
# adds together). The LUT proofs need the channels apart: a 1D cube whose green
# and blue tables are zero makes a graded frame's green collapse, which no
# content-dependent level or ratio can fake.
frame_rgb_sums() { # frame_rgb_sums <css selector for the canvas>
  evaln "(() => {
    const c = document.querySelector('$1');
    if (!c || !c.width || !c.height) return '0 0 0';
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 40) { r += d[i]; g += d[i+1]; b += d[i+2]; }
    return r + ' ' + g + ' ' + b;
  })()"
}

# The LUT fixture both proofs upload (f06_lut and f07_export): a 1D cube whose
# red table is all one and whose green and blue tables are all zero, so every
# pixel the shaper reaches becomes pure red. The oracle is the collapse of the
# green channel, which holds whatever the source frame happens to look like.
make_lut() { # make_lut <path>
  printf 'TITLE "battery-red"\nLUT_1D_SIZE 2\n1.0 0.0 0.0\n1.0 0.0 0.0\n' >"$1"
}

# The waveform and vectorscope meters paint real pixels (0.7.0). jsdom cannot
# see this (its mocked getImageData returns zeros), so the browser is the only
# place the draw is provable. Two constraints: the meters sample the monitor on
# a 100ms interval with no completion signal, so the step sleeps past one
# interval after opening the panel, and the read is bounded by the METER
# canvases, never the monitor. frame_sum is reused for the read: a trace of
# grey fillRects sums the same way a composited frame does.
f06_scopes() {
  ab click '[data-testid=scopes-toggle]' >/dev/null 2>&1
  sleeps 0.6
  local wave vector
  wave=$(frame_sum '[data-testid=scopes-waveform]')
  vector=$(frame_sum '[data-testid=scopes-vectorscope]')
  [ -n "$wave" ] && [ -n "$vector" ] || {
    echo "f06: could not read the scope meters (waveform=$wave vectorscope=$vector)" >&2
    return 1
  }
  awk -v w="$wave" -v v="$vector" 'BEGIN { exit !(w > 0 && v > 0) }' || {
    echo "f06: scope meters are blank (waveform=$wave vectorscope=$vector)" >&2
    return 1
  }
  # Collapse again: the later steps expect the panel closed, and an open
  # scopes strip narrows the monitor area for every pixel-reading step after it.
  ab click '[data-testid=scopes-toggle]' >/dev/null 2>&1
  sleeps 0.3
}

# The waveform must TILE its meter canvas, not just start at its left edge: a
# sample narrower than the canvas (a square project downsamples to 144 columns
# against the 256px meter) used to paint one-pixel bars and leave the right side
# blank. The unit suite locks the geometry; this is the browser proof that the
# pixels actually land on the last column.
f06_scopes_fill() {
  # The project width/height spinbuttons the settings step just used (Inspector's
  # project section; the first two spinbuttons in the snapshot at this point).
  local w h
  w=$(spinrefs | sed -n '1p')
  [ -n "$w" ] || { echo "f06_scopes_fill: no project width spinbutton" >&2; return 1; }
  ab scrollintoview "@$w" >/dev/null 2>&1 && sleeps 0.2
  ab fill "@$w" '1080' >/dev/null && ab press Enter >/dev/null && sleeps 0.6
  h=$(spinrefs | sed -n '2p')
  [ -n "$h" ] || { echo "f06_scopes_fill: no project height spinbutton" >&2; return 1; }
  ab scrollintoview "@$h" >/dev/null 2>&1 && sleeps 0.2
  ab fill "@$h" '1080' >/dev/null && ab press Enter >/dev/null && sleeps 0.6
  [ "$(evaln 'document.querySelector("[data-testid=preview-canvas]").width')" = "1080" ] &&
    [ "$(evaln 'document.querySelector("[data-testid=preview-canvas]").height')" = "1080" ] || {
    echo "f06_scopes_fill: the project did not become 1080x1080" >&2
    return 1
  }

  # Open the scopes unless they are already open (the panel state persists
  # across steps), and restore that state at the end.
  local was_open
  was_open=$(evaln 'document.querySelectorAll("[data-testid=scopes-meters]").length')
  if [ "$was_open" = "0" ]; then
    ab scrollintoview '[data-testid=scopes-toggle]' >/dev/null 2>&1 && sleeps 0.2
    ab click '[data-testid=scopes-toggle]' >/dev/null 2>&1
  fi
  # Past one 100ms sample interval after the resize, then read the METER canvas
  # (never the monitor): the alpha sum of its first and last pixel columns.
  sleeps 0.6
  local edges
  edges=$(evaln '(() => {
    const c = document.querySelector("[data-testid=scopes-waveform]");
    if (!c) return "none";
    const ctx = c.getContext("2d");
    const col = (x) => {
      const d = ctx.getImageData(x, 0, 1, c.height).data;
      let a = 0;
      for (let i = 3; i < d.length; i += 4) a += d[i];
      return a;
    };
    return col(0) + ":" + col(c.width - 1);
  })()')
  local ok=1
  case "$edges" in
    none)
      echo "f06_scopes_fill: the waveform meter is not mounted" >&2
      ok=0
      ;;
    *:*)
      local l r
      l=${edges%%:*}
      r=${edges##*:}
      awk -v l="$l" -v r="$r" 'BEGIN { exit !(l > 0 && r > 0) }' || {
        echo "f06_scopes_fill: the waveform misses a canvas edge (left=$l right=$r)" >&2
        ok=0
      }
      ;;
    *)
      echo "f06_scopes_fill: unreadable edge sample ($edges)" >&2
      ok=0
      ;;
  esac
  if [ "$was_open" = "0" ]; then
    ab click '[data-testid=scopes-toggle]' >/dev/null 2>&1
    sleeps 0.3
  fi
  [ "$ok" = "1" ]
}

# The .cube import is the one path that turns a file the app does not own into a
# grade, and the monitor is where the shaper can be seen. It runs after the
# relink flow, with only the console check following it, so the
# import+assignment batch and its undo cannot disturb the export round that ran
# earlier. The fixture makes every graded
# pixel pure red (make_lut), so the proof is the green channel collapsing while
# red stays: an oracle that does not depend on what the frame looks like.
f06_lut() {
  local cube="${TMPDIR:-/tmp}/battery-red-$$.cube"
  make_lut "$cube"
  LUT_FIXTURE="$cube"

  # Park on the 0.60s frame again and require content before touching the LUT.
  ab find role button click --name 'Go to start (Home)' >/dev/null && sleeps 0.4
  local i
  step_frames 18 || return 1
  sleeps 0.6
  # The FIRST video part covers the parked time (the split put it at 0.00).
  # The clip button can lag the snapshot under load (React batches the
  # re-render), so retry the find-and-click instead of failing single-shot.
  local tries=0
  while [ "$tries" -lt 30 ]; do
    click_clip 'sample-video.mp4 from 0.00 to' && break
    tries=$((tries + 1))
    sleep 0.5
  done
  [ "$tries" -lt 30 ] || {
    echo "f06_lut: the first video part did not select" >&2
    echo "f06_lut: clipcount=$(clipcount) labels: $(evaln '[...document.querySelectorAll("button")].map(b => b.getAttribute("aria-label") || "").filter(s => s.startsWith("Clip ")).join(" / ")' 2>/dev/null)" >&2
    return 1
  }
  ab eval 'document.querySelector("[data-testid=inspector-tab-clip]")?.click()' >/dev/null 2>&1
  sleeps 0.4
  insp '[data-testid=lut-load]'

  local before after back b_g a_r a_g u_g ok=1
  before=$(frame_rgb_sums '[data-testid=preview-canvas]')
  awk -v v="${before:-}" 'BEGIN {
    n = split(v, f, " ");
    if (n != 3) exit 1;
    for (i = 1; i <= 3; i++) if (f[i] !~ /^[0-9]+$/) exit 1;
  }' || {
    echo "f06_lut: could not sample the monitor before the LUT ($before)" >&2
    return 1
  }
  b_g=${before#* }; b_g=${b_g%% *}

  ab upload '[data-testid=lut-file]' "$cube" >/dev/null 2>&1 || {
    echo "f06_lut: the cube upload into the Inspector failed" >&2
    return 1
  }
  # The import is async (file.text() then one command batch): poll the LUT row
  # for the name instead of sleeping a guess.
  local landed=0
  for i in $(seq 1 20); do
    if [ "$(evaln 'document.querySelector("aside[aria-label=Inspector]")?.innerText.includes("battery-red") ? "yes" : "no"')" = "yes" ]; then
      landed=1
      break
    fi
    sleep 0.25
  done
  [ "$landed" = "1" ] || {
    echo "f06_lut: the imported cube was never assigned to the clip" >&2
    return 1
  }
  sleeps 0.6

  after=$(frame_rgb_sums '[data-testid=preview-canvas]')
  awk -v v="${after:-}" 'BEGIN {
    n = split(v, f, " ");
    if (n != 3) exit 1;
    for (i = 1; i <= 3; i++) if (f[i] !~ /^[0-9]+$/) exit 1;
  }' || {
    echo "f06_lut: could not sample the monitor after the LUT ($after)" >&2
    return 1
  }
  a_r=${after%% *}
  a_g=${after#* }; a_g=${a_g%% *}
  awk -v ar="$a_r" -v bg="$b_g" -v ag="$a_g" 'BEGIN {
    if (bg <= 0) exit 1
    exit !(ar > 0 && ag < bg * 0.25)
  }' || {
    echo "f06_lut: the monitor did not grade (before=$before after=$after)" >&2
    ok=0
  }

  # The batch (library entry plus assignment) is ONE undo step: a single Ctrl+Z
  # must return the row to None and the parked frame to its pre-LUT pixels.
  ab eval 'document.activeElement && document.activeElement.blur()' >/dev/null 2>&1
  ab press Control+z >/dev/null 2>&1
  sleeps 0.7
  local sel
  sel=$(evaln 'document.querySelector("aside[aria-label=Inspector]")?.innerText.includes("battery-red") ? "yes" : "no"')
  [ "$sel" = "no" ] || {
    echo "f06_lut: the undo left the LUT assigned" >&2
    ok=0
  }
  back=$(frame_rgb_sums '[data-testid=preview-canvas]')
  u_g=${back#* }; u_g=${u_g%% *}
  awk -v bg="$b_g" -v ug="${u_g:-}" 'BEGIN { exit !(ug >= bg * 0.8) }' || {
    echo "f06_lut: the undo did not restore the ungraded frame (before=$before undo=$back)" >&2
    ok=0
  }
  [ "$ok" = "1" ]
}

# ————— F6 playback + compositing —————
f06_play() {
  local t0 t1
  t0=$(evaln "document.querySelector('[data-testid=time-display]').innerText")
  ab find role button click --name 'Play (Space)' >/dev/null && sleep 0.9
  t1=$(evaln "document.querySelector('[data-testid=time-display]').innerText")
  ab find role button click --name 'Pause (Space)' >/dev/null && sleep 0.3
  [ "$t0" != "$t1" ]
}
f06_canvas() {
  local s
  s=$(evaln '(() => {
    const c = document.querySelector("[data-testid=preview-canvas]");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let s = 0; for (let i = 0; i < d.length; i += 40) s += d[i] + d[i+1] + d[i+2];
    return s;
  })()')
  [ "${s:-0}" -gt 0 ] 2>/dev/null || return 1

  # Color grade reaches the monitor (0.6.0).
  # Park on a deterministic frame: 18 frame-steps = 0.60s at 30 fps, a doc time
  # where the video clip is live. f07_export decodes the same time out of the
  # produced MP4, so both samples cover the same content.
  ab find role button click --name 'Go to start (Home)' >/dev/null && sleeps 0.4
  step_frames 18 || return 1
  sleeps 0.6
  local neutral graded
  neutral=$(canvas_ratio "[data-testid=preview-canvas]")
  [ -n "$neutral" ] || { echo "f06: could not sample the monitor" >&2; return 1; }

  click_clip 'sample-video' || { echo "f06: video clip missing for the grade sample" >&2; return 1; }
  local n; n=$(evaln 'document.querySelectorAll("#grade-temperature [role=slider]").length')
  [ "$n" = "1" ] || { echo "f06: temperature slider missing (thumbs=$n)" >&2; return 1; }
  # Focus the thumb, then press End: the slider commits on the keydown, exactly
  # like the Inspector gain slider elsewhere in this battery.
  ab eval 'document.querySelector("#grade-temperature [role=slider]").focus()' >/dev/null
  ab press End >/dev/null 2>&1 && sleeps 0.6
  graded=$(canvas_ratio "[data-testid=preview-canvas]")
  [ -n "$graded" ] || { echo "f06: could not resample the monitor" >&2; return 1; }
  awk -v n="$neutral" -v g="$graded" 'BEGIN { exit !(g > n * 1.2) }' || {
    echo "f06: +100 temperature did not warm the monitor (neutral=$neutral graded=$graded)" >&2
    return 1
  }
}

# ————— F2 split + F8 undo/redo —————
f02_split() {
  click_clip 'sample-video' || return 1
  ab find role button click --name 'Go to start (Home)' >/dev/null && sleep 0.4
  step_frames 60 || return 1 # 60 frames = 2.0s, in-page with delivery lock
  sleep 0.3
  local before after
  before=$(clipcount)
  ab press Control+k >/dev/null && sleeps 0.6
  after=$(clipcount)
  [ "${after:-0}" -gt "${before:-0}" ]
}
f08_undo() {
  local before after
  before=$(clipcount)
  ab press Control+z >/dev/null; sleeps 0.5
  after=$(clipcount)
  [ "${after:-0}" -lt "${before:-0}" ]
}
f08_redo() {
  local before after
  before=$(clipcount)
  ab press Control+Shift+z >/dev/null; sleeps 0.5
  after=$(clipcount)
  [ "${after:-0}" -gt "${before:-0}" ]
}

# ————— F2 trim (part1: 0.00 -> 1.50) —————
f02_trim() {
  click_clip 'sample-video' || return 1
  fill_timing 0 1.5 || return 1
  sleeps 0.3
  snap | grep -Eq 'Clip sample-video.mp4 from 0.00 to 1.50 seconds'
}

# ————— F3 crossfade —————
f03_crossfade() {
  click_clip 'sample-video' || { echo "f03: video clip not found" >&2; return 1; }
  insp '[role=switch][aria-label="Enable transition"]'
  ab find role switch click --name 'Enable transition' >/dev/null 2>&1 || {
    echo "f03: switch missing, inspector switches: $(snap | grep -c switch)" >&2
    return 1
  }
  sleeps 0.5
  snap | grep -q '"Enable transition" \[checked=true'
}

# --- T spatial transitions (0.8.4) ---
t01_wipe() {
  click_clip 'sample-video' || { echo "t01: video clip not found" >&2; return 1; }
  # Type select opens on Cross dissolve (first option): two downs reach Wipe.
  select_option 'Transition type' 2 || return 1
  snap | grep -q 'combobox "Transition direction"' || {
    echo "t01: direction select missing" >&2; return 1
  }
  # Direction opens on From left: one down reaches From right.
  select_option 'Transition direction' 1 || return 1
  # Edge opens on Hard: one down reaches Feathered.
  select_option 'Wipe edge' 1 || return 1
  snap | grep -q 'Wipe feather width' || {
    echo "t01: feather slider missing" >&2; return 1
  }
  snap | grep -q 'Wipe' || { echo "t01: wipe type not shown" >&2; return 1; }
  if snap | grep -q 'Update failed'; then
    echo "t01: error toast shown" >&2
    return 1
  fi
}

t02_slide_push() {
  click_clip 'sample-video' || { echo "t02: video clip not found" >&2; return 1; }
  # From Wipe (third option): one down reaches Slide, another reaches Push.
  select_option 'Transition type' 1 || return 1
  snap | grep -q 'Slide' || { echo "t02: slide type not shown" >&2; return 1; }
  snap | grep -q 'From right' || {
    echo "t02: direction did not persist across the type switch" >&2; return 1
  }
  select_option 'Transition type' 1 || return 1
  snap | grep -q 'Push' || { echo "t02: push type not shown" >&2; return 1; }
  snap | grep -q 'From right' || {
    echo "t02: direction did not persist across the type switch" >&2; return 1
  }
}

# ————— F4 text —————
f04_text_add() {
  ab press t >/dev/null && sleeps 0.7
  snap | grep -q 'Clip Your text here'
}
f04_text_edit() {
  click_clip 'Your text here' || return 1
  insp 'textarea[aria-label="Text content"]'
  local t; t=$(firstref 'textbox "Text content"')
  [ -n "$t" ] && ab fill "@$t" 'Hello A/B' >/dev/null && sleeps 0.3
}

# ————— C captions (0.8.5) —————
c01_captions_import() {
  local srt; srt="${TMPDIR:-/tmp}/battery-captions-$$.srt"
  cat > "$srt" << 'SRT'
1
00:00:01,000 --> 00:00:02,000
Alpha

2
00:00:01,000 --> 00:00:02,000
Beta

3
00:00:02,500 --> 00:00:03,500
Gamma
SRT
  ab upload '[data-testid=captions-import]' "$srt" >/dev/null 2>&1 || {
    echo "c01: the SRT upload into the captions panel failed" >&2
    rm -f "$srt"
    return 1
  }
  rm -f "$srt"
  # The import is async (file.text() then one command batch): poll the cue
  # list for the last text instead of sleeping a guess.
  local landed=0
  local i
  for i in $(seq 1 20); do
    if snap | grep -q 'Gamma'; then landed=1; break; fi
    sleep 0.25
  done
  [ "$landed" = "1" ] || { echo "c01: the imported cues never landed" >&2; return 1; }
  snap | grep -q 'Alpha' || { echo "c01: the Alpha cue is missing" >&2; return 1; }
  snap | grep -q 'Beta' || { echo "c01: the Beta cue is missing" >&2; return 1; }
}
c02_captions_export() {
  # The captions panel sits in the bottom row: scroll its button into view
  # first, like every other below-the-fold control in this battery.
  ab scrollintoview '[data-testid=captions-download]' >/dev/null 2>&1
  sleeps 0.3
  local out; out=$(mktemp /tmp/battery-captions.XXXXXX.srt)
  CAPTIONS_TMPS="$CAPTIONS_TMPS $out"
  ab download '[data-testid=captions-download]' "$out" >/dev/null 2>&1 || {
    echo "c02: the SRT download failed" >&2
    rm -f "$out"
    return 1
  }
  [ -s "$out" ] || { echo "c02: the downloaded SRT is empty" >&2; rm -f "$out"; return 1; }
  # Three cues in start order separated by arrow lines; the equal-start pair
  # keeps both overlaps in tiebreak (code-unit) order: Alpha before Beta.
  local al be ga arrows
  al=$(grep -n '^Alpha$' "$out" | cut -d: -f1)
  be=$(grep -n '^Beta$' "$out" | cut -d: -f1)
  ga=$(grep -n '^Gamma$' "$out" | cut -d: -f1)
  arrows=$(grep -c -- '-->' "$out")
  rm -f "$out"
  [ -n "$al" ] && [ -n "$be" ] && [ -n "$ga" ] || {
    echo "c02: a cue text is missing from the SRT" >&2; return 1; }
  [ "$arrows" -ge 3 ] || {
    echo "c02: expected 3 arrow lines, got $arrows" >&2; return 1; }
  [ "$al" -lt "$be" ] && [ "$be" -lt "$ga" ] || {
    echo "c02: cue order wrong ($al,$be,$ga)" >&2; return 1; }
  # The VTT button exports the same cue list as WebVTT: header first, the
  # three cues in the same order, dot-shaped arrow lines, no sequence
  # numbers. Same single-result-line discipline as the SRT body above.
  ab scrollintoview '[data-testid=captions-download-vtt]' >/dev/null 2>&1
  sleeps 0.3
  local vtt; vtt=$(mktemp /tmp/battery-captions.XXXXXX.vtt)
  CAPTIONS_TMPS="$CAPTIONS_TMPS $vtt"
  ab download '[data-testid=captions-download-vtt]' "$vtt" >/dev/null 2>&1 || {
    echo "c02: the VTT download failed" >&2
    rm -f "$vtt"
    return 1
  }
  [ -s "$vtt" ] || { echo "c02: the downloaded VTT is empty" >&2; rm -f "$vtt"; return 1; }
  local val vbe vga varrows vshaped
  head -1 "$vtt" | grep -q '^WEBVTT$' || {
    echo "c02: the VTT header is missing" >&2; rm -f "$vtt"; return 1; }
  # A bare number is only a sequence id when an arrow line follows it
  # directly; a numeric cue text is followed by a blank line, never an
  # arrow line. (A numeric VTT cue *identifier* would match this shape too,
  # but the serializer emits no identifiers, so any hit here is a violation
  # of our output contract.)
  grep -A1 -E '^[0-9]+$' "$vtt" | grep -E -- '-->' && {
    echo "c02: the VTT has sequence numbers" >&2; rm -f "$vtt"; return 1; }
  val=$(grep -n '^Alpha$' "$vtt" | cut -d: -f1)
  vbe=$(grep -n '^Beta$' "$vtt" | cut -d: -f1)
  vga=$(grep -n '^Gamma$' "$vtt" | cut -d: -f1)
  varrows=$(grep -c -- '-->' "$vtt")
  vshaped=$(grep -cE '^[0-9]{2,}:[0-9]{2}:[0-9]{2}\.[0-9]{3} --> [0-9]{2,}:[0-9]{2}:[0-9]{2}\.[0-9]{3}$' "$vtt")
  [ "$varrows" -eq 3 ] || {
    echo "c02: expected exactly 3 VTT arrow lines, got $varrows" >&2; rm -f "$vtt"; return 1; }
  [ "$vshaped" -eq 3 ] || {
    echo "c02: VTT arrow lines are not all dot-shaped timestamps" >&2; rm -f "$vtt"; return 1; }
  rm -f "$vtt"
  [ -n "$val" ] && [ -n "$vbe" ] && [ -n "$vga" ] || {
    echo "c02: a cue text is missing from the VTT" >&2; return 1; }
  [ "$val" -lt "$vbe" ] && [ "$vbe" -lt "$vga" ] || {
    echo "c02: VTT cue order wrong ($val,$vbe,$vga)" >&2; return 1; }
}

# ————— E effects (0.8.6) —————
# Each step adds one effect through the real picker, proves it landed (and,
# where pixels allow, that it renders), then undoes the add so every later
# step sees the timeline it left behind. The Effect Controls tab hosts the
# picker; the Clip tab hosts the blend dropdown.

e00_effects_tab() {
  ab press Escape >/dev/null 2>&1; sleeps 0.2
  click_clip 'sample-video' || { echo "e00: video clip not found" >&2; return 1; }
  ab eval 'document.querySelector("[data-testid=inspector-tab-effects]").click()' >/dev/null 2>&1
  sleeps 0.5
  snap | grep -q 'Add effect' || { echo "e00: effects section missing" >&2; return 1; }
}

e01_crop_add_remove() {
  insp '[aria-label="Add effect"]'
  ab find role button click --name 'Add effect' >/dev/null 2>&1 || {
    echo "e01: Add effect button missing" >&2; return 1; }
  sleeps 0.4
  ab find role menuitem click --name 'Crop' >/dev/null 2>&1 || {
    echo "e01: Crop menu item missing" >&2; return 1; }
  sleeps 0.5
  snap | grep -q 'Remove Crop' || { echo "e01: the crop entry never landed" >&2; return 1; }
  # Geometry proof: Left to max consumes the frame, so the settled monitor
  # must differ from the unkeyed frame (an ignored crop would composite
  # identically). Parked at 0.3s, inside the first video part and clear of
  # the 1.0s caption cues; any non-fully-occluding stack differs.
  ab eval "document.activeElement && document.activeElement.blur()" >/dev/null 2>&1
  ab find role button click --name 'Go to start (Home)' >/dev/null && sleeps 0.4
  local i
  for i in $(seq 1 9); do ab press ArrowRight >/dev/null 2>&1; done
  if ! between "$(playhead_seconds)" 0.29 0.41; then
    echo "e01: playhead missed 0.3s ($(playhead_seconds))" >&2; return 1
  fi
  local plain1
  plain1=$(settled_sum "[data-testid=preview-canvas]")
  [ -n "$plain1" ] || { echo "e01: monitor never settled" >&2; return 1; }
  # aria-label rides the thumb itself (see NamedSlider), so the selector
  # must not use a descendant combinator.
  ab eval "document.querySelector('[aria-label=\"Left value\"][role=slider]').focus()" >/dev/null 2>&1
  ab press End >/dev/null 2>&1 && sleeps 0.6
  # End must not leak to transport, and the slider must actually read 100:
  # a lost End leaves one command too few, and the second undo below would
  # then eat a pre-step entry (this exact desync once deleted the Captions
  # lane and failed e04 downstream).
  if ! between "$(playhead_seconds)" 0.29 0.41; then
    echo "e01: End moved the playhead ($(playhead_seconds))" >&2; return 1
  fi
  snap | grep -q 'slider "Left value".*: 100' || {
    echo "e01: Left did not reach max" >&2; return 1; }
  local cropped
  cropped=$(settled_sum "[data-testid=preview-canvas]")
  [ -n "$cropped" ] || { echo "e01: monitor never settled after cropping" >&2; return 1; }
  [ "$cropped" != "$plain1" ] || { echo "e01: consumed crop rendered identically ($cropped)" >&2; return 1; }
  ab press Control+z >/dev/null; sleeps 0.4
  ab press Control+z >/dev/null; sleeps 0.5
  snap | grep -q 'Remove Crop' && { echo "e01: undo did not remove the crop" >&2; return 1; }
  return 0
}

e02_blend_mode() {
  ab eval 'document.querySelector("[data-testid=inspector-tab-clip]").click()' >/dev/null 2>&1
  sleeps 0.4
  select_option 'Clip blend mode' 1 || return 1
  snap | grep -q '"Clip blend mode" selected="Multiply"' || snap | grep -q 'Multiply' || {
    echo "e02: blend mode did not switch to Multiply" >&2; return 1; }
  ab press Control+z >/dev/null; sleeps 0.5
  # The undo must restore Normal: the closed combobox prints its value after
  # a colon in the snapshot (verified live: `: Multiply` vs `: Normal`).
  snap | grep -q 'combobox "Clip blend mode".*: Normal' || {
    echo "e02: undo did not restore Normal" >&2; return 1; }
  return 0
}

e03_chroma_hex() {
  ab eval 'document.querySelector("[data-testid=inspector-tab-effects]").click()' >/dev/null 2>&1
  sleeps 0.4
  insp '[aria-label="Add effect"]'
  ab find role button click --name 'Add effect' >/dev/null 2>&1 || {
    echo "e03: Add effect button missing" >&2; return 1; }
  sleeps 0.4
  ab find role menuitem click --name 'Chroma key' >/dev/null 2>&1 || {
    echo "e03: Chroma key menu item missing" >&2; return 1; }
  sleeps 0.5
  snap | grep -q 'Pick key color from monitor' || { echo "e03: the keyer entry never landed" >&2; return 1; }
  # Non-default key through the real hex field, committed with Enter.
  ab fill '[aria-label="Key color hex"]' '#ff0000' >/dev/null 2>&1 || {
    echo "e03: hex fill failed" >&2; return 1; }
  ab press Enter >/dev/null 2>&1 && sleeps 0.5
  snap | grep -q '#ff0000' || { echo "e03: hex key did not display" >&2; return 1; }
  # Similarity to max collapses the ramp to a hard step at dN <= 1, which
  # keys nearly every pixel regardless of content: the monitor must erase.
  # Focus through the DOM like the grade slider (f06): a snapshot ref can go
  # stale between lookup and use (a commit re-renders and detaches the thumb),
  # but the labelled slider does not move.
  snap | grep -q 'slider "Similarity value"' || { echo "e03: Similarity slider missing" >&2; return 1; }
  # Park where the keyed first video part is live (0..1.50, same seam rule as
  # e04: 1.2s is safely inside), polling for a live frame before sampling.
  ab eval "document.activeElement && document.activeElement.blur()" >/dev/null 2>&1
  ab find role button click --name 'Go to start (Home)' >/dev/null && sleeps 0.4
  step_frames 36 || return 1
  if ! between "$(playhead_seconds)" 1.09 1.41; then
    echo "e03: playhead missed 1.2s ($(playhead_seconds))" >&2; return 1
  fi
  local plain3
  plain3=$(settled_sum "[data-testid=preview-canvas]")
  [ -n "$plain3" ] || { echo "e03: monitor never settled at 1.2s" >&2; return 1; }
  [ "${plain3:-0}" -gt 1000000 ] 2>/dev/null || { echo "e03: monitor dark at 1.2s ($plain3)" >&2; return 1; }
  ab eval "document.querySelector('[data-testid=fx-static-similarity] [role=slider]').focus()" >/dev/null 2>&1
  ab press End >/dev/null 2>&1 && sleeps 0.6
  # End must not leak to transport: the playhead stays at 1.2s.
  if ! between "$(playhead_seconds)" 1.09 1.41; then
    echo "e03: End moved the playhead ($(playhead_seconds))" >&2; return 1
  fi
  # The slider must actually read 1: this separates a lost keypress (test
  # bug) from a committed value that renders wrong (product bug).
  snap | grep -q 'slider "Similarity value".*: 1' || {
    echo "e03: Similarity did not reach max" >&2; return 1; }
  local keyed
  keyed=$(settled_sum "[data-testid=preview-canvas]")
  [ -n "$keyed" ] || { echo "e03: monitor never settled after keying" >&2; return 1; }
  # Keying must remove most of the top layer. No absolute zero: lower lanes
  # show through fully-keyed regions (an image beneath reads as content, not
  # black). Three quarters, not one half: the layer beneath can be nearly as
  # bright as the keyed one, and an ignored key would composite identically.
  awk -v a="${keyed:-0}" -v b="${plain3:-1}" 'BEGIN { exit !(a * 4 < b * 3) }' || {
    # No blind undos here (see above): a leftover inert keyer is harmless to
    # later steps (their pixel proofs are all relative), a corrupted history
    # is not.
    echo "e03: max similarity did not key the picture ($keyed vs $plain3)" >&2; return 1; }
  ab press Control+z >/dev/null; sleeps 0.4
  # Each undo is verified before the next: an unverified undo chain can
  # silently desync (popping a pre-step entry) when a commit never landed.
  snap | grep -q 'slider "Similarity value".*: 0' || {
    echo "e03: first undo did not restore similarity" >&2; return 1; }
  ab press Control+z >/dev/null; sleeps 0.4
  snap | grep -q '#00ff00' || { echo "e03: second undo did not restore the key" >&2; return 1; }
  ab press Control+z >/dev/null; sleeps 0.5
  snap | grep -q 'Pick key color from monitor' && { echo "e03: undo did not remove the keyer" >&2; return 1; }
  return 0
}

e04_matte_masks_and_survives_hide() {
  # Matte source: the Captions text track from c01 sits above V1. Park at
  # 1.2s: inside the matted first video part (0..1.50, end-exclusive, so
  # parking ON 1.50 would show the next, unmatted part) and inside the Alpha
  # cue (1.0..2.0) so the mask has content to read.
  # Pre-flight: the prefix must have left the Captions lane and its cues
  # behind. Without this guard a broken prefix fails here as a matte mystery.
  snap | grep -q 'Hide Captions' || {
    echo "e04: no Captions track (prefix state broken)" >&2
    echo "e04 track census: $(snap | grep -E 'track|Captions|Alpha|Beta|Gamma' | head -30 | tr '\n' '|')" >&2
    headers=$(evaln "Array.from(document.querySelectorAll('[data-testid^=track-header]')).map(e => e.dataset.testid).join(',')")
    echo "e04 DOM headers: $headers" >&2
    echo "e04 DOM cue text: $(evaln 'document.body.innerText.includes("Alpha")')" >&2
    return 1
  }
  snap | grep -q 'Alpha' || { echo "e04: no caption cues (prefix state broken)" >&2; return 1; }
  ab eval "document.activeElement && document.activeElement.blur()" >/dev/null 2>&1
  ab find role button click --name 'Go to start (Home)' >/dev/null && sleeps 0.4
  local i
  step_frames 36 || return 1
  if ! between "$(playhead_seconds)" 1.09 1.41; then
    echo "e04: playhead missed 1.2s ($(playhead_seconds))" >&2; return 1
  fi
  # Parked seeks settle asynchronously: poll for a LIVE frame before
  # sampling, so a slow seek reads as waiting, not as content. The floor is
  # well above an unsettled (near-black) frame and far below the bright video
  # parked here, so neither side passes vacuously.
  local plain
  plain=$(settled_sum "[data-testid=preview-canvas]")
  [ -n "$plain" ] || { echo "e04: monitor never settled at 1.2s" >&2; return 1; }
  [ "${plain:-0}" -gt 1000000 ] 2>/dev/null || { echo "e04: monitor dark at 1.2s ($plain)" >&2; return 1; }
  insp '[aria-label="Add effect"]'
  ab find role button click --name 'Add effect' >/dev/null 2>&1 || {
    echo "e04: Add effect button missing" >&2; return 1; }
  sleeps 0.4
  ab press Escape >/dev/null 2>&1; sleeps 0.2
  local opened=0
  for i in $(seq 1 8); do
    if snap | grep -q 'menuitem "Track matte"'; then
      if ab find role menuitem click --name 'Track matte' >/dev/null 2>&1; then
        opened=1
        break
      fi
    fi
    ab find role button click --name 'Add effect' >/dev/null 2>&1
    sleeps 0.5
  done
  [ "$opened" = "1" ] || { echo "e04: Track matte menu item missing" >&2; return 1; }
  # The submenu opens on hover, which can race shut mid-flight; retry the
  # whole open-hover-select cycle a few times before giving up.
  local attempt selected=0
  for attempt in 1 2 3; do
    # Ensure the main menu is open first (a retried attempt starts closed).
    if ! snap | grep -q 'menuitem "Track matte"'; then
      ab find role button click --name 'Add effect' >/dev/null 2>&1
      sleeps 0.5
    fi
    # Hover the trigger and poll for the source item (a click alone can
    # leave the submenu closed).
    local found=0
    for i in $(seq 1 10); do
      if snap | grep -q 'menuitem "Captions"'; then found=1; break; fi
      mt=$(firstref 'menuitem "Track matte"')
      [ -n "$mt" ] && ab hover "@$mt" >/dev/null 2>&1
      sleep 0.3
    done
    if [ "$found" = "1" ]; then
      # Focus + Enter instead of a click: clicking travels the mouse, which
      # can close the hover-opened submenu mid-flight and land on empty
      # space (the menus then close with no entry and no toast).
      cap=$(firstref 'menuitem "Captions"')
      if [ -n "$cap" ]; then
        ab focus "@$cap" >/dev/null 2>&1 && ab press Enter >/dev/null 2>&1
        sleeps 0.6
      fi
    fi
    if snap | grep -q 'Remove Track matte'; then selected=1; break; fi
    ab press Escape >/dev/null 2>&1; sleeps 0.3
  done
  if [ "$selected" != "1" ]; then
    echo "e04: the matte entry never landed" >&2
    echo "e04 menuitems: $(snap | grep -oE 'menuitem "[^"]+"' | tr '\n' ';')" >&2
    echo "e04 toasts: $(snap | grep -oiE '(refused|unknown|must be)[^\[]*' | tr '\n' ';')" >&2
    echo "e04 clips: $(snap | grep -oE 'button "Clip [^"]+"' | tr '\n' ';')" >&2
    echo "e04 tracks: $(snap | grep -oE '(Hide|Show) [^"]+' | tr '\n' ';')" >&2
    echo "e04 inspector: $(snap | grep -oE '(Remove [A-Za-z ]+|No effects|Shutter angle|Similarity|Source track)' | sort -u | tr '\n' ';')" >&2
    ab press Escape >/dev/null 2>&1
    return 1
  fi
  local masked
  masked=$(settled_sum "[data-testid=preview-canvas]")
  [ -n "$masked" ] || { echo "e04: monitor never settled after matting" >&2; return 1; }
  # The text mask keeps only glyph pixels: far less than the full picture.
  awk -v a="${masked:-0}" -v b="${plain:-1}" 'BEGIN { exit !(a * 2 < b) }' || {
    echo "e04: matte did not mask the picture ($masked vs $plain)" >&2; return 1; }
  # Hiding the source track must NOT lift the mask (visibility affects the
  # main composite only).
  hide=$(firstref 'button "Hide Captions"')
  ab scrollintoview "@$hide" >/dev/null 2>&1; sleeps 0.3
  ab find role button click --name 'Hide Captions' >/dev/null 2>&1 || {
    echo "e04: Captions eyeball missing" >&2; return 1; }
  sleeps 0.6
  local hidden
  hidden=$(settled_sum "[data-testid=preview-canvas]")
  [ -n "$hidden" ] || { echo "e04: monitor never settled while hidden" >&2; return 1; }
  awk -v a="${hidden:-0}" -v b="${plain:-1}" 'BEGIN { exit !(a * 2 < b) }' || {
    echo "e04: hiding the source lifted the mask ($hidden vs $plain)" >&2; return 1; }
  [ "${hidden:-0}" -gt 0 ] 2>/dev/null || {
    echo "e04: hiding the source erased the picture instead of masking ($hidden vs $plain)" >&2; return 1; }
  show=$(firstref 'button "Show Captions"')
  ab scrollintoview "@$show" >/dev/null 2>&1; sleeps 0.3
  ab find role button click --name 'Show Captions' >/dev/null 2>&1 || {
    echo "e04: Show Captions click failed" >&2; return 1; }
  sleeps 0.4
  # The three undos below assume the lane is visible again: stop here,
  # undoing nothing, if the click missed or the lane stayed hidden.
  snap | grep -q 'button "Hide Captions"' || {
    echo "e04: Captions still hidden after Show" >&2; return 1; }
  # Three history entries to unwind: the re-show, the hide, then the matte
  # add itself. After all three the entry is gone and the lane is visible.
  ab press Control+z >/dev/null; sleeps 0.4
  ab press Control+z >/dev/null; sleeps 0.4
  ab press Control+z >/dev/null; sleeps 0.5
  ab press Escape >/dev/null 2>&1; sleeps 0.2
  snap | grep -q 'Remove Track matte' && { echo "e04: undo did not remove the matte" >&2; return 1; }
  return 0
}

e05_blur_accumulates() {
  insp '[aria-label="Add effect"]'
  # The picker menu can miss opening on a single click; poll and reopen.
  local opened=0
  for i in $(seq 1 6); do
    if snap | grep -q 'menuitem "Motion blur"'; then
      opened=1
      break
    fi
    ab find role button click --name 'Add effect' >/dev/null 2>&1
    sleeps 0.5
  done
  [ "$opened" = "1" ] || { echo "e05: Motion blur menu item missing" >&2; return 1; }
  ab find role menuitem click --name 'Motion blur' >/dev/null 2>&1 || {
    echo "e05: Motion blur menu item missing" >&2; return 1; }
  sleeps 0.5
  snap | grep -q 'Shutter angle' || { echo "e05: the blur entry never landed" >&2; return 1; }
  local lit
  lit=$(frame_sum "[data-testid=preview-canvas]")
  [ "${lit:-0}" -gt 0 ] 2>/dev/null || { echo "e05: monitor dark with blur" >&2; return 1; }
  ab press Control+z >/dev/null; sleeps 0.5
  snap | grep -q 'Shutter angle' && { echo "e05: undo did not remove the blur" >&2; return 1; }
  return 0
}

# Best-effort return to the e05 end state. Returns 0 only when the export
# dialog is gone and the blur entry is gone; anything else aborts the run
# via the caller (a failed step must never hand dirty state downstream).
e06_cleanup() {
  if snap | grep -q 'Export video'; then
    ab find role button click --name 'Cancel' >/dev/null 2>&1
    sleeps 1
    ab find role button click --name 'Close' >/dev/null 2>&1 && sleeps 0.5
  fi
  snap | grep -q 'Export video' && {
    echo "e06: cleanup could not close the dialog" >&2; return 1; }
  if snap | grep -q 'Shutter angle'; then
    ab press Control+z >/dev/null; sleeps 0.5
    snap | grep -q 'Shutter angle' && {
      echo "e06: cleanup could not remove the blur" >&2; return 1; }
  fi
  return 0
}

e06_effects_export() {
  # Precondition: start clean. e05 does not restore on every failure path,
  # so stacking onto a dirty timeline would desync the undo below. A dirty
  # timeline records FAIL and lets the run continue: later steps may
  # cascade-fail honestly on the dirty state, but the verdict still goes
  # red and no step is hidden. A hard exit here turned one effects flake
  # into an INCOMPLETE run that proved nothing about the remaining steps.
  select_named 'sample-video' || { echo "e06: video clip not found" >&2; return 1; }
  ab eval 'document.querySelector("[data-testid=inspector-tab-effects]").click()' >/dev/null 2>&1
  sleeps 0.4
  # The empty-state paragraph has no ARIA role, so `snap` omits it: read
  # the DOM section directly (a missing section also fails into the abort).
  [ "$(evaln 'document.querySelector("[data-testid=applied-effects]")?.innerText.includes("No effects")')" = "true" ] || {
    echo "e06: effects already present (dirty timeline)" >&2; return 1; }
  insp '[aria-label="Add effect"]'
  # The picker menu can miss opening on a single click; poll and reopen.
  local opened=0
  for i in $(seq 1 6); do
    if snap | grep -q 'menuitem "Motion blur"'; then
      opened=1
      break
    fi
    ab find role button click --name 'Add effect' >/dev/null 2>&1
    sleeps 0.5
  done
  [ "$opened" = "1" ] || { echo "e06: Motion blur menu item missing" >&2; return 1; }
  ab find role menuitem click --name 'Motion blur' >/dev/null 2>&1 || {
    echo "e06: Motion blur menu item missing" >&2; return 1; }
  sleeps 0.5
  snap | grep -q 'Shutter angle' || {
    echo "e06: the blur entry never landed" >&2
    e06_cleanup || true  # failure already messaged; the step records FAIL below
    return 1
  }
  ab find role button click --name 'Export' >/dev/null && sleep 0.8
  ab find role button click --name 'Start export' >/dev/null && sleep 1
  # Local completion poll (export_done is local to f07_export): the
  # completion toast lives ~1s, so accept the persistent result view too.
  # Elapsed-time deadline (not a count): the deadline is approximate (whole-
  # second SECONDS plus blocking calls), overshoot bounded by one poll
  # period plus one eval.
  local poll_s=120 done=0
  local deadline=$((SECONDS + poll_s))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ "$(evaln 'document.body.innerText.includes("Export complete") || !!document.querySelector("[data-testid=export-result-video]")')" = "true" ]; then
      done=1
      break
    fi
    sleep 0.25
  done
  if [ "$done" != "1" ]; then
    echo "e06: no export-complete signal within ${poll_s}s" >&2
    e06_cleanup || true  # failure already messaged; the step records FAIL below
    return 1
  fi
  local rgb r
  rgb=$(export_rgb_sums)
  r=${rgb%% *}
  [ -n "$r" ] && [ "$r" -gt 0 ] 2>/dev/null || {
    echo "e06: exported frame is empty ($rgb)" >&2
    e06_cleanup || true  # failure already messaged; the step records FAIL below
    return 1
  }
  ab find role button click --name 'Close' >/dev/null 2>&1 && sleeps 0.5
  snap | grep -q 'Export video' && {
    echo "e06: export dialog did not close" >&2
    e06_cleanup || true  # failure already messaged; the step records FAIL below
    return 1
  }
  ab press Control+z >/dev/null; sleeps 0.5
  snap | grep -q 'Shutter angle' && {
    echo "e06: undo did not remove the blur" >&2
    e06_cleanup || true  # failure already messaged; the step records FAIL below
    return 1
  }
  return 0
}

# ————— F5 audio —————
f05_mute() {
  click_clip 'sample-audio' || { echo "f05: audio clip not found" >&2; return 1; }
  insp '[role=switch][aria-label="Mute clip"]'
  ab find role switch click --name 'Mute clip' >/dev/null 2>&1 || {
    echo "f05: mute switch missing, inspector switches: $(snap | grep -c switch)" >&2
    return 1
  }
  sleeps 0.4
  snap | grep -q '"Mute clip" \[checked=true' || return 1

  # Noise reduction toggle (0.6.0): the switch lives in the Effect Controls
  # tab's AudioShaping section (the Clip tab only has gain/mute), so switch tabs
  # first. Off for an untouched clip, and the checked state flips when clicked
  # (and flips back, so the export later in the battery runs with denoise OFF).
  # `ab find role tab` resolves the tab but its click does not flip the state
  # (verified in a live session); the eval-click on the testid works.
  ab eval 'document.querySelector("[data-testid=inspector-tab-effects]").click()' >/dev/null 2>&1
  sleeps 0.4
  insp '[role=switch][aria-label="Reduce noise"]'
  snap | grep -q '"Reduce noise" \[checked=false' || {
    echo "f05: Reduce noise switch missing or not unchecked initially" >&2
    return 1
  }
  ab find role switch click --name 'Reduce noise' >/dev/null 2>&1 && sleeps 0.4
  snap | grep -q '"Reduce noise" \[checked=true' || {
    echo "f05: Reduce noise did not switch on" >&2
    return 1
  }
  ab find role switch click --name 'Reduce noise' >/dev/null 2>&1 && sleeps 0.4
  snap | grep -q '"Reduce noise" \[checked=false' || {
    echo "f05: Reduce noise did not switch back off" >&2
    return 1
  }
}
# ————— F5 blend parity (0.7.0) —————
# A parked monitor must equal the export plan's blend, frame by frame. The step
# rides the real plan (dumped from export/offline.ts) and builds its own
# reference IN the page: a second <video> decodes the pair the plan names for
# each output frame, composites it the way drawBlendedContain does (black base,
# additive layers at 1-w / w, one blit to the dest rect), and its stride-40 sum
# is compared with the monitor canvas. The clip is set to 0.25x, so one output
# frame reads a quarter of a source frame and the plan asks for a blend every
# fourth output frame, which is exactly a source frame boundary: the case an
# element seek can resolve to the previous frame.
f05_blend_parity() {
  local root; root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  click_clip 'sample-video.mp4 from 0.00 to 6.00 seconds' || {
    echo "f05_blend_parity: the video clip did not select" >&2
    return 1
  }
  ab eval 'document.querySelector("[data-testid=inspector-tab-effects]").click()' >/dev/null 2>&1
  sleeps 0.5
  insp '[data-testid=speed-section] [role=slider]'
  ab eval '(() => { const t = document.querySelector("[data-testid=speed-section] [role=slider]"); if (t) t.focus(); })()' >/dev/null 2>&1
  ab press Home >/dev/null 2>&1 && sleeps 0.6 # the speed slider's minimum is 0.25x

  # Every exit past the speed edit undoes the edit, so later steps see the
  # timeline they left behind; a restore that cannot confirm the undo is
  # reported and still fails the step. When the edit never landed (the slider
  # still reads 1, or its read broke) no undo fires: an undo there could
  # revert the PREVIOUS step's action instead.
  f05_blend_parity_restore() {
    local msg=$1 now
    echo "$msg" >&2
    now=$(evaln 'document.querySelector("[data-testid=speed-section] [role=slider]").getAttribute("aria-valuenow")')
    case "$now" in
      1 | '') return 1 ;;
    esac
    ab press Control+z >/dev/null 2>&1 && sleeps 0.6
    now=$(evaln 'document.querySelector("[data-testid=speed-section] [role=slider]").getAttribute("aria-valuenow")')
    [ "$now" = "1" ] || echo "f05_blend_parity: the restore undo left the speed at $now" >&2
    return 1
  }
  local speed
  speed=$(evaln 'document.querySelector("[data-testid=speed-section] [role=slider]").getAttribute("aria-valuenow")')
  [ "$speed" = "0.25" ] || {
    f05_blend_parity_restore "f05_blend_parity: speed slider is $speed, expected 0.25"
    return 1
  }

  # The plan for the 12 output frames the sweep covers (sourceTime + blendTime).
  local plan
  plan=$(bun -e "
import { planVideoFrame } from '$root/src/lib/editor/export/offline.ts'
import { createClip, createTrack } from '$root/src/lib/editor/factories.ts'
const asset = { id: 'm1', name: 'sample-video.mp4', kind: 'video', duration: 6, width: 640, height: 360, url: 'x' }
const clip = createClip({ id: 'cv', mediaId: 'm1', start: 0, duration: 6, inPoint: 0, speed: 0.25 })
const doc = { project: { id: 'p', name: 'n', width: 1920, height: 1080, fps: 30, tracks: [createTrack('video', 1, { id: 't0', clips: [clip] })] }, media: [asset] }
const rows = []
for (let k = 0; k <= 11; k++) { const d = planVideoFrame(doc, k / 30).draws[0]; rows.push(k + ' ' + d.sourceTime + ' ' + d.blendTime) }
console.log(rows.join('\n'))
" 2>/dev/null)
  [ -n "$plan" ] || {
    f05_blend_parity_restore "f05_blend_parity: could not dump the export plan"
    return 1
  }

  # In-page reference decoder. `probe` must see real pixels and `ladder` must
  # confirm the 30 fps frame ladder the reference derives frames from: a seek
  # inside a frame's window shows that frame, and the next frame differs.
  local ref
  ref=$(cat <<'REFJS'
window.__bpar = (() => {
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'auto'
  v.playsInline = true
  v.src = '/samples/sample-video.mp4'
  v.style.position = 'fixed'
  v.style.left = '-10000px'
  v.style.width = '640px'
  v.style.height = '360px'
  document.body.appendChild(v)
  const preview = document.querySelector('[data-testid=preview-canvas]')
  const W = preview.width
  const H = preview.height
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  const fit = Math.min(W / 640, H / 360)
  const dw = 640 * fit
  const dh = 360 * fit
  const dx = (W - dw) / 2
  const dy = (H - dh) / 2
  const rw = Math.max(1, Math.round(dw))
  const rh = Math.max(1, Math.round(dh))
  const scratch = document.createElement('canvas')
  scratch.width = rw
  scratch.height = rh
  const sctx = scratch.getContext('2d')
  const sum = () => {
    const d = ctx.getImageData(0, 0, W, H).data
    let s = 0
    for (let i = 0; i < d.length; i += 40) s += d[i] + d[i + 1] + d[i + 2]
    return s
  }
  const ready = new Promise((res) => {
    if (v.readyState >= 2) return res()
    const done = () => res()
    v.addEventListener('loadeddata', done, { once: true })
    v.addEventListener('canplay', done, { once: true })
    setTimeout(done, 8000)
  })
  // `seeked` alone can fire before the new frame is painted, so the wait
  // continues into a presented-frame callback.
  const presented = async (t) => {
    await ready
    await new Promise((res) => {
      const h = () => { v.removeEventListener('seeked', h); res() }
      v.addEventListener('seeked', h, { once: true })
      v.currentTime = t
      setTimeout(res, 4000)
    })
    await new Promise((res) => {
      if (typeof v.requestVideoFrameCallback !== 'function') return setTimeout(res, 60)
      let done = false
      const id = v.requestVideoFrameCallback(() => { done = true; res() })
      setTimeout(() => { if (!done) { try { v.cancelVideoFrameCallback(id) } catch (e) {} ; res() } }, 600)
    })
  }
  const black = (c, w, h) => {
    c.globalCompositeOperation = 'source-over'
    c.globalAlpha = 1
    c.fillStyle = '#000000'
    c.fillRect(0, 0, w, h)
  }
  // The sample is 30 fps CFR with PTS 0, 1/30, 2/30, ...: the frame a read lands
  // in is floor(t * 30), the timestamp the exporter's decoder reports. The park
  // sits a hair inside the frame so a boundary seek cannot show the frame before.
  const frameAt = (i) => i / 30 + 0.0001
  const drawOne = async (i) => {
    black(ctx, W, H)
    await presented(frameAt(i))
    ctx.globalAlpha = 1
    ctx.drawImage(v, dx, dy, dw, dh)
  }
  const drawPair = async (ia, ib, w) => {
    black(sctx, rw, rh)
    sctx.globalCompositeOperation = 'lighter'
    await presented(frameAt(ia))
    sctx.globalAlpha = 1 - w
    sctx.drawImage(v, 0, 0, rw, rh)
    await presented(frameAt(ib))
    sctx.globalAlpha = w
    sctx.drawImage(v, 0, 0, rw, rh)
    black(ctx, W, H)
    ctx.globalAlpha = 1
    ctx.drawImage(scratch, dx, dy, dw, dh)
  }
  const probe = async () => {
    await drawOne(0)
    return String(sum())
  }
  const ladder = async () => {
    const ok = []
    for (let i = 0; i <= 3; i++) {
      await drawOne(i)
      const at = sum()
      await drawOne(i + 1)
      ok.push(at > 0 && at !== sum())
    }
    return ok.every(Boolean) ? 'ok' : 'bad'
  }
  // The plan's pair for one output frame, composited the way the exporter does.
  // Returns `expectedSum|weight|firstFrame|secondFrame` so the shell needs no
  // JSON parser.
  const parity = async (sourceTime, blendTime) => {
    const ia = Math.max(0, Math.floor(sourceTime * 30 + 1e-6))
    const ib = Math.max(0, Math.floor(blendTime * 30 + 1e-6))
    const aTs = ia / 30
    const bTs = ib / 30
    let w = 0
    if (bTs > aTs) w = Math.min(1, Math.max(0, (sourceTime - aTs) / (bTs - aTs)))
    if (w > 0 && w < 1) await drawPair(ia, ib, w)
    else await drawOne(ia)
    return sum() + '|' + w.toFixed(4) + '|' + ia + '|' + ib
  }
  return { probe, ladder, parity }
})()
'ready'
REFJS
)
  ab eval "$ref" >/dev/null 2>&1

  local probe; probe=$(evaln 'window.__bpar.probe()')
  case "$probe" in
    '' | 0 | *[!0-9]*)
      f05_blend_parity_restore "f05_blend_parity: the reference decoder produced no pixels ($probe)"
      return 1
      ;;
  esac
  local ladder; ladder=$(evaln 'window.__bpar.ladder()')
  [ "$ladder" = "ok" ] || {
    f05_blend_parity_restore "f05_blend_parity: the 30fps frame ladder did not validate ($ladder)"
    return 1
  }

  # Park on every output frame, sample the monitor, compare with the plan.
  local k src blend expected weight ia ib preview info
  local matched=0 blended=0 frames=0
  while read -r k src blend; do
    [ -n "$k" ] || continue
    ab find role button click --name 'Go to start (Home)' >/dev/null 2>&1 && sleeps 0.35
    local j=0
    while [ "$j" -lt "$k" ]; do
      ab press ArrowRight >/dev/null 2>&1
      sleeps 0.12
      j=$((j + 1))
    done
    sleeps 0.9
    preview=$(frame_sum "[data-testid=preview-canvas]")
    info=$(evaln "window.__bpar.parity($src, $blend)")
    IFS='|' read -r expected weight ia ib <<<"$info"
    [ -n "$expected" ] || {
      f05_blend_parity_restore "f05_blend_parity: no reference for k=$k"
      return 1
    }
    frames=$((frames + 1))
    case "$weight" in
      0.0000 | 1.0000) : ;;
      *) blended=$((blended + 1)) ;;
    esac
    if [ "$preview" = "$expected" ]; then
      matched=$((matched + 1))
    else
      echo "f05_blend_parity: k=$k monitor $preview != plan $expected (weight $weight, source frames $ia/$ib)" >&2
    fi
  done <<<"$plan"

  # A sweep that never blends could not tell a blend from a held frame.
  if [ "$blended" -lt 3 ]; then
    f05_blend_parity_restore "f05_blend_parity: only $blended of $frames frames blend, no discriminating power"
    return 1
  fi
  [ "$matched" = "$frames" ] || {
    f05_blend_parity_restore "f05_blend_parity: $matched of $frames frames matched the export plan"
    return 1
  }

  # Restore the clip: one undo returns the speed edit, so later steps see the
  # timeline they left behind.
  ab press Control+z >/dev/null 2>&1 && sleeps 0.6
  speed=$(evaln 'document.querySelector("[data-testid=speed-section] [role=slider]").getAttribute("aria-valuenow")')
  [ "$speed" = "1" ] || { echo "f05_blend_parity: undo left the speed at $speed" >&2; return 1; }
  return 0
}

f05_gain() {
  # f05_mute switched the Inspector to its Effect Controls tab to reach the
  # denoise switch, and the tab is component state: it persists across steps and
  # selections. Without switching back, the FIRST role=slider in the Inspector
  # is the Effect Controls Volume row, so the Clip-tab Gain slider this step is
  # named for was never exercised (the assertion still passed, since Volume also
  # tops out at 200%). f07_export switches back for the same reason.
  ab eval 'document.querySelector("[data-testid=inspector-tab-clip]").click()' >/dev/null 2>&1
  sleeps 0.4
  insp '[role=slider]'
  # Target by role+name. Radix reads a thumb's accessible name from the THUMB's
  # own props, and shadcn's Slider spread the caller's `aria-label` onto the
  # root, where it named nothing: the snapshot showed the slider unnamed, so this
  # used to walk in by CSS. The shared slider now forwards the label to the
  # thumb, which makes this step the regression proof for the naming fix.
  ab find role slider click --name 'Clip gain percent' >/dev/null 2>&1 || return 1
  ab press End >/dev/null 2>&1 && sleeps 0.4
  [ "$(evaln 'document.querySelector("aside[aria-label=Inspector]").innerText.includes("200%")')" = "true" ]
}

# ----- F5 reverse + time remapping (the picture-only rows) -----
# The reversed branch had NO battery coverage: the mirrored row axis (value,
# dots, and the keyframe the easing picker and the diamond target) plus the
# reverse switch were pinned by jsdom tests only. This walks the real UI: both
# picture-only rows are offered on a video clip, Reverse lights the timeline
# badge, a seeded curve turns the static Speed slider off, and the diamond
# clears the curve again. A one-keyframe curve cannot tell the mirrored axis
# from the plain one (the axis is its own inverse), so the numeric
# discrimination stays in the render tests; what this proves is the whole path
# in a real browser. The clip is left exactly as it was found.
f05_reverse() {
  click_clip 'sample-video' || { echo "f05_reverse: video clip not found" >&2; return 1; }
  ab eval 'document.querySelector("[data-testid=inspector-tab-effects]").click()' >/dev/null 2>&1
  sleeps 0.4
  insp '[data-testid=prop-timeScale]'
  [ "$(evaln 'document.querySelectorAll("[data-testid=prop-timeScale]").length')" = "1" ] || {
    echo "f05_reverse: the time-remap row is missing on a video clip" >&2
    return 1
  }
  insp '[role=switch][aria-label="Reverse clip"]'
  ab find role switch click --name 'Reverse clip' >/dev/null 2>&1 || {
    echo "f05_reverse: the reverse switch is missing on a video clip" >&2
    return 1
  }
  sleeps 0.5
  [ "$(evaln 'document.querySelectorAll("[data-testid=clip-reverse-badge]").length')" = "1" ] || {
    echo "f05_reverse: the reverse badge did not appear for the reversed clip" >&2
    return 1
  }

  # Seeding the curve (the diamond) must draw the graph and take the rate away
  # from the static speed slider, which is the cue that the ramp is live.
  ab eval 'document.querySelector("[data-testid=kf-toggle-timeScale]").click()' >/dev/null 2>&1
  sleeps 0.4
  [ "$(evaln 'document.querySelectorAll("[data-testid=kf-graph-timeScale]").length')" = "1" ] || {
    echo "f05_reverse: seeding the time-remap curve drew no graph" >&2
    return 1
  }
  [ "$(evaln 'document.querySelector("[data-testid=speed-section] [role=slider]").hasAttribute("data-disabled")')" = "true" ] || {
    echo "f05_reverse: the static speed slider stayed live under a curve" >&2
    return 1
  }

  # Clearing it again exercises the removal path on a reversed clip, then the
  # clip goes back to the state the later steps expect.
  ab eval 'document.querySelector("[data-testid=kf-toggle-timeScale]").click()' >/dev/null 2>&1
  sleeps 0.4
  [ "$(evaln 'document.querySelectorAll("[data-testid=kf-graph-timeScale]").length')" = "0" ] || {
    echo "f05_reverse: the diamond did not clear the curve" >&2
    return 1
  }
  ab find role switch click --name 'Reverse clip' >/dev/null 2>&1
  sleeps 0.5
  [ "$(evaln 'document.querySelectorAll("[data-testid=clip-reverse-badge]").length')" = "0" ]
}

# ----- F5 reversed-clip trim, proved in pixels -----
# The reversed-edge trim contract (the tail's low anchor keeps every retained
# local frame on the source frame it showed) is unit-locked in commands.test.ts,
# clip-gesture.test.ts and the pointer-drag render tests; this is the browser
# proof that the contract survives to the composited picture. Rides on
# f02_trim's exact result: the first video part sits at 0.00..1.50. Park at
# 0.60s, sample the monitor, drag the tail LEFT a fixed 40px (0.5s at the
# battery's zoom: two zoom-outs halve 80 px/s to 20), re-park on the same
# timeline time and sample again. Keeping a local frame must keep the frame:
# the parked local 0.6 read source 1.5 - 0.6 = 0.9 before and reads
# inPoint 0.5 + (1.0 - 0.6) = 0.9 after (a reversed tail shows the LOW source
# end), while the pre-fix pinning read 0.4, a different frame.
f05_reverse_frame() {
  local part; part=$(firstref 'button "Clip sample-video.mp4 from 0.00 to 1.50 seconds"')
  [ -n "$part" ] || { echo "f05_reverse_frame: the 1.50s video part is missing" >&2; return 1; }
  ab scrollintoview "@$part" >/dev/null 2>&1 && sleeps 0.2
  ab click "@$part" >/dev/null 2>&1 && sleeps 0.4
  [ "$(ring_count)" -ge 1 ] || { echo "f05_reverse_frame: the video part did not select" >&2; return 1; }

  # Reverse it. The switch lives in the Effect Controls tab (next to Speed and
  # Time remapping), which is component state left by an earlier step, so click
  # the tab explicitly to make sure it is mounted.
  ab eval 'document.querySelector("[data-testid=inspector-tab-effects]").click()' >/dev/null 2>&1
  sleeps 0.4
  insp '[role=switch][aria-label="Reverse clip"]'
  ab find role switch click --name 'Reverse clip' >/dev/null 2>&1 || {
    echo "f05_reverse_frame: the reverse switch is missing" >&2
    return 1
  }
  sleeps 0.5
  [ "$(evaln 'document.querySelectorAll("[data-testid=clip-reverse-badge]").length')" = "1" ] || {
    echo "f05_reverse_frame: the reverse badge did not appear" >&2
    return 1
  }

  # Park on the timeline frame at 0.60s and sample the monitor.
  local before
  ab find role button click --name 'Go to start (Home)' >/dev/null 2>&1 && sleeps 0.4
  step_frames 18 || return 1 # 18 frames = 0.60s, in-page with delivery lock
  sleeps 0.6
  before=$(frame_sum "[data-testid=preview-canvas]")
  [ "${before:-0}" -gt 0 ] 2>/dev/null || {
    echo "f05_reverse_frame: could not sample the monitor (before)" >&2
    return 1
  }

  # Drag the tail LEFT by exactly 40px: duration 1.50 -> 1.00s, inPoint 0 -> 0.5.
  # The handle is an 8px-wide edge strip, invisible until hover, so it is found
  # by geometry and dragged by raw coordinates (the f10 marker-drag pattern).
  local handle xy x y
  handle=$(evaln '(() => {
    const c = [...document.querySelectorAll("[aria-label=\"Trim clip end\"]")]
      .find((h) => h.closest("[data-testid^=clip-]")?.getAttribute("aria-label")?.includes("0.00 to 1.50"));
    if (!c) return "none";
    const r = c.getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)].join(",");
  })()')
  [ "$handle" != "none" ] || { echo "f05_reverse_frame: the trim-end handle is missing" >&2; return 1; }
  IFS=',' read -r x y <<<"$handle"
  ab mouse move "$x" "$y" >/dev/null 2>&1
  ab mouse down >/dev/null 2>&1
  ab mouse move "$((x - 20))" "$y" >/dev/null 2>&1
  ab mouse move "$((x - 40))" "$y" >/dev/null 2>&1
  sleeps 0.2
  ab mouse up >/dev/null 2>&1
  sleeps 0.6
  snap | grep -Eq 'Clip sample-video.mp4 from 0.00 to 1.00 seconds' || {
    echo "f05_reverse_frame: the tail drag did not cut 1.50 to 1.00" >&2
    return 1
  }

  # Re-park on the SAME timeline time (0.60s is inside the kept span) and sample
  # again: keeping a local frame must keep the source frame it showed.
  ab find role button click --name 'Go to start (Home)' >/dev/null 2>&1 && sleeps 0.4
  step_frames 18 || return 1 # 18 frames = 0.60s, in-page with delivery lock
  sleeps 0.6
  local after
  after=$(frame_sum "[data-testid=preview-canvas]")
  [ "${after:-0}" -gt 0 ] 2>/dev/null || {
    echo "f05_reverse_frame: could not resample the monitor (after)" >&2
    return 1
  }
  [ "$before" = "$after" ] || {
    echo "f05_reverse_frame: the kept frame moved under the trim (before=$before after=$after)" >&2
    return 1
  }
  true
}

# ----- F5 keyframe curve editing, proved in a real browser -----
# The curve, the handles, the active-quad attribute and the easing defaults
# are locked in jsdom (effect-controls-ui.render.test.tsx); this walks the
# whole chain on real elements: seed a keyframe with the diamond, write a
# SECOND one with the opacity slider (two keyframes are what make a segment,
# and only a segment has handles), press a preset while the playhead sits on
# the segment's start keyframe, arrow-nudge the outgoing handle, drag the
# incoming one with a real pointer, then presses `Ease out` so the outgoing
# handle sits EXACTLY on the first dot and drags THAT DOT with real mouse input
# (the one hit-test the overlay could steal, and the only one jsdom cannot see),
# and finally undoes every commit so the clip goes
# back exactly as the later steps expect it. Rides on f05_reverse_frame's
# exact result: the first video part sits at 0.00..1.00, so a keyframe at the
# clip start plus one on the slider make a segment inside the clip.
f05b_curve_handles() {
  local part; part=$(firstref 'button "Clip sample-video.mp4 from 0.00 to 1.00 seconds"')
  [ -n "$part" ] || { echo "f05b: the 1.00s video part is missing" >&2; return 1; }
  ab scrollintoview "@$part" >/dev/null 2>&1 && sleeps 0.2
  ab click "@$part" >/dev/null 2>&1 && sleeps 0.4
  [ "$(ring_count)" -ge 1 ] || { echo "f05b: the video part did not select" >&2; return 1; }

  # The tab is component state an earlier step may have left on the Clip tab,
  # so click Effect Controls explicitly.
  ab eval 'document.querySelector("[data-testid=inspector-tab-effects]").click()' >/dev/null 2>&1
  sleeps 0.4
  insp '[data-testid=prop-opacity]'
  [ "$(evaln 'document.querySelectorAll("[data-testid=prop-opacity]").length')" = "1" ] || {
    echo "f05b: the opacity row is missing on a video clip" >&2
    return 1
  }

  # Seed the first keyframe at the clip start, then park the playhead later
  # and step the opacity slider: an animated property writes a keyframe at
  # the playhead, and a keyboard step on the slider commits immediately
  # (Radix semantics), so the second keyframe is one undo entry like the seed.
  ab find role button click --name 'Go to start (Home)' >/dev/null 2>&1 && sleeps 0.4
  ab eval 'document.querySelector("[data-testid=kf-toggle-opacity]").click()' >/dev/null 2>&1
  sleeps 0.4
  [ "$(evaln 'document.querySelector("[data-testid=kf-toggle-opacity]").getAttribute("data-active")')" = "true" ] || {
    echo "f05b: the diamond did not seed an opacity keyframe" >&2
    return 1
  }
  step_frames 15 || return 1 # 15 frames = 0.50s, in-page with delivery lock
  sleeps 0.4
  ab find role slider click --name 'Opacity value' >/dev/null 2>&1 || {
    echo "f05b: the opacity slider is missing" >&2
    return 1
  }
  ab press ArrowLeft >/dev/null 2>&1 && sleeps 0.4
  [ "$(evaln 'document.querySelectorAll("[data-testid=kf-dot-opacity-1]").length')" = "1" ] || {
    echo "f05b: the slider step did not write a second keyframe" >&2
    return 1
  }
  # One keyframe has no segment, so no handles: this is the cue the pair landed.
  [ "$(evaln 'document.querySelectorAll("[data-testid=kf-handle-opacity-out], [data-testid=kf-handle-opacity-in]").length')" = "2" ] || {
    echo "f05b: a two-keyframe segment drew no handles" >&2
    return 1
  }

  # The curve SVG must be exactly the row's box. It is a replaced element with a
  # square viewBox, so it sizes itself from the 1:1 intrinsic ratio whenever a
  # side is left to `auto`: `inset-0` alone makes the box as tall as the row is
  # WIDE and a height alone makes it as narrow as the row is tall. Either way the
  # viewBox stretches with the box and the drawn curve stops meeting the
  # percent-placed dots. jsdom cannot see layout, so this is the only lock on the
  # two boxes agreeing.
  local geom svgW svgH rowW rowH
  geom=$(evaln '(() => {
    const s = document.querySelector("[data-testid=kf-curve-opacity]");
    const g = document.querySelector("[data-testid=kf-graph-opacity]");
    if (!s || !g) return "missing";
    const r = s.getBoundingClientRect();
    return `${r.width.toFixed(2)} ${r.height.toFixed(2)} ${g.clientWidth} ${g.clientHeight}`;
  })()')
  svgW=''; svgH=''; rowW=''; rowH=''
  read -r svgW svgH rowW rowH <<<"$geom"
  awk -v sw="$svgW" -v sh="$svgH" -v rw="$rowW" -v rh="$rowH" 'BEGIN {
    exit !(rw > 10 && rh > 10 && sw > rw - 1 && sw < rw + 1 && sh > rh - 1 && sh < rh + 1)
  }' || {
    echo "f05b: the curve SVG is ${svgW}x${svgH} against a ${rowW}x${rowH} row (the curve is stretched)" >&2
    return 1
  }

  # Park ON the seed keyframe before pressing a preset: the picker edits the
  # active segment's start keyframe, exactly what the handles edit, so both
  # targets agree deterministically here. The picker is always mounted, one per
  # row, so click the row's own button by testid rather than a name several
  # rows share.
  ab find role button click --name 'Go to start (Home)' >/dev/null 2>&1 && sleeps 0.4
  ab eval 'document.querySelector("[data-testid=kf-ease-opacity-easeInOut]").click()' >/dev/null 2>&1
  sleeps 0.4
  local quad
  quad=$(evaln 'document.querySelector("[data-testid=kf-graph-opacity]").getAttribute("data-active-quad")')
  [ "$quad" = "0.420,0.000,0.580,1.000" ] || {
    echo "f05b: the ease-in/out preset did not land on the segment (quad=$quad)" >&2
    return 1
  }

  # Arrow-nudge the outgoing handle twice: y climbs 0.02 per press, and the
  # write normalizes the name to linear (a hand-made shape matches no preset),
  # so no button may read pressed afterwards.
  ab eval 'document.querySelector("[data-testid=kf-handle-opacity-out]").focus()' >/dev/null 2>&1
  ab press ArrowUp >/dev/null 2>&1 && sleeps 0.3
  ab press ArrowUp >/dev/null 2>&1 && sleeps 0.4
  quad=$(evaln 'document.querySelector("[data-testid=kf-graph-opacity]").getAttribute("data-active-quad")')
  [ "$quad" = "0.420,0.040,0.580,1.000" ] || {
    echo "f05b: the arrow nudge did not move the outgoing handle (quad=$quad)" >&2
    return 1
  }
  [ "$(evaln '[...document.querySelectorAll("[data-testid^=kf-ease-opacity-]")].filter((b) => b.getAttribute("aria-pressed") === "true").length')" = "0" ] || {
    echo "f05b: a preset still reads pressed after the keyboard edit" >&2
    return 1
  }

  # A real pointer drag on the incoming handle. The pointerdown goes to the
  # element (the React handler begins the transient); the moves and the up go
  # to the gesture's own window listeners, which attach on the render that
  # follows the press, so the press is its own eval and then we wait. Same
  # protocol as the dot drag and the rate-stretch step.
  local started
  started=$(evaln '(() => {
    const h = document.querySelector("[data-testid=kf-handle-opacity-in]");
    if (!h) return "missing";
    const r = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent("pointerdown", {
      pointerId: 11, pointerType: "mouse", isPrimary: true, bubbles: true,
      cancelable: true, composed: true, button: 0, buttons: 1,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    return "ok";
  })()')
  [ "$started" = "ok" ] || { echo "f05b: could not start the handle drag ($started)" >&2; return 1; }
  sleeps 0.4
  # The drag writes the quad in the segment's own BOX, so the expected x
  # delta is the strip move divided by the segment's share of the strip (a
  # full-width segment would hide a strip-normalized read; this one spans
  # half of it, so the two differ by 2x). The segment path's first and last
  # x are its box ends in strip percent; both are read before the moves.
  local dragged
  dragged=$(evaln '(() => {
    const h = document.querySelector("[data-testid=kf-handle-opacity-in]");
    const w = document.querySelector("[data-testid=kf-graph-opacity]");
    const seg = document.querySelector("[data-testid^=kf-seg-opacity-]");
    if (!h || !w || !seg) return "missing";
    const hr = h.getBoundingClientRect();
    const wr = w.getBoundingClientRect();
    const d = seg.getAttribute("d") || "";
    const nums = d.match(/-?\d+(?:\.\d+)?/g) || [];
    const spanPct = nums.length >= 4 ? Number(nums[nums.length - 2]) - Number(nums[0]) : 0;
    if (!(spanPct > 0.01)) return "no-span";
    const x = hr.left + hr.width / 2;
    const y = hr.top + hr.height / 2;
    const dx = Math.round(wr.width * 0.1);
    const dy = Math.round(wr.height * 0.5);
    const expected = (dx / wr.width) * 100 / spanPct;
    const ev = (type, cx, cy, buttons) => new PointerEvent(type, {
      pointerId: 11, pointerType: "mouse", isPrimary: true, bubbles: true,
      cancelable: true, composed: true, button: 0, buttons,
      clientX: cx, clientY: cy,
    });
    window.dispatchEvent(ev("pointermove", x + dx, y + dy, 1));
    window.dispatchEvent(ev("pointermove", x + dx, y + dy, 1));
    window.dispatchEvent(ev("pointerup", x + dx, y + dy, 0));
    return "ok " + expected.toFixed(4);
  })()')
  local dragStatus dragExpected
  read -r dragStatus dragExpected <<<"$dragged"
  [ "$dragStatus" = "ok" ] || { echo "f05b: could not dispatch the handle drag ($dragged)" >&2; return 1; }
  sleeps 0.5

  # The drag must move the INCOMING pair only, by the BOX delta it should: a
  # strip-normalized x read would move this one by half the expected amount
  # and would still clear a mere "> 0.02" check.
  local after
  after=$(evaln 'document.querySelector("[data-testid=kf-graph-opacity]").getAttribute("data-active-quad")')
  awk -v before="$quad" -v now="$after" -v want="$dragExpected" 'BEGIN {
    split(before, b, ","); split(now, n, ",");
    ok = (n[1] > b[1] - 0.011 && n[1] < b[1] + 0.011) &&
         (n[2] > b[2] - 0.011 && n[2] < b[2] + 0.011) &&
         (n[3] > b[3] + want - 0.05 && n[3] < b[3] + want + 0.05);
    exit !ok;
  }' || {
    echo "f05b: the drag did not write the box delta (before=$quad after=$after want=$dragExpected)" >&2
    return 1
  }

  # The corner lock: `Ease out`'s first control point IS the pair's start point,
  # so the outgoing handle sits exactly on dot 0. A real pointer press there must
  # reach the DOT (the overlay is pointer-events-none and the dot paints above
  # the handle), and a drag must move the dot's TIME while the quad stays put.
  # Only real input is hit-tested: `fireEvent` bypasses hit-testing and jsdom has
  # no layout, which is why this lives here and not in a render test.
  ab find role button click --name 'Go to start (Home)' >/dev/null 2>&1 && sleeps 0.4
  ab eval 'document.querySelector("[data-testid=kf-ease-opacity-easeOut]").click()' >/dev/null 2>&1
  sleeps 0.4
  quad=$(evaln 'document.querySelector("[data-testid=kf-graph-opacity]").getAttribute("data-active-quad")')
  [ "$quad" = "0.000,0.000,0.580,1.000" ] || {
    echo "f05b: the ease-out preset did not land on the segment (quad=$quad)" >&2
    return 1
  }
  local corner
  corner=$(evaln '(() => {
    const dot = document.querySelector("[data-testid=kf-dot-opacity-0]");
    const handle = document.querySelector("[data-testid=kf-handle-opacity-out]");
    const graph = document.querySelector("[data-testid=kf-graph-opacity]");
    if (!dot || !handle || !graph) return "missing";
    const d = dot.getBoundingClientRect();
    const h = handle.getBoundingClientRect();
    const g = graph.getBoundingClientRect();
    const cx = Math.round(d.left + d.width / 2);
    const cy = Math.round(d.top + d.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    const step = Math.round(g.width * 0.1);
    const expected = ((cx + step - g.left) / g.width) * Number(dot.getAttribute("aria-valuemax"));
    const overlap = Math.abs(d.left - h.left) < 0.5 && Math.abs(d.top - h.top) < 0.5;
    return `${cx} ${cy} ${step} ${expected.toFixed(4)} ${hit?.getAttribute("data-testid")} ${overlap}`;
  })()')
  local cx cy step wantTime hitName overlap
  cx=''; cy=''; step=''; wantTime=''; hitName=''; overlap=''
  read -r cx cy step wantTime hitName overlap <<<"$corner"
  [ "$hitName" = "kf-dot-opacity-0" ] || {
    echo "f05b: the corner press would hit ${hitName:-nothing}, not the dot" >&2
    return 1
  }
  [ "$overlap" = "true" ] || { echo "f05b: the ease-out handle is not on dot 0" >&2; return 1; }
  ab mouse move "$cx" "$cy" >/dev/null 2>&1; sleeps 0.2
  ab mouse down >/dev/null 2>&1; sleeps 0.3
  ab mouse move "$((cx + 3))" "$cy" >/dev/null 2>&1; sleeps 0.2
  ab mouse move "$((cx + step))" "$cy" >/dev/null 2>&1; sleeps 0.3
  ab mouse up >/dev/null 2>&1; sleeps 0.5
  local dotAfter quadAfter
  dotAfter=$(evaln 'document.querySelector("[data-testid=kf-dot-opacity-0]").getAttribute("aria-valuenow")')
  quadAfter=$(evaln 'document.querySelector("[data-testid=kf-graph-opacity]").getAttribute("data-active-quad")')
  [ "$quadAfter" = "0.000,0.000,0.580,1.000" ] || {
    echo "f05b: the corner drag moved the handle, not the dot (quad=$quadAfter)" >&2
    return 1
  }
  awk -v got="$dotAfter" -v want="$wantTime" 'BEGIN { exit !(got > want - 0.02 && got < want + 0.02) }' || {
    echo "f05b: the corner drag did not move the dot (time=$dotAfter want=$wantTime)" >&2
    return 1
  }

  # Restore: undo until the curve is gone. The commit count is not pinned (a
  # slider click can commit a second entry), so the loop watches for the
  # keyframes to clear and then asserts the clip is unanimated again.
  local guard
  for guard in 1 2 3 4 5 6 7 8 9 10 11 12; do
    [ "$(evaln 'document.querySelectorAll("[data-testid=kf-graph-opacity]").length')" = "0" ] && break
    ab press Control+z >/dev/null 2>&1 && sleeps 0.4
  done
  [ "$(evaln 'document.querySelectorAll("[data-testid=kf-graph-opacity]").length')" = "0" ] || {
    echo "f05b: undo did not restore the clip (the curve is still on the row)" >&2
    return 1
  }
  true
}

# ----- F2/F8 clipboard, duplicate, ripple -----
# Group semantics (actions.ts): duplicate/copy/ripple expand the selection to
# its link groups, and a plain click selects ONE clip (the ring is group-aware
# but resolveSelectionGroups of one unlinked member is that member). The
# expected delta is therefore read LIVE from the selection ring at action
# time. No hardcoded +1/+2 that depends on which clip earlier steps left
# behind. ring_count is also the click-actually-selected guard.
ring_count() {
  evaln '[...document.querySelectorAll("[data-testid^=clip-]:not([data-testid$=badge])")].filter((c) => c.className.includes("ring-rose-400")).length'
}
select_named() { # select_named <name-regex>: click by name, retry once, report ring
  click_clip "$1" || return 1
  [ "$(ring_count)" -ge 1 ] && return 0
  click_clip "$1" || return 1
  [ "$(ring_count)" -ge 1 ]
}
f02_duplicate() {
  # A first D after earlier steps has been observed to drop silently (the
  # keydown arrives, the handler runs, no clone lands). Press D ONCE, check
  # the count, and only retry (Escape, D) when nothing moved: Escape does not
  # clear the clip selection, so a blind second D would clone the clone and
  # fail the exact-count assertion. The assertion stays strict either way:
  # the count must rise by exactly the selection's group size.
  local before after n
  before=$(clipcount)
  select_named 'sample-audio' || { echo "f02: audio clip did not select" >&2; return 1; }
  n=$(ring_count)
  # NOTE: sleeps are unconditional, the count must settle before it is read.
  ab press d >/dev/null 2>&1; sleeps 0.6
  after=$(clipcount)
  if [ "$after" -ne "$((before + n))" ]; then
    ab press Escape >/dev/null 2>&1; sleeps 0.3
    ab press d >/dev/null 2>&1; sleeps 0.6
    after=$(clipcount)
  fi
  [ "$after" -eq "$((before + n))" ] || {
    echo "f02: D moved $((after - before)) clips, selection ring held $n" >&2
    return 1
  }
  ab press Control+z >/dev/null 2>&1; sleeps 0.6
  [ "$(clipcount)" -eq "$before" ]
}
f02_copy_paste() {
  # Paste at the sequence END (End key first): the audio sample is 8s long, so
  # a paste at the earlier playhead would OVERLAP the original on the same
  # lane and a later coordinate click could hit either clip. At the end the
  # copy starts at a label time no other clip shares, and overlaps nothing.
  local before after n
  before=$(clipcount)
  select_named 'sample-audio' || { echo "f02: audio clip did not select for copy" >&2; return 1; }
  n=$(ring_count)
  ab press Control+c >/dev/null 2>&1; sleeps 0.3
  ab find role button click --name 'Go to end (End)' >/dev/null 2>&1 && sleeps 0.4
  ab press Control+v >/dev/null 2>&1; sleeps 0.6
  after=$(clipcount)
  [ "$after" -eq "$((before + n))" ] || {
    echo "f02: paste moved $((after - before)) clips, copied group held $n" >&2
    return 1
  }
  # The copy starts at the sequence END, so its label time is the maximum clip
  # start on the timeline. Read it back live: the layout the earlier steps
  # leave is not fixed (a hardcoded 22.00 broke the ripple step once).
  PASTED_START=$(evaln '(() => {
    const starts = [...document.querySelectorAll("[data-testid^=clip-]")]
      .map((e) => / from ([0-9.]+) to ([0-9.]+) seconds/.exec(e.getAttribute("aria-label") || ""))
      .filter(Boolean)
      .map((m) => Number(m[1]));
    return starts.length ? Math.max(...starts).toFixed(2) : "none";
  })()')
  [ "$PASTED_START" != "none" ] || { echo "f02: could not read the pasted copy back" >&2; return 1; }
}
f08_ripple_delete() {
  # The pasted copy starts at the sequence end; f02_copy_paste recorded that
  # label time in PASTED_START, so target the copy there. The honest
  # assertions: the pasted clip is GONE and the clip count dropped (the exact
  # gap math on overlapping neighbors is locked in commands.test.ts).
  local before target
  [ -n "$PASTED_START" ] || { echo "f08: f02_copy_paste never recorded the pasted copy" >&2; return 1; }
  before=$(clipcount)
  target=$(firstref "button \"Clip sample-audio.mp3 from $PASTED_START")
  [ -n "$target" ] || { echo "f08: the pasted ${PASTED_START}s copy is missing" >&2; return 1; }
  ab scrollintoview "@$target" >/dev/null 2>&1 && sleeps 0.2
  ab click "@$target" >/dev/null 2>&1; sleeps 0.5
  [ "$(ring_count)" -ge 1 ] || { echo "f08: the pasted copy did not select" >&2; return 1; }
  ab press Shift+Delete >/dev/null 2>&1; sleeps 0.6
  [ "$(clipcount)" -lt "$before" ] || {
    echo "f08: Shift+Delete removed nothing" >&2
    return 1
  }
  snap | grep -q "Clip sample-audio.mp3 from $PASTED_START" && {
    echo "f08: the pasted ${PASTED_START}s copy survived Shift+Delete" >&2
    return 1
  }
  true
}
f02_link_unlink() {
  # Quick-add births the video sample as a linked A/V pair (actions.ts), so the
  # video clip wears the link badge. Ctrl+L drops the bond, Ctrl+Z restores it
  # (the manual two-group Link selection needs Shift+click, which agent-browser
  # cannot dispatch; the command-level behavior is locked in av-links.test.ts).
  local badges
  badges=$(evaln 'document.querySelectorAll("[data-testid=clip-link-badge]").length')
  [ "$badges" -ge 1 ] || { echo "f02: no linked pair to unlink (badges=$badges)" >&2; return 1; }
  click_clip 'sample-video' || return 1
  ab press Control+l >/dev/null 2>&1 && sleeps 0.5
  [ "$(evaln 'document.querySelectorAll("[data-testid=clip-link-badge]").length')" -lt "$badges" ] || {
    echo "f02: Ctrl+L did not drop the link badge" >&2
    return 1
  }
  ab press Control+z >/dev/null 2>&1 && sleeps 0.5
  [ "$(evaln 'document.querySelectorAll("[data-testid=clip-link-badge]").length')" -eq "$badges" ]
}

# ————— Menus —————
menus_open() {
  local ok=0
  for m in File Edit Clip Sequence Marker Graphics View Window Help; do
    # A failed click must skip the increment, or the 9-item assertion can
    # never fail and the step advertises a check it does not perform.
    ab find role menuitem click --name "$m" >/dev/null 2>&1 || continue
    sleep 0.3
    ab press Escape >/dev/null 2>&1 && sleep 0.2
    ok=$((ok + 1))
  done
  [ "$ok" = "9" ]
}
menu_snapping() { # snapping starts ON → one toggle must show "Snapping off"
  sleep 0.5
  local r s
  r=$(firstref 'menuitem "View"')
  [ -n "$r" ] || return 1
  ab click "@$r" >/dev/null && sleep 0.5
  # The checkbox shows its 'S' shortcut hint → accessible name is "Snapping S",
  # so the pattern must not require the closing quote.
  s=$(firstref 'menuitemcheckbox "Snapping')
  [ -n "$s" ] || return 1
  ab click "@$s" >/dev/null && sleep 0.5
  ab press Escape >/dev/null
  snap | grep -q 'Snapping off'
}

# ————— Panels —————
panels_collapse() {
  ab find role button click --name 'Collapse Media panel' >/dev/null && sleep 0.5
  snap | grep -q 'Expand Media panel' # stays collapsed: keeps workspace dirty for reset
}
panels_collapse_pair() {
  ab find role button click --name 'Collapse Source Monitor panel' >/dev/null && sleep 0.5
  ab find role button click --name 'Collapse Inspector panel' >/dev/null && sleep 0.5
  # BOTH strips must be thin at the same time. Before the fix the Source Monitor
  # could not collapse at all (it kept its full width with a strip drawn inside),
  # and collapsing the Inspector reopened it, so this reads not-thin.
  #
  # The measurement MUST be the last command of the function. A bash function
  # returns the status of its last command, battery.sh runs without `set -e`, and
  # step() keys PASS/FAIL on that status. Appending ANY command after this line
  # (an expand click, a sleep, a bare `true`) silently discards the verdict and
  # the red proof stops working.
  [ "$(evaln '(() => { const w = (id) => document.querySelector("[data-panel-id=" + id + "]").getBoundingClientRect().width; return (w("panel-source") < 80 && w("panel-inspector") < 80) ? "both-thin" : "not-thin"; })()')" = "both-thin" ]
}
panels_reset() {
  ab find role menuitem click --name 'Window' >/dev/null && sleep 0.4
  ab find role menuitem click --name 'Reset Workspace Layout' >/dev/null && sleep 0.8
  ab wait --text 'Workspace layout reset'
}
panels_expand_after_reset() {
  snap | grep -q 'Collapse Media panel'
}

# ————— F8 autosave + save —————
f08_autosave() {
  # Autosave-settle poll (item 3): the debounced write (800ms, status set
  # synchronously on edit) is done when no "Autosaving" text remains. The
  # deadline is generous on purpose: it only binds on failure, and a slow
  # flush must read as waiting, never as a pass.
  local settle_s=30
  local deadline=$((SECONDS + settle_s))
  while [ "$(evaln 'document.body.innerText.includes("Autosaving") ? "pending" : "settled"')" = "pending" ] && [ "$SECONDS" -lt "$deadline" ]; do sleep 0.25; done
  [ "$(evaln 'document.body.innerText.includes("Autosaving") ? "pending" : "settled"')" = "settled" ] || { echo "no autosave settle within ${settle_s}s" >&2; return 1; }
  ab reload >/dev/null
  # Boot poll: the greeting check below needs a mounted page, so wait for the
  # editor chrome instead of assuming the reload has settled. A DOM query, not
  # the a11y snapshot: an open welcome modal hides the chrome from snap while
  # the page is fine, and the modal is exactly dismiss_greeting's case.
  # The chrome arm queries the mounted menubar, not panel text: the collapse
  # controls are icon-only buttons, so their "Collapse X panel" labels live in
  # aria-label/title attributes and never appear in innerText (an innerText
  # check for them reads a blank page as unbooted forever).
  # The deadline is generous on purpose (reload plus dev-server recompile on a
  # loaded box); it only binds on failure.
  local boot=0
  deadline=$((SECONDS + 60))
  while [ "$boot" != "1" ] && [ "$SECONDS" -lt "$deadline" ]; do
    boot=$(evaln '(() => { const d = document; return (d.querySelector("[role=menubar]") || d.querySelector("[data-testid=release-notes-modal]")) ? "1" : "0"; })()')
    [ "$boot" = "1" ] || { boot=0; sleep 0.25; }
  done
  [ "$boot" = "1" ] || { echo "no editor boot after reload (url=$(evaln 'location.href' 2>/dev/null) textlen=$(evaln 'document.body.innerText.length' 2>/dev/null))" >&2; return 1; }
  dismiss_greeting || return 1
  # Restore-banner poll (item 3): the banner renders after boot.
  local banner=0
  deadline=$((SECONDS + 10))
  while [ "$banner" = "0" ] && [ "$SECONDS" -lt "$deadline" ]; do
    snap | grep -q '"Restore"' && banner=1
    [ "$banner" = "0" ] && sleep 0.25
  done
  [ "$banner" = "1" ] || { echo "no restore banner" >&2; return 1; }
  ab find role button click --name 'Restore' >/dev/null
  local n=0
  deadline=$((SECONDS + 6))
  while [ "$n" -lt 4 ] && [ "$SECONDS" -lt "$deadline" ]; do
    n=$(clipcount)
    [ "$n" -lt 4 ] && sleep 0.25
  done
  [ "$n" -ge 4 ]
}
f08_capture_project() {
  # Capture the toolbar's Save download to a UNIQUE temp path (mktemp), so a
  # pre-existing file at some fixed path can never be clobbered. f07_open_project
  # removes the file after consuming it; the EXIT/INT/TERM trap (top of script)
  # catches every earlier exit path, including this function's own failure.
  PROJECT_CAPTURE=$(mktemp /tmp/battery-project.XXXXXX.veproj.json)
  ab download 'button[aria-label="Save project (Ctrl+S)"]' "$PROJECT_CAPTURE" >/dev/null 2>&1 || {
    echo "f08: save download failed" >&2
    rm -f "$PROJECT_CAPTURE"
    return 1
  }
  [ -s "$PROJECT_CAPTURE" ]
}
f08_save() {
  ab find role button click --name 'Save project (Ctrl+S)' >/dev/null && sleep 1
  ab wait --text 'Project saved'
}

# ————— F7 export —————
delete_clip() { # delete_clip <name-regex>
  local r; r=$(firstref "button \"Clip $1")
  if [ -n "$r" ]; then
    ab scrollintoview "@$r" >/dev/null 2>&1 && sleeps 0.2
    ab click "@$r" >/dev/null 2>&1 && sleeps 0.4 && ab press Delete >/dev/null 2>&1 && sleeps 0.4
  fi
  return 0
}
f07_prep() { # normalize every aux clip to 0-1s; drop the video tail (label shifted by the crossfade pull)
  click_clip 'sample-audio' && fill_timing 0 1
  click_clip 'sample-image' && fill_timing 0 1
  click_clip 'Your text here' && fill_timing 0 1
  delete_clip 'sample-video.mp4 from 1'
  return 0
}
f07_open_project() {
  # File > New drops the editor to a bare 4-track doc (toast confirms).
  ab find role menuitem click --name 'File' >/dev/null 2>&1 && sleeps 0.4
  ab find role menuitem click --name 'New Project' >/dev/null 2>&1 && sleeps 0.8
  ab wait --text 'New project created' --timeout 5000 >/dev/null 2>&1 || return 1
  [ "$(clipcount)" = "0" ] || { echo "f07: New Project left clips behind" >&2; return 1; }
  # Open the captured .veproj.json through the toolbar's hidden input (the
  # real File > Open plumbing minus the OS picker), then clean it up.
  ab upload 'header input[type=file][accept=".json,application/json"]' "$PROJECT_CAPTURE" >/dev/null 2>&1 || {
    echo "f07: project upload failed" >&2
    rm -f "$PROJECT_CAPTURE"
    return 1
  }
  rm -f "$PROJECT_CAPTURE"
  # Hydration refetches the bundled sample bytes before installing the doc, so
  # poll the clip count instead of assuming a fixed settle time: a loaded box
  # installs later than 2.5s and the old sleep read it as lost clips.
  local waited=0
  while [ "$(clipcount)" -lt 4 ] && [ "$waited" -lt 60 ]; do
    sleep 0.5
    waited=$((waited + 1))
  done
  [ "$(clipcount)" -ge 4 ] || { echo "f07: reopened project lost its clips (count=$(clipcount))" >&2; return 1; }
  # Since 0.5.6 the open path hydrates the bundled samples BEFORE install, so
  # the reopened project's samples come back ONLINE by themselves: park on the
  # first clip and the offline overlay must NOT appear.
  ab find role button click --name 'Go to start (Home)' >/dev/null 2>&1 && sleeps 0.4
  [ "$(evaln 'document.querySelectorAll("[data-testid=media-offline-overlay]").length')" = "0" ] || {
    echo "f07: reopened project still shows media offline" >&2
    return 1
  }
}
# The exported MP4's own track list, read from the file bytes: the result
# view's Download button gives agent-browser the real blob, then a box walk
# (moov -> trak -> mdia -> hdlr) collects the handler types. Prints them sorted,
# e.g. "soun vide"; empty audio means the export muxed no audio track at all.
export_track_kinds() {
  local f dref k
  dref=$(firstref 'button "Download"')
  [ -n "$dref" ] || { echo "export_track_kinds: Download button missing from the result view" >&2; return 1; }
  f=$(mktemp /tmp/battery-export.XXXXXX.mp4)
  ab download "@$dref" "$f" >/dev/null 2>&1 || {
    echo "export_track_kinds: downloading the export failed" >&2
    rm -f "$f"
    return 1
  }
  k=$(bun -e '
const b = require("fs").readFileSync(process.argv[1]);
const out = new Set();
(function w(s, e) {
  let p = s;
  while (p + 8 <= e) {
    let z = b.readUInt32BE(p); const t = b.toString("latin1", p + 4, p + 8); let h = 8;
    if (z === 1) { z = Number(b.readBigUInt64BE(p + 8)); h = 16; } else if (z === 0) { z = e - p; }
    if (z < h || p + z > e) break;
    if (t === "moov" || t === "trak" || t === "mdia") w(p + h, p + z);
    else if (t === "hdlr" && p + 20 <= e) out.add(b.toString("latin1", p + 16, p + 20));
    p += z;
  }
})(0, b.length);
console.log([...out].sort().join(" "));
' "$f" 2>/dev/null)
  rm -f "$f"
  [ -n "$k" ] || { echo "export_track_kinds: could not read the export's handler types" >&2; return 1; }
  echo "$k"
}

# Mute every audio-capable clip in one pass so the next export's timeline has
# no audible source at all (TO_FIX issue 2: the all-skipped shape has to be
# constructed at export time; f05_mute muted exactly one copy and never reverts,
# and the reopened project's state comes back through save/open). Selects each
# clip by its unique label, reads the Clip tab's Mute switch the way f05_mute
# does, and skips clips that offer no Mute control (image, text).
mute_all_audio() {
  local labels lab clicked sel attempt muted=0 mstate
  # Labels are joined with "|", not "\n": evaln strips the quotes off
  # agent-browser's JSON reply but leaves its \n escapes literal, so a newline
  # join would arrive as one backslash-n-bearing line.
  labels=$(evaln '[...document.querySelectorAll("[data-testid^=clip-]")].filter((e) => {
    const id = e.dataset.testid || "";
    return id !== "clip-context-menu" && id !== "clip-marker" && !id.endsWith("badge");
  }).map((e) => e.getAttribute("aria-label")).join("|")')
  [ -n "$labels" ] || { echo "mute_all_audio: clip list unreadable" >&2; return 1; }
  # The Mute switch lives on the Clip tab; earlier steps left the Inspector on
  # Effect Controls. ClipPanel remounts per selected clip with tab='clip', but
  # assert it anyway for the no-selection-to-first-selection transition.
  ab eval 'document.querySelector("[data-testid=inspector-tab-clip]")?.click()' >/dev/null 2>&1
  sleeps 0.4
  while IFS= read -r lab; do
    [ -n "$lab" ] || continue
    # Select by dispatching the clip's own Enter key from the DOM. Coordinate
    # clicks cannot work here: the timeline stacks the image clip at the exact
    # rect of the 0-1s video clip (both @421/442/80/55 in the probe below), so
    # a real click at the video's centre selects the image every time, and
    # snapshot refs race the selection re-render and resolve to neighbours.
    # Enter on the clip div selects it (ClipView onKeyDown; no global Enter
    # handler exists), needs no viewport hit-test, and the ring is read back
    # after every attempt so a wrong selection can never pass.
    clicked=''
    sel=''
    for attempt in 1 2 3; do
      clicked=$(evaln "[...document.querySelectorAll(\"[data-testid^=clip-]\")].filter((e) => {
        const id = e.dataset.testid || \"\";
        return id !== \"clip-context-menu\" && id !== \"clip-marker\" && !id.endsWith(\"badge\");
      }).find((e) => e.getAttribute(\"aria-label\") === \"$lab\")?.dataset.testid ?? \"missing\"")
      if [ -z "$clicked" ] || [ "$clicked" = "missing" ]; then
        echo "mute_all_audio: clip not in DOM: $lab" >&2
        break
      fi
      evaln "(() => {
        const el = [...document.querySelectorAll('[data-testid^=clip-]')].filter((e) => {
          const id = e.dataset.testid || '';
          return id !== 'clip-context-menu' && id !== 'clip-marker' && !id.endsWith('badge');
        }).find((e) => e.getAttribute('aria-label') === \"$lab\");
        if (!el) return 'gone';
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'ok';
      })()" >/dev/null
      sleeps 0.5
      # Verify on the WANTED clip's own ring, not "the first ringed element":
      # linked clips render the ring on every group member, so a group whose
      # earlier-in-DOM member is not the wanted clip used to read as a miss.
      sel=$(evaln "(() => {
        const el = [...document.querySelectorAll('[data-testid^=clip-]')].filter((e) => {
          const id = e.dataset.testid || '';
          return id !== 'clip-context-menu' && id !== 'clip-marker' && !id.endsWith('badge');
        }).find((e) => e.getAttribute('aria-label') === \"$lab\");
        if (!el) return 'gone';
        return el.className.includes('ring-rose-400') ? 'selected' : 'not-selected';
      })()")
      [ "$sel" = "selected" ] && break
      if [ -n "${BATTERY_DEBUG:-}" ]; then echo "mute_all_audio: attempt $attempt for $lab got ${sel:-none}"; fi
    done
    if [ -z "$clicked" ] || [ "$clicked" = "missing" ]; then return 1; fi
    if [ "$sel" != "selected" ]; then
      echo "mute_all_audio: could not select $lab (wanted $clicked, state ${sel:-none})" >&2
      if [ -n "${BATTERY_DEBUG:-}" ]; then
        echo "mute_all_audio: probe => $(evaln "(() => {
          const clips = [...document.querySelectorAll('[data-testid^=clip-]')].filter((e) => {
            const id = e.dataset.testid || '';
            return id !== 'clip-context-menu' && id !== 'clip-marker' && !id.endsWith('badge');
          });
          const rect = (e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join('/'); };
          const byLabel = clips.find((e) => e.getAttribute('aria-label') === \"$lab\" );
          const ringed = document.querySelector('[data-testid^=clip-].ring-rose-400');
          let hitInfo = 'none';
          if (byLabel) {
            const r = byLabel.getBoundingClientRect();
            const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
            const c = hit && hit.closest('[data-testid^=clip-]');
            hitInfo = (hit ? hit.tagName + '|' + (hit.getAttribute('data-testid') || '-') : 'null') + ' => ' + (c ? c.getAttribute('aria-label') : 'no-clip');
          }
          return JSON.stringify({
            wanted: byLabel ? byLabel.dataset.testid + '@' + rect(byLabel) : 'gone',
            ringed: ringed ? ringed.dataset.testid + '@' + ringed.getAttribute('aria-label') + '@' + rect(ringed) : 'none',
            atCenter: hitInfo,
            clips: clips.map((e) => (e.dataset.testid || '').slice(5, 13) + ':' + e.getAttribute('aria-label') + '@' + rect(e)),
          });
        })()")"
      fi
      return 1
    fi
    # Read the switch through the DOM, not the a11y snapshot: the snapshot
    # only carries visible content, and a tall panel (Video + grade + timing
    # sections) puts the Audio section below the fold, which reads as "no audio
    # rows" and silently leaves that clip audible.
    mstate=$(evaln 'document.querySelector("aside[aria-label=Inspector] [role=switch][aria-label=\"Mute clip\"]")?.getAttribute("aria-checked") ?? "none"')
    [ -n "$mstate" ] || { echo "mute_all_audio: switch state unreadable for $lab" >&2; return 1; }
    if [ -n "${BATTERY_DEBUG:-}" ]; then
      echo "mute_all_audio: $lab -> $mstate | tabs=$(evaln 'document.querySelectorAll("[data-testid^=inspector-tab-]").length') | aside=$(evaln 'document.querySelector("aside[aria-label=Inspector]") ? "yes" : "NO"') | head=$(evaln 'document.querySelector("aside[aria-label=Inspector]")?.innerText.split("\n").slice(0,6).join(" / ")')"
    fi
    case "$mstate" in
      none) continue ;; # no Audio section (image, text)
      true) continue ;; # already muted
      false)
        # The click needs screen coordinates, so bring the row into view first.
        insp '[role=switch][aria-label="Mute clip"]'
        ab find role switch click --name 'Mute clip' >/dev/null 2>&1 || {
          echo "mute_all_audio: mute click failed on $lab" >&2
          return 1
        }
        sleeps 0.4
        mstate=$(evaln 'document.querySelector("aside[aria-label=Inspector] [role=switch][aria-label=\"Mute clip\"]")?.getAttribute("aria-checked") ?? "none"')
        [ "$mstate" = "true" ] || {
          echo "mute_all_audio: $lab did not mute (state: $mstate)" >&2
          return 1
        }
        muted=$((muted + 1))
        ;;
      *) echo "mute_all_audio: unexpected switch state '$mstate' for $lab" >&2; return 1 ;;
    esac
  done <<< "${labels//|/$'\n'}"
  echo "mute_all_audio: muted $muted clip(s)"
  # f07 needs the all-muted shape actually constructed: fail on zero mutes so
  # the step reports the mute setup, not a bogus export regression.
  [ "$muted" -ge 1 ]
}

f07_export() {
  ab find role button click --name 'Export' >/dev/null && sleep 0.8
  ab find role button click --name 'Start export' >/dev/null && sleep 1
  # The completion toast lives ~1s (radix auto-dismiss); `ab wait --text` polls
  # too slowly and raced it (three consecutive hangs here), so poll fast and
  # also accept the result view itself, which persists in the done phase.
  export_done() {
    local poll_s=240
    local deadline=$((SECONDS + poll_s))
    while [ "$SECONDS" -lt "$deadline" ]; do
      [ "$(evaln 'document.body.innerText.includes("Export complete") || !!document.querySelector("[data-testid=export-result-video]")')" = "true" ] && return 0
      sleep 0.25
    done
    echo "f07: no export-complete signal within ${poll_s}s" >&2
    echo "f07: dialog state: $(evaln 'document.body.innerText.slice(0, 200)' 2>/dev/null)" >&2
    return 1
  }
  export_done || return 1

  # The EXPORTED pixels are graded (0.6.0).
  # The export plans its own filter chain, so f06's preview proof does not cover
  # it and the decoded frame is the only real oracle. The reopened project kept
  # the +100 grade (it round-tripped through the .veproj.json), so this first
  # render is the warm one. A second render at -100 is the cool one: the two
  # exports differ ONLY in the grade, so any red-channel gap between them can
  # only come from the temperature matrix reaching the export.
  local warm_rgb cool_rgb warm cool warm_kinds cool_kinds
  warm_rgb=$(export_rgb_sums)
  warm=${warm_rgb%% *}
  [ -n "$warm" ] && [ "$warm" -gt 0 ] 2>/dev/null || {
    echo "f07: could not sample the exported +100 frame" >&2
    return 1
  }
  # Stream-layout lock (0.6.3): one sample-audio copy is still audible here, so
  # the exported MP4 MUST carry an audio track. Running it before the mute also
  # proves export_track_kinds returns non-empty kinds, so the absent assertion
  # below cannot pass vacuously on a broken parser.
  warm_kinds=$(export_track_kinds) || { echo "f07: warm export track kinds unreadable" >&2; return 1; }
  case " $warm_kinds " in
    *" soun "*) ;;
    *) echo "f07: warm export carries no audio track (kinds: $warm_kinds)" >&2; return 1 ;;
  esac
  ab find role button click --name 'Close' >/dev/null 2>&1 && sleeps 0.5

  # Construct the all-skipped audio shape for the cool render: mute EVERY
  # audio-capable clip, so renderAudioMix must return null and the MP4 must
  # contain video only. Muting does not touch pixels, so the warm/cool red
  # ratio below still compares two renders that differ only in the grade.
  mute_all_audio || { echo "f07: could not mute every audio clip" >&2; return 1; }

  # The reopened project has no selection, and the Inspector may still be on its
  # Effect Controls tab from the audio steps: select the video clip and open the
  # Clip tab so the grade controls exist again.
  select_named 'sample-video' || { echo "f07: video clip did not select" >&2; return 1; }
  ab eval 'document.querySelector("[data-testid=inspector-tab-clip]").click()' >/dev/null 2>&1
  sleeps 0.4

  # Home = the slider minimum = -100 (the cool end). Same commit-on-keydown path
  # f06 used with End.
  [ "$(evaln 'document.querySelectorAll("#grade-temperature [role=slider]").length')" = "1" ] || {
    echo "f07: temperature slider missing for the cool render" >&2
    return 1
  }
  ab eval 'document.querySelector("#grade-temperature [role=slider]").focus()' >/dev/null
  ab press Home >/dev/null 2>&1 && sleeps 0.6

  ab find role button click --name 'Export' >/dev/null && sleep 0.8
  ab find role button click --name 'Start export' >/dev/null && sleep 1
  export_done || return 1
  cool_rgb=$(export_rgb_sums)
  cool=${cool_rgb%% *}
  [ -n "$cool" ] && [ "$cool" -gt 0 ] 2>/dev/null || {
    echo "f07: could not sample the exported -100 frame" >&2
    return 1
  }
  # The regression lock: with every audio clip muted the early-out must skip
  # the mix entirely. The unfixed code built the context anyway and muxed a
  # SILENT AAC track, which is what this rejects.
  cool_kinds=$(export_track_kinds) || { echo "f07: cool export track kinds unreadable" >&2; return 1; }
  case " $cool_kinds " in
    *" soun "*) echo "f07: muted timeline still exported an audio track (kinds: $cool_kinds)" >&2; return 1 ;;
  esac
  # At +100 the matrix scales red 1.25x, at -100 it scales red 0.75x, so the
  # warm/cool red ratio is 1.667 for untouched pixels and can only fall to 1.333
  # (when the warm pixels clip at 255). Anything at or below 1.25 means the
  # exported pixels are not carrying the grade at all.
  awk -v w="$warm" -v c="$cool" 'BEGIN { exit !(w / c > 1.25) }' || {
    echo "f07: the exported frame is not graded (red +100=$warm vs -100=$cool)" >&2
    return 1
  }

  # The exported pixels carry a 1D LUT too (0.7.0). The third render changes
  # exactly ONE thing from the cool one: the cube assigned to the still-selected
  # video clip, whose green and blue tables are zero and red table all one. Both
  # renders share the -100 grade and the muted mix, so the cube's arrival is a
  # channel signature: the LUT frame's green must collapse while its red cannot
  # (the shaper makes red 255, and the -100 matrix scales it back down to the
  # same ceiling the cool source's own red is already bounded by).
  local lut_rgb lut_r lut_g cool_g
  local cube="${TMPDIR:-/tmp}/battery-red-$$.cube"
  make_lut "$cube"
  LUT_FIXTURE="$cube"
  ab find role button click --name 'Close' >/dev/null 2>&1 && sleeps 0.5
  insp '[data-testid=lut-load]'
  ab upload '[data-testid=lut-file]' "$cube" >/dev/null 2>&1 || {
    echo "f07: the cube upload into the Inspector failed" >&2
    ab press Control+Shift+a >/dev/null 2>&1
    return 1
  }
  local lut_landed=0 i
  for i in $(seq 1 20); do
    if [ "$(evaln 'document.querySelector("aside[aria-label=Inspector]")?.innerText.includes("battery-red") ? "yes" : "no"')" = "yes" ]; then
      lut_landed=1
      break
    fi
    sleep 0.25
  done
  [ "$lut_landed" = "1" ] || {
    echo "f07: the imported cube was never assigned to the video clip" >&2
    ab press Control+Shift+a >/dev/null 2>&1
    return 1
  }
  sleeps 0.5

  # Every exit past the assignment restores it: the import plus assignment is
  # ONE command batch, so a single Ctrl+Z must clear the clip and the later
  # steps must see the timeline they left behind. Before the batch lands no
  # undo fires: one there could revert the PREVIOUS step's action instead (the
  # f05 blend-parity lesson).
  f07_lut_restore() {
    local sel
    ab find role button click --name 'Close' >/dev/null 2>&1 && sleeps 0.5
    ab eval 'document.activeElement && document.activeElement.blur()' >/dev/null 2>&1
    ab press Control+z >/dev/null 2>&1 && sleeps 0.7
    sel=$(evaln 'document.querySelector("aside[aria-label=Inspector]")?.innerText.includes("battery-red") ? "yes" : "no"')
    [ "$sel" = "no" ]
  }

  # A failed step must not take the later steps down with it: the settings step
  # below reads the FIRST spinbutton as the project width, so no clip may stay
  # selected on any exit of this block.
  f07_lut_fail() { # f07_lut_fail <message>
    echo "$1" >&2
    f07_lut_restore || echo "f07: could not restore the LUT after the failure" >&2
    ab press Control+Shift+a >/dev/null 2>&1 && sleeps 0.4
    return 1
  }

  ab find role button click --name 'Export' >/dev/null && sleep 0.8
  ab find role button click --name 'Start export' >/dev/null && sleep 1
  export_done || { f07_lut_fail "f07: no export-complete signal for the LUT render"; return 1; }
  lut_rgb=$(export_rgb_sums)
  [ -n "$lut_rgb" ] || { f07_lut_fail "f07: could not sample the LUT export"; return 1; }
  lut_r=${lut_rgb%% *}
  lut_g=${lut_rgb#* }; lut_g=${lut_g%% *}
  cool_g=${cool_rgb#* }; cool_g=${cool_g%% *}
  if ! awk -v lr="$lut_r" -v lg="$lut_g" -v cr="$cool" -v cg="$cool_g" 'BEGIN {
    if (cg <= 0) exit 1
    exit !(lr > 0 && lg < cg * 0.25 && lr >= cr * 0.9)
  }'; then
    f07_lut_fail "f07: the export ignored the LUT (cool r=$cool g=$cool_g, lut r=$lut_r g=$lut_g)"
    return 1
  fi
  f07_lut_restore || {
    echo "f07: the LUT undo did not clear the clip's assignment" >&2
    return 1
  }

  # Leave no clip selected: the settings step below reads the FIRST spinbutton in
  # the a11y snapshot, which must stay the project width and not a clip's Timing
  # field.
  ab press Control+Shift+a >/dev/null 2>&1 && sleeps 0.4
}
f07_close_dialog() {
  ab find role button click --name 'Close' >/dev/null && sleep 0.5
  ! snap | grep -q 'Export video'
}

# The per-channel sums ("r g b") of the export dialog's decoded output at
# 0.60s (the doc time f06 sampled). Every read seeks the same way, so the
# differentials stay valid even if the element never seeks. "" on failure.
# The 0.6001 seek (a hair inside frame 18, the source helper's convention)
# plus a mediaTime check against frame PTS 0.6 proves the requested frame
# was presented; every timeout path fails closed to "" and cancels the pending
# frame callback on the way out.
export_rgb_sums() {
  ab eval '(() => {
    const v = document.querySelector("[data-testid=export-result-video]");
    window.__erg = "wait";
    if (!v) { window.__erg = "no-video"; return "kick"; }
    const T = 0.6001, PTS = 0.6, EPS = 0.017;
    const finish = (s) => { window.__erg = s; };
    const watch = () => {
      try {
        if (typeof v.requestVideoFrameCallback !== "function") { finish("no-rvfc"); return; }
        const id = v.requestVideoFrameCallback((t, md) => {
          if (md && typeof md.mediaTime === "number" && Math.abs(md.mediaTime - PTS) <= EPS) finish("ready");
          else watch();
        });
        window.__erg_id = id;
      } catch (e) { finish("rvc-fail"); return; }
    };
    const go = () => {
      try { v.pause(); } catch (e) {}
      const cur = v.currentTime;
      if (typeof cur !== "number") { finish("no-time"); return; }
      watch();
      if (Math.abs(cur - T) < 0.00005) {
        try { v.currentTime = 0; } catch (e) { finish("seek-fail"); return; }
      }
      try { v.currentTime = T; } catch (e) { finish("seek-fail"); return; }
    };
    if (v.readyState >= 2) { go(); return "kick"; }
    let waited = false;
    const ready = () => { if (!waited) { waited = true; go(); } };
    v.addEventListener("loadeddata", ready, { once: true });
    v.addEventListener("canplay", ready, { once: true });
    setTimeout(() => { if (!waited) { waited = true; finish("no-data"); } }, 8000);
    return "kick";
  })()' >/dev/null 2>&1
  local deadline=$((SECONDS + 14)) state="wait"
  while [ "$SECONDS" -lt "$deadline" ]; do
    state=$(evaln "window.__erg || \"wait\"")
    case "$state" in
      ready) break ;;
      wait) sleep 0.25 ;;
      *) state="fail"; break ;;
    esac
  done
  case "$state" in
    ready) ;;
    *)
      # Cancel the pending frame callback (if any) so a timed-out wait leaves
      # no registration behind on the paused video. Still fails closed to "".
      ab eval '(() => { try { const v = document.querySelector("[data-testid=export-result-video]"); const id = window.__erg_id; if (v && typeof id === "number" && typeof v.cancelVideoFrameCallback === "function") v.cancelVideoFrameCallback(id); } catch (e) {} window.__erg_id = 0; return "ok"; })()' >/dev/null 2>&1
      echo ""
      return 0
      ;;
  esac
  local out r g b
  out=$(evaln '(() => {
    const v = document.querySelector("[data-testid=export-result-video]");
    if (!v || !v.videoWidth) return "";
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(v, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 40) { r += d[i]; g += d[i+1]; b += d[i+2]; }
    return r + " " + g + " " + b;
  })()')
  read -r r g b <<<"${out:-}"
  if [ -z "${r:-}" ] || [ -z "${g:-}" ] || [ -z "${b:-}" ]; then
    echo ""
    return
  fi
  case "$r$g$b" in
    *[!0-9]*) echo "" ;;
    *) echo "$r $g $b" ;;
  esac
}

# ————— settings —————
settings_width() {
  sleep 0.5
  local r; r=$(spinrefs | sed -n '1p')
  [ -n "$r" ] || return 1
  ab scrollintoview "@$r" >/dev/null 2>&1 && sleeps 0.2
  ab fill "@$r" '960' >/dev/null && ab press Enter >/dev/null && sleep 0.8
  [ "$(evaln 'document.querySelector("[data-testid=preview-canvas]").width')" = "960" ]
}

# F2 rate stretch on a relinked-shorter asset (runs late: it saves and reopens the project)
# `relinkMedia` swaps an offline asset's file (and its duration) and leaves every
# clip window untouched, so a clip can end up consuming more source than the new
# asset holds. Alt-drag used to hold the source span fixed, so `trimClip`'s
# window guard rejected every pointer position: one toast and a dead edge. The
# decision now clamps the span to the asset's readable tail, which makes the pair
# satisfiable and the drag recover the clip. This step proves that in the real
# UI: generate a 2s WAV, import and clip it, save, New Project, reopen (the
# non-bundled file comes back offline), relink it to a 1s WAV, then Alt-drag the
# tail. The speed badge must show the CLAMPED 1s span's rate; holding the old 2s
# span would read twice as fast and is what a failed clamp looks like.
#
# No ffmpeg here, so the WAVs are generated: an 8 kHz 8-bit mono PCM WAV of
# silence is a 44-byte header plus one zero byte per sample.
le32() { # le32 <n>: the four little-endian bytes of n as printf escape text
  printf '\\x%02x\\x%02x\\x%02x\\x%02x' "$(($1 & 255))" "$((($1 >> 8) & 255))" "$((($1 >> 16) & 255))" "$((($1 >> 24) & 255))"
}
make_wav() { # make_wav <path> <whole seconds>
  local path="$1" secs="$2"
  local samples=$((8000 * secs))
  {
    printf 'RIFF'; printf "$(le32 $((samples + 36)))"
    printf 'WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00'
    printf "$(le32 8000)"; printf "$(le32 8000)"
    printf '\x01\x00\x08\x00data'
    printf "$(le32 "$samples")"
    head -c "$samples" /dev/zero
  } >"$path"
}

f02_ratestretch_relinked() {
  local long="${TMPDIR:-/tmp}/battery-long-$$.wav"
  local short="${TMPDIR:-/tmp}/battery-short-$$.wav"
  local proj; proj=$(mktemp /tmp/battery-relink.XXXXXX.veproj.json)
  clean_relink() { rm -f "$long" "$short" "$proj"; }
  make_wav "$long" 2
  make_wav "$short" 1

  # Import the 2s file through the media bin's real multi-file input, then
  # quick-add it: the clip window is the full 2s of source.
  ab upload 'aside[aria-label="Media bin"] input[type=file][multiple]' "$long" >/dev/null 2>&1 || {
    echo "f02_ratestretch_relinked: the 2s WAV upload failed" >&2
    clean_relink
    return 1
  }
  # Probe poll (item 3): the bin row lands asynchronously; poll the same
  # read the assert below uses instead of sleeping a fixed 2.5s.
  local item="none" deadline=$((SECONDS + 8))
  while [ "$item" = "none" ] && [ "$SECONDS" -lt "$deadline" ]; do
    item=$(evaln '(() => {
      const el = [...document.querySelectorAll("[data-testid^=media-item-]")]
        .find((e) => e.textContent.includes("battery-long-"));
      return el ? el.getAttribute("data-testid") : "none";
    })()')
    [ "$item" = "none" ] && sleep 0.25
  done
  [ "$item" != "none" ] || {
    echo "f02_ratestretch_relinked: the 2s WAV did not appear in the bin" >&2
    clean_relink
    return 1
  }
  ab click "[data-testid=$item] button[aria-label=\"Add to timeline\"]" >/dev/null 2>&1
  local n=0 deadline=$((SECONDS + 5))
  while [ "$n" -lt 1 ] && [ "$SECONDS" -lt "$deadline" ]; do
    n=$(clipcount)
    [ "$n" -lt 1 ] && sleep 0.25
  done
  [ "$n" -ge 1 ] || {
    echo "f02_ratestretch_relinked: quick-add produced no clip" >&2
    clean_relink
    return 1
  }

  # Save the project, then reopen it: the WAV's blob URL cannot persist, so the
  # open path marks it offline (the bundled samples relink themselves by name),
  # and the clip keeps the 2s window that now over-consumes a 1s asset.
  ab download 'button[aria-label="Save project (Ctrl+S)"]' "$proj" >/dev/null 2>&1 || {
    echo "f02_ratestretch_relinked: project save download failed" >&2
    clean_relink
    return 1
  }
  [ -s "$proj" ] || {
    echo "f02_ratestretch_relinked: the saved project is empty" >&2
    clean_relink
    return 1
  }
  ab find role menuitem click --name 'File' >/dev/null 2>&1 && sleeps 0.4
  ab find role menuitem click --name 'New Project' >/dev/null 2>&1 && sleeps 0.8
  ab wait --text 'New project created' --timeout 5000 >/dev/null 2>&1 || {
    echo "f02_ratestretch_relinked: New Project did not confirm" >&2
    clean_relink
    return 1
  }
  ab upload 'header input[type=file][accept=".json,application/json"]' "$proj" >/dev/null 2>&1 || {
    echo "f02_ratestretch_relinked: project upload failed" >&2
    clean_relink
    return 1
  }
  # Reopen poll (item 3): the offline relink button renders asynchronously.
  item="none" deadline=$((SECONDS + 8))
  while [ "$item" = "none" ] && [ "$SECONDS" -lt "$deadline" ]; do
    item=$(evaln '(() => {
      const el = [...document.querySelectorAll("[data-testid^=media-item-]")]
        .find((e) => e.textContent.includes("battery-long-"));
      return el && el.querySelector("button[aria-label=\"Relink media file\"]")
        ? el.getAttribute("data-testid")
        : "none";
    })()')
    [ "$item" = "none" ] && sleep 0.25
  done
  # The reopened asset must be offline with a relink button, and the clip must
  # still hold its 2s window (the relink leaves clips untouched).
  [ "$item" != "none" ] || {
    echo "f02_ratestretch_relinked: the reopened WAV is not offline with a relink button" >&2
    clean_relink
    return 1
  }
  local d0
  d0=$(evaln '(() => {
    const c = document.querySelector("[data-testid^=clip-][aria-label^=\"Clip battery-long-\"]");
    const m = /from ([\d.]+) to ([\d.]+) seconds/.exec(c ? c.getAttribute("aria-label") : "");
    return m ? (Number(m[2]) - Number(m[1])).toFixed(2) : "none";
  })()')
  [ "$d0" = "2.00" ] || {
    echo "f02_ratestretch_relinked: the reopened clip window is not 2.00s ($d0)" >&2
    clean_relink
    return 1
  }

  # Relink to the 1s file and prove the asset shrank.
  ab upload "[data-testid=$item] input[type=file]" "$short" >/dev/null 2>&1 || {
    echo "f02_ratestretch_relinked: the 1s WAV relink upload failed" >&2
    clean_relink
    return 1
  }
  # Relink poll (item 3): the asset duration updates asynchronously.
  local shown="none" deadline=$((SECONDS + 6))
  while [ "$SECONDS" -lt "$deadline" ]; do
    shown=$(evaln '(() => {
      const el = [...document.querySelectorAll("[data-testid^=media-item-]")]
        .find((e) => e.textContent.includes("battery-long-"));
      return el ? el.textContent.replace(/\s+/g, " ") : "none";
    })()')
    case "$shown" in *1.0s*) break ;; esac
    sleep 0.25
  done
  case "$shown" in
    *1.0s*) ;;
    *)
      echo "f02_ratestretch_relinked: the asset duration did not become 1.0s ($shown)" >&2
      clean_relink
      return 1
      ;;
  esac

  # Alt-drag the tail right by half a second, the px measured from the clip's
  # own width so any zoom works. agent-browser cannot hold Alt across its
  # separate keydown and mouse commands (each invocation owns a fresh input
  # state, verified), so the pointerdown is dispatched with altKey set and the
  # moves and up go to the gesture's own window listeners. The real path is
  # still exercised: beginGesture records the Alt, moveTo re-times, trimClip
  # validates, and commitTransient lands one history entry.
  local dragged
  dragged=$(evaln '(() => {
    const clip = document.querySelector("[data-testid^=clip-][aria-label^=\"Clip battery-long-\"]");
    const h = [...document.querySelectorAll("[aria-label=\"Trim clip end\"]")]
      .find((e) => e.closest("[data-testid^=clip-]")?.getAttribute("aria-label")?.includes("battery-long-"));
    if (!clip || !h) return "none";
    const m = /from ([\d.]+) to ([\d.]+) seconds/.exec(clip.getAttribute("aria-label"));
    const scale = clip.getBoundingClientRect().width / (Number(m[2]) - Number(m[1]));
    const dx = Math.round(scale * 0.5);
    const r = h.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const ev = (type, cx, cy, buttons) => new PointerEvent(type, {
      pointerId: 7, pointerType: "mouse", isPrimary: true, bubbles: true,
      cancelable: true, composed: true, button: 0, buttons,
      altKey: true, clientX: cx, clientY: cy,
    });
    h.dispatchEvent(ev("pointerdown", x, y, 1));
    window.dispatchEvent(ev("pointermove", x + dx / 2, y, 1));
    window.dispatchEvent(ev("pointermove", x + dx, y, 1));
    window.dispatchEvent(ev("pointerup", x + dx, y, 0));
    return "ok";
  })()')
  [ "$dragged" = "ok" ] || {
    echo "f02_ratestretch_relinked: could not dispatch the Alt-drag ($dragged)" >&2
    clean_relink
    return 1
  }
  # Post-drag poll (item 3): the re-timed clip and badge render asynchronously.
  local d1="none" badge="none" deadline=$((SECONDS + 4))
  while [ "$SECONDS" -lt "$deadline" ]; do
    d1=$(evaln '(() => {
      const c = document.querySelector("[data-testid^=clip-][aria-label^=\"Clip battery-long-\"]");
      const m = /from ([\d.]+) to ([\d.]+) seconds/.exec(c ? c.getAttribute("aria-label") : "");
      return m ? (Number(m[2]) - Number(m[1])).toFixed(2) : "none";
    })()')
    badge=$(evaln '(() => {
      const c = document.querySelector("[data-testid^=clip-][aria-label^=\"Clip battery-long-\"]");
      const b = c ? c.querySelector("[data-testid=clip-speed-badge]") : null;
      return b ? b.textContent.replace("×", "") : "none";
    })()')
    if [ "$d1" != "none" ] && [ "$badge" != "none" ]; then break; fi
    sleep 0.25
  done
  # The drag must have re-timed the clip, and with the CLAMPED span: the badge
  # rate is 1/duration, not the 2x that holding the old 2s span would read.
  if [ "$d1" = "none" ] || [ "$badge" = "none" ]; then
    echo "f02_ratestretch_relinked: no re-timed clip with a speed badge (duration=$d1 badge=$badge)" >&2
    clean_relink
    return 1
  fi
  awk -v was="$d0" -v now="$d1" -v badge="$badge" 'BEGIN {
    clamped = 1 / now;
    held = 2 / now;
    ok = now > was + 0.05 && badge > clamped - 0.011 && badge < clamped + 0.011 && (badge < held - 0.05 || badge > held + 0.05);
    exit !ok;
  }' || {
    echo "f02_ratestretch_relinked: the drag did not recover the clip (duration=$d1 badge=$badge; the clamped 1s span needs speed 1/$d1)" >&2
    clean_relink
    return 1
  }
  clean_relink
  true
}

console_clean() {
  local errs; errs=$(ab errors 2>/dev/null | grep -c "Error" || true)
  [ "${errs:-0}" = "0" ]
}

# ————— run —————
step "s01 public: hero loads and links to the editor" s01_public
step "s02 boot: Open editor loads the editor"      s02_boot
step "s03 fresh: storage cleared, editor empty"     s03_fresh
step "f01 import: sample media loads 3 assets"     f01_import
step "f01b import: a real (non-bundled) file imports" f01b_import_real_file
step "f02 add: video+audio+image quick-added"      f02_add
step "f02 zoom: all clips reachable in snapshot"   zoom_out
step "f02b place: insert moves a downstream clip by the marked span" f02b_insert_place
step "f05 blend: monitor matches the export plan frame by frame" f05_blend_parity
step "f09 marquee: box drag selects every clip"    f09_marquee
step "f09 marquee: empty-space click clears it"    f09_marquee_clear
step "f11 whats-new: Help > What's new opens the modal" f11_whatsnew_opens
step "f11 whats-new: a recorded version stays silent on reload" f11_whatsnew_once
step "f10 markers: sequence add/nav/drag/delete"    f10_markers_sequence
step "f10 markers: clip marker + dialog edit"       f10_markers_clip
step "f06 play: transport runs, time advances"     f06_play
step "f06 sync: preview canvas renders + temperature grades it" f06_canvas
step "f06 scopes: waveform + vectorscope paint real pixels" f06_scopes
step "f02 split: select + 2.0s + Ctrl+K splits clip" f02_split
step "f08 undo: Ctrl+Z removes the split"          f08_undo
step "f08 redo: Ctrl+Shift+Z re-applies it"        f08_redo
step "f02 trim: first video part -> 1.50s"         f02_trim
step "f02 duplicate: D clones the selected audio clip" f02_duplicate
step "f02 clipboard: Ctrl+C / Ctrl+V pastes a copy"  f02_copy_paste
step "f02 link: Ctrl+L drops the A/V bond, Ctrl+Z restores it" f02_link_unlink
step "f03 crossfade: enable on first clip"         f03_crossfade
step "t01 wipe: type wipe applies and direction select appears" t01_wipe
step "t02 slide+push: each type applies without errors" t02_slide_push
step "f04 text: T adds a text clip"                f04_text_add
step "f04 text: content edited via Inspector"      f04_text_edit
step "c01 captions: SRT import creates timed flagged clips" c01_captions_import
step "c02 captions: SRT and VTT export download the cues in order" c02_captions_export
step "e00 effects: Effect Controls hosts the effects section" e00_effects_tab
step "e01 effects: crop adds through the picker and undoes" e01_crop_add_remove
step "e02 effects: blend mode switches to Multiply and undoes" e02_blend_mode
step "e03 effects: chroma key adds through the picker and undoes" e03_chroma_hex
step "e04 effects: track matte masks and survives hiding the source" e04_matte_masks_and_survives_hide
step "e05 effects: motion blur adds, renders, and undoes" e05_blur_accumulates
step "e06 effects: motion blur exports to completion" e06_effects_export
step "f05 audio: mute + reduce-noise switches work" f05_mute
step "f05 audio: gain slider reaches 200%"         f05_gain
step "f05 reverse: picture-only rows + the mirrored curve" f05_reverse
step "f05 reverse: trim keeps the parked frame in pixels" f05_reverse_frame
step "f05b curve: handle drag reshapes an eased segment" f05b_curve_handles
step "f08 ripple: Shift+Delete removes the pasted copy" f08_ripple_delete
step "menus: all 9 application menus open"         menus_open
step "menus: View > Snapping toggles off"          menu_snapping
step "panels: collapse Media panel (strip shown)"  panels_collapse
step "panels: collapse Source and Inspector (both strips, no reopen)" panels_collapse_pair
step "panels: Window > Reset Workspace Layout"     panels_reset
step "panels: reset expanded Media again"          panels_expand_after_reset
step "f08 autosave: reload -> restore session"     f08_autosave
step "f08 save: capture the .veproj.json download"  f08_capture_project
step "f08 save: project download toast"            f08_save
step "f07 roundtrip: New Project + reopen the saved file" f07_open_project
step "f07 export prep: normalize aux clips"        f07_prep
step "f07 export: renders graded pixels to completion" f07_export
step "f07 export: dialog closes cleanly"           f07_close_dialog
step "settings: width change resizes canvas"       settings_width
step "f06 scopes: waveform tiles the meter canvas on a square project" f06_scopes_fill
step "f02 rate stretch: relinked-shorter asset recovers" f02_ratestretch_relinked
step "f06 LUT: an imported .cube grades the monitor" f06_lut
step "console: zero page errors across battery"    console_clean

passed=$(grep -c '^PASS' "$OUT"); failed=$(grep -c '^FAIL' "$OUT")
echo "— done: $passed passed, $failed failed —" >>"$OUT"
echo "results written to $OUT ($passed passed, $failed failed)"

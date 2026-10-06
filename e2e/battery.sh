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
# The pasted copy's label time, recorded by f02_copy_paste and consumed by
# f08_ripple_delete: it depends on the clip layout the earlier steps leave, so
# it is read back live instead of hardcoded.
PASTED_START=''
trap '[ -n "$PROJECT_CAPTURE" ] && rm -f "$PROJECT_CAPTURE"' INT TERM EXIT

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

# ————— 0. boot —————
s01_boot() { ab open "$BASE_URL" >/dev/null && sleep 2.5; }

# g0 gate login — the app sits behind a password gate (src/proxy.ts). With
# GATE_PASSWORD unset (gate open) this is a no-op; with it set, the first
# navigation lands on /gate and every later step needs the session cookie.
g0_login() {
  if snap | grep -q 'This editor is private'; then
    ab fill 'input[type=password]' "${GATE_PASSWORD:?GATE_PASSWORD must match the server}" >/dev/null
    ab press Enter >/dev/null
    sleep 2.5
  fi
  dismiss_greeting || return 1 # fresh visitor: the welcome modal hides the app until closed
  snap | grep -q 'Load sample media'
}

s02_fresh() {
  ab eval 'localStorage.clear()' >/dev/null
  ab reload >/dev/null && sleep 2.5
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
  ab reload >/dev/null && sleep 2.5
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
f10_markers_sequence() {
  ab press Control+Shift+a >/dev/null 2>&1   # no live clip selection -> M targets the timeline
  ab find role button click --name 'Go to start (Home)' >/dev/null && sleep 0.4
  for i in $(seq 1 30); do ab press ArrowRight >/dev/null 2>&1; done # 30 frames = 1.0s
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
  for i in $(seq 1 30); do ab press ArrowRight >/dev/null 2>&1; done # 1.0s inside the clip
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
  local i
  for i in $(seq 1 18); do ab press ArrowRight >/dev/null 2>&1; done
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
  for i in $(seq 1 60); do ab press ArrowRight >/dev/null 2>&1; done # 60 frames = 2.0s
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
  insp '[role=switch][aria-label="Enable crossfade transition"]'
  ab find role switch click --name 'Enable crossfade transition' >/dev/null 2>&1 || {
    echo "f03: switch missing, inspector switches: $(snap | grep -c switch)" >&2
    return 1
  }
  sleeps 0.5
  snap | grep -q '"Enable crossfade transition" \[checked=true'
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
  local i
  for i in $(seq 1 18); do ab press ArrowRight >/dev/null 2>&1; done # 18 frames = 0.60s
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
  for i in $(seq 1 18); do ab press ArrowRight >/dev/null 2>&1; done # 18 frames = 0.60s
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
  local i
  for i in $(seq 1 15); do ab press ArrowRight >/dev/null 2>&1; done # 15 frames = 0.50s
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
  sleep 1.5
  ab reload >/dev/null && sleep 2.5
  dismiss_greeting || return 1
  snap | grep -q '"Restore"' || { echo "no restore banner" >&2; return 1; }
  ab find role button click --name 'Restore' >/dev/null && sleep 1.5
  [ "$(clipcount)" -ge 4 ]
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
  sleep 2.5
  [ "$(clipcount)" -ge 4 ] || { echo "f07: reopened project lost its clips" >&2; return 1; }
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
    for _ in $(seq 1 120); do
      [ "$(evaln 'document.body.innerText.includes("Export complete") || !!document.querySelector("[data-testid=export-result-video]")')" = "true" ] && return 0
      sleep 1
    done
    echo "f07: no export-complete signal within 120s" >&2
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
  local warm cool warm_kinds cool_kinds
  warm=$(export_red_sum)
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
  cool=$(export_red_sum)
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

  # Leave no clip selected: the settings step below reads the FIRST spinbutton in
  # the a11y snapshot, which must stay the project width and not a clip's Timing
  # field.
  ab press Control+Shift+a >/dev/null 2>&1 && sleeps 0.4
}
f07_close_dialog() {
  ab find role button click --name 'Close' >/dev/null && sleep 0.5
  ! snap | grep -q 'Export video'
}

# The red sum of the export dialog's decoded output at 0.60s (the doc time f06
# sampled). Seek failures are harmless: both exports are read the same way, so
# the differential stays valid even if the element never seeks. "" on failure.
export_red_sum() {
  ab eval '(() => {
    const v = document.querySelector("[data-testid=export-result-video]");
    if (v) { v.pause(); v.currentTime = 0.6; }
  })()' >/dev/null 2>&1
  sleeps 1.5
  local r
  r=$(evaln '(() => {
    const v = document.querySelector("[data-testid=export-result-video]");
    if (!v || !v.videoWidth) return "0";
    const c = document.createElement("canvas");
    c.width = v.videoWidth; c.height = v.videoHeight;
    const ctx = c.getContext("2d");
    ctx.drawImage(v, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let r = 0;
    for (let i = 0; i < d.length; i += 40) r += d[i];
    return String(r);
  })()')
  case "${r:-}" in
    '' | *[!0-9]*) echo "" ;;
    *) echo "$r" ;;
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
  sleeps 2.5
  local item
  item=$(evaln '(() => {
    const el = [...document.querySelectorAll("[data-testid^=media-item-]")]
      .find((e) => e.textContent.includes("battery-long-"));
    return el ? el.getAttribute("data-testid") : "none";
  })()')
  [ "$item" != "none" ] || {
    echo "f02_ratestretch_relinked: the 2s WAV did not appear in the bin" >&2
    clean_relink
    return 1
  }
  ab click "[data-testid=$item] button[aria-label=\"Add to timeline\"]" >/dev/null 2>&1
  sleeps 0.8
  [ "$(clipcount)" -ge 1 ] || {
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
  sleeps 2.5

  # The reopened asset must be offline with a relink button, and the clip must
  # still hold its 2s window (the relink leaves clips untouched).
  item=$(evaln '(() => {
    const el = [...document.querySelectorAll("[data-testid^=media-item-]")]
      .find((e) => e.textContent.includes("battery-long-"));
    return el && el.querySelector("button[aria-label=\"Relink media file\"]")
      ? el.getAttribute("data-testid")
      : "none";
  })()')
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
  sleeps 1.5
  local shown
  shown=$(evaln '(() => {
    const el = [...document.querySelectorAll("[data-testid^=media-item-]")]
      .find((e) => e.textContent.includes("battery-long-"));
    return el ? el.textContent.replace(/\s+/g, " ") : "none";
  })()')
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
  sleeps 0.5

  # The drag must have re-timed the clip, and with the CLAMPED span: the badge
  # rate is 1/duration, not the 2x that holding the old 2s span would read.
  local d1 badge
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
step "s01 boot: page loads and renders"            s01_boot
step "g0  gate: login accepts the access password"   g0_login
step "s02 fresh: storage cleared, editor empty"    s02_fresh
step "f01 import: sample media loads 3 assets"     f01_import
step "f01b import: a real (non-bundled) file imports" f01b_import_real_file
step "f02 add: video+audio+image quick-added"      f02_add
step "f02 zoom: all clips reachable in snapshot"   zoom_out
step "f09 marquee: box drag selects every clip"    f09_marquee
step "f09 marquee: empty-space click clears it"    f09_marquee_clear
step "f11 whats-new: Help > What's new opens the modal" f11_whatsnew_opens
step "f11 whats-new: a recorded version stays silent on reload" f11_whatsnew_once
step "f10 markers: sequence add/nav/drag/delete"    f10_markers_sequence
step "f10 markers: clip marker + dialog edit"       f10_markers_clip
step "f06 play: transport runs, time advances"     f06_play
step "f06 sync: preview canvas renders + temperature grades it" f06_canvas
step "f02 split: select + 2.0s + Ctrl+K splits clip" f02_split
step "f08 undo: Ctrl+Z removes the split"          f08_undo
step "f08 redo: Ctrl+Shift+Z re-applies it"        f08_redo
step "f02 trim: first video part -> 1.50s"         f02_trim
step "f02 duplicate: D clones the selected audio clip" f02_duplicate
step "f02 clipboard: Ctrl+C / Ctrl+V pastes a copy"  f02_copy_paste
step "f02 link: Ctrl+L drops the A/V bond, Ctrl+Z restores it" f02_link_unlink
step "f03 crossfade: enable on first clip"         f03_crossfade
step "f04 text: T adds a text clip"                f04_text_add
step "f04 text: content edited via Inspector"      f04_text_edit
step "f05 audio: mute + reduce-noise switches work" f05_mute
step "f05 audio: gain slider reaches 200%"         f05_gain
step "f05 reverse: picture-only rows + the mirrored curve" f05_reverse
step "f05 reverse: trim keeps the parked frame in pixels" f05_reverse_frame
step "f05b curve: handle drag reshapes an eased segment" f05b_curve_handles
step "f08 ripple: Shift+Delete removes the pasted copy" f08_ripple_delete
step "menus: all 9 application menus open"         menus_open
step "menus: View > Snapping toggles off"          menu_snapping
step "panels: collapse Media panel (strip shown)"  panels_collapse
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
step "f02 rate stretch: relinked-shorter asset recovers" f02_ratestretch_relinked
step "console: zero page errors across battery"    console_clean

passed=$(grep -c '^PASS' "$OUT"); failed=$(grep -c '^FAIL' "$OUT")
echo "— done: $passed passed, $failed failed —" >>"$OUT"
echo "results written to $OUT ($passed passed, $failed failed)"

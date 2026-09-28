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

set -u
BASE_URL="${BASE_URL:-http://localhost:3000}"
SESSION="${SESSION:-battery}"
OUT="${OUT:-results.txt}"
: > "$OUT"

# The project-file capture (f08_capture_project) lives at a unique mktemp path
# and is normally consumed by f07_open_project. Any step's early return between
# the two must not leak the file, so an EXIT/INT/TERM trap removes it — by the
# VARIABLE, never a glob: a glob could delete a PARALLEL battery run's capture
# (the runner documents A/B runs against two trees).
PROJECT_CAPTURE=''
trap '[ -n "$PROJECT_CAPTURE" ] && rm -f "$PROJECT_CAPTURE"' INT TERM EXIT

ab() { agent-browser --session "$SESSION" "$@"; }
snap() { ab snapshot -i -c 2>/dev/null; }
refs() { snap | grep -E "$1" | grep -oE 'ref=e[0-9]+' | cut -d= -f2; }
spinrefs() { snap | grep -- '- spinbutton' | grep -oE 'ref=e[0-9]+' | cut -d= -f2; }
firstref() { refs "$1" | head -1; }
evaln() { ab eval "$1" 2>/dev/null | tr -d '"'; }
clipcount() { ab get count '[aria-label^="Clip "]' 2>/dev/null; }
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

# ————— 0.5.6 welcome modal (Help > What's new) —————
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

# ————— F1b real file import (bytes the app does not bundle) —————
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
  [ "$(ab get count '[aria-label="Add to timeline"]')" = "4" ]
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
  [ "${s:-0}" -gt 0 ] 2>/dev/null
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
  snap | grep -q '"Mute clip" \[checked=true'
}
f05_gain() {
  # Radix renders aria-label on the slider root, not the thumb — the a11y
  # snapshot shows it unnamed, so target it via CSS instead of by role+name.
  insp '[role=slider]'
  ab find first 'aside[aria-label=Inspector] [role=slider]' click >/dev/null 2>&1 || return 1
  ab press End >/dev/null 2>&1 && sleeps 0.4
  [ "$(evaln 'document.querySelector("aside[aria-label=Inspector]").innerText.includes("200%")')" = "true" ]
}

# ————— F2/F8 clipboard, duplicate, ripple —————
# Group semantics (actions.ts): duplicate/copy/ripple expand the selection to
# its link groups, and a plain click selects ONE clip (the ring is group-aware
# but resolveSelectionGroups of one unlinked member is that member). The
# expected delta is therefore read LIVE from the selection ring at action
# time. No hardcoded +1/+2 that depends on which clip earlier steps left
# behind. ring_count is also the click-actually-selected guard.
clip_named_count() { # clip_named_count <name-regex> — snapshot buttons matching one clip name
  snap | grep -cE "button \"Clip $1"
}
ring_count() {
  evaln '[...document.querySelectorAll("[data-testid^=clip-]:not([data-testid$=badge])")].filter((c) => c.className.includes("ring-rose-400")).length'
}
select_named() { # select_named <name-regex> — click by name, retry once, report ring
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
  # copy starts at a distinctive label time (22.00) and overlaps nothing.
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
}
f08_ripple_delete() {
  # The pasted copy starts at the sequence end (22.00s, set by copy_paste),
  # so target it by that distinctive label. The honest assertions: the pasted
  # clip is GONE and the clip count dropped (the exact gap math on
  # overlapping neighbors is locked in commands.test.ts).
  local before target
  before=$(clipcount)
  target=$(firstref 'button "Clip sample-audio.mp3 from 22.00')
  [ -n "$target" ] || { echo "f08: the pasted 22.00s copy is missing" >&2; return 1; }
  ab scrollintoview "@$target" >/dev/null 2>&1 && sleeps 0.2
  ab click "@$target" >/dev/null 2>&1; sleeps 0.5
  [ "$(ring_count)" -ge 1 ] || { echo "f08: the pasted copy did not select" >&2; return 1; }
  ab press Shift+Delete >/dev/null 2>&1; sleeps 0.6
  [ "$(clipcount)" -lt "$before" ] || {
    echo "f08: Shift+Delete removed nothing" >&2
    return 1
  }
  snap | grep -q 'Clip sample-audio.mp3 from 22.00' && {
    echo "f08: the pasted 22.00s copy survived Shift+Delete" >&2
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

f07_export() {
  ab find role button click --name 'Export' >/dev/null && sleep 0.8
  ab find role button click --name 'Start export' >/dev/null && sleep 1
  ab wait --text 'Export complete' --timeout 60000
}
f07_close_dialog() {
  ab find role button click --name 'Close' >/dev/null && sleep 0.5
  ! snap | grep -q 'Export video'
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
step "f06 sync: preview canvas renders frames"     f06_canvas
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
step "f05 audio: mute switch works"                f05_mute
step "f05 audio: gain slider reaches 200%"         f05_gain
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
step "f07 export: renders to completion"           f07_export
step "f07 export: dialog closes cleanly"           f07_close_dialog
step "settings: width change resizes canvas"       settings_width
step "console: zero page errors across battery"    console_clean

passed=$(grep -c '^PASS' "$OUT"); failed=$(grep -c '^FAIL' "$OUT")
echo "— done: $passed passed, $failed failed —" >>"$OUT"
echo "results written to $OUT ($passed passed, $failed failed)"

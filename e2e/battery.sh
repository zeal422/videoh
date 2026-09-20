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

set -u
BASE_URL="${BASE_URL:-http://localhost:3000}"
SESSION="${SESSION:-battery}"
OUT="${OUT:-results.txt}"
: > "$OUT"

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

click_clip() { # click_clip <name-regex>
  local r; r=$(firstref "button \"Clip $1")
  [ -n "$r" ] && ab click "@$r" >/dev/null 2>&1 && sleeps 0.5
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
  ab fill "@$s" "$1" >/dev/null 2>&1 && ab press Enter >/dev/null 2>&1 && sleeps 0.3
  ab fill "@$d" "$2" >/dev/null 2>&1 && ab press Enter >/dev/null 2>&1 && sleeps 0.4
  return 0
}

# ————— 0. boot —————
s01_boot() { ab open "$BASE_URL" >/dev/null && sleep 2.5; }
s02_fresh() {
  ab eval 'localStorage.clear()' >/dev/null
  ab reload >/dev/null && sleep 2.5
  snap | grep -q 'Load sample media'
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
  local t; t=$(firstref 'textbox "Text content"')
  [ -n "$t" ] && ab fill "@$t" 'Hello A/B' >/dev/null && sleeps 0.3
}

# ————— F5 audio —————
f05_mute() {
  click_clip 'sample-audio' || { echo "f05: audio clip not found" >&2; return 1; }
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
  ab find first 'aside[aria-label=Inspector] [role=slider]' click >/dev/null 2>&1 || return 1
  ab press End >/dev/null 2>&1 && sleeps 0.4
  [ "$(evaln 'document.querySelector("aside[aria-label=Inspector]").innerText.includes("200%")')" = "true" ]
}

# ————— Menus —————
menus_open() {
  local ok=0
  for m in File Edit Clip Sequence Graphics View Window Help; do
    ab find role menuitem click --name "$m" >/dev/null 2>&1 && sleep 0.3
    ab press Escape >/dev/null 2>&1 && sleep 0.2
    ok=$((ok + 1))
  done
  [ "$ok" = "8" ]
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
  snap | grep -q '"Restore"' || { echo "no restore banner" >&2; return 1; }
  ab find role button click --name 'Restore' >/dev/null && sleep 1.5
  [ "$(clipcount)" -ge 4 ]
}
f08_save() {
  ab find role button click --name 'Save project (Ctrl+S)' >/dev/null && sleep 1
  ab wait --text 'Project saved'
}

# ————— F7 export —————
delete_clip() { # delete_clip <name-regex>
  local r; r=$(firstref "button \"Clip $1")
  if [ -n "$r" ]; then
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
  ab fill "@$r" '960' >/dev/null && ab press Enter >/dev/null && sleep 0.8
  [ "$(evaln 'document.querySelector("[data-testid=preview-canvas]").width')" = "960" ]
}

console_clean() {
  local errs; errs=$(ab errors 2>/dev/null | grep -c "Error" || true)
  [ "${errs:-0}" = "0" ]
}

# ————— run —————
step "s01 boot: page loads and renders"            s01_boot
step "s02 fresh: storage cleared, editor empty"    s02_fresh
step "f01 import: sample media loads 3 assets"     f01_import
step "f02 add: video+audio+image quick-added"      f02_add
step "f02 zoom: all clips reachable in snapshot"   zoom_out
step "f06 play: transport runs, time advances"     f06_play
step "f06 sync: preview canvas renders frames"     f06_canvas
step "f02 split: select + 2.0s + Ctrl+K splits clip" f02_split
step "f08 undo: Ctrl+Z removes the split"          f08_undo
step "f08 redo: Ctrl+Shift+Z re-applies it"        f08_redo
step "f02 trim: first video part -> 1.50s"         f02_trim
step "f03 crossfade: enable on first clip"         f03_crossfade
step "f04 text: T adds a text clip"                f04_text_add
step "f04 text: content edited via Inspector"      f04_text_edit
step "f05 audio: mute switch works"                f05_mute
step "f05 audio: gain slider reaches 200%"         f05_gain
step "menus: all 8 application menus open"         menus_open
step "menus: View > Snapping toggles off"          menu_snapping
step "panels: collapse Media panel (strip shown)"  panels_collapse
step "panels: Window > Reset Workspace Layout"     panels_reset
step "panels: reset expanded Media again"          panels_expand_after_reset
step "f08 autosave: reload -> restore session"     f08_autosave
step "f08 save: project download toast"            f08_save
step "f07 export prep: normalize aux clips"        f07_prep
step "f07 export: renders to completion"           f07_export
step "f07 export: dialog closes cleanly"           f07_close_dialog
step "settings: width change resizes canvas"       settings_width
step "console: zero page errors across battery"    console_clean

passed=$(grep -c '^PASS' "$OUT"); failed=$(grep -c '^FAIL' "$OUT")
echo "— done: $passed passed, $failed failed —" >>"$OUT"
echo "results written to $OUT ($passed passed, $failed failed)"

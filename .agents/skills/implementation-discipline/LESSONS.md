# Lessons

One entry per failure, wrong assumption, or defect found after a check had
passed. Appended by the implementation-discipline skill during a run; the
checklist itself stays short, this log grows.

Promotion is the point: an entry that stays here is a note; an entry promoted
into `SKILL.md` stops the next run from repeating it.

Format:

    ## <YYYY-MM-DD> - <trigger or phase>
    What happened: <one line, with the command or file>
    Would-have-caught: <the rule>
    Action: promoted to rule <n> | kept as a note

## Entries

## 2026-10-08 - Phase 3, affected tests (a lock added after docs were synced)

What happened: adding 3 call-site locks to `compositing-ui.test.ts` (34 -> 37 cases) left the count
claims stale, so `bun run test src/lib/editor/__tests__/docs-drift.test.ts` went red on the next run
(README and testing.md said 1045, structure.md 1021, the inventory row 34) while the suite I edited
was itself green.
Would-have-caught: trigger 6 read narrowly ("affected tests" = the suites I edited). Any test-count
change makes the count lock an affected test, and the inventory row plus every repo-wide headline
move with the tests.
Action: promoted to rule 6.

## 2026-10-08 - Phase 3, manual proof (harness assumption)

What happened: `agent-browser mouse down right` delivered button=2 to the page but never fired a
native `contextmenu`, so Radix's track menu never opened and the first proof run asserted against an
absent menu (and `find text "Load sample media"` had clicked the empty-state `<em>` instead of the
button, so no samples imported at all).
Would-have-caught: trigger 7 (proof names the action and the observed result) read as asserting the
ACTION's effect, not only the end state, after each step.
Action: kept as a note (the workaround is dispatching a `contextmenu` event and clicking by role);
no checklist rule needs it.

## 2026-10-10 - plan review (fixing one defect introduced another)

What happened: fixing the "proxy drops preview audio" finding, `PLAN-0.8.0-tier2.md` described the proxy
audio decode as `Input -> getPrimaryAudioTrack() ... the exact pattern mp4.ts:160,505 already uses`.
`mp4.ts` never calls `getPrimaryAudioTrack` (grep is empty); it decodes with `ctx.decodeAudioData` on the
file (`mp4.ts:308`), and `toAudioBuffer()` is on a decoded `AudioSample` (`sample.d.ts:569`), not on an
`InputAudioTrack`. The plan cited a precedent the repo does not have.
Would-have-caught: rule 2 (read before you climb) applied to citations: a "the existing X already does
this" line is a claim about the code, so open X and confirm the exact mechanism before writing it down.
Action: kept as a note. In the plan this became a standing habit: every `file:line` and every
"already does this" is opened before it ships.

## 2026-10-10 - plan claim audit (a "pass" that was hand-counted)

What happened: the plan's Class A audit claimed "pass (37 citations)" but had not opened every line, so
it passed `core.ts:668` where the intended comment sits at `:671` (668 is the `computeGain` signature).
A reviewer's line-by-line pass caught it.
Would-have-caught: rule 7 (proof names the action and the observed result) applied to the audit itself: a
citation check's result is the opened line, not a count of citations.
Action: promoted the wording into the plan's Class A row ("read the named thing on that EXACT line; a
list of line numbers is not a pass until each is opened").

## 2026-10-11 - Feature C source inventory (search root was too narrow)

What happened: the first `project.tracks` inventory searched editor modules and components but omitted
`src/hooks/editor/useEditorKeyboard.ts`, reporting 90 line occurrences in 27 files instead of 92 in 28.
Would-have-caught: rule 4 now requires structural sweeps from the full `src/` root, with test exclusions,
separate line and file counts, and each source location opened.
Action: promoted into rule 4.

## 2026-10-12 - Feature C createCompoundClip depth guard (checked before the edge existed)

What happened: the nesting-depth guard ran `maxSequenceDepth(doc)` after pushing the new sequence but
BEFORE adding the container clip, so the new sequence was unreachable from the root and the walk never
saw the extra edge; a depth-9 compound was accepted. The `compound.test.ts` boundary test caught it.
Would-have-caught: rule 5 (write the lock first and watch it fail) applied to a guard that depends on a
mutation ORDER: the prospective-graph check must run with every edge of the prospective graph present.
Action: kept as a note; the command now adds the container, checks depth, then removes the originals.

## 2026-10-15 - Static-source locks pin import lines (0.8.4 color.test.ts red gate)

What happened: adding `paintSpatialMask` to mp4.ts's compositor import broke the color.test.ts lock
that pins the exact import statement, failing the full gate after all affected suites were green.
Would-have-caught: rule 4 (grep every caller is not enough; grep every QUOTER: static-source tests
quote production lines verbatim, so a new import or symbol must be searched in `__tests__` too).
Action: kept as a note; pre-gate sweep now includes `grep` for the touched symbol across tests.

## 2026-10-15 - Battery insp() needs raw CSS, and blind keypresses corrupt state (0.8.4 t01/t02)

What happened: the new `select_option` helper passed an a11y query (`combobox "Name"`) to `insp()`,
which takes a CSS selector, so nothing scrolled and the clicks missed; the following arrows+Enter
went into the page body with no failure signal, and the later f07/settings/f06 failures were
cascade from that corrupted state. A menu-open guard (fail fast when no listbox appears) now
prevents silent corruption.
Would-have-caught: rule 7 (proof names the action and the observed result): the helper proved
"the run finished" instead of "the menu opened".
Action: kept as a note; battery helpers that drive overlays must assert the overlay opened
before sending keys.

## 2026-10-15 - pkill -f matches the harness itself

What happened: `pkill -f 'next dev'` to stop an own dev server returned a ChildProcess.kill
error against the tool harness; the port check confirmed the server did stop, but the blunt
match is exactly what AGENTS.md rule 8 forbids. `fuser 3000/tcp` only identifies the port
owner; stopping is a separate `kill` of that PID, and only for a server you started yourself
(record the PID or process group at start, never `pkill -f`, and leave a user-started server
running per rule 8).
Would-have-caught: AGENTS.md rule 8, already written; this is a compliance failure, not a gap.
Action: kept as a note.

## 2026-10-15 - A trailing negative grep fails the battery step when the toast is absent (0.8.4 t01)

What happened: the new `snap | grep -q 'Update failed' && { ...; return 1; }` guard sat last
in t01_wipe, so the good case (no toast) exited the function nonzero and failed a green step
with zero output. Restructured to an `if` so absence exits 0.
Would-have-caught: the round-2 lesson directly above (helpers must assert before keying);
a negative assertion as the last line inverts the verdict by construction.
Action: kept as a note; battery steps end with an explicit `return 0` or a positive assertion.

## 2026-10-17 - Browser proof measured a stale dev server (0.8.5 collapse fix)

What happened: a second `setsid bun run dev` died with EADDRINUSE while the
first server kept serving, so a whole proof round (collapse, reload, widths)
measured pre-fix code and "disproved" a working fix. Turbopack also does not
always recompile on edit (single "Compiled" line despite changes), so HMR
cannot be assumed either.
Would-have-caught: trigger 7 (proof names the action and the observed result)
applied to the harness itself: prove WHICH server answers (kill by recorded
PID/group, confirm the port free, start fresh, confirm Ready) before proving
anything through it.
Action: kept as a note; browser proofs start from a known-fresh server, and a
result that contradicts the code on disk triggers a freshness check first.

## 2026-10-18 - 0.8.6 effects implementation (late-found render defects)
What happened: two render defects survived unit tests and were caught only by
live pixel proof: the matte mask loop keyed on its own written white (every
mask fully opaque), and motion-blur accumulation with fixed 1/N alpha
converges to 1-(1-1/N)^N (every blurred frame darkened a third). A third
(hidden matte sources erased the picture instead of masking) survived both
unit tests and the battery, caught only by adversarial review.
Would-have-caught: trigger 7 (prove the fix, not the wiring) applied per
effect with settled frame sums, plus a review pass that re-derives render
math instead of re-reading code shape.
Action: kept as a note.

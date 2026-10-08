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

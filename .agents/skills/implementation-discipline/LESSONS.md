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

## 2026-10-20 - Playhead effect-contract docs (wrong total source)

What happened: new tests moved the suite to 1486 vitest tests, and the four
doc claims were updated to 1486 from the vitest total. `bun run check` went
red on docs-drift: the docs pin the DRIFT total (countCases regex, 1474),
not the vitest total (it.each and friends expand past the regex count).
Would-have-caught: trigger 6 read as "the count lock has its own counter".
The drift failure message prints the actual total; copy that number, never
the vitest headline.
Action: kept as a note.

## 2026-10-20 - Motion-blur bypass tests (trailing windows sample before the frame)

What happened: two export mocked-harness tests composited at the helper's
frame 0 with a Motion ramp starting at local 0, so the trailing shutter
windows sampled negative locals where the curve constant-extends flat and
the "animated" fixture bypassed like a static one
(`export-effects.mocked.test.ts` mixed-flag case). Fixed by compositing at
frame 1 (direct `compositeFrame` + `planVideoFrame(d, 1)`, the wipe-test
precedent), where the ramp covers the window.
Would-have-caught: trigger 5 (the lock must fail for its stated reason):
the mixed case passed for the wrong reason until the window placement was
checked against the curve's range.
Action: kept as a note; animated blur fixtures must cover the sampled
window, not just contain keyframes.

## 2026-10-20 - Plan edits on a disputed order (edit-permission failure)

What happened: edited the plan file twice on an order the user later
disputed ("readd the version rule ... DO IT NOW"), then had to revert both
edits. Same session already carried a stale todo list, a recommendation-free
question, and a release buried as a silent non-goal: a pattern of acting on
ambiguous instructions instead of confirming first.
Would-have-caught: AGENTS.md rule 10 (no edit without explicit go-ahead;
vague approval is not permission). An all-caps "DO IT" attached to an
ambiguous target is vague approval: confirm the exact action, then edit.
Action: kept as a note; when the order and the target are in doubt, quote
back the intended action and wait.

## 2026-10-21 - VTT implementation: two self-caught edit mistakes

What happened: (1) wrote a render-test assertion with the wrong cue end time (assumed the captionsDoc fixture's First cue ends at 2.0; it is start 1 plus duration 2, so 3.0); the new test itself caught it on its first green run. (2) an edit whose oldString was a table-row prefix fused the new architecture.md vtt row into the srt row; reading the merged lines back caught it before anything else ran.
Would-have-caught: the plan-implementer rung order (affected tests before the suite) for (1); read-after-write for (2).
Action: kept as a note; fixture numbers come from the fixture, not memory, and row-prefix edits get a read-back before continuing.

## 2026-10-21 - VTT review round: toast-dismiss broke the render file

What happened: added toast.dismiss() to a test file's beforeEach to isolate toast assertions, without checking the export shape; toast is a factory, dismiss lives on the useToast() hook return, so all 40 tests in the file failed with "toast.dismiss is not a function".
Would-have-caught: reading the export (one grep) before editing; the green trio run immediately after.
Action: kept as a note; verify the export shape before calling it, and prefer narrowing the assertion to texts the test itself can produce over harness surgery.

## 2026-10-21 - Battery e06 hard exit hid a flake as INCOMPLETE

What happened: a full dev battery stopped at 38/63 results with INCOMPLETE after an e04 pixel flake. The step framework records FAIL and continues, but e06's dirty-timeline precondition called exit 1, killing the script. Fixed to return 1 with the tradeoff documented (later steps may cascade-fail honestly; verdict still red, nothing hidden), then proved with fault injection: forced e04 failure and forced e06 trip each produced full 63-result red verdicts instead of INCOMPLETE.
Would-have-caught: grepping step functions for bare exit (awk BEGIN exits are subshell-local and fine; only e06 had one).
Action: kept as a note; a step function that calls exit aborts the verdict, a step that returns 1 records it.

## 2026-10-22 - Rebuilding under a running artifact server breaks it

What happened: ran `bun run build` while the standalone artifact server from the previous build still served, then killed only the `bun run start` wrapper pid; the child server.js kept the port, the new server died with EADDRINUSE, and the battery ran against a stale server whose .next files had been replaced mid-run (mass FAILs from the gate step onward on the untouched tree).
Would-have-caught: killing the actual server process (server.js pid, not the wrapper) and verifying the port is free before starting its replacement.
Action: kept as a note; stop the server process itself, confirm the port is free, then rebuild and serve; never rebuild under a live server.

## 2026-10-22 - Same-task DOM reads race React renders in battery evals

What happened: the in-page frame-step dispatch read the transport text synchronously after dispatching; delivery and handling both passed, but the playhead read 0.000 because React batches store updates and the DOM had not re-rendered yet, failing every converted step from f10 onward on the first post-change run.
Would-have-caught: remembering that in-page evals observe pre-commit DOM unless they yield; the settled_sum pattern in the same file already polls for exactly this reason.
Action: kept as a note; any in-page state change followed by a DOM read must poll (async IIFE, which ab eval awaits), never read synchronously after the mutation.

## 2026-10-23 - Radix data-inset={false} still matches data-[inset]:pl-8

What happened: passed inset={hasCheckbox} to MenubarItem; pure-item menus rendered data-inset="false", and Tailwind's data-[inset] variant matches attribute presence, so File and other pure menus widened to pl-8. Live DOM measurement caught it after lint and typecheck were green.
Would-have-caught: remembering data-* attributes render the string "false", which still satisfies presence-based variants; conditional props need || undefined.
Action: kept as a note; pass inset={cond || undefined} so the attribute is absent when false.

## 2026-10-23 - Prettier vs docs-drift on testing.md inventory rows

What happened: lengthening the menubar.test.tsx inventory row, then running prettier --write, appended a stray empty table cell that docs-drift counted as broken; removing the cell made prettier --check fail until the row was rewritten and both tools re-run.
Would-have-caught: the AGENTS.md note that Prettier glues markdown table rows, which docs-drift then counts.
Action: kept as a note; after editing testing.md, run prettier --check and the drift suite separately and reconcile by hand until both pass.

## 2026-10-23 - Attribute battery reds with a pristine-tree run before touching code

What happened: the dev-leg battery failed the same 4 steps (f06 LUT, f07 export, f07 roundtrip, f08 autosave) twice on the changed tree; instead of guessing from the diff, stashed all 11 changed files and re-ran the leg on the pristine tree, which failed identically, exonerating the changes as a pre-existing issue.
Would-have-caught: the trigger audit habit of verifying against the untouched tree, applied to the battery rather than only the unit suite.
Action: kept as a note; when a full-battery red survives one repeat, the next step is a stash-and-rerun attribution leg, not code edits.

## 2026-10-23 - Boot predicate queried innerText for an aria-label

What happened: the battery's post-reload boot check waited on innerText containing "Collapse Media panel", but that string lives only in an aria-label and a title attribute on an icon button, so it can never appear in innerText; when the welcome modal was also absent, boot failed every run, the restore was never clicked, and f07/f06/export all failed downstream on the empty timeline. Four deterministic reds, one dead predicate arm.
Would-have-caught: reading the component that renders the awaited text (PanelShell renders the label into aria-label/title, not into text) instead of trusting the step comment.
Action: kept as a note; readiness predicates must query mounted structure (roles, testids), never the visible-text rendering of a control's accessible name.

## 2026-10-23 - Green jsdom suite hid a dead CSS cascade

What happened: the 10-cell preloader suite passed (100 cells, delays, statics) while the rendered grid sat frozen dim in a real browser. The opacity calc lived in a Tailwind utility but an inline opacity: 0.25 overrode it: CSS animations override inline styles only for the properties they animate (--bo/--bi), not for downstream properties computed from them. Unit tests cannot see cascade precedence.
Would-have-caught: the manual browser proof rung, which ran before the gate was final and moved the calc inline where the animated variables resolve.
Action: kept as a note; when animation-adjacent presentation splits across utilities and inline styles, verify the winning declaration in a real browser before calling the suite green.

## 2026-10-23 - Stale Turbopack CSS survived a dev-server restart

What happened: after changing keyframes in globals.css, the browser ran the OLD percentages (resolved offsets 0/0.1875/0.375/1 instead of 0/0.125/0.25/1) even though the dev server had been restarted after the edit and the file on disk was correct. Only wiping .next forced a fresh compile. Manual timing probes caught it because measured peaks disagreed with the plan math.
Would-have-caught: asserting the resolved keyframes in-browser (getKeyframes offsets) as part of any CSS-animation proof, instead of assuming restart picks up stylesheet edits.
Action: kept as a note; when a browser-measured animation disagrees with source, check getKeyframes before doubting the math, and wipe .next when they differ.

## 2026-10-24 - Preloader double-start was the dynamic boundary, not the component

What happened: the boot grid visibly restarted ~245ms after mount in dev and production. Two suspects were cleared first (StrictMode off still remounted; render made fully deterministic with identical SSR bytes, still remounted), and a mount fade was shipped to mask it. A static route rendering the same component showed zero remounts, proving the cause was next/dynamic's loading boundary replacing its fallback after hydration; the fix was loading the shell chunk in an effect with no dynamic boundary, plus deleting the component's own 1.6s key-change loop cut, which was a second restart by design.
Would-have-caught: trigger 2 (read before you climb) applied to the framework piece: isolate the component from its boundary with a static route before theorizing about hydration or masking with a fade.
Action: kept as a note; a mount-time visual restart gets a boundary-vs-component isolation probe before any masking animation.

## 2026-10-24 - Zone map read of the reference clip was wrong

What happened: the plan's frame-by-frame analysis claimed a four-stage chase (corners, center, middle, outer); on a real screen it played as discrete blocks, not a ripple, and corners-first looked broken. Replaced with the continuous center-out wave the pattern name implies (delay proportional to Euclidean distance, sub-0.2s adjacent steps), with a smoothness lock that fails on any stepped map (proven red against the old zone logic).
Would-have-caught: trigger 7 (prove the fix, not the wiring): the zone read was settled by stills, never by watching the wave move on a screen early.
Action: kept as a note; motion reads get a live screen check before the plan locks them.

## 2026-10-24 - Computed-style-right mask still looked square

What happened: the first radial feather (opaque to 50%, gone at 100% of the corner radius) resolved correctly in getComputedStyle but screenshots still showed a hard square: at 50-100% the edge midpoints kept 42% of their light, so the resting grid and the arriving wavefront both held a visible edge. Tightening to 40-85% plus dropping the resting base 0.12 to 0.07 produced the round melt.
Would-have-caught: trigger 7 (prove the look, not the wiring): a mask is a visual value, so the verdict is the screenshot, never the computed style.
Action: kept as a note.

## 2026-10-24 - Designed hold vs fixed harness sleeps (battery 26/63)

What happened: the first battery on the preloader tree went 26/63 with g0 failing first. The cause was the 3.2s min-show hold outlasting the harness's fixed 2.5s post-navigation sleeps: g0/s02/f11-once asserted inside the preloader window, f01's click then raced the reveal, and every media-dependent step cascaded. Fixed harness-side with a menubar boot poll (60s deadline) at the three navigation points; step count unchanged at 63.
Would-have-caught: trigger 2 (read before you climb) applied to the failing step itself: g0's sleep-vs-hold mismatch was visible in two files before any rerun.
Action: kept as a note; when a feature adds a designed load hold, the harness's fixed post-navigation sleeps must become boot polls in the same change.

## 2026-10-24 - Review findings need per-line verification, not trust

What happened: three pasted review findings (harness wait placement, page import rejection, opacity var fallback) all checked out against the current code, including two the implementer had deferred or never considered; the opacity one (unregistered var invalidates the whole calc) would have shipped a bright grid to exactly the oldest browsers. No finding was followed blindly: each was re-read in its file, two needed new tests, one needed only a move.
Would-have-caught: the standing rule to verify review text as untrusted data before editing.
Action: kept as a note; a pasted finding still gets its evidence line opened and its red run captured before the fix counts.

## 2026-10-24 - Assert nothing, attach the run that proves it

What happened: three review findings survived a "clean" verdict because each rested on an untested assumption (gate always shows, chunk never fails, unknown var reads as 0). The claims were asserted from reasoning, never from a run down that path.
Would-have-caught: trigger 7 applied to negative space: for every claim, name the run that exercised the failure path, not just the happy path. A verdict with no attached failing-then-passing run is a draft, not a result.
Action: promoted into the working order: every "verified" statement in a report names its evidence (log line, probe output, red/green run). No evidence, no claim.

## 2026-10-24 - resetModules duplicates React for dynamic imports

What happened: a review claimed home.test.tsx paired two React copies (static renderer vs post-reset dynamic page import). An identity probe confirmed it: pre-reset and post-reset dynamic imports of react are different objects. The tests passed anyway, but only by accident of shared internals.
Would-have-caught: probing module identity instead of assuming externalized deps are singletons.
Action: kept as a note; any test using vi.resetModules must import the renderer from the same post-reset registry as the unit under test, and an identity probe settles singleton claims.

## 2026-10-24 - Plan locks weaker than the plan text

What happened: a review found the keyframes/@property/hue tests pinned only a subset of what the plan's lock paragraph claimed (missing 0/25/100 stops, the --b peak, syntax/initial-value, and any hue-duration or wrapper assertion). The suite was green while the plan promised more.
Would-have-caught: diffing the lock paragraph against the test file line by line when the plan was written, not after review.
Action: kept as a note; new lock paragraphs get a symbol-by-symbol check against the test file before the plan ships.

## 2026-10-24 - React set-state-in-effect on a dialog open read

What happened: the appearance dialog's `open` effect called `setSelected(readTheme(...))`; `bun run lint` rejected it with `react-hooks/set-state-in-effect`.
Would-have-caught: checking the React Compiler lint rules before choosing an effect to re-read storage on open.
Action: kept as a note; mount the dialog only while open, read storage in the state initializer, and keep the effect for the external DOM sync only.

## 2026-10-24 - failing RTL assertion leaked the mounted preloader

What happened: `home.test.tsx`'s new boot test failed before its inline `rtl.cleanup()`, leaving a mounted preloader whose pending 3.2s timer failed the next three tests.
Would-have-caught: a failure-safe `afterEach` cleanup in any suite that renders a long-lived component with timers.
Action: kept as a note; register the RTL cleanup in the suite's `afterEach`, not only at the end of each test.

## 2026-10-24 - storage getter throws before the method guard

What happened: a review found `window.localStorage` was evaluated at the Home effect and both AppearanceDialog call sites, so a blocked getter escaped before `readTheme`/`writeTheme` could catch the method error. The boot could crash instead of using Default.
Would-have-caught: treating the property access as part of the storage trust boundary, not only the `getItem`/`setItem` calls.
Action: kept as a note; browser storage access goes through `themeStorage`, which returns `null` on a throwing getter, and callers pass that result to the pure helpers.

## 2026-10-24 - a Map hid duplicate declarations from the token-set lock

What happened: the palette token-set test read CSS declarations into a Map, so a duplicate allowed token collapsed and the "exactly 17" contract was not enforced. Borders and inputs were skipped by the contrast loop and never asserted.
Would-have-caught: using the declaration list for count/duplicate contracts, and giving every intentionally skipped value its own assertion.
Action: kept as a note; count locks read declarations, not key sets, and skipped values get explicit locks.

## 2026-10-24 - dev server served a stale palette CSS chunk

What happened: after adding the 0.10.1 palette blocks, the restarted dev server served a stylesheet with only the three 0.10.0 blocks. The picker set data-palette and storage, but the page stayed default; the production build had all 13, so the source was correct.
Would-have-caught: comparing the served stylesheet with the source before treating a browser result as a code failure, and starting the dev server from a clean .next after a CSS-only change.
Action: kept as a note; when a CSS change is not visible in dev, clear .next and recheck the served stylesheet before changing code.

## 2026-10-24 - a capped list did not cap its dialog

What happened: the 0.10.1 picker capped the radio list at 60vh and scrolled it, but the dialog added its header, gap, and padding on top. At a 250px viewport the shipped dialog measured -6 to 256 and clipped.
Would-have-caught: measuring the whole dialog box, not only the list, at a short viewport; a viewport-relative cap belongs on the scroll container that owns the full content.
Action: kept as a note; cap the dialog itself at calc(100vh - 2rem), let it own the scroll, and keep the radio grid unconstrained inside it.

## 2026-10-24 - a native button test rendered without the app's global keymap

What happened: the fullscreen button test rendered `MenuBar` alone and passed Space activation, but in the real app `useEditorKeyboard` preventDefaulted Space on the focused button, so Space toggled playback instead. Manual headed proof caught it after the unit suite was green.
Would-have-caught: rendering the real global keyboard hook in the test that claims native Space activation, and exercising the integration in a headed browser.
Action: kept as a note; a native-control test that competes with an app-level shortcut must include the shortcut's real listener, and manual proof must press the actual key.

## 2026-10-25 - battery boot block replacement

What happened: replacing the boot function block in `e2e/battery.sh` dropped the shared `wait_boot` helper; the first battery run failed 38 downstream steps with `wait_boot: command not found`.
Would-have-caught: after replacing a block in a shell script, list the functions the block contained and grep every helper used by later steps before running the full battery.
Action: kept as a note; the battery is the proof for script structure, not syntax checks alone.

## 2026-10-26 - a storage disclosure that was not exhaustive

What happened: the Privacy page's "What the browser stores" list omitted `releases:lastSeen`, which `EditorShell` reads and writes, so the page's intro read as complete while one stored value was undocumented.
Would-have-caught: inventorying every localStorage key in source before writing a storage disclosure, then locking the disclosure with a render assertion.
Action: kept as a note; a page that says "what the browser stores" gets a key-by-key source sweep and a test for every listed marker.

## 2026-10-26 - a scoped docs lock passed when its line was deleted

What happened: `checkScoped` only validated lines that already contained `__tests__/`; deleting the required README tree line left no match and returned null. The structure line still passed, so the README lock was gone.
Would-have-caught: for every "must exist" claim, assert the expected line exists before validating its content; a loop over matches is vacuous at zero.
Action: kept as a note; presence locks are separate assertions, and the lock test removes the line to prove the failure path.

## 2026-10-26 - a queue-wide retry deadline starved newer events

What happened: `analytics.ts` stored one `queueStartedAt` and dropped the whole queue after five seconds, so an event queued at 4.9 seconds could be discarded 0.1 seconds later.
Would-have-caught: reviewing every bounded queue against the documented promise, and testing a late arrival before accepting the single-timestamp implementation.
Action: kept as a note; bounded retries store the deadline or enqueue time on each item, and the late-arrival test proves an older event expires without killing a newer one.

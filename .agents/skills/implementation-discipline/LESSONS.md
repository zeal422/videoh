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

What happened: fixing the "proxy drops preview audio" finding, the 0.8.0 proxy plan described the proxy
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

## 2026-10-27 - the panel-tree move hid media actions from the battery

What happened: moving the media panel into the upper row halved its height. At the battery's default 1280x577 viewport the lower media cards fell below the fold, so the visible-only accessibility refs in `f02_add` skipped the image, `f01b` could not scroll to its Remove button, and the prefix run failed even though the desktop grid was correct.
Would-have-caught: running the prefix battery immediately after the panel-tree change, then auditing every battery step that clicks a media-bin target by snapshot ref instead of assuming the change only affected the two time-format prefixes.
Action: kept as a note; a layout change that shortens a scrollable panel gets a battery audit for visible-only refs, and the affected steps scroll their targets into view.

## 2026-10-27 - a jsdom runtime test could not drive the panel layout observer

What happened: a review asked to replace the `handleUpperRowLayout` source lock with a jsdom runtime test that hides the preview and asserts sizes are not persisted. Rendering `EditorShell`, hiding the preview and pumping the mock frames produced zero `onLayout`/`setSize` calls because `react-resizable-panels` cannot measure layout in jsdom.
Would-have-caught: probing the observer with a mount-time spy before writing the test, then checking the repo's own flakiness rule that jsdom must not be asked to do real layout.
Action: kept as a note; panel-layout persistence gets a static wiring lock plus a browser proof, not a jsdom layout test.

## 2026-10-27 - a video asset on an audio-only clip still planned a filmstrip

What happened: `filmstripSamples` gated on `asset.kind === 'video'` but not `clip.audioOnly`, so the audio twin of an A/V pair drew picture cells. The jsdom audio-clip test caught it.
Would-have-caught: checking every media predicate against the pair's `audioOnly` flag, the way `hasLinkedAudioTwin` and `clipRendersAudio` already do.
Action: kept as a note; the planner rejects `audioOnly` in both the video sampler and the image plan, and the pure test names the case.

## 2026-10-27 - a failed strip stayed failed after relinking its asset

What happened: a seek failure was recorded in `settledKeys`, and relink only disposed cached entries, not that failure marker. The relinked clip reused the same key and never retried.
Would-have-caught: tracing every invalidation path through BOTH the entry map and the failure set, not just the entries.
Action: kept as a note; `settledKeys` is keyed by asset id, `dropAsset` clears that asset's failures, and a relink-retry test locks it.

## 2026-10-27 - a move re-requested the filmstrip through the plan object

What happened: the component's request effect depended on the memoized plan object, which is recreated when the clip object changes on a move. The cache reused the entry, but the effect cleared the ready flag and re-requested after the debounce.
Would-have-caught: depending on the cache key and asset URL, not on an object whose identity changes without the source window changing.
Action: kept as a note; the effect keys on `plan.key` and `asset.url`, and the move-reuse render test fails on the object dependency.

## 2026-10-30 - a post-seek guard assumed every target seeks the element

What happened: the recovery's "seek could not be applied" check compared the element position for every skip target. Audio-only clips are not positioned by `drawStill`, a reverse clip's target at `clip.duration` is outside its active window, and a sequence-end target is intentionally past the clip, so all three false-terminalized once the full suite ran.
Would-have-caught: running the whole playback suite after adding a post-commit guard, and checking the guard against the same active-window and element-kind rules `drawStill` uses.
Action: kept as a note; the guard only runs for a video element whose clip is active at the target with no slack.

## 2026-10-30 - UrlSource over a blob URL timed out the keyframe lookup

What happened: the keyframe helper used mediabunny's `UrlSource` for the element's blob URL. The 127 MB file issued whole-file and tail range requests and hit the 3 s timeout, so the manual proof always took the 6 s fallback even though the next keyframe was known.
Would-have-caught: testing the helper against the actual blob URL in the browser, not only a mocked `UrlSource`, and checking the fetch pattern before accepting the timeout.
Action: kept as a note; a blob URL is fetched once and read through `BlobSource`, which finds the keyframe in about a second; `UrlSource` remains for http(s) sources.

## 2026-10-30 - a keyframe timeout started after the async source setup

What happened: `nextVideoKeyframe` started its 3 s timer only after the blob fetch, the blob read, and `Input` construction. A slow fetch was unbounded, and an `Input` created after the race returned would have leaked.
Would-have-caught: placing the timeout before the first await in the bounded operation, and testing a fetch that resolves after the deadline.
Action: kept as a note; the timer covers the whole lookup, a late `Input` disposes itself, and the slow-fetch test locks both.

## 2026-10-31 - a user pause was overridden by the project-replacement drain

What happened: the recovery finally treated every cancellation with a changed project epoch as a replacement and drained deferred errors. A pause also bumped the recovery epoch, so a pause combined with a project replacement let the stale recovery start a new recovery despite the user's pause.
Would-have-caught: combining pause with project replacement and asserting the pause still suppresses the stale recovery's deferred work.
Action: kept as a note; the finally compares the recovery epoch to distinguish a user pause/seek/play from a project-only change, and only the latter drains.

## 2026-10-31 - a reused clip id hid the new project's error behind the old recovery

What happened: `recoveryInFlight` stored only a clip id. Reopening a project that reused the id made the paused refresh skip that clip, and `handleElementError` ignored its code 3 as a duplicate of the old recovery. The old recovery then exited on the epoch change without syncing the clip, so its error stayed unhandled until another refresh.
Would-have-caught: replacing a project during an in-flight recovery with a document that reuses the clip id, then asserting the new clip is synced and recovered without another action.
Action: kept as a note; recovery ownership now records the project epoch, the refresh guard only skips a current-project recovery, and a stale recovery defers a same-id error for the new project instead of ignoring it.

## 2026-10-31 - a stale recovery cleared the new project's deferred error

What happened: replacing the project while a recovery awaited its keyframe lookup left `recoveryInFlight` set. The new project's first media error was deferred behind it, then the stale recovery's `finally` saw the cancellation and cleared the queue instead of dispatching it, so the paused preview stayed silent until another seek or play.
Would-have-caught: replacing the project during an in-flight recovery and asserting the new project's first error is handled without another user action.
Action: kept as a note; the `finally` distinguishes a project-epoch change from a user cancellation and drains deferred errors for the new project, and the regression test holds the old lookup, replaces the project, and asserts the new clip recovers.

## 2026-10-30 - a resumed failed reload lost its attempt budget

What happened: a failed reload released the element and returned without resuming, so playback stopped silently. Resuming exposed a second issue: `clearPassedRecovery` deleted the record as soon as the playhead passed `failedTo`, which reset the three-attempt budget after a failed reload.
Would-have-caught: resuming on the failure path and tracing the record through the next `syncMedia`, including the no-skip case.
Action: kept as a note; a failed reload resumes when it was playing (not at the sequence end), and only a committed skip clears its record on playback pass.

## 2026-10-31 - a pool teardown load reported a phantom decode

What happened: `ClipMediaPool.release` called `load()` on an empty source before deleting the map entry and before detaching the element's error listener. A synchronous error from that load could reach `handleElementError` as a real code 4 while the element was still pooled.
Would-have-caught: firing an error from the teardown load in the pool test and asserting the pool callback never sees it.
Action: kept as a note; teardown detaches its error listener first, release deletes the map entry before best-effort teardown, and a throwing pause is contained.

## 2026-10-31 - a cancelled recovery still owned its clip

What happened: `recoveryInFlight` stored only the clip id. After a seek recreated the element, or after a user action bumped the recovery epoch, a same-clip error was still treated as a duplicate of the cancelled recovery. The deferred queue was then cleared or drained with the wrong ownership.
Would-have-caught: seeking during a pending recovery, erroring the fresh element, and asserting the new position recovers without another action.
Action: kept as a note; recovery ownership records the element, user-action epoch, and project epoch. A pause discards deferred work, while a seek or play drains it for the new position.

## 2026-10-31 - terminal state outlived its clip and partner

What happened: a terminal clip was still resolved for the compositor, its parked blend partner stayed pooled and could keep playing after an error, and deleting the clip left its recovery record, notice range, and deferred error behind.
Would-have-caught: checking the compositor resolver and every state map after a terminal error, a partner error, and a clip deletion.
Action: kept as a note; the resolver skips terminal elements, terminalization releases the partner, partner errors pause it, and `releaseMissingClips` drops state for clip ids no longer in the doc.

## 2026-10-31 - a verified keyframe inside the still seek dead zone terminalized

What happened: recovery accepted a verified keyframe less than one frame ahead, but the post-commit element check required the element to reach the target within 1e-3. `drawStill` deliberately skips a seek inside `stillSeekEps`, so the element stayed at the error position and the recovery terminalized instead of using the keyframe.
Would-have-caught: testing the keyframe-any-positive-advance rule end to end, including the element position check, not only the source-target arithmetic.
Action: superseded on 2026-10-31 by the forced commit seek. Recovery now seeks the element to the keyframe even inside the dead zone, and the post-commit check requires 1e-3 for both keyframe and fallback targets.

## 2026-10-31 - a stale skip notice outlived its clip

What happened: recovery held its lock while `startPlayback` awaited `prepare()`. An ordinary edit during that window changed neither the recovery epoch nor the project epoch, and refresh skips the recovering element, so a removed or retimed clip could still emit a skip notice for its old timeline range.
Would-have-caught: holding `prepare()` after the commit, deleting or retiming the clip, then resolving the gate. A single-clip timeline hides the removal because the empty timeline ends playback and bumps the epoch.
Action: kept as a note; after the resume, recovery re-runs the pool, active-clip, and terminal guard and compares the source at the committed target with the committed source target before emitting.

## 2026-10-31 - an unexpected recovery throw vanished

What happened: the outer recovery catch was empty by design, so an unexpected throw left playback paused with no notice or diagnostic.
Would-have-caught: injecting a rejected reload and asserting the failure is logged while the lock still releases.
Action: kept as a note; the catch logs `[playback] decode recovery failed` with the clip id and error.

## 2026-10-31 - a forced keyframe commit and a stale record

What happened: the dead-zone tolerance accepted a near-start keyframe when `load()` left the element at zero, so the recovery emitted a skip notice without moving the element. Separately, a retime during the resume bailed without deleting the committed record, so a later error could reuse the old failed range and attempt budget.
Would-have-caught: holding a keyframe 0.01 s from the start with the element at zero, and retiming during the resume then asserting the record is gone.
Action: kept as a note; the commit uses a forced seek and a 1e-3 post-commit check, and a failed source comparison deletes the stale record.

## 2026-11-02 - paused resume re-seeked a parked element

What happened: `PlaybackCore.syncMedia` always called `seekElement` for a paused element. After the 0.18.0 WebCodecs paused path stopped seeking the `<video>` element, resume from 24.1 s with the element at 23.99 s forced a 0.7 s seek and a black canvas while the audio clock advanced; initial play at 0 forced a 0.0001 s seek that took 2.7 s on the 127 MB file.
Would-have-caught: pausing and resuming the real 127 MB file in Chrome and sampling canvas luminance and element `currentTime`, not only the unit tests.
Action: kept as a note; `syncMedia` now guards the paused seek with `START_SEEK_THRESHOLD`, and `primePlayback` warms the active elements (bounded by `PRIME_TIMEOUT_MS`) before the clock starts.

## 2026-11-02 - warmup trusted an in-flight seek and the worker key retry had no bound

What happened: `primePlayback` skipped a new seek when one was already in flight and never re-compared the landed position, so a stale seek could start the clock at the wrong frame. Separately, `scrub-worker`'s keyframe retry ran outside the decode timeout, so a stalled `getKeyPacket`/`getFirstKeyPacket` left `drain` on one clip and a replacement URL never ran.
Would-have-caught: holding a stale in-flight seek and asserting Play corrects it before `playingState`; stalling the key lookup and queuing a replacement URL for the same clip.
Action: kept as a note; `primeElement` waits, compares, and corrects before the clock, and `drain` bounds the complete attempt with a late-frame close.

## 2026-11-02 - a stalled thumbnail decode held the filmstrip lane

What happened: `ThumbnailCache.ensure` awaited `decodeFrame` without a timeout. `generateVideo` awaited `ensure`, `runJob` kept the only active lane, and `drainQueue` refused to start another job while active. A stalled track lookup or timestamp iterator blocked every later strip. `reset()` also left `assetEpochs` and `latestRun` populated.
Would-have-caught: stalling the injected decode and queueing a second filmstrip job; inspecting the two maps after reset.
Action: kept as a note; each decode run is bounded by `THUMBNAIL_DECODE_TIMEOUT_MS` with late frames closed, and reset clears both maps.

## 2026-11-02 - paused WebCodecs scrub dropped the blend pair

What happened: `resolveClip` returned the cached WebCodecs canvas or bitmap with no `blend`, and `drawStill` took the single-frame shortcut even for a sub-frame-rate clip. The compositor draws canvas and bitmap sources directly, so paused scrubbing of a slow clip lost the pair the element path and exporter use.
Would-have-caught: a 0.5x clip with a scrub sink, asserting the scrub request is not made and the primary and partner elements are drawn.
Action: kept as a note; sub-frame-rate clips bypass the scrub shortcut and use the parked element pair.

## 2026-11-02 - a thumbnail lookup outlived its run, and a blend clip blocked the preflight

What happened: `decodeThumbnailFrame` created an `Input` and awaited the track lookup before registering it, so a timeout or reset left that lookup running and a late result installed a dead Input. Separately, the paused render preflight still required a WebCodecs frame for every sink-backed clip, but a sub-frame-rate clip never requests one because it renders through the element pair, so the whole composite could return early.
Would-have-caught: resolving a stalled lookup after the timeout/reset and inspecting the shared map; pausing a 0.5x clip with an empty scrub cache and asserting the element pair still draws.
Action: each decode run now owns its Input across the lookup and disposes it on timeout, reset, or drop; the preflight skips clips with a blend partner, and a blend clip is only recorded as a scrub fallback when its sink is unavailable.

## 2026-11-02 - stale thumbnail cancellation rejected like a decode failure

What happened: a drop or reset cancelled a thumbnail decode and `ensure` rejected with the cancellation error. The only caller treats rejection as a decode failure and falls through to per-frame element seeks, so a run nobody wanted still looked like a fault.
Would-have-caught: cancelling a pending default-decoder lookup with a drop and a reset, then asserting the promise resolves while the Input is disposed and never registered.
Action: cancellation now throws a distinct error, and `ensure` resolves it only when the run is stale. Timeouts and genuine decode failures still reject, and the filmstrip caller stops before its prefetch decode when the job was cancelled.

## 2026-11-04 - audio recovery contract change collided with old fallback locks

What happened: the in-place audio recovery made `an audio-only element uses the source-time fallback` and the deferred-error audio fixture assert the removed six-second skip, so the focused suite went red until both were rewritten around the new contract.
Would-have-caught: trigger 6 read as "a behavior change makes every test that asserts the old behavior an affected test," and trigger 5's rule that a rewritten lock still covers the invariant, not only the new path.
Action: kept as a note; the audio tests now assert no timeline move and a muted fallback, and the deferred-error test still proves one reload and no replay.

## 2026-11-04 - audio-only notice shared the picture-damage slot

What happened: the 0.19.1 toast effect read an audio-only notice from `mediaError`, showed the toast, then called `clearMediaError()`. A terminal video notice written between the render and the passive effect would be erased, leaving a paused preview with no overlay. The review found it after the full gate was green.
Would-have-caught: trigger 2 traced the notice from `PlaybackCore` to the store but stopped at the UI effect; the ownership rule is that a transient toast must not share a slot with a persistent overlay notice.
Action: kept as a note; `preview.ts` now toasts audio-only notices in its `onMediaError` wiring and never calls `setMediaError` for them, and the UI test proves a picture-damage notice survives.

## 2026-11-05 - end-of-playback skip clear and audio error code routing

What happened: `clearPassedRecovery` only cleared after the playhead passed `failedTo` by one second plus a frame, but `tick` stops at the sequence end, so a committed skip inside that window never cleared. Separately, `handleElementError` routed every active `<audio>` error into decode recovery before reading `MediaError.code`, and the toast always said "Audio could not be decoded", so a code 4 source was retried and mislabeled. Both findings survived a green full gate.
Would-have-caught: asserting the last `onMediaError(null)` after a skip near the end, and setting code 2 or 4 on an audio element and checking both the retry decision and the toast title.
Action: kept as a note; the final sync clears committed skips with `atEnd`, audio routes code 1 and 4 to immediate mute, and `preview.ts` maps the code to a cause-specific title.

## 2026-11-05 - audio recovery exception escaped the single-flight contract

What happened: `handleElementError` intentionally routes audio before the video `recoveryInFlight` gate, but the architecture and flow docs described recovery as single-flight without the exception, and no test held a video recovery open while an audio error arrived.
Would-have-caught: trigger 2 traced the branch but stopped at the comment; when a code path deliberately bypasses a shared gate, the documented contract and the test matrix both need an exception line.
Action: kept as a note; the docs now name the audio exception and a lock holds a video recovery open while audio recovers in place.

## 2026-11-07 - `bun update` added transitive tools as runtime dependencies

What happened: `bun update vite source-map-js picomatch browserslist @humanfs/node ajv minimatch` put those packages in `package.json` `dependencies` because Bun 1.3 treats an unknown transitive name as a direct add. The plan forbids runtime dependency changes.
Would-have-caught: trigger 1's baseline plus `git diff -- package.json` immediately after every package-manager command, before any audit or gate work.
Action: removed the added entries, kept dev-only overrides, and verified the 24 direct runtime versions are unchanged against `HEAD:bun.lock`.

## 2026-11-07 - stale artifact server made a battery run invalid

What happened: a manual-pass server from an earlier build was still holding port 3001. The new `PORT=3001 bun run start` failed with EADDRINUSE, but the probe still saw HTTP 200 from the old server. The artifact battery then ran against the old 0.19.3 build and failed nine steps because the 0.19.4 release notes marker no longer matched.
Would-have-caught: trigger 1's server check read as a hard precondition: a non-000 probe before starting means stop and identify the owning process, not proceed. Also verify the release version in the served chunk before the battery.
Action: stopped the stale process group, confirmed 3001 was free, started the fresh 0.19.4 build, and reran the battery to 70/70. The invalid result was not reported.

## 2026-11-07 - Bun 1.3.14 has no nested or version-scoped overrides

What happened: the plan called for parent-scoped overrides for `minimatch`, `brace-expansion`, and `picomatch`. Bun 1.3.14 warns that nested overrides are unsupported and ignores `pkg@^range` keys. Top-level pins would force a cross-major version into `typescript-estree` or Vite.
Would-have-caught: check the installed package-manager version and its override feature set before writing a plan that depends on nested overrides.
Action: kept the safe top-level fixes, documented the remaining three dev-only package families, and deferred the parent-scoped pins to a Bun 1.4 tooling change.

## 2026-11-08 - release commit composition

What happened: the 0.19.4 release bundled CSP enforcement, a dev-tooling
refresh, and four hook fixes in one commit. A reviewer flagged the release as
hard to bisect, though each change was individually correct and the fixes were
forced by the tooling gate.
Would-have-caught: one ticket, one commit, one gate (scope discipline).
Action: kept as a note.

## 2026-11-09 - moving shared logic leaves static-source locks behind

What happened: Wave 2a moved the shaping chain into `audio-chain.ts`, but three
separate static-source locks still asserted the old inline calls in
`core.ts`/`mp4.ts` (`denoise.test.ts`, `effect-controls-ui.test.ts`), and Wave 2b
left `proxy.test.ts` asserting the old per-component revoke/replace order. Each
was caught only by a full `bun run check`, one red rung at a time.
Would-have-caught: trigger 4's caller sweep must include tests that assert on the
moved source text, not only runtime importers. Grep the old call shape across
`src/**/__tests__` before declaring the refactor done.
Action: kept as a note; the gates now assert the shared builder/install path, and
Wave 2b's proxy lock reads the one install implementation instead of each caller.

## 2026-11-10 - sanitizing a clamp changed the shape a static lock asserted

What happened: wrapping the audio EQ clamp in `clampAudioValue` to neutralize NaN
made `effect-controls-ui.test.ts` fail its literal `clamp(clip.eq.<band>, ...)`
source assertion during `bun run check`.
Would-have-caught: the 2026-11-09 lesson applies to any source-shape change, not
only moved modules. Grep the old call shape across `src/**/__tests__` before
running the gate.
Action: kept as a note; the lock now asserts
`clampAudioValue(clip.eq.<band>, EQ_DB_MIN, EQ_DB_MAX)` for all three bands, and
the runtime NaN/infinity cases live in `audio-chain.test.ts`.

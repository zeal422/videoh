# PLAN 07: Integration, visual audit, and release

Status: planned
Depends on: [PLAN 01](PLAN-01-REFERENCE-AND-SPEC.md), [PLAN 02](PLAN-02-GEOMETRY-AND-CHROME.md),
[PLAN 03](PLAN-03-FILMSTRIPS.md), [PLAN 04](PLAN-04-VOLUME-AUTOMATION.md),
[PLAN 05](PLAN-05-TRACK-CONTROLS.md), [PLAN 06A](PLAN-06A-RIPPLE-SLIP.md),
[PLAN 06B](PLAN-06B-KEYFRAME-PEN.md)
Release: no-version QA gate for `0.16.0`; any post-tag fix becomes `0.16.1`
Goal: prove the whole epic, capture the real hero screenshot, retire the local reference, and hand a
release-ready tree to the user.

## Scope

1. Full visual audit against the local reference.
2. Every visible control checklist.
3. Full test, build, and battery proof.
4. Docs and release notes.
5. Real hero capture.
6. Reference retirement.
7. Final report.

## Non-goals

- No new feature work. If the audit finds a gap, it goes back to the owning plan, not into this one
  as a silent fix.
- No new visual direction.
- No publishing, tagging, pushing, or deploying. The user does that.
- No use of the reference image as a public asset.

## 1. Visual audit

Run the editor with the Plan 01 demo fixture at 1600x1000. Use the same workspace state as the
reference: Source hidden, fixed panel shares, fixed zoom, paused playback, fixed playhead, and fixed
selection.

For each region, record pass, gap, or owning plan:

- Menu bar: wordmark, nine menus, full screen, version.
- Toolbar: every group, every tool, active state, tooltip, placement modes, project name, IO,
  export.
- Media bin: heading, import, sample, cards, thumbnails, metadata, hover actions, selection,
  offline state.
- Program monitor: canvas, scopes, transport, padded time, volume.
- Inspector: tabs, Clip summary, timing, opacity, blend, dB volume, color, transition, Effect
  Controls, speed, keyframe graph.
- Timeline: ruler, playhead, snap, track headers, target, eye, mute, M/S, lock, video filmstrips,
  audio envelopes, labels, linked badges, trim handles, context menus.
- Status bar: project, format, duration, selection, track counts, autosave.
- Panel frame: headers, chevrons, handles, collapse strips, reset layout.
- Responsive: 1600x1000, 1280x800, 1024x768 narrow desktop, 390x844 mobile.

The audit is a checklist, not a pixel diff. The reference's content is different by design.

## 2. Every visible control works

Build a control table from the Plan 01 inventory. For each visible control, prove one of:

- It dispatches a command or changes a real view state.
- It is disabled for a documented precondition.
- It is removed because it has no behavior.

No dead icon is acceptable, including hover-only icons. Pay special attention to:

- Wordmark link.
- Every toolbar button.
- Media card actions.
- Track target, eye, mute, solo, lock.
- Inspector tabs and every control.
- Timeline tools, context menus, trim, zoom, scroll.
- Status bar autosave indicator.

If a control is missing from the reference but exists in the app, keep it if it works. The reference
is not a removal mandate.

## 3. Full gate

Run, in this order:

```bash
bun run check
```

This covers format, lint, typecheck, tests, and the production build. Read the tail. A red step is
fixed at its cause. Do not skip or suppress.

Then run `bun run test:coverage`. `bun run check` does not enforce coverage. The thresholds in
`vitest.config.ts` are statements 70, branches 60, functions 75, and lines 70. A miss fails the
gate; do not lower the thresholds.

Then run the browser proof:

- Dev server check first. Start only if the port is free. Stop only a server the agent started.
- Full dev battery with `DETACH=1` if the harness may clean up background children.
- Build, serve the standalone artifact, and run the full battery against it.
- Keep `e2e/battery.sh` and `e2e/battery.timing.sh` in sync. Verify both register the same
  post-change step count with `grep -c '^step ' e2e/battery.sh e2e/battery.timing.sh`. The count is
  not fixed at 63; Plan 06 may add steps.
- The verdict must be complete. A killed run is not a pass.
- If steps were added, the documented battery count moves with them.
- Close every browser session.
- Verify the port is free if the agent started the server.

The battery verdict is the release verdict. Do not report a prefix run as a full pass.

## 4. Docs and release notes

Release-bearing plans already bumped their versions. This plan checks the whole atomic set:

- `package.json`.
- `src/lib/releases.ts` with an ISO date and at least four real highlights.
- `CHANGELOG.md` with a `## [x.y.z] - <date>` entry.
- `ROADMAP.md`.
- `README.md` feature list, test and battery counts, screenshot tree.
- `AGENTS.md` test and battery counts, if they move.
- `docs/architecture.md`, `docs/flows.md`, `docs/design-system.md`, `docs/testing.md`,
  `docs/structure.md`, and any doc that records the version or counts.
- `docs/seo.md`: check the screenshot-alt checklist unconditionally, even if the metadata itself
  does not change. The alt text is expected to change.
- The shortcuts dialog and README keyboard table for B/Y/P and any new keys.
- `TO_FIX.md`: remove or mark the filmstrip feature done. The file is local and gitignored.
- `public/screenshots/editor.png`, the hero alt text in `src/components/site/Hero.tsx`, and its
  mirror in `src/lib/editor/__tests__/public-pages.render.test.tsx`.

If the last release gate has not bumped the version yet, do it here before capture. This plan should
not need a version bump when Plan 06 already landed `0.15.0`. If Plan 06 split, the target is
`0.16.0` instead. If fixes are needed after the tag, use a patch release (`0.15.1` or `0.16.1`) with
its own atomic bump, changelog entry, and release notes; do not silently move the last tag.

## 5. Real hero capture

Requirements:

- Use the running production-style build, not a mock and not the reference.
- 1600x1000, editor only.
- Demo fixture with filmstrips, volume envelopes, track controls, and tools visible.
- Playback paused. Use the playhead, zoom, and selection recorded in Plan 01 section 6; do not choose
  new values for the hero.
- Wait for fonts and `data-filmstrips-ready` on the timeline root. The marker covers every mounted
  strip, including fallbacks.
- No browser chrome, no dev overlays, no console errors.
- Save to `public/screenshots/editor.png` at the documented dimensions.
- Update `src/components/site/Hero.tsx` alt text to describe what is actually in the capture, and
  update the mirror constant in `src/lib/editor/__tests__/public-pages.render.test.tsx`. A component
  change without the test constant fails `bun run check`.
- Check the photo attribution in `docs/design-system.md`. The parity fixture uses the bundled
  sample image, not the old Unsplash night-city photo. If the capture no longer contains that photo,
  remove the credit and describe the actual sample media. Do not carry a false attribution forward.
- Hero content decision: the current public capture's night-city image is not in the repo. Before
  this final capture, the owner must either supply that image or an owned replacement, or accept the
  bundled sample image. In the second case, update the alt text and remove the Unsplash credit in
  the same change. Do not publish a mismatched image, alt text, and credit.
- Verify the image in the built site, not only in the dev server.
- `next/image` dimensions, `sizes`, and preload stay consistent.

The reference image is never used as the hero. It is deleted at the end of this plan.

## 6. Reference retirement

After the real capture passes:

- Delete `.design/editor-parity/`.
- Confirm `git status --short` shows no reference image or local design folder.
- Mark every plan `done` in the orchestrator.
- Keep the written plans as the historical record.
- Do not add the reference image to a release asset, issue, or public doc.

If the owner wants to keep the image privately, it moves outside the repo. The repo does not carry
it after this plan.

## 7. Final report

The handoff must state:

- What changed, plan by plan.
- What was proven and how: unit, mocked browser, static lock, browser proof, full battery.
- The full test count and battery result.
- The version and release notes.
- What was skipped and why.
- Any remaining risk or known limitation.
- Confirmation that no server, browser session, or scratch worktree is running.
- Confirmation that the user still owns the commit, push, tag, and deployment.

## Acceptance criteria

- The visual audit has no open gap outside a documented owning plan.
- Every visible control has a working behavior or is removed.
- `bun run check` is green.
- `bun run test:coverage` meets the statements 70, branches 60, functions 75, and lines 70
  thresholds.
- The full dev battery and standalone artifact battery are green and complete.
- The hero screenshot is a real capture and the alt text matches it.
- The local reference is deleted and not in git.
- All plans are marked `done`.
- Docs, version, changelog, and counts are in sync. The expected version is `0.15.0`, or `0.16.0`
  if Plan 06 split; any post-tag fix is a patch with its own atomic bump and entry.
- No process or session is left running.
- The user has a release-ready tree and the final report.

## Risks

- **Late visual gap.** Mitigation: return it to the owning plan; do not patch it silently here.
- **Battery flake.** Mitigation: use `DETACH=1`, read the full verdict, and never report a killed
  run.
- **Stale screenshot.** Mitigation: capture from the final build and verify it in the built site.
- **Reference leak.** Mitigation: delete the local folder and verify git status before handoff.
- **Version drift.** Mitigation: run the atomic version checklist and `releases.test.ts` through
  the full gate.

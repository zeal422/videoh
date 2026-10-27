# PLAN 03: Sampled filmstrip thumbnails

Status: planned
Depends on: [PLAN 01](PLAN-01-REFERENCE-AND-SPEC.md), [PLAN 02](PLAN-02-GEOMETRY-AND-CHROME.md)
Release: `0.12.0` with Plan 02's chrome
Goal: draw sampled source frames inside video clips and the source image inside image clips, without
touching the project document, undo history, serialization, or playback engine.

## Why this is the headline feature

A repeated poster thumbnail looks like a filmstrip at a glance and fails the moment the clip is
trimmed, reversed, speed-changed, or zoomed. The strip must sample the clip's actual source window.
The reference shows different frames across each clip, and that is the behavior to match.

For an image clip there is only one source frame. The honest result is the image itself, cropped or
stretched to the clip. Do not fabricate a sequence of frames.

## Scope

1. A pure sampling planner.
2. A runtime filmstrip cache.
3. A `ClipView` filmstrip layer.
4. Invalidation and cancellation.
5. The video waveform rule for linked pairs.
6. Tests, browser proof, and release tasks.

## Non-goals

- No filmstrip data in `Doc`, autosave, project JSON, or `MediaAsset`.
- No new media files or new thumbnail sizes in the project file.
- No WebCodecs frame-accurate filmstrip in the first pass. The spike in Plan 01 decides whether the
  hidden-video path is enough.
- No changes to clip gestures, trim behavior, labels, badges, or transition rendering.
- No audio filmstrips. Audio keeps its waveform.

## Current state to verify

- `src/lib/editor/types.ts`: `MediaAsset.thumbnail` is a single JPEG data URL.
- `src/lib/editor/media/probe.ts`: `makeThumbnail` caps the poster at 160px wide.
- `src/lib/editor/factories.ts`: `sourceTimeAt` is the source-time mapping for speed, reverse, and
  time remapping.
- `src/components/editor/timeline/ClipView.tsx`: waveform draws for any audio-bearing asset,
  including video; label and trim handles are absolutely positioned.
- `src/components/editor/timeline/Waveform.tsx`: canvas waveform. It already caps its width at
  8000px and buckets to 8px; filmstrips use a stricter 4096px cap because the cache budget is shared.
- `src/lib/editor/persistence.ts`: autosave writes the serialized doc to localStorage.
- `src/lib/editor/serialization.ts`: serializes the poster thumbnail; it must not learn a filmstrip
  field.

## 1. Pure sampling planner

Create `src/lib/editor/filmstrip.ts` as a pure module. No DOM, no video element, no React.

API shape:

- Declare hard bounds: `MAX_STRIP_WIDTH = 4096`, `MAX_STRIP_HEIGHT = 64`, and
  `MAX_STRIP_PIXELS = MAX_STRIP_WIDTH * MAX_STRIP_HEIGHT`. These are safety limits, not tuning
  knobs.
- `filmstripFrameCount(widthPx)`: return `0` when `widthPx < 24`. Otherwise compute
  `widthBucket = Math.min(MAX_STRIP_WIDTH, Math.max(64, Math.round(widthPx / 64) * 64))` and return
  `clamp(widthBucket / 64, 4, 24)`. The bucket is capped before the count so a long clip cannot
  request a huge canvas.
- `filmstripSamples(clip, asset, widthPx, heightPx)`: takes the `MediaAsset | undefined` so it can
  reject missing, audio, image, and text sources. Returns
  `{ frames, widthBucket, heightBucket }` or `null` when no strip should be drawn. `heightBucket` is
  `Math.min(MAX_STRIP_HEIGHT, Math.max(1, Math.round(heightPx)))`; `frames` is an array of
  `{ local, sourceTime, x }` and `x` is the normalized 0..1 cell center.
- `filmstripCanvasFits(widthBucket, heightBucket)`: true only for finite, positive dimensions with
  `widthBucket * heightBucket <= MAX_STRIP_PIXELS`. The component calls it before creating a canvas.
- `filmstripCacheKey(clip, asset, widthBucket, heightBucket)`: for video assets includes media id,
  `inPoint`, `duration`, `speed`, `reverse`, the time-scale curve identity, and the capped buckets.
  For image assets it returns `image:${asset.id}:${widthBucket}x${heightBucket}`; trim, speed,
  reverse, and time scale do not apply to a single frame. A clip wider than the cap reuses the
  max-width strip instead of generating a distinct huge one.
- A 1-hour clip at 400 px/s has a layout width of 1,440,000px. Its `widthBucket` is 4096. The canvas
  is CSS-scaled to the clip; the backing canvas is never 1,440,000px wide.
- The component sets a boolean `data-filmstrip-ready` attribute on each strip element after the
  canvas or the poster fallback is painted. A new key clears it.
- The timeline root sets `data-filmstrips-ready` only when every mounted video or image clip with a
  strip request has settled (canvas or fallback). Any new request clears it. Screenshot procedures
  wait on this root marker, not on a hand-picked clip. The per-strip attribute stays for debugging.
  No separate pure ready-state predicate is needed.

Expected frame counts for the tests:

| Width   | Count |
| ------- | ----- |
| 0       | 0     |
| 23      | 0     |
| 24      | 4     |
| 25      | 4     |
| 100     | 4     |
| 500     | 8     |
| 2000    | 24    |
| 5000    | 24    |
| 1440000 | 24    |

Sampling rules:

- Return no frames when `asset` is undefined, `asset.missing`, `asset.kind !== 'video'`, the clip is
  a text or compound clip, or `clip.duration <= 0`.
- Use `sourceTimeAt(clip, local)` for every sample.
- Sample at the center of each cell: `local = (i + 0.5) / count * clip.duration`, clamped into the
  clip. The rule is fixed and tested, not chosen per render.
- Clamp source times to `[0, Math.max(0, asset.duration - SOURCE_END_MARGIN)]`, matching
  `clampSourceTime`. An asset shorter than the margin clamps to 0, never a negative upper bound.
- A reversed clip samples its source in the reversed direction naturally through `sourceTimeAt`.
- A speed-changed clip consumes the correct source span.
- A time-remapped clip uses the curve. If the curve changes, the cache key changes.
- The planner never returns NaN, negative times, or times past the asset end.

Why `sourceTimeAt`: raw `inPoint + fraction * duration` ignores speed, reverse, and time remapping.
A filmstrip that shows the wrong frames is worse than no filmstrip.

## 2. Runtime cache

Create a browser module at `src/lib/editor/media/filmstrip-cache.ts`. Keep it browser-bound, beside
`probe.ts` and `proxies.ts`.

Requirements:

- One cache entry per key. Entries hold a canvas or `ImageBitmap`, not a data URL.
- Every path that drops an entry releases its graphics memory through one `disposeEntry` helper:
  call `ImageBitmap.close()` for a bitmap entry, and set `width = 0` and `height = 0` on a canvas
  entry to release its backing store. Run it on LRU eviction, relink invalidation, asset removal,
  and project replacement.
- The component owns its display canvas and draws the cache entry into it. A cache entry is never
  the mounted DOM canvas, so disposing an evicted entry cannot blank a live clip.
- LRU eviction with a cap. Start with 40 entries and a 16-megapixel total budget. Both are
  constants, not magic numbers. Count the budget in capped canvas pixels, not layout pixels.
- A single strip cannot exceed `MAX_STRIP_PIXELS`. At 4096x44, 40 entries are 7.2MP; at 4096x64,
  they are 10.5MP. Both fit the 16MP budget with headroom. Evict before adding if needed.
- Before creating a canvas, call `filmstripCanvasFits(widthBucket, heightBucket)`. If it returns
  false, use the poster fallback, mark the request settled, and do not allocate the canvas.
- The canvas backing size is `widthBucket` by `heightBucket`, not the clip's layout width or height.
  CSS stretches the capped canvas to the clip width.
- One global generation job at a time. This protects playback and keeps the cache deterministic.
- Queue every distinct key. Do not keep only the most recent request: dropping a distinct mounted
  clip's request leaves its strip unsettled and blocks the root ready marker.
- Drain the queue in FIFO order. A new distinct key appends to the tail. A superseding request for a
  queued same-clip key replaces that entry in place so it does not jump ahead of other clips.
- Supersede a request only when a newer request replaces the same clip's generation (a trim, zoom,
  or curve change) or when its clip unmounts, its media disappears, or the project is replaced. Keep
  other clips' queued requests.
- Deduplicate concurrent requests for the same key. If a queued key is stale for that same clip,
  replace it with the newest key; do not cancel a different clip's key.
- A generation token per request. A stale token cannot install a strip after the clip changed,
  unmounted, lost its media, or the project was replaced.
- The cache exposes a pending-request count or subscription so the timeline root can set
  `data-filmstrips-ready` when all mounted requests settle. The root does not coordinate with each
  ClipView directly.
- Cancel or ignore a job when its `ClipView` unmounts or its key changes.
- One hidden video element per asset, reused across requests, cleaned up when the asset is removed.
  Use the original `asset.url`, not a proxy. Proxies are a playback concern and add a second
  invalidation axis; revisit only if the Plan 01 spike fails on heavy media.
- Detect asset removal through the same editor-root store update that drives relink and project
  replacement, or an explicit `syncAssets(doc.media, doc.project.id)` call from that root. On
  removal, dispose that asset's element (`src = ''`, `load()`), `disposeEntry` every entry for the
  asset, and settle pending requests. Project replacement calls `disposeAll()` unconditionally;
  `disposeAll` closes bitmaps, zeroes canvases, and disposes every hidden element. Do not poll.
- `preload="auto"`, `muted`, `playsInline`. No audio graph node.
- Seek sequentially, await `seeked`, draw the frame, advance. Do not seek in parallel on the same
  element.
- Draw at the source aspect, cropped to the strip cell with `object-fit: cover` math. `frames[].x` is
  normalized 0..1; the canvas places it at `x * widthBucket`, so two clips in one bucket share the
  same sampling.
- A failed load, decode, or draw returns a typed "unavailable" result, not an exception that
  escapes to React.
- Invalidate on relink, media removal, and project replacement. A new asset URL or file handle is a
  new generation. Relink `disposeEntry`s the old entries before dropping them. Project replacement
  also clears and disposes every cache entry, cancels jobs, and disposes the hidden elements
  (`src = ''`, `load()`, drop the map entry), not just the LRU list.
- Do not use the project poster as a fake strip. The poster is the fallback while loading and when
  the strip is unavailable.

Fallback order:

1. Cached strip for the current key.
2. The previous strip for the same clip while the new one loads, if its key differs only by width
   bucket.
3. `asset.thumbnail`.
4. The missing-media styling.

## 3. ClipView layer

Create `src/components/editor/timeline/Filmstrip.tsx`. The component receives the clip, asset,
width, and height, and handles the debounced request.

Layer order inside the clip:

1. Filmstrip canvas, absolute inset 0, clipped by the rounded border.
2. A subtle top and bottom scrim for label readability.
3. Fade and transition overlays, preserving the current order.
4. Waveform, if this clip should show one.
5. Label, linked badge, speed and reverse badges, transition badge.
6. Trim handles and markers.

Rules:

- The filmstrip must not intercept pointer events. `pointer-events-none` on the canvas.
- Before creating the canvas, call `filmstripCanvasFits(samples.widthBucket, samples.heightBucket)`.
  If false, render the poster fallback, mark the strip settled, and do not allocate the canvas.
- Keep the existing clip background color visible at the edges and behind unfilled cells. The strip
  uses a cover crop, so there are no letterboxed frames.
- Do not cover the label or the linked badge.
- Do not change the selection ring, hover, razor cursor, or context menu.
- Do not regenerate during a live trim, rate stretch, or move. Use a short debounce after the
  gesture settles. Moving a clip does not change its source window, so a move should reuse the
  strip.
- Width bucket: round to 64px steps, capped at `MAX_STRIP_WIDTH`. Height bucket: round to the track
  height, capped at `MAX_STRIP_HEIGHT`. A zoom that stays in the same bucket, or goes past the cap,
  reuses the strip. Set the canvas `width`/`height` attributes to the capped buckets and let CSS use
  `width: 100%`.
- A clip narrower than 24px shows no strip, only the color block and label.
- An offline or missing-media clip keeps the dashed red styling and no strip.

Image clips:

- Draw the image once, cropped to fill the clip, with no sampling.
- Use the image key from `filmstripCacheKey`: media id plus capped width and height buckets. Do not
  include the video-only trim, speed, reverse, or time-scale fields.
- Do not tile the poster as if it were video.

## 4. Video waveform rule

Today `ClipView` draws a waveform for any asset with peaks, including a video clip that already has
a linked audio twin. The reference keeps the video half clean.

Rule:

- If a video clip has a linked audio twin, do not draw the waveform on the video half. The twin
  carries the sound and shows the waveform.
- If a video clip has no twin, keep its waveform. A solo video's embedded audio still exists.
- Audio clips keep their waveform.
- Image and text clips keep no waveform.

This is a behavior change, so add a render test for both cases. Do not change the audio routing; the
twin is already the sole carrier.

## 5. Invalidation matrix

Cover this matrix in tests. A row with no test is an incomplete plan.

| Event                      | Expected result                               |
| -------------------------- | --------------------------------------------- |
| Trim head or tail          | New key, regenerate after the gesture settles |
| Speed change               | New key, regenerate                           |
| Reverse toggle             | New key, regenerate                           |
| Time-remap keyframe edit   | New key, regenerate                           |
| Move to another track      | Same key, reuse                               |
| Zoom within a width bucket | Same key, reuse                               |
| Zoom across a bucket       | New key, regenerate after a debounce          |
| Relink media               | New asset generation, dispose old entries     |
| Remove media               | Dispose and drop entries and hidden element   |
| Replace project            | Dispose and clear the whole cache             |
| Unmount clip               | Cancel pending job                            |
| Offline media              | No job, show the missing styling              |
| Image clip                 | One draw, no seek                             |
| Text or audio clip         | No strip                                      |

## 6. Tests

Pure tests (`filmstrip.test.ts`):

- Frame count at 0, 23, 24, 25, 100, 500, 2000, 5000, and 1,440,000px matches the table in section 1.
  The last two hit `MAX_STRIP_WIDTH` and still return 24 frames.
- `filmstripSamples` receives the asset and rejects missing, audio, image, text, and compound clips.
- `filmstripSamples` caps `widthBucket` at 4096 and `heightBucket` at 64 for oversized inputs.
- `filmstripCanvasFits(4096, 64)` is true. `(4097, 64)`, `(4096, 65)`, `(0, 44)`, and a non-finite
  dimension are false.
- Sample count and normalized x spacing.
- Forward clip: source times match `sourceTimeAt`, and the static-speed case matches
  `inPoint + local * speed`.
- Trimmed clip: starts at the new `inPoint`.
- Reversed clip: source times descend as local increases, matching `sourceTimeAt`.
- Speed 0.5 and 2: source span matches.
- Time-remap curve: source times follow the curve and the key changes when the curve changes.
- Clamp at asset end.
- An asset shorter than `SOURCE_END_MARGIN` (for example 0.005s) returns source time 0, not a
  negative value.
- Zero duration, missing asset, image, audio, text, compound: no samples.
- Cache key changes on trim, speed, reverse, curve, and width bucket; unchanged on move and same
  bucket.
- Two widths in the same 64px bucket produce the same key and the same normalized samples.
- Two widths above `MAX_STRIP_WIDTH` share the max-width bucket and the same key when the other key
  fields match.
- No NaN, negative, or past-end values.

Cache tests with the mocked browser harness:

- A request draws N frames and installs one strip.
- Two requests for the same key share one job.
- Two distinct clips request while one job runs. Both install in turn, and the root marker sets
  only after both settle. Superseding clip A does not cancel clip B.
- The pending count tracks distinct queued keys; a superseded same-clip request settles or is
  removed without leaving the count stuck.
- A stale token cannot install after a newer key.
- The root `data-filmstrips-ready` marker clears on a new request and sets only when every mounted
  strip has settled; a poster fallback counts as settled.
- Unmount cancels or ignores the pending job.
- Seek failure falls back to the poster and does not throw.
- Relink invalidates the old entry and disposes it before dropping it.
- LRU evicts the least recently used entry at the cap and disposes it: bitmap entries get
  `close()`, canvas entries get zeroed dimensions.
- Project replacement clears and disposes every entry, cancels jobs, and disposes every hidden
  element.
- A 1-hour clip at 400 px/s requests a 4096px canvas, not a 1,440,000px canvas. No canvas allocation
  exceeds `MAX_STRIP_PIXELS`.
- Forty max-size 4096x44 strips fit the 16MP budget. Forty 4096x64 strips are 10.5MP and also fit.
- An over-budget or invalid bucket uses the poster fallback, marks the request settled, and does not
  allocate a canvas.
- A strip install leaves the serialized doc byte-identical to the doc before the strip.
- No filmstrip field appears in serialization or autosave.
- Image entry draws once and never seeks.
- The image cache key ignores trim, speed, reverse, and time scale; it changes with media id or a
  width/height bucket.
- Queue drain is FIFO. A superseding same-clip key replaces in place and does not reorder other
  clips' keys.
- Removing an asset disposes its hidden element and disposes and drops its entries. Project
  replacement disposes every hidden element and every entry.
- Offline media never creates a video element.

Render tests (`filmstrip-ui.test.tsx`):

- A video clip renders a filmstrip canvas behind the label.
- The label, linked badge, speed badge, transition badge, trim handles, and context menu still
  render.
- A video clip with a linked twin and `waveformPeaks` set has no waveform.
- A solo video with no twin and `waveformPeaks` set keeps its waveform.
- A positive control in the same file proves a video clip with peaks and no twin still draws the
  waveform, so the two negative assertions cannot pass vacuously.
- An audio clip has no filmstrip.
- A narrow clip below the threshold has no filmstrip.
- The canvas has `pointer-events-none`.
- The clip gesture handlers are unchanged.

Static locks:

- `ClipView` imports the filmstrip layer.
- The layer sits below the label and trim handles in z-order, not above them.
- Serialization has no filmstrip field.
- The cache is runtime-only and not imported by the pure state core.

Coverage:

- Add `src/lib/editor/filmstrip.ts` to the coverage include list in `vitest.config.ts`.
- Add it to the coverage-scope sentence in `docs/testing.md`.
- Run `bun run test:coverage` once in this plan and record the result. A new pure module outside the
  include list is unmeasured.

Browser proof:

- Load the Plan 01 fixture and wait for `data-filmstrips-ready` on the timeline root. A 4-second
  video clip shows distinct frames across its width.
- Trim the head and tail: the strip updates and does not show frames outside the new source window.
- Reverse: the strip updates.
- Speed 0.5 and 2: the strip updates and stays within the source.
- Zoom from 100 to 400 px/s: the strip re-samples at the new bucket, capped at 4096px.
- A synthetic 1-hour clip at 400 px/s uses a 4096px canvas. The 4-second fixture cannot exercise
  this in the browser, so the render test is the proof.
- Playback while a strip generates: no long task over 100ms in the recorded trace.
- Five video tracks: all strips render, memory stays within the 16MP cap.
- Narrow desktop (1024x768): the label, waveform, badge, and trim handles remain usable.
- Console clean.

Flakiness controls:

- Do not put wall-clock performance budgets in the test suite. The Plan 01 spike and the browser
  trace are the evidence.
- Wait for `data-filmstrips-ready` on the timeline root before screenshots and before asserting a
  strip in the browser. The per-strip `data-filmstrip-ready` attribute is for debugging.
- Use the mocked video harness for unit tests, not real media.
- Canvas tests assert recorded draws, not pixels.
- The demo fixture uses the bundled sample, so the source frames are deterministic.
- No test may depend on the browser's decode order or a timezone.

## 7. Release tasks for `0.12.0`

Because Plan 03 completes the first release, do the atomic version bump from `AGENTS.md`:

- `package.json` version.
- `src/lib/releases.ts`: new head entry with ISO date and at least four highlights.
- `CHANGELOG.md`: new `## [0.12.0] - <date>` entry. The entry and the `releases.ts` highlights name
  both the chrome changes from Plan 02 and the filmstrips, not filmstrips alone.
- `ROADMAP.md`: add the `0.12.0` shipped row. The filmstrip is not currently a gap row, so either
  record it as workflow polish or leave the gap table unchanged. Do not invent a Premiere gap just
  to close it.
- `README.md`: feature list, test counts, screenshot tree.
- `docs/architecture.md`, `docs/flows.md`, `docs/design-system.md`, `docs/testing.md`,
  `docs/structure.md` as affected.
- `public/screenshots/editor.png`: real capture with filmstrips. Update the hero alt text in
  `src/components/site/Hero.tsx` and the attribution note if the photo changes. Do not use the
  reference image. The current night-city photo is not in the repo. If the owner does not supply it,
  use the bundled sample image, update the alt text, and remove the Unsplash credit. Do not publish
  a mismatched credit.
- Test counts and battery counts move with the suite. `docs-drift.test.ts` is the lock. If a battery
  step is added, update both `e2e/battery.sh` and `e2e/battery.timing.sh`.

If the version number or release grouping changes, the user confirms it before the bump.

## Acceptance criteria

- Video clips show sampled source frames, not a repeated poster.
- Image clips show the image, not a fabricated strip.
- Trim, speed, reverse, and time remap produce the correct frames.
- Move and same-bucket zoom reuse the strip.
- A one-hour clip at 400 px/s uses a 4096px backing canvas, not a 63.36MP strip. No single strip
  exceeds `MAX_STRIP_PIXELS`, and the cache stays within 16MP.
- Stale jobs cannot install frames after a clip changes or unmounts.
- No filmstrip data enters `Doc`, autosave, or the project file.
- The label, waveform rule, linked badge, trim handles, and context menu behave as before.
- A linked video half hides its waveform; a solo video keeps it.
- The browser proof passes at default and narrow widths.
- `bun run check` is green.
- The `0.12.0` version bump and docs are complete.

## Risks

- **Seek cost.** Mitigation: Plan 01 spike, one job at a time, debounce, cache, fallback.
- **Stale frames.** Mitigation: generation tokens and the invalidation matrix.
- **Memory.** Mitigation: LRU cap, 16MP pixel budget, 4096x64 per-strip cap, canvas not data URLs.
- **Huge clips.** Mitigation: cap `widthBucket` and `heightBucket`, check `filmstripCanvasFits`
  before creating the canvas, and fall back to the poster when the guard fails.
- **Decode differences.** Mitigation: hidden video element, not WebCodecs, on the first pass.
- **Layer conflicts.** Mitigation: filmstrip at the bottom, overlays above, pointer-events none.
- **Serialization bloat.** Mitigation: runtime-only cache and a serialization test.
- **Release coupling.** Plan 02 has no version bump. If Plan 02 is not committed before Plan 03,
  stop and rebase the plan.

# 0.23.0 durable media and freeze frame

**Created:** 2026-11-12
**Complexity:** High
**Effort:** L
**Schema:** 4 to 5
**Depends on:** 0.22.0
**Status:** planned

## 1. Goal

Make imported media survive a reload, let each saved copy resolve its own media revision, then use that
lifecycle to add freeze frame:

- Store imported source bytes in OPFS, keyed by a SHA-256 content hash that the asset persists.
- Rehydrate object URLs and `File` handles before a project is installed.
- Relink by writing a new hash and updating only the current doc, so another copy that still points at
  the old hash is unaffected.
- Add a Freeze Frame command that captures the current composited frame as a still image asset and
  places it on the timeline.

This is the foundation release for voiceover, screen recording, camera recording, custom fonts, and
project bundles. It is a schema release: `MediaAsset.contentHash` is the one new persisted field, and
`SERIALIZATION_VERSION` moves from 4 to 5.

## 2. Anti-goals

- No cloud storage and no account sync.
- No OPFS storage for proxies. Proxies stay session-only unless a later release says otherwise.
- No background persistence worker or service worker.
- No automatic re-import from the file system after a permission loss without a user action.
- No freeze field in `Clip`. Freeze uses a generated still image asset.
- No freeze of audio only. Freeze produces a visual still.
- No other persisted media field beyond `contentHash`. No per-copy project id, no pointer registry, and
  no change to how an asset appears in the bin.

## 3. Current state, verified

- `MediaAsset.url` is an object URL and `MediaAsset.file` is a session `File`; both are never serialized
  (`src/lib/editor/types.ts:454`).
- `MediaAsset` has no content hash and `SerializedMedia` has no hash field. `SERIALIZATION_VERSION` is
  4 (`src/lib/editor/serialization.ts:103`).
- `serializeDoc` strips URLs and files. On load, assets without a URL are marked `missing` and relink
  by name or by hand (`README.md:148`, `src/lib/editor/serialization.ts:90`).
- Autosave writes only JSON to localStorage, with no media bytes (`src/lib/editor/persistence.ts`).
- `importFile` is the single file import boundary and keeps the source `File` on the asset
  (`src/lib/editor/media/probe.ts:64`).
- Export reads frames and audio from `asset.file`, not the object URL, so rehydration must restore both
  (`src/lib/editor/export/mp4.ts`).
- There is no IndexedDB, OPFS, `navigator.storage`, or `showDirectoryPicker` usage in `src`.
- Project load and autosave restore currently parse synchronously and install a `Doc`. Rehydration must
  preserve the one-install behavior and the existing history reset.

## 4. Technical approach

### Storage adapter

Add a browser-bound media store module under `src/lib/editor/media/` with a small interface:

- `isMediaStoreSupported()`
- `hashFile(file): Promise<string>`, a SHA-256 lowercase hex digest
- `writeMediaFile(projectId, contentHash, file)`
- `readMediaFile(projectId, contentHash)`
- `deleteMediaFile(projectId, contentHash)`
- `listMediaFiles(projectId)`
- `beginPendingWrite(projectId, contentHash)` and `endPendingWrite(projectId, contentHash)`
- `writeMediaClaim(projectId, hashes): Promise<string>` and `readMediaClaims(projectId)`
- `deleteMediaClaim(projectId, claimId)`
- `beginInstallReservation(projectId, installId, hashes)` and `endInstallReservation(projectId, installId)`
- `cleanProjectMedia(projectId, keepHashes)`
- `clearProjectMedia(projectId)`
- `estimateMediaStore()`
- `requestPersistentStorage()`

Use OPFS as the primary store, with a documented fallback when OPFS is unavailable or the write fails.
Do not make OPFS a hard requirement for import. A failed write degrades to the current session-only
asset and shows a clear warning.

Keys are `<project-id>/<content-hash>`. The project id comes from the doc and the hash comes from
`MediaAsset.contentHash`, so bytes are immutable and a saved copy that still points at an old hash keeps
loading those bytes after another copy relinks. The display name is serialized per asset in
`SerializedMedia.name`; do not read it from the hash sidecar. The sidecar `<content-hash>.json` stores
the MIME type and byte size, which are properties of the bytes. If two assets share a hash, they share
the bytes and the sidecar type, but each keeps its own serialized name. Write the bytes to a temporary
name, verify the SHA-256, then promote: if the final hash is absent, rename the temp into place; if it
exists and verifies, delete the temp and reuse it; if it exists but fails verification, quarantine it,
rename the temp in, and delete the quarantine. Never overwrite a valid entry. Readers verify a hash and
treat a mismatch as missing. Validate the hash as 64 lowercase hex characters before using it as a path
segment. Do not accept slashes, `..`, uppercase, or non-hex.

Explicit project save and project open write a new immutable claim shard at
`<project-id>/claims/<claim-id>.json` listing every referenced `contentHash`. Shards are never merged
or overwritten; clean reads every shard and unions them, so concurrent saves cannot lose a claim. The
claim set only grows and is the record of hashes a closed copy may reference. It is not a pointer and
never changes which bytes an asset loads. Clean keeps every claimed hash. The store creates an empty
claims directory when a project is created or installed, so a missing directory means lost or
unreadable claims, not a new project. If the claims directory is missing or unreadable, clean refuses
to delete content hashes and only removes temp, quarantine, and stale pending files; it does not assume
no copies exist. `clear-all` is the only action that removes claims and reservations, and its
confirmation names that saved copies will lose their media. The claims directory, the `.cleaning`
marker, reservation files, temp files, and quarantine entries are store metadata, not media hashes;
list and clean exclude them from the hash candidates.

Claim writes take the same exclusive media lock as clean. Without Web Locks, a claim write creates a
unique shard through temp write plus rename and broadcasts `claim` with its id; clean re-reads every
shard immediately before deleting. Immutable shards mean two concurrent saves cannot overwrite each
other, so there is no read-merge-write to serialize. A claim write that sees a `cleaning` marker waits
for `done`, and a clean that sees a new shard includes it before the delete.

### Import lifecycle

- On import, hash the file, mark the hash pending, then participate in the `.cleaning` handshake
  before attaching it to the doc. With Web Locks, hold the exclusive media lock across the pending
  marker, write, and attachment. Without Web Locks, write the pending marker first, broadcast `join`,
  check the `.cleaning` marker, wait for `done` when it is set, and recheck after the wait. Write the
  bytes and sidecar, add the asset with `contentHash`, then clear the pending marker. A clean that
  starts after the check sees the pending marker or the new live hash. A clean that finished before
  the import started has already completed its deletes; the import then writes a new pending marker
  and hash, so that clean cannot reach them. If a marker is present, the import waits for `done` and
  rechecks before attaching. If the write fails, delete the partial entry, clear the marker, still add
  the session-only asset, and surface a warning.
- On relink, hash the replacement, then participate in the same `.cleaning` handshake as import
  before attaching it: mark the new hash pending with a heartbeat, write it, set `asset.contentHash`
  under the finalization lock, then clear the pending marker. With Web Locks, hold the exclusive media
  lock across the pending marker, write, and attachment. Without Web Locks, write the pending marker
  first, broadcast `join`, check the `.cleaning` marker, wait for `done` when it is set, and recheck
  after the wait before attaching. Drop any proxy built for the old file. If the write succeeds, keep
  the new hash and bytes and the persistent path below. If the media store is unsupported, unavailable,
  or full, or the write fails, delete only the partial temp and marker, then apply `relinkMedia` as a
  session-only relink with a warning. For that session-only result, do not claim the new hash and clear
  the asset's `contentHash` so no persisted hash names different bytes. Leave any previous stored hash
  and its bytes untouched for undo and other copies. A later explicit save or autosave may promote the
  session file and write a new hash; until then, reopening the project needs another relink. This also
  recovers a missing v4 asset that has no stored hash. The persistent-storage path is unchanged when
  the write succeeds.
- On remove, do not delete the stored bytes. `removeMediaAsset` is undoable, and undo restores the
  asset entry but cannot restore bytes that are already gone. Deletion belongs to the clean action
  below.
- On project unload, clear any session-only warning state. Do not clear stored bytes.

### Deletion and cleanup

Removal never deletes bytes. The first version has no automatic GC on load. Cleanup is an explicit
action that lists the candidate hashes, their sizes, and the reason they are unreferenced, then
requires confirmation:

1. List the stored hashes for the loaded project id.
2. Read every claim shard under `<project-id>/claims/` and keep every claimed hash. If the directory is
   missing or unreadable, do not delete any content hash; clean may only remove temp, quarantine, and
   stale pending files.
3. Keep every hash referenced by `doc.media` or by any snapshot held by undo or redo.
4. If the autosave slot parses to the loaded project id, keep the media and font hashes it references.
   An autosave restore does not write a claim; the autosave slot is a live reference, and its hashes
   become eligible for cleanup once the slot no longer references them.
5. Keep every hash with a pending marker whose heartbeat is recent, regardless of the marker's age,
   every hash marked reserved by an install, import, or promotion, and every hash written within a
   short grace window. The importer updates the heartbeat every 30 seconds while the write is active,
   and the stale threshold is at least five minutes so a throttled background tab is not mistaken for
   abandoned. A marker with no heartbeat for the stale threshold may be listed as a candidate with a
   warning.
6. Delete only the hashes the user confirms, plus their sidecars.
7. Report the reclaimed size.

Each open project tab writes a durable membership record under `<project-id>/tabs/` before loading,
then joins `BroadcastChannel('videoh-media:<project-id>')` and publishes its live hash set, the union
of `doc.media` and both history stacks, on change, on visibility change, and every 10 seconds. The
record, not a received heartbeat, establishes membership: a suspended or inactive tab that never
answers is still listed. The clean action lists every record, waits 30 seconds, retries once, unions
every live set it receives, and keeps those hashes. A recorded tab that cannot be reached blocks
content-hash deletion even when its heartbeat is stale; only the explicit `clear-all` action, whose
confirmation names that saved copies lose media, may proceed. Confirmation is not a substitute for
reachability in a normal clean. The whole collect, revalidate, and delete sequence runs under the
exclusive cross-tab lock. With Web Locks unavailable, the durable membership records, the
BroadcastChannel union, and the pending-marker heartbeat are the protection.

A record carries a tab id, session id, open time, heartbeat time, state (`open` or `closing`), and its
live hash set. On orderly unload, the tab stops its heartbeat, writes `closing`, broadcasts `leave`
with the record id, then removes the record. Any tab that receives `leave` may remove a matching
`closing` record; a failed removal is left for recovery. Recovery never deletes a hash. Each tab holds
a lifetime Web Lock named `media-tab:<record-id>`. A dedicated recovery action probes that lock with
`ifAvailable`; only a free lock proves the page is closed, because a suspended or unreachable tab
still holds it. Remove only the record after that proof, then let a later clean recompute candidates.
Without Web Locks, unresolved open records keep protecting media and only `clear-all` may bypass them,
unchanged. Content-hash deletion and clear-all behavior do not change.

Every project install takes the same exclusive lock before rehydration and holds it through
`installProject`. A new project or reset also takes it before replacing the doc. Before rehydration,
the install parses the doc and writes a reservation at
`<project-id>/reservations/<install-id>.json` listing every serialized `contentHash`, including hashes
that fail to hydrate, then publishes the set on the channel. The reservation is written before the
install checks for a clean, and clean keeps every reserved hash.

With Web Locks unavailable, clean and install use one publication barrier. The install writes its
reservation first, then broadcasts `join` and checks the `.cleaning` marker. A fresh marker means it
waits for `done`, then verifies every reserved hash still exists. If any is missing, it restores or
reacquires the bytes from its source before installing, or aborts before install with a clear error;
it never installs with a reserved hash silently missing. Clean writes the marker first, then
broadcasts `cleaning` and waits for every durable membership record to answer `idle` or `reserved`.
A tab with an install in flight publishes its reservation before answering `reserved`. Clean may not
collect or delete a hash until every existing member has answered. A tab that starts after the marker
checks it before writing a reservation, joins the waiters, and publishes nothing until `done`; a new
membership record appearing during the barrier restarts the wait. Clean re-reads membership records,
reservations, and the marker immediately before each hash deletion, and any new reservation aborts the
delete and restarts the barrier. The marker is held for the whole barrier and delete, and cleared with
`done` in a finally block. Publication and deletion are therefore mutually exclusive for the entire
delete window. The Web Locks path follows the same rule under its exclusive lock.

A normal install releases its reservation after install or failure and broadcasts `release`. The
install refreshes the heartbeat every 30 seconds while rehydration and installation are active. A
degraded install keeps its reservation for the whole session, as described under Load and
rehydration. A reservation whose heartbeat is stale and whose durable membership record is gone is
abandoned and may be listed as a candidate with a warning. A stale heartbeat alone never makes a
reservation abandoned while its tab record still exists.

The clean action still answers `join` with `cleaning` for its whole delete window and writes the
`.cleaning` marker with a start time, clearing it after the last delete. An install refuses while a
fresh marker exists; fresh means younger than the stale threshold, and an older marker is stale and may
be cleared with a warning after the install queries the live tabs.

The clean action records the project generation and the live-set generation before collecting. Under
the same lock, immediately before each delete, it re-reads the current doc and both history stacks,
rechecks the claimed hashes and live tab sets, and compares the generations. If a reference appeared or
a generation changed, it aborts the delete and restarts. Every project install, new project, or reset
bumps the project generation and publishes it before changing the doc; a relink publishes its new live
hash set before changing the doc. A hash that becomes referenced during the wait is therefore never
deleted.

Before collecting, the clean sets a local `mediaCleanInProgress` guard and broadcasts `cleaning` on the
channel. A project install or reset in this tab refuses or waits while the guard is set, and another tab
that receives `cleaning` defers its install until `done`. Clear the guard and the persistent marker in a
finally block after the last delete. This closes the gap between the generation check and the delete.

This keeps undo and redo whole for the whole session. Relink is independent because each doc carries
its own hash. Two files that share a project id still share one directory, but every explicit save and
open claims its hashes, so clean cannot delete bytes that a closed copy may reference. Clean never
deletes a claimed hash automatically. Only `clear-all`, with a confirmation that names the risk, can
break a saved copy.

### Load and rehydration

Keep `parseSerializedDoc` synchronous. Add an async `rehydrateMedia(doc)` step that runs before
`installProject` for both file open and autosave restore:

1. For each serialized media asset with a `contentHash`, read `<project-id>/<content-hash>`. A legacy
   asset with no hash stays missing and uses the existing relink path.
2. If bytes exist, read the sidecar MIME type, use the serialized asset's name, create a new `File`,
   create an object URL, and set `file`, `url`, and `missing: false`. If the sidecar is missing or
   malformed, derive the type from the file extension, then warn.
3. If bytes do not exist, keep `missing: true` and the existing relink path.
4. If a font or other future asset type needs hydration, extend this step, not each caller.

Before install, write a claim shard listing every validated referenced `contentHash` in the doc,
including assets whose hydration failed. The claim is written before the doc is live, so a closed copy
keeps its bytes even if the project is replaced immediately after opening. When the claim write
succeeds, keep this claim-before-install order. If the media store is unsupported, unavailable, or
rejects the claim, open in degraded mode instead of blocking the project: write the install
reservation, install the hydrated or session-only doc with a warning, and keep that reservation live
for the whole session so clean cannot reclaim promoted bytes. Session-only assets have no hash and
stay relinkable. Refresh the reservation heartbeat every 30 seconds until the tab unloads; the durable
tab membership record also keeps it from being treated as abandoned. Retry the claim on the next
explicit save or autosave. A successful retry writes the claim first, then releases the degraded
reservation. A failed retry keeps both and leaves the warning in place. An autosave may proceed because
its slot is a live reference and the reservation protects its hashes. A legacy project with no content
hashes needs no claim and opens normally. This fallback applies to opening or restoring an existing
project; a bundle import keeps its stricter claim-before-install rule because it promotes new bytes. Do
not delete existing shards or bytes on this path. An autosave restore does not write a claim; clean
reads the autosave slot as a live reference. Explicit save through `downloadProjectJSON` is different:
it must still await its claim write and fail rather than write a copy whose bytes are unclaimed. Do not
fire-and-forget a claim for a copy that is about to be written.

Install the hydrated doc once, so history, selection, and the restore banner behave exactly as they do
today. Revoke replaced object URLs. Do not leave a second install path.

Every open or autosave restore takes a monotonically increasing request token before rehydration. After
the await, install only if the token is still current. A superseded request revokes any object URLs it
created and returns without touching the store, history, or selection. This covers a project open
racing an autosave restore. Every path that creates a new project, resets the store, or calls
`installProject` bumps the token before changing state, so an in-flight rehydration cannot install over
a project that replaced it.

If rehydration is slow, show a loading state. Do not install a half-hydrated doc and patch it later,
because that creates a second install path and a visible flash of missing media.

### Schema v5

One new persisted field carries the per-copy media revision:

- Increment `SERIALIZATION_VERSION` to 5 and update its header comment.
- Add `contentHash?: string` to `MediaAsset` and `SerializedMedia`.
- Hydrate a v4 asset with no hash. It stays `missing` and relinks exactly as a v4 project does today.
- A valid hash is exactly 64 lowercase hex characters. A malformed, uppercase, non-string, or path-like
  value is dropped with a warning, and the asset falls back to the missing state.
- Add a v4 fixture that loads with no hash, a v5 round trip with a hash, and hostile payloads:
  `contentHash: "../../evil"`, `contentHash: 1`, uppercase hex, non-hex characters, and an overlong
  string.
- Update `docs/architecture.md` and the `.veproj.json` version in `README.md`.
- A v5 project opened by a v4 build is refused by the existing version guard. Say so in the release
  notes.

### Storage UX

- Show storage usage and a clean-unreferenced-media action in the media bin or project settings. The
  action lists the candidates and requires confirmation.
- Keep a separate destructive clear-all action behind a second confirmation, and explain that it marks
  every asset missing.
- Request persistent storage once, with a user-visible explanation and a way to decline.
- Explain that clearing site data removes stored media and falls back to relink.
- The clear-all action names that every saved copy of this project loses its media; it is not a
  cleanup of unused bytes.
- Surface quota failures as a non-destructive warning with the affected file names.

### Freeze frame

Add a command that:

1. Resolves the visible composited frame at the playhead for the active sequence.
2. Refuses when nothing visible is under the playhead, when the source media is offline, or when the
   active sequence cannot accept a new video track.
3. Renders the frame at project width and height to an opaque canvas: fill the project background (or
   composite the frame over it) before drawing, then flatten alpha before PNG encoding. The still must
   carry the captured composite, including its background, so lower source layers cannot show through
   it or blend with it again.
4. Encodes a PNG, creates a `File`, and imports it through the same `importFile` path so it gets a
   thumbnail and OPFS storage.
5. Adds the image asset, a new video track at index 0 of the active sequence through `addTrack` with
   `atIndex: 0`, and the clip at the playhead in one command batch, with a documented default duration
   (2 seconds in the first version) and a clear name. The new track is above every source layer, so the
   frozen frame is not covered by the source.
6. Selects the new clip and leaves the playhead unchanged.

Do not reuse an existing track. The still must sit above the layers it captured, and a new top track
avoids both a locked source track and a clip collision at the playhead. If the sequence scope cannot
accept the track, refuse before encoding so no partial asset is created.

Undo removes the clip and the asset entry and keeps the stored bytes, so redo restores a working still.
The clean action reclaims those bytes only after the history no longer reaches them.

Reuse the existing compositor path. Do not add a third renderer. If the export compositor is the only
path that can render an arbitrary frame offscreen, extract the shared frame render rather than forking
it.

If the still image encode or OPFS write fails, do not add a broken clip. Show the failure.

## 5. File plan

New files:

- `src/lib/editor/media/media-store.ts`, the OPFS adapter and fallback.
- `src/lib/editor/media/rehydrate.ts` if the rehydration logic is not kept inside project IO.
- A pure freeze planning helper if the command needs deterministic asset and clip construction.

Expected modified files:

- `src/lib/editor/types.ts`: `MediaAsset.contentHash`.
- `src/lib/editor/serialization.ts`: v5, `SerializedMedia.contentHash`, hydration, validation.
- `src/lib/editor/media/probe.ts`: compute the hash on import if that is the chosen boundary.
- `src/lib/editor/media/relink.ts`: compute the new hash and update the session file.
- `src/lib/editor/project-io.ts`: await rehydration before install, make the save path async so it can
  write the claim shard before download, and write claim shards on explicit save and open.
- `src/lib/editor/persistence.ts`: rehydrate autosave restores. Do not write a claim on restore; clean
  reads the autosave slot as a live reference.
- `src/lib/editor/commands.ts`: `freezeFrame` command.
- `src/components/editor/MediaBin.tsx` or the project settings UI: storage usage, clean, and clear-all
  actions.
- `src/components/editor/MenuBar.tsx` and the clip context menu: Freeze Frame entry.
- `src/lib/editor/__tests__/` for the store, rehydration, freeze command, schema, and hostile hashes.
- `docs/architecture.md`, `docs/flows.md`, `README.md`, `docs/deployment.md`, `docs/testing.md`.

## 6. Phases and verification

### Phase 1: store adapter

- Add feature detection, the OPFS read, write, delete, estimate, clean, and clear methods, the SHA-256
  helper, the content-hash key, the pending marker, claim shards, and install reservations.
- Verify a red test fails before the adapter exists.
- Cover unsupported OPFS, a write failure, a quota failure, an invalid hash, a missing entry, a delete
  of a missing entry, a partial write, a malformed sidecar, a stale pending marker, an existing valid
  hash that is reused, an invalid existing hash that is quarantined and replaced, two concurrent claim
  shard writes that both survive, and a missing claims directory that disables content-hash deletion.

### Phase 2: import, relink, remove

- Wire the store into the single import boundary and set `MediaAsset.contentHash`.
- Verify an import writes one hash and clears the pending marker.
- Verify relink participates in the `.cleaning` handshake before attaching, rechecks after waiting
  for `done`, marks the new hash pending, writes it, updates only the current asset's `contentHash`
  under the finalization lock, then clears the marker; a failed write leaves the old hash and old bytes
  and does not apply the relink.
- Verify two docs that share a project id but carry different hashes load different bytes, and that a
  relink in one leaves the other doc's bytes unchanged.
- Verify undo of a relink restores the old `contentHash` and the old bytes still load.
- Verify remove leaves the entry, undo restores a working asset, and the clean action removes the hash
  once history no longer reaches it.
- Verify an explicit save and an open write a claim shard listing every referenced hash, including an
  asset whose hydration failed, and clean keeps a claimed hash after the copy is closed.
- Verify two concurrent claim shard writes both survive and clean unions them.
- Verify an autosave restore writes no claim, clean keeps the autosave slot's hashes, and the hashes
  become eligible after the slot no longer references them.
- Verify clean on a project with a missing claims directory deletes only temp, quarantine, and stale
  pending files.
- Verify an install reservation is written before rehydration, clean keeps its hashes, and release
  makes them eligible again.
- Verify a reservation created during the clean's delete window cannot be followed by deletion of its
  hashes; clean rechecks before each deletion and aborts or restarts. Verify the waiting install then
  rechecks its reserved hashes and either reacquires missing bytes or aborts before installing.
- Verify a clean that starts while an install is rehydrating cannot delete a reserved hash without Web
  Locks, and an install that starts while clean is running waits.
- Verify the clean action skips a pending import and a hash written inside the grace window.
- Verify an import finalize and a clean action on the same project id serialize under the cross-tab
  lock; the import's entry survives.

### Phase 3: rehydration

- Add async rehydration before install.
- Verify a saved project with stored bytes reopens with a working `url` and `file`, not just an image.
- Verify a v4 asset with no hash hydrates as `missing` and relinks, and a v5 asset with a hash hydrates
  from that hash.
- Verify the sidecar name and MIME type rebuild the `File`; a missing sidecar falls back with a warning.
- Verify a missing entry still hydrates as `missing` and relinks.
- Verify object URLs for replaced assets are revoked.
- Verify an open writes a claim shard for every validated referenced hash before install, including an
  asset whose bytes fail to hydrate, and an autosave restore writes no claim.
- Verify the clean action removes an orphaned hash and keeps a referenced one.
- Verify a superseded open or autosave restore does not install and revokes its object URLs.
- Verify undo and the autosave restore banner still behave as one install.

### Phase 4: storage UX

- Add usage, clean, clear-all, and persistent-storage request.
- Verify the UI handles unsupported OPFS and quota errors.
- Verify the clean action lists candidates, requires confirmation, and leaves referenced media intact.
- Verify a reference that appears during the clean wait aborts the delete and restarts the candidate
  list.
- Verify a suspended tab's durable membership record is listed and blocks normal deletion even when
  the tab never heartbeats; only clear-all proceeds, and the claim union and revalidation still apply.
- Verify an install or reset during the clean guard refuses or waits and the clean finishes, including
  when Web Locks is unavailable and the install starts after the `cleaning` broadcast.
- Verify an install reservation is not released until install finishes or fails, and clean never
  deletes a reserved hash.
- Verify clear-all leaves the project and clips intact, marks every asset missing, removes the claims
  and reservations directories, and warns that saved copies lose their media.

### Phase 5: freeze frame

- Add the command and menu entry.
- Verify a red test fails before the command exists.
- Verify the clip is an image, has the documented duration, is placed at the playhead, and is selected.
- Verify the still is on a new topmost video track above the source, including when the source track is
  locked, and that a clip at the playhead does not collide with it.
- Verify the still is opaque and preserves the captured composite when the source footage underneath
  changes; active source layers must not show through or blend with it again.
- Verify undo removes the clip and the asset entry, redo restores a working still, and the clean action
  reclaims the bytes only after the history no longer reaches them.
- Verify empty playhead, offline source, a sequence that cannot accept a new track, and failed encode
  are refused without a partial clip.
- Verify a frozen still survives reload through OPFS.

### Phase 6: docs, batteries, release cut

- Update persistence and media docs.
- Run `bun run check`.
- Run `bun run battery:pair` for the release verdict; keep the reload proof as a manual step.
- Apply the atomic 0.23.0 bump from the master plan.

## 7. Tests and locks

- Store: supported and unsupported runtime, write, read, delete, clean, clear, estimate, invalid hash,
  project id and hash traversal attempts, quota rejection, concurrent writes for different hashes,
  duplicate hash write, sidecar type round trip, two assets with different names and one hash keep
  independent names, stale pending marker, heartbeat keeps a long import alive, cross-tab lock, clean
  unions another tab's live hash set, durable membership lists a suspended tab that never heartbeats
  and blocks normal deletion, only clear-all proceeds for an unreachable recorded tab, clean
  revalidates immediately before delete and aborts on a changed generation, clean skips a reserved
  hash, clean keeps a claimed hash, two concurrent claim shard writes both survive, a missing claims
  directory disables content-hash deletion, an existing valid hash is reused, an invalid existing hash
  is quarantined and replaced.
- Lifecycle: import writes and clears the pending marker, import participates in the `.cleaning`
  handshake before attaching the hash, a clean that finishes its pending and live-set checks before an
  import starts cannot delete the hash the import then attaches, the imported asset resolves its
  bytes, relink participates in the same handshake and rechecks after waiting for `done`, a failed
  relink keeps the old hash and bytes, a failed claim write opens degraded with a live reservation
  while explicit save still waits and fails, remove keeps the hash, clean
  deletes an orphan, clean keeps a referenced hash, clean skips pending, reserved, and recent entries,
  an explicit save and an open write a claim shard for every validated referenced hash including failed
  hydration, an autosave restore writes no claim, clean keeps the autosave slot's hashes until the slot
  no longer references them, object URL revoke.
- Rehydration: v5 asset restores `file` and `url` from its hash and sidecar, v4 asset with no hash stays
  missing and relinks, missing sidecar falls back with a warning, autosave restore, one install,
  superseded install discarded, an open writes its claim shard before install, a claim write failure
  opens degraded with a live reservation and a legacy project with no hashes opens normally, a
  reservation created during deletion is never deleted and the install rechecks or reacquires before
  proceeding, a new project or reset
  invalidates an in-flight restore, history reset as today.
- Install coordination: clean and install serialize under the exclusive lock; an install writes its
  reservation before rehydration and releases it after success or failure; a long rehydration heartbeat
  keeps the reservation fresh; clean keeps every reserved hash; an install that starts after the
  `cleaning` broadcast waits for `done`; a clean that starts during an install cannot delete a reserved
  hash without Web Locks; a fresh `.cleaning` marker blocks an install when Web Locks is unavailable.
- Schema: v4 loads with no hash, v5 round trip, hostile hash values rejected or dropped, newer version
  refused.
- Copy independence: two docs that share a project id and carry different hashes load different bytes;
  a relink in one does not change the other; undo restores the old hash.
- Freeze: image asset, duration, start, selection, new topmost video track above the source, locked
  source track, clip collision at the playhead, undo and redo with bytes intact, empty timeline,
  offline source, encode failure, OPFS failure.
- Browser proof: import a file, reload, play it, freeze a frame, reload, confirm the still is present,
  remove the asset, undo, reload, confirm the still is still present, then remove again, reload, confirm
  the still is missing, run the clean action, and confirm its bytes are reclaimed.
- Autosave proof: restore an autosave, remove an asset, clear its history, confirm clean keeps its hash
  while the autosave slot references it, then replace the autosave and confirm clean can reclaim it.
- Copy proof: save two project files that share a project id, relink media in copy A, reload copy B, and
  confirm B loads its original bytes from its own hash.
- Static locks: every asset producer goes through the shared import or store boundary.

## 8. Atomic release cut

Follow section 7 of `MASTER_PLAN.md`. The 0.23.0 commit must update:

- `package.json` to `0.23.0`.
- `src/lib/releases.ts` with four or more highlights and the actual ISO date.
- `CHANGELOG.md` with `## [0.23.0] - YYYY-MM-DD` and a schema note.
- `ROADMAP.md` with the shipped row and intro sentence. No Premiere gap status change.
- `README.md` persistence, freeze frame, and `.veproj.json` version 5.
- `docs/flows.md` save, load, autosave, and relink contracts.
- `docs/architecture.md` serialization row, media module, and project IO notes.
- `docs/deployment.md` storage and browser support notes.
- `docs/testing.md` for the new tests and coverage scope.

Do not bump to 5 for any other persisted field. The media hash is the only v5 surface.

## 9. Rollback

Before any destructive cleanup, preserve the media bytes, including generated stills and any asset
without an external copy. The exported `.veproj.json` is not a media backup; it only references assets.
Copy or export those files first, then run clean or clear-all if needed, then revert. A v5 project
cannot be opened by the reverted v4 build. If the revert happens first, the clean actions are gone;
clear the origin's site data (which also removes autosave and workspace settings) or reinstall the 0.23
build temporarily. If freeze frame is broken, hide the menu entry and revert the command; do not leave a
half-created asset path.

## 10. Risks and decisions

- **Quota and eviction.** OPFS is not unlimited and can be evicted. Request persistence, show usage,
  and keep relink as the fallback.
- **Undo versus deletion.** Removing an asset must never delete bytes. Undo restores the asset entry,
  so a delete-on-remove would leave a missing asset. Clean and clear-all are the only deletion paths;
  clean keeps entries reachable from the current doc, both history stacks, and the claim shards.
- **Shared project id and cleanup.** Two files that share a project id share one store directory.
  Relink is independent because each doc carries its own hash. Every explicit save and open writes an
  immutable claim shard, and clean keeps every claimed hash. A missing claims directory disables
  content-hash deletion, so a closed copy cannot lose bytes to an assumed-empty reference set. Only
  `clear-all`, with a confirmation that names the risk, can break a saved copy.
- **Autosave references.** An autosave restore does not write a claim, because that would keep every
  restored hash forever. Clean reads the autosave slot as a live reference for the loaded project id;
  the hashes become eligible when the slot no longer references them.
- **In-flight imports.** A pending marker with a periodic heartbeat, a short grace window, and a
  cross-tab lock keep a clean action from deleting bytes that an import in this tab or another tab has
  written but not yet added. A long import stays protected past the stale threshold without Web Locks.
- **Clean and install race.** Clean and install take the same exclusive lock. Without Web Locks, both
  write their intent before checking the other: the install writes a reservation, the clean writes the
  `.cleaning` marker and waits one heartbeat window, and the clean re-reads reservations immediately
  before deleting. A reservation is released after install or failure, so clean cannot delete its
  hashes while the install is rehydrating. A stale reservation expires with a warning.
- **Other tabs' undo history.** The current tab cannot see another tab's `past` and `future`. Each open
  tab publishes its live hash set over `BroadcastChannel`, the clean action unions every live set and
  blocks on an unanswered tab, and the delete runs under the exclusive lock. With Web Locks unavailable,
  the same union plus the pending heartbeat is the protection.
- **Stale installs.** A new project, a reset, or any `installProject` call bumps the restore token, so
  an older rehydration cannot replace it.
- **Relink atomicity.** Write the new hash and sidecar first, then set `asset.contentHash`. A failed
  write leaves the old hash and bytes and does not apply `relinkMedia`, so a reload cannot silently
  revert.
- **Relink and undo.** The content hash is part of the `Doc`, so undo restores the old hash and the old
  bytes are still stored. Do not delete the old hash on relink.
- **Schema downgrade.** A v5 project cannot be opened by a v4 build. The release notes must say so, and
  the rollback path must export or keep a v5 copy.
- **Sidecar MIME.** `SerializedMedia` has no MIME type. Store the name and type in the content-hash
  sidecar; a malformed sidecar is a warning, not a failed load.
- **Private mode and Safari.** Feature-detect and test the unsupported path. Do not assume Chromium
  behavior everywhere.
- **Synchronous load assumptions.** Keep parsing synchronous and rehydrate before install. Do not make
  `deserializeDoc` async and ripple through every caller.
- **Freeze representation.** The still image at project resolution is the chosen default. A `freeze`
  field would be a schema release and is out of scope.
- **Freeze of a compound or text clip.** It should work because the compositor renders the frame. Test
  both, rather than special-casing them.

## 11. Definition of done

- Imported media survives reload with working preview and frame-accurate export.
- A v4 project loads with no hash and relinks; a v5 project round-trips; two copies that share a project
  id but carry different hashes load independently.
- Missing and unsupported storage paths fall back to relink without data loss.
- A closed copy's claimed hashes are never deleted by clean; a missing claims directory disables
  content-hash deletion.
- An install reservation protects its hashes from clean until install finishes or fails, including
  without Web Locks.
- Removing an asset keeps its bytes for undo; the clean action frees them once history no longer
  reaches them.
- Freeze frame creates a durable still on a new topmost video track, adds one clip, and undoes as one
  action.
- `bun run check` and `bun run battery:pair` are green.
- The 0.23.0 schema bump and version bump are atomic in one commit.

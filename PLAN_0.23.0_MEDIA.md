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
- `writeMediaClaim(projectId, hashes): Promise<string>` and `readMediaClaims(projectId)`
- `deleteMediaClaim(projectId, claimId)`
- `cleanProjectMedia(projectId, keepHashes)`
- `clearProjectMedia(projectId)`
- `estimateMediaStore()`
- `requestPersistentStorage()`
- `holdProjectLock(projectId)` and `withExclusiveProjectLock(projectId, fn)`, the multi-tab guard

Multi-tab guard: every open tab holds a shared Web Lock `media-project:<project-id>` for its
lifetime. The clean action temporarily releases this tab's shared lock, then requests the same lock in
exclusive mode with `ifAvailable`. A granted lock proves no other tab has the project open, because any
other open tab holds the shared mode. A refused request, or a browser without Web Locks, refuses clean
outright and deletes nothing. Claim shards, not the lock, protect closed copies. There are no tab
records, recovery locks, install reservations, heartbeats, pending markers, or grace windows.

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
or overwritten; clean reads every shard and unions them, so a save can never lose a claim. The claim
set only grows and is the record of hashes a closed copy may reference. It is not a pointer and never
changes which bytes an asset loads. Clean keeps every claimed hash. The store creates an empty claims
directory when a project is created or installed, and when a project directory holds no stored hashes.
An existing project that still holds stored hashes but has no claims directory stays claims-missing
instead of gaining an empty record, so a missing directory means lost or unreadable claims, not a new
project. If claims are missing or unreadable, clean refuses to delete content hashes and only removes
temp and quarantine files, and an explicit claim write refuses too, so a save fails rather than hide
the lost records. Only clear-all resets that state.
`clear-all` is the only action that removes claims, and its confirmation names that saved copies will
lose their media. The claims directory, temp files, and quarantine entries are store metadata, not
media hashes; list and clean exclude them from the hash candidates.

A claim write needs no cross-tab lock: shards are immutable and uniquely named, so two saves cannot
overwrite each other and there is no read-merge-write to serialize. In one tab, a clean holds a flag
across its reference snapshot and every delete, and a claim write, import, relink, Freeze Frame write,
or rehydration waits for that flag, so no candidate hash is rewritten during the delete.

### Import lifecycle

Clean cannot race an import, so the import has no handshake. The clean refuses while this tab has an
import or install in flight, and while any other tab holds the project open. The import only writes a
hash that this tab then attaches to the live doc.

- On import, hash the file, then write the bytes and sidecar. Add the asset with `contentHash` only
  after the write succeeds. If the media store is unsupported, unavailable, or full, or the write
  fails, still add the session-only asset, leave `contentHash` unset, and surface a warning naming the
  file. A failed write deletes its partial temp entry first.
- On relink, hash the replacement and write it, then set `asset.contentHash` through `relinkMedia` in
  the same patch that carries the new file and URL. Drop any proxy built for the old file. If the write
  fails, apply `relinkMedia` as a session-only relink with a warning and set `contentHash` to
  `undefined`, so no persisted hash names different bytes. Leave any previous stored hash and its bytes
  untouched for undo and other copies. A later saved project may write a new hash; until then,
  reopening the project needs another relink. This also recovers a missing v4 asset that has no stored
  hash.
- On remove, do not delete the stored bytes. `removeMediaAsset` is undoable, and undo restores the
  asset entry but cannot restore bytes that are already gone. Deletion belongs to the clean action
  below.
- On project unload, clear any session-only warning state and release the project lock. Do not clear
  stored bytes.

### Deletion and cleanup

Removal never deletes bytes. The first version has no automatic GC on load. Cleanup is an explicit
action that lists the candidate hashes, their sizes, and the reason they are unreferenced, then
requires confirmation:

1. Refuse when an import, a relink, or a project install is in flight in this tab.
2. Release this tab's shared project lock and request `media-project:<project-id>` in exclusive mode
   with `ifAvailable`. Refuse, deleting nothing, when another tab holds the project open or the browser
   has no Web Locks. Re-acquire the shared lock in a finally block.
3. List the stored hashes for the loaded project id.
4. Read every claim shard under `<project-id>/claims/` and keep every claimed hash. If the directory is
   missing or unreadable, do not delete any content hash; clean may only remove temp and quarantine
   files.
5. Keep every hash referenced by `doc.media` or by any snapshot held by undo or redo.
6. If the autosave slot parses to the loaded project id, keep the media hashes it references. An
   autosave restore does not write a claim; the autosave slot is a live reference, and its hashes
   become eligible for cleanup once the slot no longer references them.
7. Re-read the doc, both history stacks, the claim shards, and the autosave slot immediately before
   each delete. If any reference appeared since the candidate list was built, abort and rebuild it.
8. Delete only the hashes the user confirms, plus their sidecars. Hold a same-tab clean flag across
   the reference snapshot and every delete, so an import, relink, or rehydration waits instead of
   rewriting a candidate hash.
9. Report the reclaimed size.

The exclusive lock covers the whole collect and delete. Because clean can only run when no other tab
has the project open, the union of live tab sets is not needed: there is exactly one open tab, this
one, and its doc, history, and autosave slot are read directly.

This keeps undo and redo whole for the whole session. Relink is independent because each doc carries
its own hash. Two files that share a project id still share one directory, but every explicit save and
open claims its hashes, so clean cannot delete bytes that a closed copy may reference. Clean never
deletes a claimed hash automatically. Only `clear-all`, with a confirmation that names the risk, can
break a saved copy. Clear-all also removes the claims directory, and is the only action that may.

### Load and rehydration

Keep `parseSerializedDoc` synchronous. Add an async `rehydrateMedia(doc)` step that runs before
`installProject` for both file open and autosave restore:

1. For each serialized media asset with a `contentHash`, read `<project-id>/<content-hash>`. A legacy
   asset with no hash stays missing and uses the existing relink path.
2. If bytes exist and verify, read the sidecar MIME type, use the serialized asset's name, create a new
   `File`, create an object URL, and set `file`, `url`, and `missing: false`. If the sidecar is missing
   or malformed, derive the type from the file extension, then warn.
3. If bytes do not exist or fail verification, keep `missing: true` and the existing relink path.
4. If a font or other future asset type needs hydration, extend this step, not each caller.

Before install, write a claim shard listing every validated referenced `contentHash` in the doc,
including assets whose hydration failed. The claim is written before the doc is live, so a closed copy
keeps its bytes even if the project is replaced immediately after opening. When the claim write
succeeds, keep this claim-before-install order. If the media store is unsupported, unavailable, or
rejects the claim, open in degraded mode instead of blocking the project: install the hydrated or
session-only doc with a warning, and mark clean unavailable for this session until a claim write
succeeds. The mark is session state, not a store record: a later explicit save retries the claim first
and clears the mark on success. No claim, no clean. Session-only assets have no hash and stay
relinkable. A legacy project with no content hashes needs no claim and opens normally. This fallback
applies to opening or restoring an existing project. Do not delete existing shards or bytes on this
path. An autosave restore does not write a claim; clean reads the autosave slot as a live reference.
Explicit save through `downloadProjectJSON` is different: it must still await its claim write and fail
rather than write a copy whose bytes are unclaimed. Do not fire-and-forget a claim for a copy that is
about to be written.

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
  helper, the content-hash key and path validation, the sidecar, claim shards, and the project lock
  helpers.
- Verify a red test fails before the adapter exists.
- Cover unsupported OPFS, a write failure, a quota failure, an invalid hash, a missing entry, a delete
  of a missing entry, a partial write, a malformed sidecar, an existing valid hash that is reused, an
  invalid existing hash that is quarantined and replaced, two concurrent claim shard writes that both
  survive, and a missing claims directory that disables content-hash deletion.
- Cover the lock: a clean refuses when another holder owns the shared project lock, refuses when Web
  Locks is unavailable, and restores this tab's shared lock after a refused or completed clean.

### Phase 2: import, relink, remove

- Wire the store into the single import boundary and set `MediaAsset.contentHash`.
- Verify an import writes one hash and attaches it only after the write succeeds.
- Verify a failed import write still adds a session-only asset with no `contentHash`.
- Verify relink writes the new bytes before attaching, updates only the current asset's `contentHash`,
  and that a failed write leaves the old hash and old bytes and applies a session-only relink with
  `contentHash` cleared.
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
- Verify clean on a project with a missing claims directory deletes only temp and quarantine files.
- Verify the clean action refuses while this tab has an import in flight.
- Verify a clean and an import on the same project id cannot overlap: the clean holds the exclusive
  lock for the whole delete, and the import runs only in a tab that holds the shared lock.

### Phase 3: rehydration

- Add async rehydration before install.
- Verify a saved project with stored bytes reopens with a working `url` and `file`, not just an image.
- Verify a v4 asset with no hash hydrates as `missing` and relinks, and a v5 asset with a hash hydrates
  from that hash.
- Verify the sidecar MIME type rebuilds the `File`; a missing sidecar falls back with a warning.
- Verify a missing entry still hydrates as `missing` and relinks.
- Verify object URLs for replaced assets are revoked.
- Verify an open writes a claim shard for every validated referenced hash before install, including an
  asset whose bytes fail to hydrate, and an autosave restore writes no claim.
- Verify a failed claim write opens degraded, warns, and disables clean until a later save claims.
- Verify the clean action removes an orphaned hash and keeps a referenced one.
- Verify a superseded open or autosave restore does not install and revokes its object URLs.
- Verify undo and the autosave restore banner still behave as one install.

### Phase 4: storage UX

- Add usage, clean, clear-all, and persistent-storage request.
- Verify the UI handles unsupported OPFS and quota errors.
- Verify the clean action lists candidates, requires confirmation, and leaves referenced media intact.
- Verify a reference that appears while the candidate list waits aborts the delete and restarts it.
- Verify clean refuses when a second tab holds the project open, and when Web Locks is unavailable.
- Verify clear-all leaves the project and clips intact, marks every asset missing, removes the claims
  directory, and warns that saved copies lose their media.

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
  independent names, clean keeps a claimed hash, two concurrent claim shard writes both survive, a
  missing claims directory disables content-hash deletion, an existing valid hash is reused, an invalid
  existing hash is quarantined and replaced, clean refuses while another holder owns the shared project
  lock, clean refuses when Web Locks is unavailable, the shared lock is restored after a refused or
  completed clean.
- Lifecycle: import attaches the hash only after the write, a failed import write adds a session-only
  asset, the imported asset resolves its bytes, relink writes before attaching and a failed write keeps
  the old hash and bytes with a session-only relink, a failed claim write opens degraded and disables
  clean until a save claims, remove keeps the hash, clean deletes an orphan, clean keeps a referenced
  hash, clean refuses while an import is in flight, an explicit save and an open write a claim shard
  for every validated referenced hash including failed hydration, an autosave restore writes no claim,
  clean keeps the autosave slot's hashes until the slot no longer references them, object URL revoke.
- Rehydration: v5 asset restores `file` and `url` from its hash and sidecar, v4 asset with no hash stays
  missing and relinks, missing sidecar falls back with a warning, autosave restore, one install,
  superseded install discarded, an open writes its claim shard before install, a claim write failure
  opens degraded and a legacy project with no hashes opens normally, a new project or reset
  invalidates an in-flight restore, history reset as today.
- Install coordination: install does not delete or reorder a claim shard; a clean refuses while an
  install or import is in flight in this tab; the exclusive project lock excludes every other open tab
  for the whole clean; a second tab opening the project during a clean makes the delete fail closed.
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
- **In-flight imports.** Clean refuses while this tab has an import or install in flight, and while any
  other tab holds the project open. A clean can therefore never run beside a write that has not yet
  been attached to a doc.
- **Clean and install race.** Clean releases this tab's shared lock, takes the project lock exclusively,
  and holds it across collect and delete. Another tab that opens the project during that window keeps
  its shared request queued; the exclusive request is already granted, so no other tab can open the
  project until the delete finishes. If the exclusive request is not granted, clean deletes nothing.
- **Other tabs' undo history.** A clean cannot run while another tab has the project open, so the only
  history stack that matters is this tab's, and clean reads it directly. A closed tab's history is
  covered by its claim shards and the autosave slot.
- **Degraded open.** A failed claim write opens the project with a warning and disables clean for the
  session. A save retries the claim and clears the mark on success. No claim, no clean.
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
- A clean refuses while another tab holds the project open, or when Web Locks is unavailable, and
  deletes nothing in either case.
- A failed claim write opens the project in degraded mode and clean stays unavailable until a save
  claims the bytes.
- Removing an asset keeps its bytes for undo; the clean action frees them once history no longer
  reaches them.
- Freeze frame creates a durable still on a new topmost video track, adds one clip, and undoes as one
  action.
- `bun run check` and `bun run battery:pair` are green.
- The 0.23.0 schema bump and version bump are atomic in one commit.

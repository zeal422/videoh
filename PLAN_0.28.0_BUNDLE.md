# 0.28.0 project bundle

**Created:** 2026-11-12
**Complexity:** High
**Effort:** L
**Schema:** 8, no bump
**Depends on:** 0.23.0 for media and 0.25.0 for fonts; sequenced after 0.27.0
**Status:** planned

## 1. Goal

Add a portable project bundle:

- Export a ZIP containing the project file, every media library entry, and every project font.
- Import a bundle, validate it, restore media through OPFS, and install the project once.

This closes the sharing gap without a backend. The bundle is a local file the user can copy, archive,
or send. The release is one commit and one version bump.

## 2. Anti-goals

- No cloud upload, share links, accounts, or collaboration.
- No incremental sync or merge.
- No arbitrary ZIP import into the current project. A bundle opens as a project.
- No media transcoding during bundling.
- No files outside the project's own media and font libraries. Proxies, thumbnails, caches, and
  generated previews are not bundled.
- No schema bump. The project inside the bundle keeps its current `SERIALIZATION_VERSION`.
- No remote font or template download.

## 3. Current state, verified

- Project files are `.veproj.json` and contain no media bytes. Object URLs and `File` handles are
  stripped (`README.md:147`, `src/lib/editor/serialization.ts:90`).
- 0.23.0 stores imported media in OPFS and rehydrates it before install.
- 0.25.0 adds project font metadata and font bytes.
- 0.27.0 adds recordings, which are ordinary media assets.
- There is no ZIP dependency in `package.json`.
- `export/mp4.ts` already streams to a File System Access sink for large exports. The bundle writer
  should follow the same pattern when available.

## 4. Bundle format

Use a documented bundle version separate from `SERIALIZATION_VERSION`.

Proposed layout:

```text
manifest.json
project.veproj.json
media/<assetId>/<sanitized-file-name>
fonts/<fontId>/<sanitized-file-name>
```

`manifest.json` contains:

- `bundleVersion`, starting at 1.
- `createdAt`, ISO date.
- `project`, the path to the project JSON.
- `assets`, an array of id, path, name, MIME type, byte size, and SHA-256 hash.
- `fonts`, an array of id, path, display name, byte size, and SHA-256 hash.

Rules:

- The project JSON remains the existing format and version. Do not rewrite it for the bundle.
- The project's `Doc.media` and `Project.fonts` are the source of truth. Every entry is bundled,
  including unused bin items and fonts referenced only by the brand kit, because the project JSON
  lists them on import.
- A media entry that is not in `Doc.media`, or a font entry that is not in `Project.fonts`, is
  rejected as an extra entry.
- A missing font file is a warning, not a load failure, because the project can fall back.
- Sanitize every path segment. Reject absolute paths, `..`, backslashes that normalize into traversal,
  NUL characters, and duplicate normalized paths.
- Use a deterministic name for the project file and sanitized display names for media.

## 5. ZIP implementation and dependency gate

The repo has no ZIP writer or reader. This is the one release where a dependency may be justified.

Phase 0 is a short implementation spike with two candidates:

1. A store-only ZIP writer and reader in pure TypeScript, with CRC32 and a central directory. Media is
   already compressed, so store-only is acceptable. This avoids a dependency but needs careful
   streaming and archive parsing.
2. A small lazy-loaded ZIP library, imported only when the user exports or imports a bundle. This is
   less code to own but adds a dependency and must support streaming large entries or at least a
   documented size cap.

Choose the store-only path if it stays a small, testable module and can stream a bundle to a file sink
without buffering the whole archive. Otherwise use the library, with explicit approval recorded in the
release commit and `CHANGELOG.md`.

Do not install a dependency before the spike proves the need. Do not buffer a multi-gigabyte bundle in
memory without a documented cap and warning.

## 6. Export flow

1. Capture one immutable project snapshot and gather the project JSON from that snapshot through the
   existing serializer.
2. From the same snapshot, collect every `Doc.media` id and every `Project.fonts` id. Do not read the
   live store again after the snapshot.
3. Resolve media bytes from OPFS, falling back to the session `File` when the asset is not stored.
   Resolve font bytes from the project font namespace by the font's `contentHash`; fonts have no
   session-file fallback. Compute each entry's SHA-256 and compare it with the stored `contentHash`.
   Refuse export on a mismatch, including a session-file fallback whose bytes do not match. If an
   asset has no stored hash, use the computed hash in the manifest; import adopts it after
   verification.
4. If any media entry is unavailable, refuse the bundle and list the missing files. The user can
   relink or remove them, or use the existing project-only save. If a referenced project font is
   missing, warn with the font names and require confirmation that the bundle will fall back. An
   unreferenced library font is a warning only.
5. Build the manifest and write the ZIP.
6. Prefer the File System Access streamed sink. Fall back to a Blob download with a size warning.
7. Name the bundle `<project-name>.vebundle.zip` or another documented extension. Do not use the bare
   `.veproj.json` extension.

Include every project font's bytes, not only its metadata. Keep binary font data out of the project
JSON and in the bundle `fonts/` entries. If a font file is missing, keep the metadata in the project
and apply the warning and confirmation above.

## 7. Import flow

1. Read the ZIP and the manifest.
2. Validate the manifest version, entry paths, duplicate ids, entry count, total size, per-entry size,
   and declared hashes.
3. Parse the project JSON through the existing `parseSerializedDoc`. Refuse a newer project version.
4. Match manifest assets to every `Doc.media` id, not only clip-referenced ones. Reject missing media,
   duplicate ids, extra entries, unknown kinds, mismatched byte sizes, and hash mismatches. The project
   asset's `contentHash` must equal the manifest asset's SHA-256. If the project predates content
   hashes, adopt the manifest hash only after the file hash matches. Probe each entry for kind,
   dimensions, and audio, passing the serialized duration as the `durationHint`. Keep a finite
   serialized `duration`; when the probe duration is non-finite or 0, keep the serialized duration, so a
   WebM recording without a duration header survives a bundle round trip.
5. Match fonts to every `Project.fonts` id. A missing font is a warning. The project font's
   `contentHash` is the ID-to-bytes mapping; the manifest SHA-256 must equal it, or supply it for a
   project that predates the field. Bundled bytes install into the project font namespace under that
   hash. Stage the faces under the import id, and register them in the active project registry only
   after installation succeeds and before the first composite. On validation or installation failure,
   delete every staged face.
6. Rehydrate the media and font bytes into a staging directory keyed by a fresh import id. After every
   entry validates, promote each content hash into the matching media or font namespace under
   `<project-id>/<hash>` only when that hash is absent. Write each hash to `<hash>.tmp-<import-id>`,
   verify the SHA-256, then promote under the lock: if the final hash is absent, rename the temp into
   place; if it exists and verifies, delete the temp; if it exists but is invalid, quarantine it,
   rename the temp in, and delete the quarantine. Never overwrite a valid hash. Readers verify the hash
   and treat a mismatch as missing. A crash leaves a temp or quarantine file, never a partial file at a
   final hash path. On failure, delete only the staging directory and the temp files; a promoted hash
   is immutable, may be shared with another import, and is left for the explicit clean action.
7. Hold the exclusive media lock from the first promotion through installation, and mark each promoted
   hash reserved in the live-set protocol. Before `installProject`, write an immutable claim shard
   under `<project-id>/claims/` listing every installed hash. If the claim write fails, abort before
   installation, delete the partial shard, release the reservation, and leave the project uninstalled.
   Existing claim shards are untouched.
8. Install the hydrated project once through `installProject`. Take autosave ownership before
   `installProject`. If autosave ownership cannot be acquired, delete the import's claim shard,
   release the reservations, and abort before installation. After installation succeeds, append the
   install id to the installed-state registry and await its durable commit before writing the
   imported doc to the shared slot. If the registry append fails, do not write the slot; keep
   ownership, the claim shard, and the reservations, keep other tabs paused, and show an error. Retry
   the append and slot write on the next autosave. If the slot write fails after a durable registry
   append, keep ownership, the claim, and the reservations, and show an autosave error. Release the
   reservations only after the registry record and the imported slot are durable. If installation
   fails, delete the import's claim shard, release the reservations, leave the promoted hashes in
   place, and leave the project uninstalled; newly promoted hashes are left for cleanup and existing
   claims are untouched. If installation fails before the slot write, release autosave ownership and
   resume the paused tabs. Never clear a reservation while installed media is unclaimed. Verify
   `installProject`'s failure contract in phase 3 and never install a partial doc. There is no claim
   write after `installProject` succeeds, so a late claim failure cannot leave installed media
   unclaimed.
9. Show warnings for missing fonts and for any other non-fatal condition.
10. Revoke any temporary object URLs, delete any staged font faces, and close the file handle.

Crash recovery for pre-install claim shards: each claim shard records the install id and is written
before installation. A successful installation records that install id durably in a persisted
installed-state registry before it writes the imported doc to the shared slot. The registry is
append-only and keyed by project id; it is not cleared when
another project is opened, so a saved copy's install id and claim shard survive a later project
switch. Saving a copy records its install id in the same registry. The shard itself stays immutable.
After a crash, read the project installation state before touching the shard. A shard whose install id
is recorded as installed is kept. A shard whose install id has no matching installed record is
orphaned; remove the shard so its hashes can be reclaimed, but do not delete the bytes during
recovery. If the installation state is missing or ambiguous, keep the shard and warn. Recovery runs
before the clean action and re-reads the installation state under the media lock; it never treats an
unreadable state as proof that a project is uninstalled.

Crash-boundary tests drive the durable order explicitly. Crash after the installed-state record is
durable but before the autosave slot write: recovery finds the install id and keeps the shard; the
absent slot cannot orphan it. Crash after the slot write but before reservation release: recovery
again keeps the shard, and the slot keeps the hashes live. Crash before the registry record: no
autosave can reference the shard because the slot write has not run; recovery may remove the
orphaned shard, but it does not delete bytes. A test that completes the autosave after the registry
record must assert the shard is not classified as orphaned.

Do not merge into the current project. Do not leave a partially imported project installed.

The imported doc keeps its project id. Its media entries carry their own content hashes, so an existing
project with the same id keeps resolving its own hashes; the import never changes another doc's
references. Do not allocate a new project id for this reason.

The autosave slot is one key shared by every project and tab, not a map keyed by project id.
Importing replaces the current doc and autosave, like opening any project; it does not merge. Save or
export the current project first if it must be kept. Before installing, the importing tab takes autosave
ownership. It broadcasts `autosave-pause` on the global editor channel; every other tab cancels its
pending autosave timer, prevents new writes, and waits for any in-flight write to settle before
replying `paused`. If a write cannot be aborted safely, the tab waits for it; it never acknowledges
while an older write could still land. If any tab does not reply within a timeout, the import refuses
and asks the user to close or reload that tab. The warning is not the protection. Every autosave
writer, including a newly opened or reloaded tab, serializes the ownership check and the shared-slot
write in one cross-tab critical section, with a per-tab queue only for ordering local writes. Use
`navigator.locks.request('videoh-autosave:<slot>', { mode: 'exclusive' }, ...)` when available.
Without Web Locks, put the ownership record and the slot in one IndexedDB object store and perform
the read-check-write in a single `readwrite` transaction. The record names the owner tab, its session
id, a resume-token hash, a monotonic ownership epoch, and a heartbeat. Every slot write records the
epoch. A takeover increments the epoch under the same critical section. A tab without fresh ownership
does not write;
it loads read-only, shows the reload prompt, and waits. A new tab cannot claim ownership while the
record is fresh. Only an explicit takeover after the owner is unresponsive may claim it. A former
owner that resumes sees the new epoch and cannot overwrite the takeover's write; it must reload
read-only. This rule applies to the importer and to every later writer, not only tabs that received
`autosave-pause`.

A reload keeps a `sessionId` and `resumeToken` in `sessionStorage`. The loaded page broadcasts a
probe for its session. If the old page answers, it does not resume. If no page answers, the ownership
record still carries the same session id and epoch, and the token hash matches, the reload atomically
replaces the page id and refreshes the heartbeat under the same critical section. If the epoch
changed, the reload stays read-only. A user can instead close the owner tab and use explicit
takeover, which increments the epoch; the former owner can never write again.

After `installProject`, the importer writes the imported doc to the shared slot and holds ownership
until it unloads. If that write fails, it keeps ownership, keeps the other tabs paused, and shows an
autosave error; do not ask them to reload until the slot is current. Other tabs stay paused and show a
reload prompt; they never resume their pre-import document. On reload they read the imported autosave
and may resume as normal editors. After a successful install, ownership release, including a
stale-owner expiry, does not unpause a tab; only a reload does. On a failed install before any slot
write, release ownership and resume the paused tabs because their previous documents are still
current. This preserves the shared-slot behavior while preventing an older in-memory document from
overwriting the imported project.

## 8. Security

Treat the archive as hostile:

- Zip bomb: entry count cap, per-entry size cap, total size cap, and compression ratio cap if
  compression is used.
- Path traversal: normalize each entry path and reject any path outside the bundle root.
- Duplicate paths and duplicate asset ids: reject.
- Manifest fields: validate types, lengths, and known values.
- Project JSON: use the existing serialization validator, including the newer-version refusal.
- Media bytes: import through the normal probe path so a malformed file becomes a missing or rejected
  asset, not an editor crash. Verify each declared SHA-256 before promotion; a mismatch rejects the
  bundle.
- Fonts: reuse the 0.25.0 font validation. A corrupt font must not break the import.
- Do not execute anything from the archive. Do not follow paths outside OPFS.

## 9. File plan

New files:

- `src/lib/editor/project-bundle.ts` for the manifest, path rules, and bundle planning.
- `src/lib/editor/bundle-zip.ts` or the chosen ZIP module.
- Browser wrapper in `src/lib/editor/project-io.ts` for picker, stream, and OPFS integration.
- UI entries for Export Bundle and Open Bundle.

Expected modified files:

- `src/lib/editor/project-io.ts`: bundle export and import entry points.
- `src/lib/editor/project-bundle.ts`: validation and round-trip.
- `src/lib/editor/media/media-store.ts`: read and write helpers for bundle entries, claims, and
  reservations.
- `src/lib/editor/persistence.ts`: autosave pause, resume, ownership, and the shared-slot handshake.
- `src/lib/editor/fonts.ts`: font byte lookup for bundling and staged face registration and cleanup.
- `src/components/editor/MenuBar.tsx` and the toolbar or File menu.
- `src/lib/editor/__tests__/` for manifest, ZIP, hostile archives, and round trip.
- `package.json` and `bun.lock` only if the dependency gate approves a library.
- `docs/architecture.md`, `docs/flows.md`, `README.md`, `docs/testing.md`, `docs/deployment.md`.

## 10. Phases and verification

### Phase 0: ZIP spike

- Build the smallest store-only ZIP round trip or evaluate the library.
- Verify a large streamed write does not buffer the whole archive.
- Verify a hostile archive is rejected at the path and size checks.
- Record the dependency decision before proceeding.

### Phase 1: manifest and path rules

- Add the manifest schema, path normalization, id matching, and limits.
- Write the hostile path and duplicate-id tests first.
- Verify traversal, absolute paths, NUL, duplicate ids, oversized manifests, and missing project file.

### Phase 2: export

- Gather every `Doc.media` and `Project.fonts` entry.
- Verify a complete bundle round-trips a project with media and a custom font.
- Verify a media entry whose bytes do not match its stored `contentHash` refuses, including when the
  bytes come from the session `File` fallback.
- Verify font bytes come from the project font namespace and a missing referenced font warns and
  requires confirmation.
- Verify a missing relinkable asset refuses with a file list.
- Verify streamed and Blob fallback paths.

### Phase 3: import

- Validate, rehydrate, and install.
- Verify one install, history reset as with any project open, and no partial project.
- Verify the project asset hash and the font hash match their manifest entries.
- Verify a partial temp file never reaches a final hash path, and an invalid final hash is quarantined
  and replaced.
- Verify promoted hashes are reserved through installation and the clean action cannot reclaim them, and
  the import writes its claim shard before `installProject` and releases reservations only after
  success or failure.
- Verify a claim shard write failure aborts before installation, leaves the project uninstalled, and
  leaves existing claims untouched.
- Verify a failed `installProject` removes the import's claim shard, leaves no project installed, and
  leaves promoted hashes for the clean action.
- Verify a hash that already exists in another project is reused and never overwritten.
- Verify bundled fonts install into the project font namespace and register before the first composite,
  and staged faces are removed on validation or install failure. Verify rollback recovery either
  preserves the original font id and generated family or remaps every `TextStyle.fontFamily` and
  brand-kit reference to the new family, so text does not fall back after re-upload.
- Verify a WebM recording without a duration header round-trips with its serialized duration.
- Verify every other active editor tab pauses autosave and acknowledges before installation, waiting
  for any in-flight write to settle first, a tab that does not acknowledge refuses the import, and the
  refused import leaves no claim shard or reservation. Ownership lasts until unload, and a slot write
  failure keeps the other tabs paused. A paused tab never resumes its pre-import document without a
  reload. Verify every autosave writer, including a new or reloaded tab, serializes the ownership check
  and slot write in one queue, so an older write cannot replace the imported project after the importer
  writes it; a tab without fresh ownership cannot overwrite it.
- Verify a claim shard left by a crash is kept when its install id is recorded installed and retired
  when no installed record matches, only after the installation state is read under the media lock;
  orphaned hashes are left for the clean action, never deleted during recovery. Verify the installed
  registry retains a saved copy's install id after another project is opened, and that import, save,
  open another project, clean, then reopen the saved copy preserves the claim and required bytes.
- Verify missing media refuses, missing font warns, and extra entries follow the chosen policy.
- Verify a newer project version is refused.

### Phase 4: security and large files

- Add caps and compression-ratio checks.
- Verify a zip bomb, duplicate entries, path traversal, and oversized entry are rejected without
  exhausting memory.
- Verify a large media bundle stays within the documented memory budget.

### Phase 5: docs, batteries, release cut

- Update the project file and bundle docs.
- Run `bun run check`.
- Run `bun run battery:pair`.
- Apply the atomic 0.28.0 bump from the master plan.

## 11. Tests and locks

- Bundle planning: every `Doc.media` and `Project.fonts` entry, including unused bin items and
  brand-kit-only fonts, missing media list, duplicate ids, missing project file.
- ZIP: round trip, store or compression path, streamed write, entry order, CRC, truncated archive.
- Hostile archive: `../`, absolute path, NUL, duplicate path, duplicate id, zip bomb, oversized entry,
  too many entries, malformed manifest, unknown bundle version, hash mismatch.
- Import: project version refusal, missing media, missing font warning, extra entries rejected,
  orphaned pre-install claim recovery, the installed registry retains a saved copy's id across a
  project switch, project asset hash must match the manifest hash, font content hash must match the
  manifest hash, one install
  with history reset, OPFS persistence, a partial temp is never promoted, an invalid existing final
  hash is quarantined and replaced, a valid existing hash is reused and never overwritten, promoted
  hashes are reserved through installation and cannot be cleaned, the claim shard is written before
  install, a claim write failure aborts before install, a failed import removes its claim shard and
  leaves promoted hashes for cleanup, a failed `installProject` leaves no project installed, a project
  with the same id and different hashes keeps its own references, bundled fonts install and register
  before the first composite, staged faces are removed on failure, rollback re-upload preserves the
  original font id or remaps every family reference, a WebM recording without a duration
  header keeps its serialized duration, every other active editor tab waits for its in-flight write to
  settle before acknowledging the pause, a non-acknowledging tab refuses the import and leaves no claim
  shard or reservation,
  autosave ownership lasts until unload, a slot write failure keeps the other tabs paused, a paused tab
  never resumes its pre-import document without a reload, object URL cleanup.
- Export: one immutable snapshot supplies both the serialized doc and the asset and font id
  collection, edits during export cannot mix project states, OPFS bytes preferred, session file
  fallback, a media hash mismatch refuses including the session fallback, font bytes come from the
  project font namespace, a missing referenced font warns and requires confirmation, missing asset
  refusal, Blob size warning.
- Round trip: project with video, audio, image, freeze still, a WebM recording without a duration
  header, custom font, shape, group, and brand kit survives export and import, including an unused bin
  asset and a brand-kit-only font.

## 12. Atomic release cut

Follow section 7 of `MASTER_PLAN.md`. The 0.28.0 commit must update:

- `package.json` to `0.28.0`.
- `src/lib/releases.ts` with four or more highlights and the actual ISO date.
- `CHANGELOG.md` with `## [0.28.0] - YYYY-MM-DD` and a dependency note if one was added.
- `ROADMAP.md` with the shipped row and intro sentence. No Premiere gap status change.
- `README.md` project format and bundle paragraphs.
- `docs/flows.md` export and import bundle contracts.
- `docs/architecture.md` bundle and ZIP module notes.
- `docs/testing.md` for the new tests and coverage scope.
- `docs/deployment.md` for bundle size and browser support.
- `docs/structure.md` for new files and test counts.
- `package.json` and `bun.lock` only if the dependency gate approved a ZIP library.

Do not bump the schema. The project inside the bundle keeps version 8.

## 13. Rollback

Revert the single release commit. A previous app cannot open a bundle at all because it has no bundle
import, even when the project inside is a supported version. To recover, keep the upgraded app, or
extract `project.veproj.json`, the `media/` entries, and the `fonts/` entries; open the project, relink
every media file, and restore each bundled font. The font upload control creates a new font id by
default, so a bare re-upload changes the generated CSS family and leaves `TextStyle.fontFamily` and
brand-kit font references pointing at the old family. Before uploading, record each `Project.fonts`
entry's id and family. Use a recovery upload path that preserves the original id and family, or after
upload rewrite every `TextStyle.fontFamily` and brand-kit font reference in `project.veproj.json` to
the new generated family before opening it. Test both the preserve and remap paths; a missing font
still falls back with a warning. Remove the menu entries first if import is the failing surface.

## 14. Risks and decisions

- **ZIP dependency.** The only new-dependency candidate in the sequence. Decide with the spike, not by
  assumption.
- **Memory.** A media bundle can be large. Prefer streaming and enforce caps.
- **Staging collisions.** Write to a temp path, verify the hash, then promote. A valid existing hash is
  reused; an invalid one is quarantined and replaced. Promoted hashes stay reserved through install,
  the claim shard is written before install, and clean skips reservations and claims. There is no
  pointer to restore and no multi-pointer commit.
- **Hostile archives.** Validate paths, sizes, ids, and versions before writing to OPFS.
- **Missing media.** Refuse the export rather than produce a bundle that silently loses footage. The
  check covers every `Doc.media` entry, including unused bin items, because the project JSON lists
  them.
- **Unused entries.** Unused media and fonts are part of the project's libraries and are bundled.
  Skipping them would import a project with a broken bin. They are the only "unreferenced" files
  allowed; proxies, thumbnails, and caches stay out.
- **Fonts.** Missing font bytes are a warning because the project can fall back. Missing media is a
  refusal because footage is the point.

## 15. Definition of done

- A project with media, a recording, a frozen still, a custom font, a shape, a group, and a brand kit
  exports and imports as a bundle, including an unused bin asset and a brand-kit-only font.
- Missing media refuses with a clear list; missing fonts warn.
- Hostile archives are rejected without memory exhaustion or path escapes.
- Import installs once with no partial project.
- `bun run check` and `bun run battery:pair` are green.
- The 0.28.0 version bump is atomic in one commit.

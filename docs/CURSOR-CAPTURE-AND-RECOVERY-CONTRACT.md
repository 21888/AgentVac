# Cursor preservation and canonical recovery contract

Reviewed **2026-10-05 UTC**. This is a public-evidence design and small fixture
probe, not a released export feature or a supported native archive adapter.
It does not change any production action eligibility. No vendor application,
proprietary bundle, user data or user computer was inspected or executed here.

## Decision

**Keep local canonical mutation disabled.** Public evidence supports native
readable export and some native UI actions, but does not establish the current
local IDE record closure or a safe selective restore/import interface.

The useful near-term outcome is explicit preservation:

1. A user can use Cursor's native **Export Chat** action to preserve readable
   text/code. This is available now in Cursor, independently of AgentVac.
2. AgentVac can implement **Save private state snapshot** under the contract
   below, preserving every captured byte without interpreting or deleting
   unknown records. This needs a new explicit consent/destination flow and
   filesystem acceptance tests. It is **not implemented in the product**.
3. Opening an exported transcript in a new conversation supplies context; it
   is not restoration of the original native session, checkpoints or tool state.

Neither export nor a snapshot reduces the live history or its disk usage.
The request for exact-selected reversible cleanup remains open, not redefined as
transcript-file cleanup. A standalone copy is useful protection, but is not
permission to remove the source.

## Public evidence that changes the design

| Evidence                                                                                                                                                                                                                                     | Supported conclusion                                                                                                          | Does not establish                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [0.50 official release notes](https://cursor.com/changelog/0-50#exporting-chat), May 15, 2025; [staff reminder](https://forum.cursor.com/t/how-can-i-reduce-the-size-of-the-state-vscdb-file-without-deleting-chats/169927/13), Aug 31, 2026 | Native Markdown export includes text/code; staff still directs users to Export Chat                                           | Full binary attachments, resumable session export, bulk export or import           |
| [Staff on native import proposal](https://forum.cursor.com/t/native-agent-history-import-importer-api-for-claude-code-codex-and-cursor-sessions/164604/6), July 2, 2026                                                                      | A public importer with dry-run/rollback remained a requested capability; staff preferred the preview-only approach            | A supported local database patcher or official extension command for import        |
| [Staff on IDE/CLI separation](https://forum.cursor.com/t/local-ide-agent-chats-and-the-agent-cli-still-use-separate-session-stores/165486/8), Aug 31, 2026                                                                                   | Local IDE and CLI/SDK sessions had separate stores and no shared stable resume ID                                             | That `--resume <composerId>` preserves or resumes IDE history                      |
| [Staff storage update](https://forum.cursor.com/t/agent-chat-window-is-disappearing-quickly-after-showing-up/157296/23), Aug 27, 2026                                                                                                        | History storage was reworked for 3.16+                                                                                        | That the older two-database structure or deletion behavior applies to newer builds |
| [3.16.29 first-party bug report and staff response](https://forum.cursor.com/t/update-wiped-agent-chat-history-cursordiskkv-agents-window-empty-restore-crashes/168900), Aug 19–20, 2026                                                     | The reporter observed `glass.localAgentProjectMembership.v1`; staff states JSONL cannot fully reconstruct the UI              | The membership value format, write ownership, all references, or tombstone rules   |
| [Staff on native GC](https://forum.cursor.com/t/cursor-renderer-keeps-crashing/171235/8), Sept 10, 2026                                                                                                                                      | Native blob GC and a user's reachability walk selected different live sets; staff says orphaned rows can keep blobs reachable | A complete third-party blob-root traversal, or safety of deleting by key prefix    |
| [Staff on archive UI](https://forum.cursor.com/t/missing-delete-button-for-conversations-only-seeing-archive/161916/5), May 31, 2026                                                                                                         | Native Archive hides a chat from the active list and supports later restoration, with UI-specific behavior                    | That archive frees storage, or that toggling one private JSON field implements it  |

Dates and versions matter. These are the reviewed public sources, not a claim
that an undocumented interface can never exist. Older search-indexed History
URLs currently redirect to the general Agent overview, so the working release
note and staff links above are the stronger export references.

### Supported commands and APIs checked

- The [current CLI parameter reference](https://cursor.com/docs/cli/reference/parameters)
  documents session listing/resume and current-run output, not a local IDE
  historical archive/import contract. A prompt asking the model to print a
  conversation is not a byte-preserving backup.
- The [Cloud Agents API lifecycle](https://cursor.com/docs/cloud-agent/api/endpoints#archive-an-agent)
  explicitly documents idempotent archive/unarchive for cloud agent IDs. This
  is a real reversible surface, but it is a different product/store. AgentVac's
  local IDE IDs must never be sent there or guessed into cloud IDs. No API calls,
  account setup, credentials or cloud integration are part of this work.
- Native `Export Chat` and `GC Agent KV Blobs` names are public staff guidance.
  No reviewed official source provides a stable extension command identifier,
  machine-readable local archive/restore API, or local record ownership contract.
  Do not guess command IDs, reflect over a proprietary installation, or treat
  another extension's private command as a supported vendor API.
- Native GC is a separate maintenance operation, not selected-conversation
  archive/restore. Its reclamation can be incomplete and it needs temporary
  space. This work neither invokes nor automates it.

## Exact blockers for canonical selected-conversation mutation

The production allowlist of proven native write generations is **empty**.
A readable schema is not a writable schema. Before adding one, obtain lawful,
version-specific evidence and native round-trip verification for every item:

1. **Generation and migrations:** an authoritative build/schema discriminator,
   migration state and complete set of stores. Shape matching alone is not an
   independent version fence. Unknown extra relevant fields are not ignorable.
2. **Selected closure:** all composer, ordered message, tool/checkpoint/context,
   attachment, workspace, search and native transcript relationships, including
   archived and orphaned-but-live roots. Duplicate headers are not duplicate chats.
3. **Lifecycle semantics:** exact archive, delete, tombstone, parent/subagent and
   project-membership rules. A changed `isArchived` flag is not proof of canonical
   removal; do not synthesize missing headers, status, IDs or timestamps.
4. **Shared ownership:** a complete live-root traversal for `agentKv` and other
   shared objects. Preserve shared references; never remove by string prefix.
   Even if shared bytes are retained, selected restore must preserve their
   dependency bytes against later independent vendor GC.
5. **Writer exclusion across failure:** closing Cursor before a write is not a
   durable exclusion mechanism. A user can reopen it after an AgentVac crash.
   A private AgentVac journal is not observed by Cursor. If independently
   committed stores can expose partial state, the feature must stay blocked.
6. **Transaction and recovery:** [SQLite WAL](https://sqlite.org/wal.html) does not
   give a cross-database atomic commit. SQLite's [ATTACH atomicity conditions](https://sqlite.org/lang_attach.html)
   do not justify changing the vendor databases' journal modes. A tested,
   supported atomic boundary or vendor-coordinated recovery is required.
7. **Selective non-overwriting restore:** restore only selected absent/expected
   values, merge index fragments by stable identity, preserve newer unrelated
   conversations/settings, and fail on conflicts. Whole-database replacement
   cannot satisfy that contract. A backup's age does not grant overwrite authority.
8. **Proof of user-visible outcome:** native app accepts the restored thread,
   message order, tool results, attachments and required context; selected content
   disappears/returns as advertised, unrelated state remains unchanged, and every
   crash boundary recovers. Fixtures alone cannot establish this.

A native vendor API that owns lifecycle and recovery could discharge several
of these obligations together. Public export documents do not do so.

## Proposed private opaque-snapshot contract

This is an app-owned preservation format. It deliberately needs no guesses
about Cursor's tables, keys, JSON objects or blob reachability.

### 1. Selection and separate consent

- Keep existing viewing consent and a durable backup permission distinct.
  Preview the exact source scopes, estimated total bytes, new private destination,
  retention choice and free-space requirement before copying.
- Ask for an explicitly selected application-data scope. The candidate history
  scope includes entire `User/globalStorage` and `User/workspaceStorage` trees,
  not just matching rows. Preserve workspace metadata and unknown files inside
  the approved scopes. Other roots must be selected separately; never derive
  `~/.cursor` or project directories from application-data consent.
- Separately selected transcript roots may be included as additional scopes,
  clearly marked as partial native text exports. No implicit path traversal.
- Whole-store snapshots can contain unrelated histories, settings, authentication
  pages and sensitive content. Disclose that the durable copy includes them and
  remains local. Do not label it a conversation-only backup or automatically
  upload, share, sync, or attach it to a bug report.
- Copying unknown bytes preserves what was captured. It does not prove that all
  data needed for native resume lives in the approved scope. Record unselected
  or unsupported scope limitations explicitly; never report full native coverage.

### 2. One capture set, one observation interval

1. Require closed-app confirmation plus current process inspection. Unknown
   process state blocks a verified-state capture. The user must keep Cursor and
   helpers closed until it finishes. Do not kill them automatically.
2. Before copying any member, inventory **every** approved root and member.
   Pin root/ancestor/file identities using no-follow handles; reject links,
   junctions, special files, unexpected hardlinks, escaping paths and extraction
   name collisions. Record each DB's present and absent WAL/SHM/journal sidecars.
3. Enforce a user-approved cumulative budget and actual recovery space. Stream
   full bytes, never read multi-GB stores into one buffer. A sparse logical size,
   file-count cap, unreadable member or disk-full failure is explicit, not a
   silent exclusion. Private staging must be outside every source root.
4. Copy each database and any WAL as opaque bytes. Preserve other approved
   members too. A nonempty rollback journal blocks verified status. Do not open
   live source databases with SQLite, run VACUUM/GC, checkpoint them, or use
   `immutable=1` to ignore WAL.
5. Keep all earlier roots/files/absent sidecars pinned until **the entire set**
   is copied. Re-enumerate the complete inventory and recheck all identities,
   sizes, change/modification times and the writer state before publication.
   An individually verified global DB followed by a separately verified newer
   workspace DB is not enough. Any change discards verified status for the set.
6. Validate SQLite only against disposable derivatives of the private captured
   bytes, never against the original or the archival payload. Rebuild SHM there.
   Bounded integrity checks and WAL recovery/read tests must complete; failed or
   timed-out validation cannot be silently called successful.
7. Record consistency as `closed-source-stable-observation`, not `atomic-live`
   or native semantic coherence. Multiple sequential [SQLite backup calls](https://sqlite.org/backup.html)
   do not alone give one cross-store point in time. A future filesystem-snapshot
   mode needs independently verified common-volume/cross-volume semantics.

An already inconsistent source may remain inconsistent in a byte-perfect copy.
The receipt must distinguish byte integrity, per-database validation and native
semantic compatibility; none implies the next.

### 3. Manifest, integrity and durable publication

Use a versioned format such as `agentvac.cursor-opaque-capture.v1` with:

- an opaque capture ID, exact scope descriptors and root identity fingerprints;
- observed vendor version and its provenance, or explicitly `unknown`;
- file inventory, type, size, content digest, relevant source identity and sidecar
  observations; no renderer-visible raw paths or transcript text in logs;
- start/end times of capture and final common-set verification;
- consistency label, validation results and all coverage limitations;
- explicit `nativeResumeGuaranteed: false`, `removesSourceData: false`, and
  `containsUnrelatedPrivateState: true`.

Create a fresh owner-private destination, write all payloads and the manifest
through exclusive files, fsync files and required parent directories, then
publish with an OS-verified **no-replace** operation on the same filesystem.
Retain an integrity receipt in a separately trusted app-owned index or use a
properly managed signing key. A checksum stored beside the data only detects
accidental damage; an attacker can change both. Do not call hashing encryption.

The capture must not be visible as complete before all validation and durable
publication succeeds. Record `preparing`, `verified`, `published` and interrupted
states with app-owned markers. Startup handles only verified owned staging and
never deletes unknown user files. Crashed/incomplete captures are unavailable
for extraction until verified; preserving the unchanged source makes capture
failure safe without a source rollback operation.

### 4. Verification and recovery semantics

The safe recovery action is **Extract snapshot to a new review folder**, not
Restore into Cursor. Verify the trusted manifest receipt and every member first,
then stage into a fresh empty private directory. Reject occupied destinations,
links/reparse points and path/normalization/case conflicts. Publish without
replacement. Never merge into or replace a live application root, even if its
current database seems smaller or its timestamps look older.

A user can inspect the extracted data or provide it to vendor support through a
separately authorized sharing flow. Any later native recovery is a separate,
version-specific operation with new scope and conflict analysis. This export
feature must not enable a hidden native restore button.

### 5. Integrator acceptance checklist

Before exposing this in AgentVac, add real filesystem/runtime tests for:

- source and ancestor replacement; a new WAL appearing after its DB was copied;
  another workspace changing after global-copy completion; unknown files and
  partial enumeration; cancellation and provider/root consent revocation;
- no source-byte or sidecar changes; committed WAL-only records present in the
  private derivative; opaque future tables, shared blobs and embedded binary
  values preserved exactly in archival payloads;
- low disk space, oversized/sparse files, locked files, OS rename/no-replace
  behavior, POSIX permissions and actual Windows ACL inheritance;
- interruption after every file fsync, manifest write, publication and index
  update; restart discovery without promoting incomplete copies;
- tampered manifests/payloads, loss of the trusted integrity receipt, wrong
  schema versions, extraction traversal/collisions and existing destinations;
- packaged Electron IPC consent binding, bounded worker resource use, no content
  logging and a user-visible distinction between export and native archive.

The current request-local reader snapshots do not automatically satisfy this
multi-root durable export contract. Larger temporary-copy opt-in and Windows
ACL work are separate implementation tracks.

## Bounded fixture probe delivered

`tests/support/cursor-capture-contract.ts` has no filesystem, SQLite, network or
vendor-app access. It accepts only process-minted synthetic roots with a single
synthetic generation. It models complete inventory fencing, byte digests,
explicit durable-copy consent, all-or-nothing publication and empty-destination
review extraction. The format is AgentVac's own; no Cursor schema is invented.

`tests/cursor-capture-contract.test.ts` additionally creates a tiny SQLite fixture
and demonstrates that whole-byte capture preserves arbitrary table rows, binary
shared-blob bytes and an unrelated synthetic authentication sentinel. Its source
and extracted databases pass the stated byte/integrity assertions. The WAL
member in the pure model is an opaque synthetic byte fixture, not a real WAL
recovery test; existing reader WAL tests remain separate.

The probe's interruption hooks are logical boundaries, **not OS crash/power-loss
or fsync tests**. Its in-memory destination is not a production extractor. The
trusted receipt digest is supplied separately by the test and has no persistent
key-management implementation. These limits are intentional. No import from
`electron`, `shared`, `src` or packaging is added.

Run `node --import tsx --test tests/cursor-capture-contract.test.ts` and the project
typecheck. These tests do not count as native archive/restore acceptance.

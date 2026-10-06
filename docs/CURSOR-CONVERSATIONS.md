# Cursor conversation readers and cleanup boundary

Evidence checked: **2026-10-05 UTC**. This is a read/display implementation, not
an assertion that every Cursor version has one stable database schema. No real
user conversation, credential, or home-directory data was read during development.
All runtime tests use synthetic files.

## Implemented sources

1. **Explicitly selected Cursor IDE application-data root**: read-only compatibility
   view over `User/globalStorage/state.vscdb` and bounded
   `User/workspaceStorage/<id>/state.vscdb` sources. Recognized records include
   `cursorDiskKV` composer metadata and ordered bubble references, plus
   `composerHeaders` index entries. Single-column unique keys are required;
   views, virtual tables, composite-only identities and malformed records fail
   closed. It does not read arbitrary `ItemTable` values, authentication keys,
   settings, checkpoints, `agentKv` blobs, or unrelated projects.
2. **Separately selected `agent-transcripts` directory**:
   `<id>.jsonl` and `<id>/<id>.jsonl`. Selection and content consent are separate
   from the IDE application root. The reader never derives or traverses
   `~/.cursor` under an application-data consent. It displays the publicly
   evidenced `role` / `message.content` text and tool-input blocks as literal
   text. Unsupported rich/multimodal blocks are explicit notices. It never
   fetches attachment URLs, executes tool inputs, renders HTML, or follows
   transcript-supplied paths.

The root service owns consent, root/provider binding, request cancellation,
opaque renderer IDs/cursors, date/project/content filtering and archive authority.
`cursorConversationReader` and `cursorTranscriptReader` only return read data.
The transcript reader is available for integration with a separate source picker;
it must not be silently selected by the general cleanup-root picker.

## Metadata honesty

- Title is native when present, otherwise the first user message (JSONL) or the
  source identifier. Each summary exposes its provenance.
- Conversation creation/update times come only from native timestamp fields.
  Numeric fields are explicitly interpreted as epoch milliseconds. Invalid
  dates, second-like integers, zoneless strings and rollover dates are unknown.
  Filesystem modification time is never presented as conversation time.
- JSONL timestamps and project path are unknown unless a future, separately
  evidenced identity-matched metadata source supplies them. Embedded text such
  as `<timestamp>...</timestamp>` is content, not authoritative metadata.
- Workspace `workspace.json` contributes a literal folder/workspace URI to its
  own database and to an exactly matching global composer ID in the public
  `composer.composerData` workspace index. Conflicting project mappings remain
  unknown. Encoded directory names are not guessed back into paths.
- A header without readable canonical content stays an explicit incomplete
  index entry. Missing bubble references are visible placeholders; orphan rows
  are not guessed into a thread. Duplicate bubble references fail closed.

## Snapshot, privacy and bounded work

SQLite is never opened on a live source path. The reader opens source files
read-only with no-follow checks, pins file and ancestor identities, and copies
the database plus its WAL into a private temporary directory. SHM is rebuilt
only beside the private copy. A nonempty rollback journal blocks the read.
All source identities and absent sidecars are checked again before any result
is published. A writer changing the source causes the snapshot to be discarded;
this stable-file observation is not advertised as an atomic live snapshot.

The 512 MiB snapshot budget is cumulative within a request when the orchestration
cache is present. Oversized databases receive explicit native-export guidance.
Snapshots are request-local, owner-private, removed on completion/cancellation,
and never a durable content/search cache. A whole-database temporary copy can
contain unqueried settings/authentication pages; it is incorrect to claim those
bytes are never copied. The consent notice must disclose this local-copy scope.
Crashes or power loss can leave private residual copies until the next startup.
The startup scavenger operates only inside the configured app-owned snapshot
root, validates root/session/snapshot markers and file identities, retains live
or reused PID leases, and removes only verified dead-session files. Unknown,
linked or unrecognized contents remain untouched. No broad temporary-directory
glob or recursive deletion is used. POSIX owner-only modes are verified.

In v0.2.0, Cursor IDE database reading and private snapshot creation are disabled
on Windows before filesystem or helper access. A successful standalone helper
probe does not enable this path. Users can explicitly select an `agent-transcripts`
directory for supported read-only JSONL viewing, with separate content consent.
The retained read-only ACL helper and its synthetic tests are research and
validation components; they do not establish application private-copy acceptance.
There is no alternate copy destination or source-SQLite fallback.

SQLite queries run in a separate worker with V8 heap limits, a ten-second
request timeout, and worker termination on cancellation. V8 limits do not
establish a hard bound on native SQLite allocations. SQL values, record counts,
output pages, transcript reads, and the cumulative private-copy size are bounded;
those limits are not a guarantee of peak process memory. Content is never written
to application logs, telemetry, remote APIs, or uploads.

Long supported text and tool-input records are paginated through continuation
segments, with stable source identity and Unicode-safe boundaries. The displayed
tail is reachable; it is not permanently clipped after an initial preview.

`immutable=1` is deliberately not used: a synthetic regression established that
it misses committed rows still present only in WAL. Read-only SQLite can create
or update SHM, so merely passing `readOnly: true` on the live source is not the
source-preservation guarantee.

## Public evidence and compatibility limits

- [Cursor staff: readable native JSONL transcripts and intentional omission of
  tool outputs](https://forum.cursor.com/t/accessing-the-full-agent-transcript-in-cursor/157311),
  Colin, 2026-04-13. User/assistant text and tool input are included; missing
  tool results are an upstream export limitation, separate from parser limits.
- [Cursor staff: JSONL tool-input migration](https://forum.cursor.com/t/jsonl-format-should-fully-record-the-tool-use-information/154777),
  Dean Rie, 2026-03-14. A version 2.6.19 report provides the role/message/content
  structure; staff acknowledge an earlier text-only export bug. Therefore older
  transcripts can be text-only without being fabricated or parser failures.
- [Public vendor-forum transcript field observations](https://forum.cursor.com/t/richer-agent-transcripts-lifecycle-data-for-observability-langfuse-stop-hooks/166592/7),
  July 2026. The posted sample has text/tool-use blocks, without message IDs or
  timestamps. This is community field evidence, not a promised stable API.
- [Cursor staff: transcript exists while the session index is missing](https://forum.cursor.com/t/issue-with-opening-archived-chat-history/160114/9),
  2026-05-15. File presence does not prove sidebar membership or recoverability.
- [Vendor-forum v2.4.28 storage report](https://forum.cursor.com/t/how-i-recovered-my-vanished-cursor-chat-so-you-dont-have-to/151158),
  2026-02-07. It documents composer metadata/bubbles/checkpoints in the global
  database and a separate workspace index. This is explicitly version-scoped
  community evidence. Its suggested repair scripts are not shipped or executed.
- [Version 3.15.19 duplication report and staff confirmation](https://forum.cursor.com/t/forked-subagents-are-persisted-hundreds-of-times-each-growing-state-vscdb-to-30-gb-in-one-day/168418),
  August 2026. Composer headers and parent/subagent relations can be duplicated;
  equal titles or times are insufficient deduplication/deletion authority.
- [Cursor staff: native per-chat Markdown export remains available](https://forum.cursor.com/t/cloud-sync-for-agent-chat-history-across-devices-especially-remote-ssh/166367/9),
  2026-07-26. Current [CLI parameters](https://cursor.com/docs/cli/reference/parameters)
  document session resume and streaming output, but not a bulk historical export.
- [SQLite WAL](https://sqlite.org/wal.html), [backup API](https://sqlite.org/backup.html)
  and [URI behavior](https://sqlite.org/uri.html) explain WAL persistence,
  read-only sidecar behavior, snapshot choices and multi-database atomicity limits.

No latest-version full-storage guarantee is claimed. The official download page
served Cursor **3.22.12** on the evidence date, but it was not installed or run.
The bundle's license gate stopped deeper proprietary source analysis. The
production reader is based on public documentation/forum disclosures and
synthetic compatibility fixtures, not proprietary implementation extraction.

### Large closed-database feasibility, not enabled

The 512 MiB copy ceiling remains a real capability gap for common multi-gigabyte
Cursor histories. A separate synthetic probe on 2026-10-05 established that
Node 24.19.0 and Electron 44.5.1 support verified SQLite URI `mode=ro&immutable=1`
reads of a valid 539,688,960-byte closed database without WAL/SHM/journal files.
The source digest, identity, modification/change timestamps and directory entries
were unchanged, and a write attempt was rejected. This is a feasibility result,
not a shipping mode or a cold-cache performance benchmark.

A future large-history reader must positively verify URI support, require known
Cursor-closed status and absence of every sidecar before/after, pin source and
ancestor identities, retain query deadlines/schema guards, and discard results
on change. It must never fall back to immutable mode when WAL exists. That mode
needs separate integration and acceptance before removing the reported size cap.

## Canonical conversation cleanup: design review required

**No canonical database mutation is enabled.** A transcript file is a lossy export,
not sufficient evidence that removing it deletes a native conversation. Renaming
or replacing an entire `state.vscdb` would also change unrelated history, app
state and possibly credentials, so neither operation is a cleanup shortcut.

A future exact-selected cleanup must meet all of these gates before enabling:

1. Pin an independently supported storage generation and verify every relevant
   table, index, migration marker, deletion/tombstone field and relationship.
   Unknown generations are read-only. Archive state is not a deletion tombstone.
2. Resolve the exact selected conversation's record closure: global composer,
   ordered bubbles, uniquely owned checkpoints, workspace indexes/open tabs,
   search indexes, parent/subagent references and any native transcript mapping.
   Shared content-addressed blobs remain protected unless reference ownership
   and all live roots can be proven. No prefix-based shared-blob deletion.
3. Confirm Cursor and helpers are closed; recheck immediately before writes.
   Pin root identities and all planned old values. Block concurrent writers,
   unknown sidecars, partial scans, missing references and changed plans.
4. Create a durable authenticated operation journal containing only the exact
   selected records, original values, intended absent/new values and affected
   index fragments. Confirm recovery space, fsync the backup, verify its digest,
   and record operation state before any mutation. This backup is private and
   never contains unrelated authentication rows.
5. Apply compare-and-swap edits in bounded transactions. Multiple WAL databases
   are **not one atomic commit**. Use a tested prepare/commit/recover journal
   protocol, or fail closed when the supported storage cannot offer coherent
   cross-store recovery. App restart during a partial operation must be blocked
   or treated as a recoverable failure with explicit guidance.
6. Restore exact selected records into current stores only when target keys are
   absent or exactly equal to the operation's expected post-state. Merge index
   fragments by verified identity; retain newer unrelated entries and settings.
   Any conflicting selected key stops the restore. Never overwrite a whole DB
   backup onto a database containing newer conversations.
7. Exercise failure injection after every journal/database/index boundary,
   interrupted restore, restart, stale preview, duplicate click, disk-full,
   locked DB, changed/tampered backup and new-unrelated-conversation scenarios.
   Native vendor-app round-trip validation and independent safety review are
   required before claiming the conversation will disappear and return intact.

Unsupported schema, unresolved tombstones or shared references are blockers,
not warnings that permit a best-effort destructive action.

## Preservation path and current write blockers

The [capture and recovery contract](CURSOR-CAPTURE-AND-RECOVERY-CONTRACT.md)
records the current public API/export evidence, exact missing canonical-write
invariants, and an explicit private opaque-snapshot design. Staff confirms a
3.16+ storage rework; a 3.16.29 report also names a project-membership index absent
from older recovery recipes. Neither archive flags nor composer/bubble rows alone
prove the complete native write set. The supported Cloud Agents archive API is a
different store and must not be applied to local IDE conversation IDs.

Native **Export Chat** is the currently supported readable-preservation path.
It does not promise native import/resume, delete the original, or reclaim space.
The proposed AgentVac whole-state capture preserves complete captured bytes,
including unknown/shared/private records, and allows extraction only into a new
review folder. It is documented and fixture-probed, **not product-enabled**.
Canonical selected-conversation archive/restore remains an open capability gap.

## Reproducible tests

Run `node --import tsx --test tests/cursor-conversations.test.ts` and the project
typecheck. Tests cover native times, malformed/oversized UTF-8 values, exact
identity and bubble order, WAL-only committed content, unchanged source bytes,
source/sidecar mutation, unsafe links, sparse size limits, worker parsing,
request-local snapshot disposal, unknown layouts and literal JSONL content.
Packaged worker and renderer integration are separate acceptance gates.

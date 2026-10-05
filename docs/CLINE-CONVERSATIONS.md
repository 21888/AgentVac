# Cline conversation viewing and recovery research

## Implemented conversation reader

Cline now has a conversation reader rather than a log-only view. It is enabled only after the common conversation service receives explicit local-content consent for the selected provider/root. Reading does not grant cleanup permission.

- Current SDK: SQLite-marked and file-index-marked read-only sources, including SDK-only roots without extension global settings. Version-1 canonical session manifest and messages envelope. The manifest/session-directory ID and message-envelope ID must agree. The source-backed writer emits version, agent and session identity before the messages array; other envelope ordering is currently unsupported.
- Linked SDK child/team messages stored in a parent session directory are matched to their source-derived filename and envelope identity, displayed with an explicit subagent source label, and never treated as independent cleanup units.
- Historical extension storage: exact `globalStorage/saoudrizwan.claude-dev` root, bounded native `state/taskHistory.json`, and one canonical `tasks/<id>/api_conversation_history.json` per row. UI messages are not also appended, so the same conversation is not duplicated.
- Title: native title or prompt, then a bounded first-user-message fallback, then the session identifier with explicit provenance.
- Project: native workspace root/current working directory metadata. The project path is displayed, never traversed.
- Actual times: SDK manifest `started_at` and messages-envelope `updated_at` (or native `ended_at`); legacy history `ts` is the last relevant message timestamp in the pinned writer. The legacy reconstruction command can repopulate that field differently, so there is no fabricated independent creation time. Timestamps require a real calendar date and explicit timezone. Filesystem mtime is never used as conversation time.
- Text, reasoning, tool calls and tool-result text are plain text. Image/document payloads are placeholders; base64, remote resources and tools are never executed, decoded or fetched. System prompts are not returned.
- No SQLite query, index change, settings/credential read, transcript upload or transcript logging is part of this reader.

The source family is verified from storage structure and payload schema. This does not establish the installed Cline application version. Unknown layouts, unsupported schema versions, mismatched identity, external message paths and unsafe links stay unavailable.

### Bounded reading, continuity and refresh

`cline-json-stream.ts` frames JSON incrementally from a no-follow read-only handle. It materializes at most one supported bounded source message; it does not load the whole transcript. Native cursors contain byte bookmarks and source fingerprints and stay in the main process. The service gives the renderer opaque provider/root/consent-bound tokens.

Ordinary text is not permanently clipped at a display limit. A message can continue across pages, retaining native message identity, order and time. Each display segment has a unique segment ID plus explicit `continuation.messageId`, `partIndex`, `offset` and `hasMore`; segments must not be counted as additional original messages. Source relationships distinguish main and linked child sessions. The native message count is unknown until established, rather than inferred from display segments.

Current bounds:

- 2,000 recognized session manifests per enumeration; 8,000 directory entries visited
- 128 KiB per manifest/legacy index row; bounded envelope prefix
- 8 MiB per source message and 16 MiB per parser read operation
- At most 24 display segments per returned page, approximately 16 KiB text per segment
- JSON depth 64; cancellation checked during chunk reads and between segments

Transcript files can exceed those per-operation limits: byte bookmarks skip earlier message bodies. An 18 MiB synthetic conversation is completely paged in the regression suite. A single source message exceeding its bound is explicitly unsupported; the app must not label that result complete or silently omit its tail. Large/additive envelope values beyond limits are similarly unsupported.

Source file identity, every ancestor identity, manifest/index identity and transcript identity are rechecked before publishing a page. Concurrent edits invalidate the snapshot and require refresh. The latest compatible content can then be enumerated again. Changing providers, roots or consent invalidates the service's IDs and cursors.

## Canonical archive status: not enabled

Conversation viewing does not make Cline's canonical data a safe file-cleanup unit. There is no native conversation archive flag in the checked current session schema. A folder-only operation leaves SQLite/file-index records behind, while row-only removal leaves the native manifest fallback visible. Native deletion also touches relationships and workspace Git checkpoint refs.

A future current-SDK transaction has a source-backed candidate ordering:

1. Establish a separately reviewed offline writer-exclusion model; process-name absence and an SQLite lock are insufficient. Cline can fall back to a separate file index when SQLite initialization fails.
2. Authenticate a durable private intent containing exact selected rows, schema/version/root binding, revision values, complete opaque artifact inventories and checkpoint identities.
3. Under an immediate SQLite transaction, revalidate exact schema/row identity and every dependency. Reject children, parents, spawn queues, schedules, cron/agenda references, teams, mixed backends, imported/unknown ownership and unknown triggers or artifact paths. Delete only the exact approved row with an affected-row check; do not replace or compact the database.
4. Recheck artifact/root/writer identity and isolate the complete session directory with reviewed no-replace durability semantics. Leave workspace Git refs and objects untouched.
5. Restore files first with no overwrite, then plain-INSERT the exact original row if its ID remains absent. Unrelated new tasks remain intact. Never restore an old whole-database snapshot over current history.
6. Reconcile interrupted operations from authenticated intent plus actual live state, not just the journal's last phase. Same-ID new rows, recreated directories, changed bytes, missing artifacts and contradictory ownership are preserved conflicts requiring review.

This is a proposal, not a production mutator. The production Cline conversation reader cannot archive, delete, restore or rewrite canonical rows. Existing disposable-cache recovery is a separate capability and must not be presented as full conversation recovery.

### Native-source recovery experiments

The research fixture runs the pinned official schema, SQLite session store, history fallback, manifest schema and checkpoint implementation against synthetic temporary SQLite/artifact/Git data only. Twenty-two cases pass: twelve earlier dependency/lifecycle cases plus ten recovery-state cases (intent boundary, committed-row boundary, moved-directory boundary, file-first restore, unrelated-row preservation, same-ID conflict, recreated-path conflict, changed-source conflict, tampered signed intent, missing artifacts and inconsistent ownership; some cases cover multiple assertions).

These experiments demonstrate ordering and rejection conditions in a serialized offline model. They are not installed-app acceptance, real process-kill/fsync durability acceptance, an implemented durable journal, complete cross-store discovery, concurrent-writer exclusion, or Windows/macOS filesystem verification. No enabled canonical mutator should be inferred from the results.

## Source pins

Current: [cline/cline afabc824d88ebd0c779ab06f0cfb14c5483dc50f](https://github.com/cline/cline/tree/afabc824d88ebd0c779ab06f0cfb14c5483dc50f), source package VS Code 4.1.22 / CLI 3.0.68.

- [Messages contract v1](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/core/docs/messages-contract-v1.md)
- [Manifest schema](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/core/src/session/models/session-manifest.ts)
- [Canonical message writer and manifest builder](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/core/src/services/session-data.ts)
- [History fallback](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/core/src/runtime/host/history.ts)
- [Native backend fallback](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/core/src/runtime/host/host.ts)

Historical: [cline/cline 31e8c85f0a5e038bd02b160fc4cc18c5ba611b00](https://github.com/cline/cline/tree/31e8c85f0a5e038bd02b160fc4cc18c5ba611b00), source extension 3.67.0.

- [History shape](https://github.com/cline/cline/blob/31e8c85f0a5e038bd02b160fc4cc18c5ba611b00/src/shared/HistoryItem.ts)
- [Actual legacy history timestamp producer](https://github.com/cline/cline/blob/31e8c85f0a5e038bd02b160fc4cc18c5ba611b00/src/core/task/message-state.ts)
- [Reconstruction semantics](https://github.com/cline/cline/blob/31e8c85f0a5e038bd02b160fc4cc18c5ba611b00/src/core/commands/reconstructTaskHistory.ts)

`tests/cline-conversations.test.ts` is synthetic-only regression coverage. Run `node --import tsx --test tests/cline-conversations.test.ts`. Shared consent, filter/search, IPC and UI behavior also require the service and UI suites; reader tests alone do not establish complete application acceptance.

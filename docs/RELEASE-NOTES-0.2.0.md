# AgentVac 0.2.0 candidate release notes

**Status as of 2026-10-06: unpublished release candidate source.** The limited feature boundary below has been selected for this release. Final source checks, native platform acceptance, package verification and publication are not complete. This document is not a release announcement or evidence that those gates passed.

The current published downloads remain [v0.1.0, Codex only](https://github.com/21888/AgentVac/releases/tag/v0.1.0). The README download links intentionally still point to that release. No v0.2.0 asset URL or checksum is claimed here.

## What this candidate adds

- **Local conversation viewing and search.** With separate content consent, view supported Codex, Claude Code, Cline and Cursor formats. Filter by title, project, body keyword and original conversation time, and page through long messages. Missing native timestamps stay unknown. Unsupported records, incomplete history and safety limits are reported as partial coverage.
- **Provider-specific cleanup previews.** Inspect the exact eligible files or complete units and their protection reasons. Codex is limited to old rotated logs and validated legacy recovery. Claude Code can additionally archive eligible complete local session bundles. Cline and Cursor cleanup is limited to the disposable artifacts listed below.
- **Recovery with exact file identities and signed v4 journals.** New identities avoid numeric rounding. Supported authenticated legacy batches retain their recovery policy when updated; this does not re-enable new Codex session quarantine. Recovery refuses changed or conflicting destinations instead of overwriting them.
- **Cancellation and interrupted-operation handling.** Provider/root changes, cancellation and invalidation stop later work. Already-admitted filesystem operations can still finish; uncertain files and recoverable records are retained. This is not a universal guarantee against power loss or a hostile process using the same account.
- **Fresh confirmation before system Trash.** Confirm that the relevant tool and all its clients have exited, review the recovery requirements, then request the move. A failed system Trash operation keeps the files and never falls back to permanent deletion.

The app interface remains **Simplified Chinese only**. The four README translations document the same scope. Light, dark and system themes remain available.

## Included scope and deliberate exclusions

| Tool        | Conversation reading                                                                                                                                                                                | Cleanup and recovery boundary                                                                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | Supported JSONL rollouts, including available native/message time and provenance                                                                                                                    | Old rotated logs; existing signed session batches only when legacy identity and recovery validation pass. **New session-file quarantine remains disabled.** No complete canonical-history archive or deletion.                         |
| Claude Code | Supported SDK-compatible project history, main records and bounded companion subagent sections                                                                                                      | Old standard debug logs and **eligible complete local session bundles**. Active/newest/recent sessions, incomplete or unknown bundles, global prompt history, memory, credentials, Desktop, Cowork and cloud history remain protected. |
| Cline       | Current supported SDK history and supported legacy API history, with child artifacts attributed separately                                                                                          | Recognized derived search-cache units, checkpoint scratch caches, legacy model catalogs and eligible aged per-session hook telemetry. **No canonical task, conversation, index or real Git-checkpoint mutation.**                      |
| Cursor      | Supported IDE composer/bubble records on non-Windows platforms where private-copy checks pass; separately selected plain agent-transcripts. **Windows IDE database reading is disabled in v0.2.0.** | Recognized old diagnostic logs and complete supported `Cache`, `Code Cache`, `GPUCache` and `CachedData` units. **No chat/state database edits or canonical conversation archive/deletion.**                                           |

An entry in this table describes the source policy, not a successful operation on every platform or vendor version. The [release support matrix](RELEASE-SUPPORT-MATRIX.md) records the platform limits and pending acceptance. All eligible actions still require a complete recognized layout, age/activity checks, stable identities, safe filesystem conditions and a clear process inspection.

## Platform limitations that must remain visible

- **All platforms:** running, unknown or incompletely observed related processes block quarantine, restore and system Trash. Closing the visible app window alone may leave CLI, SDK, IDE or background clients running. A blocked or skipped operation is not a successful cleanup or restore.
- **Windows x64:** Cursor IDE database reading is explicitly disabled in v0.2.0, regardless of whether a private-copy helper could succeed. The release block applies before database filesystem access, copying or helper invocation. The supported alternative is explicitly selecting agent-transcripts for read-only viewing; its final packaged native positive test remains pending. No weaker copy location, source-database fallback or ACL relaxation is substituted.
- **Linux x64:** foreign runtime observations can remain unattributed/unknown, blocking Claude Code, Cline and Cursor mutations. These blocks remain in place; they do not establish that those processes are unrelated or that ordinary installations can use every advertised cleanup action.
- **macOS Intel and Apple Silicon:** ordinary quarantine/restore failures are still under targeted diagnosis. Final native and package acceptance is pending for each architecture. Affected operations must be resolved and retested or remain explicitly unavailable before publication as supported capabilities.

## Content privacy and coverage

Ordinary cleanup scans use file metadata. Conversation listing, native titles and body search require separate consent for the effective provider/root and the current app session. Revocation aborts reading, clears the displayed content and invalidates conversation-origin previews. Separately selected Cline SDK folders and Cursor transcript folders grant read-only access, not cleanup authority.

Conversation content is inert text. Embedded commands are not executed; external URLs and media are not fetched automatically. File modification time is never substituted for a missing conversation timestamp. Unsupported inherited/compacted history, unknown formats, malformed records and safety-limit exclusions can produce partial results rather than a complete history.

On macOS and Linux, Cursor database reading copies the database and required WAL into private local temporary storage. Final native acceptance of the supported paths on these platforms remains pending; Windows IDE database reading is disabled in v0.2.0. The whole copy can contain unqueried settings or authentication pages. The default cumulative copy limit is **512 MiB per request**; unavailable location/permission checks or oversized sources produce an unavailable/partial result. Normal completion removes the copy, with guarded cleanup for owned stale copies after interruption. Explicit transcript reading does not require this database copy. Source databases are not opened for mutation.

Reads, records, rendered bytes, queries and execution time are bounded. These checks and V8 worker heap limits are **not a proven hard bound on native SQLite memory**. See [conversation management](CONVERSATION-MANAGEMENT.md) for the detailed consent, copy and pagination contract.

## Recovery and use before upgrading

- **v0.1.0 users:** limit use to old-log cleanup and leave session-file quarantine disabled. Current Codex paginated histories can reference other physical rollouts. The candidate keeps new Codex session quarantine disabled while allowing only validated legacy recovery.
- Back up important files and the original recovery key separately. Keep the key offline and private. A key backup does not replace a file backup or repair an unsafe rounded identity in an old manifest.
- A signature authenticates a manifest; it does not prove byte-for-byte or hash equality of payload contents. Unsupported old identities and changed payloads must be preserved for manual recovery rather than forced through the validator. Do not edit manifests to bypass checks.
- Multi-member moves are journaled, not one atomic filesystem rename. Windows lacks directory fsync. Complete directory recovery does not guarantee every ACL, extended attribute or creation timestamp. Independent review and final native recovery acceptance remain pending.
- Quarantine does not free disk space. System Trash usually still occupies space. AgentVac has no permanent-delete function. Restoring from the operating system's Trash may change file identity and prevent automatic recovery; preserve the whole batch and key. The final candidate's native OS-Trash recovery path remains unaccepted.
- All relevant clients must stay closed during cleanup and recovery. A newly regenerated file or directory is a conflict, not permission to overwrite or merge. Claude Code sessions need restoration before resuming; Cline/Cursor cache regeneration may temporarily affect search or startup.

## Packaging and verification status

The planned distribution formats remain macOS arm64/x64 DMG and ZIP, Windows x64 portable EXE and NSIS setup EXE, and Linux x64 tar.gz. They are **targets, not published v0.2.0 downloads**. Source/browser/helper tests, synthetic screenshots and an intact archive do not establish native final-package acceptance or compatibility with every installed vendor version.

Before publication, record results against one exact candidate source and each actual package: aggregate/type/build checks with all skips accounted for, native launches, worker/preload fidelity, generated-data quarantine/restart/restore where claimed, explicit negative checks for disabled capabilities, and available system-Trash behavior. The prior independent mutation final assessment is incomplete. Historical checkpoint test counts are not a final-candidate pass.

The current apps lack completed macOS Developer ID signing/Apple notarization and Windows Authenticode signing. Final-candidate signing status and ordinary first-launch trust behavior are not accepted. Gatekeeper or SmartScreen can warn or block launch. Do not disable those protections, the Chromium sandbox or AppArmor to obtain a pass.

Published downloads must carry verified per-asset SHA-256 checksums and an accurate platform/limitation list. Until that publication is verified, keep the existing v0.1.0 links and this candidate status. See the [README](../README.en.md) for source commands and installation guidance.

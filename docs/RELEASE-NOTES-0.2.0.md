# AgentVac 0.2.0 release notes

**Evidence current to 2026-10-06.** AgentVac 0.2.0 adds local conversation viewing and search across supported Codex, Claude Code, Cline and Cursor formats, plus narrowly scoped cleanup and recovery. Some conversations cannot be archived or deleted, and reading or cleanup can be unavailable on particular platforms. This is a limited release scope, not complete management of all four tools.

The verified application source is `4a523b95c1098eeb3e220cc58d290819ef97a01f`. Distribution covers Linux x64 tar.gz, macOS arm64/x64 DMG and ZIP, and Windows x64 NSIS setup. The Windows portable executable is unverified and excluded. Package acceptance is limited to the checks reported below; it does not imply all cleanup paths passed.

## Source and binary provenance

Packages were built and tested from [application source `4a523b95`](https://github.com/21888/AgentVac/tree/4a523b95c1098eeb3e220cc58d290819ef97a01f). The release source tag also contains the later documentation, QA and publication metadata, including the Windows ASAR verification fix. These are not rebuilt application binaries. Before publication, the complete Git-tree check requires every other blob and file mode to match the tested source, including package/lock files, build scripts, icons and build configurations. Each platform verification asset records its actual source and run.

## What changes

- View and search supported local conversations after separate consent, with title, project, body keyword and native-time filters. Missing timestamps stay unknown; unsupported or incomplete history stays visibly partial.
- Preview eligible files or complete cleanup units, including reasons protected items cannot be selected.
- Recover eligible quarantined data using exact file identities and signed v4 journals. Restore refuses changed or regenerated destinations rather than overwriting or merging them.
- Cancel work and retain recoverable records after interrupted operations. Already-admitted filesystem operations can still finish.
- Review a fresh confirmation before moving a batch to the operating system's Trash. A failed Trash move preserves the files; there is no permanent-delete fallback.

The interface remains **Simplified Chinese only**, with light, dark and system themes.

## What can be cleaned

| Tool | Cleanup boundary |
| --- | --- |
| Codex | Old rotated logs and recovery of eligible signed legacy batches. **New session-file quarantine is disabled.** Complete canonical-history archive or deletion is unsupported. |
| Claude Code | Old standard debug logs and eligible complete local session bundles. Active, newest, recent, incomplete or unknown bundles remain protected, as do global prompt history, memory, credentials and Desktop/Cowork/cloud history. |
| Cline | Recognized derived search caches, checkpoint scratch caches, legacy model catalogs and eligible aged per-session hook telemetry. Canonical tasks, conversations, indexes and real Git checkpoints remain protected. |
| Cursor | Recognized old diagnostic logs and complete supported `Cache`, `Code Cache`, `GPUCache` and `CachedData` units. Chat/state databases and canonical conversation history remain unchanged. |

Reading a conversation does not grant cleanup authority. Separately selected Cline SDK folders and Cursor agent-transcripts are read-only sources. Every mutation also requires a complete recognized layout, age/activity checks, stable identities, safe filesystem conditions and a clear process inspection.

## Platform limits

- **Windows x64:** Cursor IDE database reading is explicitly disabled before database access, copying or helper invocation. Explicitly selected agent-transcripts provide the supported reading alternative. The NSIS installer passed actual per-user install, installed launch, supported readers, generated-data recovery/restart, exact payload binding and uninstall checks.
- **Linux x64 and Windows x64:** native Claude Code, Cline and Cursor cleanup tests were blocked by unknown runtime processes. Files were preserved; these refusals are not successful cleanup or restore tests.
- **macOS Intel:** native reader and all three provider quarantine/restore lifecycle checks passed, as did the actual ZIP and DMG package checks.
- **macOS Apple Silicon:** readers, all three provider lifecycles and package checks passed. A separate duplicate quarantine/restore check through the real-root path was skipped before mutation because process inventory was incomplete. The native Trash check used generated demo data.

On every platform, running, unknown or incompletely observed related processes block quarantine, restore and Trash. Closing a visible window may leave CLI, SDK, IDE or background clients running. See the [support matrix](https://github.com/21888/AgentVac/blob/v0.2.0/docs/RELEASE-SUPPORT-MATRIX.md) for exact counts, evidence and acceptance status.

## Privacy and recovery limits

Ordinary cleanup scans use metadata. Conversation access requires consent for the selected provider/root and current app session; revocation stops reading and clears displayed content. Conversation text is inert: embedded commands are not run, and external URLs or media are not fetched automatically.

On macOS and Linux, Cursor reading uses a private temporary database/WAL copy that can contain unqueried settings or authentication pages. Failed permission, location or size checks can make reading unavailable. Source databases are not modified; the support matrix describes the resource limits.

Back up important files and keep the original recovery key separately. Signed journals and exact identities do not guarantee recovery from every race, power loss or disk failure. Multi-member moves are not atomic; Windows durability and file-metadata restoration have limits. Preserve unsupported legacy batches for recovery.

Quarantine does not free disk space, and Trash usually still occupies space. **Restoring through the OS Trash interface remains untested** and may change file identity, preventing automatic recovery. Preserve the whole batch and key. Claude Code archives must be restored before resuming those sessions.

## Package verification and remaining gaps

- Original platform run `37536722747` supplies the source and Linux/macOS evidence. Windows setup-only run `37541701609`, job `112535997318`, passed native installed-package acceptance using the same application source and separate QA revision `6da2a960a2034b43595f9fbdbe0a44447f3514d8`. Source tests were not rerun; their guard failures and skips remain explicit in the support matrix.
- The verified asset set contains 14 files: 11 Linux/macOS files and the Windows setup EXE, Windows checksums and verification report. The setup EXE is 112,023,089 bytes with SHA-256 `051f78023a378c124aa34e944316e0beb0caa1f4ff24b261fb7f6294bf2ecf69`.
- Portable run `37540075963`, job `112530652671`, failed native attachment with `harness-fatal-error`. No cause is proven; portable remains unverified, was not rerun, and is excluded.
- The apps are unsigned; macOS notarization is not complete. Ordinary first-launch trust behavior and OS Trash restore UI remain untested. Package checks do not establish either result.

Successful tests on disposable data do not establish compatibility with every vendor version or user installation. See the [support matrix](https://github.com/21888/AgentVac/blob/v0.2.0/docs/RELEASE-SUPPORT-MATRIX.md) for source policy, actual platform results and remaining limits.

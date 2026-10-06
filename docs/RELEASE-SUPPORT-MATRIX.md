# AgentVac 0.2.0 support matrix

**Evidence current to 2026-10-06.** This matrix separates source policy from operations actually exercised on each platform. Passed, blocked, skipped, failed and untested results are distinct. No complete four-tool conversation deletion or universal platform coverage is claimed.

## Source policy

All reading requires content consent. Cleanup and restore require complete recognized layouts plus process, age, identity, filesystem and no-overwrite checks. The platform evidence below further limits what can be claimed.

| Provider or source | Supported reading | Eligible cleanup or recovery | Excluded |
| --- | --- | --- | --- |
| Codex JSONL | Supported native rollouts, bounded messages, native times and provenance | Old rotated logs; eligible authenticated legacy batches | New session quarantine; complete canonical-history archive/deletion; guaranteed inherited or compacted history reconstruction |
| Claude Code local projects | Supported SDK-compatible main history and bounded companion subagent content | Old standard debug logs; eligible complete local session bundles | Active/newest/recent or incomplete/unknown bundles; global history, memory, credentials; Desktop/Cowork/cloud cleanup |
| Cline current SDK and supported legacy history | Supported metadata/messages with separate child-artifact attribution | Derived search caches, checkpoint scratch caches, known legacy model catalogs and eligible aged per-session hook telemetry | Canonical tasks, conversations, manifests, indexes, real Git checkpoints and unknown data |
| Cursor IDE databases | Supported composer/bubble records through private-copy checks on macOS/Linux; **disabled on Windows** | Recognized old logs and complete supported `Cache`, `Code Cache`, `GPUCache`, `CachedData` units | Chat/state database mutation, canonical conversation archive/deletion, account/network state, profiles, extensions and workspace/index data |
| Explicit Cursor agent-transcripts | Supported plain local transcript text/tool blocks; missing native time stays unknown | None | Implicit discovery, database permission or transcript cleanup |
| Explicit Cline SDK folder | Supported SDK/file-index history | None from this selection | Changing the cleaner root or granting cleanup authority |

Only eligible Claude Code local bundles support new conversation archival. Codex, Cline and Cursor read/search support does not imply their canonical histories can be archived or deleted.

## Exact application and QA provenance

- **Application source:** `4a523b95c1098eeb3e220cc58d290819ef97a01f`.
- **Release source tag:** includes later reviewed documentation, QA, verifier and publication metadata. The complete-tree publication check permits only the explicit nonshipping path list; all application and build inputs must match the tested source. Package receipts continue to identify the original build source rather than the later tag commit.
- **Original platform run:** `37536722747`. Unit totals below belong to this run and source, not to a later rerun.
- **Windows package QA run:** `37540075963`, job `112530652671`, QA revision `ca0a753e1108587391260a0943113d2a6f5c589f`. It built and checked the original application source with separate QA inputs; that QA revision is not the claimed shipping application revision. It did not rerun the source unit suite. Portable failed; NSIS execution and upload did not run in this attempt.
- **Windows setup QA run:** `37541701609`, job `112535997318`, QA revision `6da2a960a2034b43595f9fbdbe0a44447f3514d8`. It built the original application source and passed actual per-user NSIS install, installed launch, supported packaged readers, generated-data recovery/restart, exact payload binding and uninstall. It did not rerun the source unit suite or prior provider lifecycles.
- **Windows distribution:** verified NSIS setup only. Portable is unverified and excluded; its failed native check was not rerun.

Native application checks used disposable/generated data. They establish the reported AgentVac behavior, not comprehensive testing of installed vendor applications or real user histories.

## Platform results

Unit totals are **passed / failed / skipped**. A zero unit-failure count does not mean every native or package stage passed.

| Target | Source unit results | Native operations observed | Actual package status |
| --- | --- | --- | --- |
| Linux x64 | **1066 / 0 / 4** | Source readers passed. Claude Code, Cline and Cursor mutations were refused for unknown runtimes, with bytes preserved; their positive lifecycles did not pass. | tar.gz checks and all packaged readers passed. Assets verified. The provider stage failed its positive lifecycle requirement. |
| macOS Intel x64 | **1049 / 0 / 21** | Readers and all three Claude Code/Cline/Cursor quarantine/restore lifecycles passed. The platform job passed. | ZIP and DMG package checks passed; assets verified. |
| macOS Apple Silicon arm64 | **1049 / 0 / 21** | Readers and all three provider lifecycles passed. Separate real-root duplicate quarantine/restore check **skipped before mutation** for incomplete process inventory; native Trash used generated demo data. | ZIP and DMG package checks passed; assets verified. The skipped real-root case remains unverified. |
| Windows x64 | **1026 / 0 / 44** | Source-native desktop, Trash, durability and supported readers passed. All three provider guards refused a complete but unknown process inventory; source/protected bytes remained unchanged. | Package ASAR, architecture and byte verification passed. **NSIS install, installed launch/readers, generated recovery/restart, exact payload binding and uninstall passed.** Three Windows assets verified. Portable native attachment failed and is excluded. |

The Windows portable failure reports `actual-package-native-smoke` with nested `harness-fatal-error`; no cause is proven. Portable remains unverified and excluded. Setup acceptance comes from the separate successful installed-package run, not from earlier source-native successes. The setup run does not convert the prior three guarded provider lifecycles into passes.

Windows Cursor IDE database reading is intentionally disabled before database filesystem access, copying or helper invocation, regardless of helper capability. Explicit agent-transcripts are the supported read-only alternative and passed the installed-package reader checks.

On all platforms, unknown/running related processes, incomplete observations or failed inspection block quarantine, restore and system Trash. The tested pre-mutation refusals preserved the checked source and protected bytes; they are not successful cleanup runs. Other interrupted operations can leave authenticated recovery records and already-admitted moves. Passing provider lifecycles in a separate check does not retroactively pass a skipped case.

## Common limits

- Consent covers the effective provider/root for the current app session. Revocation aborts reading and clears content. Separate reader selections confer no cleanup authority.
- Unknown formats, malformed records, incomplete/compacted history and safety bounds can produce partial results. Missing conversation times remain unknown.
- macOS/Linux Cursor reading requires a private local database/WAL copy. It can contain unqueried settings/authentication pages; the default cumulative budget is 512 MiB per request. Failed locality/permission checks block reading. Worker heap limits are not a proven hard bound on native SQLite memory.
- Metadata scans default to 50,000 entries, optionally 100,000, with depth 12 and a 24 MiB result budget. Incomplete scans disable bulk selection. A cleanup unit/batch is bounded to 5,000 nodes/items; unit descendant depth is 12.
- Default age protection is 30 days, with provider-specific current/newest rules. Unknown members protect the whole unit. Links, special files and cross-volume unit members are rejected.
- Quarantine and Trash do not guarantee reclaimed disk space. There is no permanent-delete function. Restore never overwrites or merges regenerated data.
- Signed v4 journals and exact identities do not guarantee recovery after every race, power loss or disk failure. Windows directory fsync is absent; ACL, extended-attribute and creation-time fidelity is limited. Preserve unsupported legacy batches and their original key.
- OS Trash restore UI and ordinary first-launch trust behavior remain **untested**. The apps are unsigned and macOS notarization is incomplete. Native Trash API success is not proof of a successful OS Trash restore.
- The UI is Simplified Chinese only. Synthetic screenshots and source/browser tests do not establish native package acceptance.

## Verified distribution scope

The verified asset set has **14 files**: the existing eleven Linux/macOS files, preserved unchanged, plus the Windows setup EXE, Windows checksums and verification report. Server digest checks verified the three Windows uploads and the complete inventory. This evidence supports the named package paths only; the guarded source cases, skipped Apple Silicon case, unsigned status and untested trust/Trash-restore behavior above remain limits.

Windows setup artifact: `AgentVac-0.2.0-windows-x64-setup.exe`, **112,023,089 bytes**, SHA-256 `051f78023a378c124aa34e944316e0beb0caa1f4ff24b261fb7f6294bf2ecf69`. Use each platform's matching `AgentVac-0.2.0-<platform>-<arch>-SHA256SUMS.txt` to verify its downloads. Portable is not included.

See the [release notes](RELEASE-NOTES-0.2.0.md) for the user-facing changes and recovery guidance. Historical source checkpoints and later QA revisions cannot silently replace the application or package evidence recorded here.

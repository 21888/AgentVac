# AgentVac

[简体中文](README.md) · [English](README.en.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)

An open-source desktop tool for Codex, Claude Code, Cline and Cursor: view and search supported local conversations, analyze disk usage, and preview eligible logs, caches or complete Claude Code session bundles.

**Release status:** this source prepares an **unpublished, limited-scope v0.2.0 candidate**. Some sessions cannot be archived, and reading, quarantine and restore are restricted on some platforms. It does not provide complete conversation management or deletion across all four tools. Final source checks, native platform acceptance and package verification remain pending. **Current v0.1.0 downloads support Codex only.** No verified v0.2.0 package has been published. See the [candidate release notes](docs/RELEASE-NOTES-0.2.0.md) and [release support matrix](docs/RELEASE-SUPPORT-MATRIX.md).

- **See what is on disk**: inspect logical file sizes, categories, cleanup candidates, and protection reasons.
- **Review before changing anything**: choose a tool and data folder, then preview the exact files or complete cleanup units.
- **Keep a recovery path**: quarantine locally, review batch history, and restore without overwriting existing data.
- **Work comfortably**: light, dark, and system themes; read-only SQLite and log diagnostics for Codex.

This README is available in four languages. **The app interface is currently available only in Simplified Chinese.** AgentVac is an independent project, not an official product of the supported tool vendors.

## v0.2.0 candidate scope

The table describes what the source may admit for review, subject to the platform limits below. It is not a completed release-acceptance result for every platform.

| Tool            | Available for review and quarantine                                                                                                    | Kept protected / important limits                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Codex**       | Old rotated logs; existing signed session archives that pass legacy identity and recovery checks can be restored                       | New session JSONL quarantine remains disabled; current logs, credentials, configuration, indexes, databases and unknown data stay protected |
| **Claude Code** | Old standard debug logs; optional local-session archives containing the main transcript and all recognized companion files             | Latest and active sessions, global prompt history, memory, credentials, and unknown layouts; no Desktop, Cowork, or cloud history cleanup   |
| **Cline**       | Rebuildable full-text search cache and checkpoint scratch caches; recognized legacy model catalogs and aged per-session hook telemetry | Canonical conversation database, task history, real Git checkpoints, credentials, and configuration; whole-task archival is not available   |
| **Cursor**      | Known old diagnostic logs; complete recognized `Cache`, `Code Cache`, `GPUCache`, and `CachedData` directories                         | Chat and state databases, profiles, extensions, workspaces, indexes, account/network state, and unknown cache layouts                       |

Only explicitly supported paths and complete recognized layouts qualify. Age, activity, filesystem, and process checks still apply; finding a folder does not make its contents safe to move. Claude Code archives cannot resume until restored, and global prompt recall remains unchanged. Cline cache rebuilds can temporarily affect search or offline model listings. Cursor may download resources or recompile caches on the next launch. Newly regenerated data is never overwritten during restore.

See the detailed scopes for [Claude Code](docs/CLAUDE-CODE-SCOPE.md), [Cline](docs/CLINE-SCOPE.md), and [Cursor](docs/CURSOR-SCOPE.md), plus [cleanup units and recovery](docs/SAFE-CLEANUP-UNITS.md) and the [acceptance matrix](docs/MULTI-AGENT-ACCEPTANCE.md). Synthetic tests do not establish compatibility with every installed tool version or final cross-platform release readiness.

## Local conversation viewing and search

After separate content consent, readers cover supported Codex JSONL, Claude Code main histories with bounded subagent content, current Cline SDK and supported legacy histories, and supported Cursor database records (disabled on Windows) or explicitly selected agent-transcripts. Filter by title, project, body keyword and original conversation time, and page through long messages. Missing timestamps remain unknown; file modification time is never substituted. Unknown formats, inherited or compacted history, and safety limits can leave partial coverage, which is reported in the interface.

Consent is limited to the current provider, folder and app session. Revoking it stops reading and clears displayed content. Messages are inert text: commands are not executed and external media is not loaded automatically. Cline SDK folders and Cursor agent-transcripts can be selected separately for read-only access; this grants no cleanup authority. Only eligible, completely recognized Claude Code local session bundles can request quarantine previews. Canonical conversation deletion or archival remains disabled for Codex, Cline and Cursor.

On macOS and Linux, Cursor database reading requires a private local temporary copy, which may include unqueried settings/authentication pages, with a default cumulative limit of 512 MiB per request. If location or permission checks cannot be verified, the database reader is unavailable; it does not silently choose another copy destination. Final native acceptance of the supported paths on these platforms remains pending. Cursor IDE database reading is explicitly disabled on Windows in v0.2.0. See [scope, privacy and limits](docs/CONVERSATION-MANAGEMENT.md).

### Platform limits and pending acceptance

- **All platforms:** quit the tool and every related CLI, desktop, IDE, SDK and background process. Running processes, incomplete observations or an unknown state block quarantine, restore and moving batches to system Trash. A protection block is not a successful cleanup.
- **Windows x64:** Cursor IDE database reading is explicitly disabled in v0.2.0; a successful helper check cannot enable it. The supported alternative is explicitly selecting agent-transcripts for read-only viewing. Its final packaged native positive test remains pending.
- **Linux x64:** unattributed foreign runtimes can remain unknown and block Claude Code, Cline or Cursor quarantine and restore. These actions are not promised to work on every ordinary Linux installation.
- **macOS Intel / Apple Silicon:** ordinary quarantine/restore failures are still under targeted diagnosis. Final native and package acceptance for both architectures remains pending; these operations are not yet accepted macOS release capabilities.

**v0.1.0 safety note:** use old-log cleanup only and leave session-file quarantine disabled. Current Codex paginated history can reference other rollouts. New session-file quarantine is disabled in this source. Existing signed archives can be restored only when legacy identity and recovery checks pass.

## Download and install

Current download, **Codex only**: [v0.1.0](https://github.com/21888/AgentVac/releases/tag/v0.1.0). All files below are existing v0.1.0 assets and do not include the v0.2.0 candidate features described here. Candidate source or a local build is not a published package. Prebuilt apps do not require a separate Node.js installation.

| Platform              | Download                                                                                                                                      | Requirements                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| macOS · Apple Silicon | [AgentVac-0.1.0-macos-arm64.dmg](https://github.com/21888/AgentVac/releases/download/v0.1.0/AgentVac-0.1.0-macos-arm64.dmg)                   | macOS 13+, M-series chip       |
| macOS · Intel         | [AgentVac-0.1.0-macos-x64.dmg](https://github.com/21888/AgentVac/releases/download/v0.1.0/AgentVac-0.1.0-macos-x64.dmg)                       | macOS 13+, Intel processor     |
| Windows               | [AgentVac-0.1.0-windows-x64-portable.exe](https://github.com/21888/AgentVac/releases/download/v0.1.0/AgentVac-0.1.0-windows-x64-portable.exe) | Windows 10+, x64; portable app |
| Linux                 | [AgentVac-0.1.0-linux-x64.tar.gz](https://github.com/21888/AgentVac/releases/download/v0.1.0/AgentVac-0.1.0-linux-x64.tar.gz)                 | A supported Linux x64 desktop  |

Verify downloaded files against [SHA256SUMS.txt](https://github.com/21888/AgentVac/releases/download/v0.1.0/SHA256SUMS.txt). If the repository is private, source and downloads require a GitHub account with access. Use an operating system that still receives security updates.

- **macOS**: choose the DMG for your processor, open it, drag AgentVac into Applications, and launch it from there.
- **Windows**: save and run the portable EXE. This release provides a portable launcher, not an installation wizard.
- **Linux**: extract the entire tar.gz archive and run the included app in a normal desktop session. Install dependencies through your distribution's official package manager. Moving files to Trash requires a working desktop Trash backend; if it is unavailable, the operation fails and files are kept. This release does not include an AppImage.

**The macOS app does not yet have Developer ID signing or Apple notarization; the Windows app does not yet have Authenticode signing.** Gatekeeper or SmartScreen may warn or block startup. Do not disable system protections, the Chromium sandbox, or AppArmor to bypass warnings. A successful build or intact archive does not establish that the normal first-launch trust checks have passed. Start with demo data.

## Screenshots

These screenshots show the **unreleased v0.2.0 development UI with synthetic test data**. Process checks in the previews are simulated. Charts show logical sizes of discovered files, not a user's actual usage or reclaimable space. The images illustrate the interface; they do not establish installed-tool compatibility, native platform acceptance, signing, or first-launch system trust.

### Space analysis · Light

Choose the tool, then inspect file distribution, categories, and protection reasons.

![AgentVac light-theme Codex space analysis with the tool selector, file distribution chart, and categorized file list](docs/images/overview-light.png)

### Space analysis · Dark

Old-log candidates are distinguished from sessions, which are protected by default.

![AgentVac dark-theme Codex space analysis showing synthetic scan results, old-log candidates, and protected sessions](docs/images/overview-dark.png)

### Space diagnostics

Select a Codex scope and inspect SQLite-related files and ordinary logs in read-only mode.

![AgentVac Codex space diagnostics with scope selection, read-only totals, and per-file size information](docs/images/space-diagnostics.png)

### Quarantine and restore

Claude Code batch history shows an isolated debug log and a restored complete local-session archive.

![AgentVac Claude Code quarantine history with one pending debug log and one restored complete session bundle](docs/images/quarantine-recovery.png)

<details>
<summary>More previews: Claude Code, Cline, and Cursor</summary>

### Claude Code · Complete session archive

Review the main transcript and recognized subagent files together before quarantining the complete unit.

![AgentVac Claude Code preview with a complete transcript and subagent bundle, file counts, and session-risk confirmation](docs/images/claude-session-preview-light.png)

### Cline · Rebuildable search cache

The derived search-cache database and its existing WAL / SHM companions form one unit. The canonical conversation database stays protected.

![AgentVac Cline preview of a complete derived search-cache database and WAL / SHM bundle with a rebuild warning](docs/images/cline-cache-preview-light.png)

### Cursor · Complete cache directory

Review a recognized GPUCache directory as one unit, with a warning that the cache may need rebuilding.

![AgentVac dark-theme Cursor preview of a complete GPUCache directory with exact file counts and a rebuild warning](docs/images/cursor-cache-preview-dark.png)

</details>

## First use

Chinese labels below match the current app interface.

1. **Try the demo first.** Click “体验演示扫描” (Try demo scan) to practice previewing, quarantining, and restoring in a separate Codex demo workspace. The workspace preserves your previous actions.
2. **Choose the tool and its data folder.** In the development build, select Codex, Claude Code, Cline, or Cursor at the top, then use the native folder picker. v0.1.0 supports only the Codex root, usually `~/.codex` or the location set by `CODEX_HOME`. Use the matching tool's data root, not a project folder or disk root. Cursor's IDE data folder is different from `.cursor`. Suggested locations are hints and are not scanned automatically.
3. **Back up files and the recovery key.** Back up your data, then open “目录与恢复” (Folders and recovery) and choose “导出恢复备份” (Export recovery backup). This backup contains sensitive key material. Keep it safely offline; do not upload or share it. A key backup does not replace a file backup.
4. **Scan and review the preview.** Files from the last **30 days** are protected by default. Start with a few eligible old logs. Check protection reasons, scan completeness, and every member of a selected session or cache unit. Before changing real data, quit the selected tool and all related CLI, desktop, IDE, SDK, and background processes, then confirm this in the app. An unknown or running process state blocks the operation.
5. **Test a restore.** Restore the batch from “隔离记录” (Quarantine history). Existing files and directories are never overwritten or merged. Conflicts, changed data, or missing parent folders keep the affected items available for recovery; resolve the issue and retry with the relevant tool still closed.
6. **Use Trash only when ready.** Move a batch to the system Trash only when you are sure it is no longer needed. If the system API fails, files are kept; AgentVac does not fall back to permanent deletion.

For Codex SQLite databases or logs elsewhere, add locations in “空间诊断” (Space diagnostics), select the scope, and click “只读统计” (Read-only statistics). Configuration-path hints are parsed only when you explicitly enable configuration reading and are never accessed automatically. Other tools use their own metadata-only scopes described above.

## Safety and protected data

**Quarantine does not free disk space.** Files first move into `.agentvac-quarantine` inside the selected folder. They usually still occupy disk space after moving to the system Trash. Space may be reclaimed only after you empty Trash in your operating system; that deletion is irreversible. AgentVac has no permanent-delete function.

- **Explicit eligibility**: old rotated Codex logs remain eligible. New Codex session-file quarantine is disabled; existing signed archives require valid identity and recovery checks before restoration. Supported complete Claude Code session bundles require explicit review and restoration before resuming.
- **Critical data stays protected**: credentials, settings, canonical databases and their sidecars, project data, and unknown layouts. Cline's exact derived search cache and its companions are an explicitly documented disposable-cache exception, moved as one opaque unit without executing SQL.
- **Complete units only**: supported session bundles and cache directories cannot be split into component selections. An unknown member, incomplete scan, or changed layout protects the entire unit. Each unit is bounded to 5,000 nodes and 12 descendant levels.
- **No link following**: symbolic links, multiply hard-linked files, special files, cross-volume unit members, and files within the protection period cannot be quarantined.
- **Conservative operations**: previews expire, are single-use, and are revalidated. All relevant processes must remain closed. Failed or uncertain process inspection blocks changes. AgentVac does not run SQL cleanup, VACUUM, checkpoint, or database mode changes; Codex's deeper read-only log-database inspection requires separate strict prerequisites.

Scans visit up to **50,000 entries** by default, optionally 100,000. Entries include directories; a depth limit of 12 and a 24 MiB result budget also apply. Incomplete scans are clearly marked and disable bulk selection. Each batch is limited to 5,000 items. Charts and subtotals show only the logical size of discovered regular files, not total directory usage or reclaimable space.

Restores also check file snapshots. An authenticated manifest does not mean file contents have been compared byte-for-byte or verified by hash. Copying across volumes, changing computers, or restoring from the system Trash may change file identity and prevent automatic recovery. Keep the entire batch and the original key backup; do not edit manifests to bypass checks. To recover a trashed batch, first use your operating system to put the whole batch folder back at its original `.agentvac-quarantine/<batch-ID>` location, then let AgentVac validate and restore the files.

Whole-directory recovery does not guarantee preservation of every platform-specific ACL, extended attribute, or creation timestamp. New multi-member bundles use a signed v4 recovery journal; they are not one atomic filesystem rename. Windows has no directory-fsync guarantee. Importing a key cannot repair unsafe rounded identities in old manifests; preserve the whole batch instead of forcing recovery. Native recovery through the operating system's Trash remains unaccepted for the final candidate packages.

## Privacy and operating limits

Ordinary scans read file metadata, not log or session contents. AgentVac does not upload user files. Separately authorized conversation viewing and body search do read local content. Explicitly enabled configuration-path parsing, read-only database structure and page-state checks, and access to the app's own recovery keys and manifests are separate, restricted operations. AgentVac does not launch or upgrade these tools.

The renderer has no Node access and uses sandboxing, context isolation, and CSP. Previews expire quickly, are single-use, and are revalidated before execution. Quarantine uses a same-volume move; restoration does not overwrite existing files.

Do not run with elevated privileges, use folders writable by untrusted users, or organize data while the relevant tool or its background services are running. Repeated path checks cannot eliminate every malicious race condition or guarantee consistency through power loss or disk failure. Keep independent backups of important data.

## Run and build from source

Built with Electron, Vue 3, and TypeScript. Requires Node.js `^22.17.0` or `>=24.0.0` and a normal desktop session. The current `package-lock.json` locks Electron to `44.5.1`; install the locked dependencies with `npm ci`.

```sh
npm ci
npm run dev

# Build and launch the production app
npm run build
npm start
```

Checks:

```sh
npm test
npm run typecheck
npm run build
npm run test:e2e
npm run test:app-data
npm run test:ux
npm run test:bulk
npm run test:scan
npm run test:accessibility
npm run test:desktop
npm run test:providers
```

Desktop checks require the target operating system's GUI and native services. Tests use generated fixtures, not real user data. Browser or helper-process tests do not replace native verification of the final release files.

```sh
npm run dist:mac    # macOS arm64 / x64: DMG and ZIP build targets
npm run dist:win    # Windows x64: NSIS and portable EXE build targets
npm run dist:linux  # Linux x64: tar.gz only
npm run pack       # Unarchived app directory for the current platform
```

These are build targets; see the download section for files actually released. Native GitHub Actions verification normally runs on demand. Temporary triggers may be enabled for a specific source validation; check the current workflow file for its exact triggers. Verification does not automatically publish releases.

`SOURCE-SHA256.json` records hashes for a particular source snapshot, including code, tests, documentation and screenshots. It does not establish acceptance of the current candidate or verify release binaries. Use the matching release's `SHA256SUMS.txt` for downloaded apps.

## License

[MIT License](LICENSE). See [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) for third-party licenses. Packaged apps retain Electron / Chromium and other license notices.

# AgentVac

[简体中文](README.md) · [English](README.en.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)

Open-source desktop cleaner for Codex, Claude Code, Cline and Cursor. Analyze disk usage, preview cleanup, and safely quarantine or restore local data across macOS, Windows and Linux.

**Release status:** the **unreleased v0.2.0 development source** includes four-tool support and is still undergoing acceptance testing. **The current v0.1.0 downloads support Codex only.** No multi-tool release is available yet.

- **See what is on disk**: inspect logical file sizes, categories, cleanup candidates, and protection reasons.
- **Review before changing anything**: choose a tool and data folder, then preview the exact files or complete cleanup units.
- **Keep a recovery path**: quarantine locally, review batch history, and restore without overwriting existing data.
- **Work comfortably**: light, dark, and system themes; read-only SQLite and log diagnostics for Codex.

This README is available in four languages. **The app interface is currently available only in Simplified Chinese.** AgentVac is an independent project, not an official product of the supported tool vendors.

## Supported scope in the development source

| Tool            | Available for review and quarantine                                                                                                    | Kept protected / important limits                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Codex**       | Old rotated logs; recovery of existing signed session quarantines                                                                      | New session JSONL quarantine is disabled pending coherent dependency handling; current logs, credentials, configuration, indexes, databases and unknown data stay protected |
| **Claude Code** | Old standard debug logs; optional local-session archives containing the main transcript and all recognized companion files             | Latest and active sessions, global prompt history, memory, credentials, and unknown layouts; no Desktop, Cowork, or cloud history cleanup                                   |
| **Cline**       | Rebuildable full-text search cache and checkpoint scratch caches; recognized legacy model catalogs and aged per-session hook telemetry | Canonical conversation database, task history, real Git checkpoints, credentials, and configuration; whole-task archival is not available                                   |
| **Cursor**      | Known old diagnostic logs; complete recognized `Cache`, `Code Cache`, `GPUCache`, and `CachedData` directories                         | Chat and state databases, profiles, extensions, workspaces, indexes, account/network state, and unknown cache layouts                                                       |

Only explicitly supported paths and complete recognized layouts qualify. Age, activity, filesystem, and process checks still apply; finding a folder does not make its contents safe to move. Claude Code archives cannot resume until restored, and global prompt recall remains unchanged. Cline cache rebuilds can temporarily affect search or offline model listings. Cursor may download resources or recompile caches on the next launch. Newly regenerated data is never overwritten during restore.

See the detailed scopes for [Claude Code](docs/CLAUDE-CODE-SCOPE.md), [Cline](docs/CLINE-SCOPE.md), and [Cursor](docs/CURSOR-SCOPE.md), plus [cleanup units and recovery](docs/SAFE-CLEANUP-UNITS.md) and the [acceptance matrix](docs/MULTI-AGENT-ACCEPTANCE.md). Synthetic tests do not establish compatibility with every installed tool version or final cross-platform release readiness.

## Conversation manager (in development)

After separate local-content consent, the source can read supported conversation formats from all four tools, filter by title, project, full-text keyword and original conversation time, and page through long messages. Verified Claude Code session bundles can request quarantine previews. Canonical history writes for Codex, Cline and Cursor remain gated; viewing is not complete archive support.

Cursor database reading creates a private local temporary copy that may include unqueried settings/authentication pages, with a default cumulative 512 MiB budget. Windows must pass actual read-only ACL checks; native cross-platform acceptance remains in progress. Cline SDK folders and Cursor agent-transcripts can be explicitly selected as read-only sources. See [scope, privacy and limits](docs/CONVERSATION-MANAGEMENT.md).

**v0.1.0 safety note:** use old-log cleanup only and leave session-file quarantine disabled. Current Codex paginated history can reference other rollouts. New session-file quarantine is disabled in this source; existing signed archives remain recoverable.

## Download and install

Current download, **Codex only**: [v0.1.0](https://github.com/21888/AgentVac/releases/tag/v0.1.0). Prebuilt apps do not require a separate Node.js installation.

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

- **Explicit eligibility**: old rotated Codex logs remain eligible. New Codex session-file quarantine is disabled; existing signed archives remain recoverable. Supported complete Claude Code session bundles require explicit review and restoration before resuming.
- **Critical data stays protected**: credentials, settings, canonical databases and their sidecars, project data, and unknown layouts. Cline's exact derived search cache and its companions are an explicitly documented disposable-cache exception, moved as one opaque unit without executing SQL.
- **Complete units only**: supported session bundles and cache directories cannot be split into component selections. An unknown member, incomplete scan, or changed layout protects the entire unit. Each unit is bounded to 5,000 nodes and 12 descendant levels.
- **No link following**: symbolic links, multiply hard-linked files, special files, cross-volume unit members, and files within the protection period cannot be quarantined.
- **Conservative operations**: previews expire, are single-use, and are revalidated. All relevant processes must remain closed. Failed or uncertain process inspection blocks changes. AgentVac does not run SQL cleanup, VACUUM, checkpoint, or database mode changes; Codex's deeper read-only log-database inspection requires separate strict prerequisites.

Scans visit up to **50,000 entries** by default, optionally 100,000. Entries include directories; a depth limit of 12 and a 24 MiB result budget also apply. Incomplete scans are clearly marked and disable bulk selection. Each batch is limited to 5,000 items. Charts and subtotals show only the logical size of discovered regular files, not total directory usage or reclaimable space.

Restores also check file snapshots. An authenticated manifest does not mean file contents have been compared byte-for-byte or verified by hash. Copying across volumes, changing computers, or restoring from the system Trash may change file identity and prevent automatic recovery. Keep the entire batch and the original key backup; do not edit manifests to bypass checks. To recover a trashed batch, first use your operating system to put the whole batch folder back at its original `.agentvac-quarantine/<batch-ID>` location, then let AgentVac validate and restore the files.

Whole-directory recovery does not guarantee preservation of every platform-specific ACL, extended attribute, or creation timestamp. Multi-member bundles use a durable recovery journal; they are not one atomic filesystem rename.

## Privacy and operating limits

Ordinary scans read file metadata, not log or session contents. AgentVac does not upload user files. Explicitly enabled configuration-path parsing, read-only database structure and page-state checks, and access to the app's own recovery keys and manifests are separate, restricted operations. AgentVac does not launch or upgrade these tools.

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

`SOURCE-SHA256.json` records hashes for the published source snapshot, including code, tests, documentation, and screenshots. It does not verify release binaries. Use the release’s `SHA256SUMS.txt` for downloaded apps.

## License

[MIT License](LICENSE). See [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) for third-party licenses. Packaged apps retain Electron / Chromium and other license notices.

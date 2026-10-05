# AgentVac

[简体中文](README.md) · [English](README.en.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)

A desktop app for conservatively managing local Codex data. Inspect file sizes, preview changes, quarantine old files, and restore them to their original locations when needed.

- **Space analysis**: distinguish logs, sessions, and protected files, with an explanation for each item.
- **Read-only diagnostics**: inspect SQLite databases, sidecar files, and ordinary logs separately.
- **Quarantine and restore**: preview changes, keep batch records, and restore without overwriting existing files.
- **Light and dark themes**: switch manually or follow your system setting.

This README is available in four languages. **The app interface is currently available only in Simplified Chinese.** AgentVac is not an official OpenAI product.

## Download and install

Current release: [v0.1.0](https://github.com/21888/AgentVac/releases/tag/v0.1.0). Prebuilt apps do not require a separate Node.js installation.

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

These are screenshots of the actual app using **synthetic test data**. Sizes are logical file sizes, not a user's actual usage, allocated disk space, or reclaimable space. Screenshots illustrate the interface; they do not establish installation, signing, or system trust verification for the current release files.

### Space analysis · Light

File distribution, categories, and an individual file inspector.

![AgentVac light-theme space analysis with a file distribution chart, categories, and a protected-file inspector](docs/images/overview-light.png)

### Space analysis · Dark

Old-log candidates are distinguished from sessions, which are protected by default.

![AgentVac dark-theme space analysis showing synthetic scan results, old-log candidates, and a file list](docs/images/overview-dark.png)

### Space diagnostics

Choose the scope and inspect SQLite-related files and ordinary logs in read-only mode.

![AgentVac space diagnostics showing selected locations, read-only statistics, and sizes by category](docs/images/space-diagnostics.png)

### Quarantine and restore

Review quarantined files by batch, then restore them or move the batch to the system Trash.

![AgentVac quarantine history with three demo log files and actions to restore or move them to the system Trash](docs/images/quarantine-recovery.png)

## First use

Chinese labels below match the current app interface.

1. **Try the demo first.** Click “体验演示扫描” (Try demo scan) to practice previewing, quarantining, and restoring. The demo workspace preserves your previous actions.
2. **Select your data folder.** Use the native folder picker to select your Codex data root, usually `.codex` in your home folder, or a location set by `CODEX_HOME`. Do not select a project folder or disk root. Suggested locations are only hints and are not scanned automatically.
3. **Back up files and the recovery key.** Back up your data, then open “目录与恢复” (Folders and recovery) and choose “导出恢复备份” (Export recovery backup). This backup contains sensitive key material. Keep it safely offline; do not upload or share it. A key backup does not replace a file backup.
4. **Scan and review the preview.** Files from the last **30 days** are protected by default. Start with a few sufficiently old rotated logs, and review protection reasons, scan completeness, and the operation preview. Before quarantining real data, quit all Codex CLI and desktop processes and explicitly confirm this in the app.
5. **Test a restore.** Restore the batch from “隔离记录” (Quarantine history). Existing destination files are never overwritten. Failed items are kept if there is a conflict, a file has changed, or a parent folder is missing; resolve the issue and retry.
6. **Use Trash only when ready.** Move a batch to the system Trash only when you are sure it is no longer needed. If the system API fails, files are kept; AgentVac does not fall back to permanent deletion.

If your SQLite databases or logs are elsewhere, add those locations in “空间诊断” (Space diagnostics), select the scope, and click “只读统计” (Read-only statistics). Path hints in configuration are parsed only if you explicitly enable configuration reading, and are never accessed automatically.

## Safety and protected data

**Quarantine does not free disk space.** Files first move into `.agentvac-quarantine` inside the selected folder. They usually still occupy disk space after moving to the system Trash. Space may be reclaimed only after you empty Trash in your operating system; that deletion is irreversible. AgentVac has no permanent-delete function.

- **Candidates for review**: sufficiently old, regular rotated `log/codex-tui.log` files with a single hard link (numeric or date suffixes, optionally ending in `.gz`).
- **Sessions are protected by default**: eligible files in `sessions/**/*.jsonl` and `archived_sessions/**/*.jsonl` become selectable only after you explicitly enable session review. Old sessions may still be in use; moving their files can affect history and resume.
- **Always protected**: the current log, credentials, configuration, history, indexes, state, SQLite databases and their WAL / SHM / Journal files, caches, Skills, MCP, projects, and unknown files. Protected and unknown directories are not traversed.
- **No link following**: symbolic links, multiply hard-linked files, special files, and files within the protection period cannot be quarantined.
- **Read-only databases**: no SQLite compaction, deletion, cleanup, VACUUM, checkpoint, or mode changes. Deeper inspection is available only for log databases that meet strict prerequisites; otherwise it is refused.

Scans visit up to **50,000 entries** by default, optionally 100,000. Entries include directories; a depth limit of 12 and a 24 MiB result budget also apply. Incomplete scans are clearly marked and disable bulk selection. Each batch is limited to 5,000 items. Charts and subtotals show only the logical size of discovered regular files, not total directory usage or reclaimable space.

Restores also check file snapshots. An authenticated manifest does not mean file contents have been compared byte-for-byte or verified by hash. Copying across volumes, changing computers, or restoring from the system Trash may change file identity and prevent automatic recovery. Keep the entire batch and the original key backup; do not edit manifests to bypass checks. To recover a trashed batch, first use your operating system to put the whole batch folder back at its original `.agentvac-quarantine/<batch-ID>` location, then let AgentVac validate and restore the files.

## Privacy and operating limits

Ordinary scans read file metadata, not log or session contents. AgentVac does not upload user files. Explicitly enabled configuration-path parsing, read-only database structure and page-state checks, and access to the app's own recovery keys and manifests are separate, restricted operations. AgentVac does not launch or upgrade Codex.

The renderer has no Node access and uses sandboxing, context isolation, and CSP. Previews expire quickly, are single-use, and are revalidated before execution. Quarantine uses a same-volume move; restoration does not overwrite existing files.

Do not run with elevated privileges, use folders writable by untrusted users, or organize data while Codex is running. Repeated path checks cannot eliminate every malicious race condition or guarantee consistency through power loss or disk failure. Keep independent backups of important data.

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
```

Desktop checks require the target operating system's GUI and native services. Tests use generated fixtures, not real Codex data. Browser or helper-process tests do not replace native verification of the final release files.

```sh
npm run dist:mac    # macOS arm64 / x64: DMG and ZIP build targets
npm run dist:win    # Windows x64: NSIS and portable EXE build targets
npm run dist:linux  # Linux x64: tar.gz only
npm run pack       # Unarchived app directory for the current platform
```

These are build targets; see the download section for files actually released. The GitHub Actions workflow is manually triggered only. Source or documentation updates do not run it automatically, and it does not publish releases automatically.

`SOURCE-SHA256.json` covers only source code, tests, build scripts, configuration, and icons. It does not cover documentation, screenshots, or release files. Use the release's `SHA256SUMS.txt` for downloaded binaries.

## License

[MIT License](LICENSE). See [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) for third-party licenses. Packaged apps retain Electron / Chromium and other license notices.

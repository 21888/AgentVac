# Cursor adapter: coherent cache and diagnostic-log cleanup

Evidence checked **2026-10-05 UTC**. Implementation: `electron/providers/cursor.ts`.
This adapter provides reversible quarantine and non-overwriting restoration of
supported **old diagnostic logs and complete known cache directories**. It does not clean, compact, repair, migrate,
index, export, or read Cursor chat databases.

## Supported application roots

Pure candidate discovery proposes these paths, without reading them:

- macOS: `~/Library/Application Support/Cursor`
- Windows: `%APPDATA%\Cursor`, falling back to
  `%USERPROFILE%\AppData\Roaming\Cursor` if no absolute APPDATA is available
- Linux: `~/.config/Cursor`

Selection still requires metadata validation: the basename is exactly `Cursor`,
and real directories `User`, `User/globalStorage`, and `logs` must exist. The
shared engine verifies every ancestor, rejects symlinks/reparse-like redirects,
and binds the selected root to its filesystem identity. Directly selecting a
VS Code root, `.cursor`, a Cline extension subtree, a `User` directory, workspace
storage or profile subdirectory fails closed. Similar marker directories alone
cannot turn one of those explicitly rejected roots into Cursor.

This is a conservative layout check, not cryptographic proof of application
provenance. The user must select their actual Cursor application data. A
directory deliberately renamed and populated to imitate that layout cannot be
distinguished using metadata only.

Profiles within `User/profiles` are preserved with the entire opaque `User`
tree; they are never separately offered as cleanup roots. Cursor also supports
isolated `--user-data-dir` instances. Arbitrary custom names, portable layouts,
remote hosts, `.cursor-server`, unverified XDG IDE overrides, and alternate
release-channel data roots are not auto-discovered or generalized from VS Code.
A manually selected root must still satisfy the same strict layout rules.
`CURSOR_CONFIG_DIR` and the lowercase XDG `cursor` directory documented for the
Agent CLI are not evidence of the IDE data root and are deliberately ignored.

## Exact eligible files

Only these shapes enter the diagnostic-log allowlist:

- `logs/YYYYMMDDTHHMMSS/main.log`
- `logs/YYYYMMDDTHHMMSS/renderer.log`
- `logs/YYYYMMDDTHHMMSS/windowN/renderer.log`
- `logs/YYYYMMDDTHHMMSS/windowN_wbN/renderer.log`

Window numbers begin at 1; the optional workbench suffix begins at 0. Dates
must be real calendar dates, including valid hours/minutes/seconds. Current,
future, and less-than-two-day-old timestamp directories remain protected,
independent of file mtime. The additional two-day margin avoids assuming the
timestamp writer's time zone. The shared engine separately applies the user's
mtime age threshold.

The newest valid, real dated directory remains protected even if all its file
mtimes are old or it is the only dated session. A bounded metadata enumeration
refreshes that exclusion before scan, preview, quarantine and restore. A failed
or over-limit enumeration aborts. Symlinks and regular files named like dates
cannot masquerade as newer sessions and make the real latest session eligible.

A date-shaped directory is not a blanket deletion permission. Unknown files,
compressed/rotated variants, extension output logs, custom output channels and
unknown directories stay protected. Only known log-session and window
directories are traversed by the ordinary file scanner. Log directories
themselves are not moved or removed.

## Coherent cache units

Exact top-level names `Cache`, `GPUCache`, `Code Cache` and `CachedData` have a
separate whole-directory policy, `cursor-known-cache-layout-v1`. They are
review-required units; their component files are never independently selected.
All member and directory mtimes must satisfy the selected age floor, the
entire bounded metadata snapshot must be stable, and Cursor must be stopped.
Consequently a cache touched recently remains ineligible even if some individual
entries are old. This does not label all live cache storage as waste.

Every member must fit one of these complete, source-backed layouts:

- Simple disk cache: regular `index`, directory `index-dir` with regular
  `the-real-index`, optional `temp-index`, and known 16-hex entry filenames with
  `_0`, `_1` or `_s` suffixes. Known `todelete_...` cache tombstone filenames are
  included in the same unit.
- Blockfile disk cache: regular `index`, all of `data_0` through `data_3`, and
  optional known `data_N` (up to 255) and `f_<6–8 hex>` payload files. No nested
  directories and no mixed simple/blockfile layout.
- `Cache`: direct simple/blockfile layout, or only `Cache_Data` containing that
  complete layout.
- `GPUCache`: direct simple/blockfile layout.
- `Code Cache`: only `js`, `wasm` and/or `webui_js`, each a complete simple cache.
- `CachedData`: only 40-hex commit directories, each containing only `chrome`,
  with the same known code-cache children. Older/custom layouts are protected.

Missing markers, additional files, mixed backends or unrecognized directory
names protect the entire unit. `Code Cache/pc` experimental persistent-cache
SQLite is deliberately unsupported; it is not reclassified as chat data, opened,
or modified. `DawnCache`, `DawnWebGPUCache`, `DawnGraphiteCache`, `ShaderCache`,
network state, browser partitions and cache roots in profiles are not covered.
The backend bounds a unit to 5,000 nodes / 12 levels, rejects links, hardlinks,
special files and cross-device members, and revalidates complete snapshots.

Whole-directory quarantine preserves the index/payload relationships. Restore
requires the original destination to be absent, including no newly recreated
empty directory. It uses exclusive directory creation and non-overwriting
reconstruction, with authenticated resumable state. If Cursor has rebuilt a
cache at its original path, restoration reports a conflict rather than merging
old and new cache generations.

Expected rebuild costs: HTTP resources may be downloaded again, compiled
JavaScript/Wasm and shader caches may be regenerated, and the next startup or
render can be slower. Vendor support identifies these four roots as removable
cache, separate from settings/extensions; no exact amount of future reclaimed
space or performance improvement is promised.

The shared engine requires an explicit closed-process confirmation and a clear
process inspection; any detected Cursor desktop/helper/CLI/server, incomplete
enumeration, failed inspection, empty/malformed snapshot or unattributed generic
Electron/Node process blocks mutation. Names/arguments are a conservative
process check, not a proof that an unknown renamed executable cannot exist.

Ordinary scans inspect names and filesystem metadata only. On an explicitly
confirmed quarantine/restore, the engine handles the chosen log's bytes using
its existing authenticated journal, link/race checks and non-overwrite policy.
Diagnostic logs themselves can contain private request, authentication-error or
workspace information; this adapter does not display their contents. If newer
session directories disappear and an archived log becomes dynamically protected,
restoration also stops rather than bypassing the current protection boundary.

## Always protected

- All of `User`, including `globalStorage`, `workspaceStorage`, `profiles`,
  settings, keybindings, snippets, sync and local file History
- All `state.vscdb` files, backups, SQLite WAL/SHM/journal companions and other
  database schemas, regardless of apparent size, age or extension
- Authentication, tokens, cookies, machine identity and local storage
- Extension installations and extension-owned data, including Cline data
- Project workspaces, indexes, embeddings, worktrees, unsaved files and backups
- `.cursor` user/project configuration, rules, MCP, permissions, CLI settings,
  chats and agent transcripts; these are not the IDE app-data root
- Cache component files selected independently, unsupported cache layouts,
  `CachedExtensionVSIXs`, Dawn/shader variants and other unknown caches
- Unknown filenames, layouts, symlinks, hardlinks and non-regular files

Large chat-database storage will therefore remain unchanged. Displaying this
feature as “Cursor chat cleanup” or suggesting database space was reclaimed
would be incorrect.

## Primary-source evidence and version limits

1. [Cursor support: workspace session-list storage](https://forum.cursor.com/t/agents-panel-right-sidebar-lost-session-list-no-way-to-restore/153481/4),
   Colin, **2026-03-04**: names `state.vscdb` under the workspace-storage roots on
   macOS, Windows and Linux, describes the sidebar/session-list consequence of
   clearing it, and identifies adjacent backups. Used for standard app-root
   discovery and mandatory database protection, not for a database schema.
2. [Cursor support: login diagnostics on disk](https://forum.cursor.com/t/desktop-app-stuck-on-login-screen-after-successful-browser-authentication/164774/9),
   Dean Rie, **2026-07-06**: identifies `%APPDATA%\Cursor\logs`, date/time session
   folders, `main.log`, renderer/window subfolders and `Cursor.exe`. It also
   shows why log contents can be sensitive.
3. [Cursor support: macOS terminal/version-control startup issue](https://forum.cursor.com/t/terminal-version-control-doesnt-load/158621),
   support response **2026-06-08** and direct report **2026-06-10**: confirms the
   macOS `Cursor/logs` root and observed main/renderer files and window variants.
   Unknown and extension-specific files mentioned there are not allowlisted.
4. [Cursor support: initialization stall](https://forum.cursor.com/t/bug-window-initialization-stalls-after-auto-update-extension-hosts-spawn-but-never-become-responsive/160630),
   **2026-06-02**, reported **Cursor 3.6.31**: records
   `window1/renderer.log` and `window2_wb0/renderer.log`. This is observed layout
   evidence, not a promise that every later build uses the same layout.
5. [Cursor support: macOS workspace startup](https://forum.cursor.com/t/cursor-on-macos-infinitely-loads-a-workspace/157256),
   **2026-04-26**, reported **Cursor 3.2.11 / VS Code 1.105.1**: confirms main.log
   diagnostics and supplies a specific upstream-version reference.
6. [Cursor support: global storage investigation](https://forum.cursor.com/t/cursor-3-16-17-agent-window-intermittently-freezes-during-long-agent-runs-main-process-reaches-99-cpu/168695/24),
   Colin, **2026-08-26**, thread **Cursor 3.16.17**: identifies global
   `User/globalStorage/state.vscdb` separately. AgentVac performs none of the
   SQL inspection proposed in that support exchange.
7. [Cursor support: isolated data-directory instances](https://forum.cursor.com/t/user-level-agent-discovery-ignores-user-data-dir/152043),
   **2026-02-17**, reported **Cursor 2.4.37**: acknowledges the separate
   `--user-data-dir` setting and `.cursor` agent/rules scope. It does not justify
   treating arbitrary profile or configuration paths as cleanup roots.
8. [Current Cursor CLI configuration](https://prod.cursor.com/docs/cli/reference/configuration),
   checked **2026-10-05**: distinguishes per-user/project CLI files and the
   CLI-specific directory overrides. [Current permissions reference](https://prod.cursor.com/docs/reference/permissions)
   separately documents user/project `.cursor/permissions.json`.
9. [VS Code 1.105.1 environment service](https://github.com/microsoft/vscode/blob/1.105.1/src/vs/platform/environment/common/environmentService.ts),
   lines 67–74: upstream constructs date/time log directories using local wall
   time. The file separately describes `User`, workspace storage and History.
   This supports defensive timestamp parsing; it is not used to infer Cursor's
   proprietary chat format or extend the file allowlist.
10. [Cursor changelog](https://cursor.com/changelog), checked **2026-10-05**,
    showed a most recent displayed entry dated **2026-09-23**. This does not
    supply an exact desktop binary build or storage compatibility guarantee.

Cursor's former troubleshooting-guide URL redirected to its docs landing page
when opened on the evidence date; stale search excerpts were not used to grant
cleanup permission. No live Cursor installation, private chat data or credentials
were read during implementation. Compatibility is shape-gated and fixture-tested,
not a claim of native validation on every Cursor release or OS.

### Additional cache evidence

- [Cursor support: cache-only reset](https://forum.cursor.com/t/unable-to-use-chat-window-at-all/139514/2),
  Dean Rie, **2025-10-30**: explicitly separates the four macOS cache directories
  from settings/extensions and requires Cursor to be quit first. AgentVac does
  not implement the later broad app-data deletion fallback in that response.
- [Cursor support: model-list issue](https://forum.cursor.com/t/no-models-avaliable/157705),
  Dean Rie, **2026-04-17**: again identifies `Cache`, `CachedData` and `GPUCache`
  under the macOS application root for a closed-app cache reset.
- [Cursor support: Windows connection issue](https://forum.cursor.com/t/3-1-17-system-setup-connection-failed-please-try-again-or-contact-support-if-the-issue-persists/158630/8),
  Dean Rie, **2026-04-22**, thread **3.1.17**: suggests renaming the four cache
  roots after checking no Cursor.exe remains. That response also suggests
  resetting `Network` and signing in again; AgentVac explicitly excludes Network
  because that expands into account/network state.
- [Electron session API](https://www.electronjs.org/docs/latest/api/session#sessetcodecachepathpath),
  checked **2026-10-05**: generated JS cache directories are created if absent,
  default to `Code Cache`, and can be cleared separately from storage data.
  HTTP-cache clearing is also distinct from cookies, local storage, IndexedDB
  and service workers. AgentVac does not invoke those APIs in Cursor.
- [Electron 39.8.1 network context](https://github.com/electron/electron/blob/v39.8.1/shell/browser/net/network_context_service.cc)
  and [Chromium 142.0.7444.265 constants](https://github.com/chromium/chromium/blob/142.0.7444.265/chrome/common/chrome_constants.cc)
  identify the HTTP `Cache` root separately from cookies/network state.
  [The same Chromium version's network boundary](https://github.com/chromium/chromium/blob/142.0.7444.265/content/browser/network_service_instance_impl.h)
  explains the `Cache_Data` child used for cache reset operations.
- [Chromium simple-cache index](https://github.com/chromium/chromium/blob/142.0.7444.265/net/disk_cache/simple/simple_index_file.cc)
  and [entry filenames](https://github.com/chromium/chromium/blob/142.0.7444.265/net/disk_cache/simple/simple_util.cc)
  define the exact simple-cache member grammar. [Blockfile storage](https://github.com/chromium/chromium/blob/142.0.7444.265/net/disk_cache/blockfile/block_files.cc)
  and [backend](https://github.com/chromium/chromium/blob/142.0.7444.265/net/disk_cache/blockfile/backend_impl.cc)
  define the separate block/payload structure.
- [Chromium generated-code caches](https://github.com/chromium/chromium/blob/142.0.7444.265/content/browser/code_cache/generated_code_cache_context.cc)
  identifies `js`, `wasm`, `webui_js`, and the separate experimental `pc` backend.
  AgentVac rejects that last layout. [GPU cache definitions](https://github.com/chromium/chromium/blob/142.0.7444.265/gpu/ipc/common/gpu_disk_cache_type.cc)
  identify GPUCache as shader data, while distinguishing newer Dawn names that
  lack Cursor-specific reset evidence here.
- [VS Code 1.105.1 startup](https://github.com/microsoft/vscode/blob/1.105.1/src/main.ts)
  derives `CachedData/<commit>`; [application setup](https://github.com/microsoft/vscode/blob/1.105.1/src/vs/code/electron-main/app.ts)
  places Chromium's generated-code cache under its `chrome` child.
  [The upstream cache cleaner](https://github.com/microsoft/vscode/blob/1.105.1/src/vs/code/electron-utility/sharedProcess/contrib/codeCacheCleaner.ts)
  skips the active commit and ages out older whole commit directories. These
  sources support layout validation, not assumptions about Cursor-specific data.

### Dependency boundary

Application-root cache units derive from installed code, fetched resources or
GPU compilation and can be rebuilt. They contain their own cache indexes and
payloads, so only a complete recognized generation is moved/restored. In contrast,
Cursor's global `state.vscdb`, workspace databases and their WAL/SHM/backup files
are durable, interrelated state: global chat records, workspace/sidebar references,
and user/workspace configuration cannot be independently pruned safely using
these cache contracts. `.cursor` transcript or CLI stores are a separate data
family. No part of that history/state dependency graph is selected or rewritten.

## Verification

Run `node --import tsx --test tests/cursor-provider.test.ts`.
Tests cover platform candidates, malformed paths/dates, unknown names, current
and newest sessions, profile/Code/Cline root rejection, links, metadata-only
scanning, protected SQLite/config fixtures, real quarantine, non-overwriting
restore, changed-protection refresh, process failures and provider-bound journals.
The integration owner additionally runs the existing Codex/source185 aggregate
regressions. All cleanup tests use disposable synthetic fixtures only.

### Native runtime acceptance still to perform

No Cursor binary was installed or launched for this work. A future native
acceptance run must first agree on a disposable OS user/VM and vendor build;
changing only `--user-data-dir` is insufficient because some `.cursor` features
use home-scoped paths. Use a dummy workspace, separate extensions/data roots,
no account login, no secrets, and no access to the user's real home data.

For each supported OS/build: generate caches in that isolated profile, quit and
verify the process guard, confirm the generated layout fits the policy, then
quarantine and restore a copied/aged synthetic profile. Independently launch
the isolated vendor app after removal to verify regeneration and ordinary UI
startup. Finally confirm newly regenerated destinations prevent restoring the
old generation. Compare only disposable state fixtures. Record exact build and
observed layout rather than treating the synthetic roundtrip as native proof.

The public [Cursor installer](https://cursor.com/install), read but not executed
on **2026-10-05**, exposed CLI version **2026.10.01-e373342**, its
`~/.local/share/cursor-agent/versions/` installation, and the `agent` alias.
Those executable/entrypoint paths inform the guard. Bare ambiguous `agent`
processes remain unknown; quoted prose or `node -e` strings mentioning Cursor
do not count as a running Cursor executable.

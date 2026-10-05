# Cline adapter scope and source evidence

Last checked: 2026-10-05. This is limited, experimental Cline artifact cleanup, not complete Cline task/history management. Task archive needs an index- and checkpoint-aware transaction; it is deliberately not approximated by deleting one conversation file.

## Implemented baseline

- Candidate discovery: shared Cline data (`~/.cline/data`, `CLINE_DATA_DIR`, `CLINE_DIR/data`) and standard VS Code/Insiders Cline extension storage on macOS, Windows and Linux. VS Code portable/appdata overrides are recognized. Discovery computes paths only; it does not read them.
- Explicit root selection: compatible-editor, portable, profile and same-machine remote-extension layouts ending in `globalStorage/saoudrizwan.claude-dev`; relocated shared data roots with complete independent metadata markers. Selecting a directory does not make unknown contents eligible.
- Current rebuildable checkpoint scratch directories: `checkpoint-scratch/<32-hex>/{index,pathspec}` as one exact directory unit. Keep latest/tied and under-30-day caches, missing members, links, locks and unknown descendants protected. This is a private performance cache, not the real workspace Git index or retained checkpoint refs.
- Current derived search cache: exact `db/session-search.db` plus existing `-wal`, `-shm` and `-journal` companions as one opaque unit. All companions must be ordinary, old, and free of unknown filename variants. No production SQL is executed. Canonical `db/sessions.db` and its sidecars remain protected. Native search rebuild may temporarily make search unavailable; restoring over a regenerated cache is refused.
- Four verified historical model catalogs under an exact legacy extension root: `cache/openrouter_models.json`, `cache/vercel_ai_gateway_models.json`, `cache/groq_models.json`, `cache/cline_recommended_models.json`. Each is a one-file recoverable unit. Offline model listings may be unavailable until refresh or restore; remote configuration and MCP caches remain protected.
- Metadata-only scan of documented older SDK `sessions/<13-digit timestamp>_<5 lowercase alphanumeric characters>/hooks.jsonl` telemetry. The canonical manifest and message files must exist as ordinary single-link files. The newest canonical session (all timestamp ties), sessions modified within 30 days, incomplete sessions and unknown IDs are protected. The user's chosen age filter can be stricter.
- Native quarantine/restore through the common identity, no-follow, signed-journal and no-overwrite pipeline. No provider-specific direct unlink implementation.
- Current shared `logs/hooks.jsonl`, `logs/cline.log`, `logs/code.log`, task transcripts, manifests, compaction state, configuration, credentials, canonical indexes, canonical SQLite databases and sidecars, MCP, rules, memories, skills, real checkpoints and unknown files remain protected. The exact derived search cache and private scratch index above are the only index exceptions.

The per-session telemetry format is documented by the current source's messages contract, but current code writes hook audit logging to the shared `logs/hooks.jsonl`. No source-backed rotated shared-log name is assumed. Users with only new-format logs may therefore have no eligible telemetry.

## Root policy

Modern shared-data validation requires ordinary `sessions/` and `db/` directories plus single-link ordinary `db/sessions.db` and `globalState.json`. These are checked with filesystem metadata only; no SQLite query or settings read occurs. Sparse SDK-only/file-index variants and unknown migrations fail closed in this baseline. Custom `CLINE_SESSION_DATA_DIR` and database overrides are not guessed or followed.

Legacy extension roots require the exact Cline extension ID, a real `tasks/` directory and ordinary `state/taskHistory.json`. Roo Code (`rooveterinaryinc.roo-cline`) and other forks are not Cline support. Broad editor roots, `.codex`, `.claude`, `.cursor`, extension parents and unrecognized roots are rejected. The common engine independently checks every ancestor, canonical root identity, source fingerprints and links before operations.

Cline extension storage defaults:

- macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev`
- Windows: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/Code/User/globalStorage/saoudrizwan.claude-dev`
- VS Code Insiders uses its own `Code - Insiders` product directory.

Profiles can use `User/profiles/<id>/globalStorage`, or share default global state. The adapter does not read profile settings or enumerate profile IDs. Select the actual extension data root explicitly. Portable VS Code uses its `user-data` tree; `--user-data-dir` and compatible-editor product names are explicit-selection cases unless a supported environment override supplies the base.

SSH/WSL/container extension data can live on another machine or filesystem. A root path alone does not prove its writers are visible in the local process table. Network-mounted or externally written data is outside the local cleanup guarantee and must not be marketed as supported remote-process cleanup.

## Process policy

Known Cline/native/SDK commands and common VS Code-compatible or JetBrains editor hosts block mutation. Failed, empty, malformed or incomplete enumeration is unknown. Generic Node/Bun/Java-style runtimes without attributable full arguments, or eval-only launch forms, are unknown. A fully attributed unrelated absolute script/JAR command need not block normal development.

A custom application may import Cline without naming it in its command line. That cannot be detected reliably from process metadata. The common engine still requires explicit confirmation that all Cline clients and background services are stopped. Self-process exclusion must use verified process IDs, not trusting an executable named AgentVac.

## Source pins

Current source snapshot: [cline/cline at afabc824d88ebd0c779ab06f0cfb14c5483dc50f](https://github.com/cline/cline/tree/afabc824d88ebd0c779ab06f0cfb14c5483dc50f), committed 2026-10-05T16:48:15Z. Package metadata reports VS Code extension 4.1.22 and CLI 3.0.68. This does not establish an installed version or Marketplace rollout.

- [Extension package identity](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/apps/vscode/package.json)
- [Shared data-directory resolution and state/secrets layout](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/apps/vscode/src/shared/storage/storage-context.ts)
- [SDK path overrides, data/db/log locations](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/shared/src/storage/paths.ts)
- [Documented canonical messages and older per-session telemetry](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/core/docs/messages-contract-v1.md)
- [Canonical session artifact paths](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/core/src/services/session-artifacts.ts)
- [Exact default SDK session-ID producer](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/shared/src/session/index.ts)
- [Current shared hook-audit log producer](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/core/src/hooks/hook-file-hooks.ts)
- [Current rebuildable scratch cache, 14-day native reaper, and missing-index rebuild](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/core/src/hooks/checkpoint-hooks.ts)
- [Current derived full-text search cache and reconciliation](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/core/src/session/search/session-history-search.ts)
- [Current CLI log lifecycle](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/apps/cli/src/logging/adapter.ts)
- [Current desktop log lifecycle](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/apps/examples/desktop-app/sidecar/logging.ts)
- [Legacy state deliberately retained during migration](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/apps/vscode/src/hosts/vscode/vscode-to-file-migration.ts)
- [Current VS Code controller delegates to SDK](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/apps/vscode/src/core/controller/index.ts)

VS Code primary references checked on the same date: [ExtensionContext API](https://code.visualstudio.com/api/references/vscode-api#ExtensionContext), [profiles](https://code.visualstudio.com/docs/configure/profiles), [portable mode](https://code.visualstudio.com/docs/setup/portable), [remote development](https://code.visualstudio.com/docs/remote/remote-overview). Official implementation references: [user-data path](https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/node/userDataPath.ts), [profile global storage](https://github.com/microsoft/vscode/blob/main/src/vs/platform/userDataProfile/common/userDataProfile.ts), [extension ID storage suffix](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostStoragePaths.ts). Those moving VS Code references explain host layout; they are not a version guarantee for every fork.

## Temp-command logs are intentionally not enabled

Current [shell executor](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/core/src/extensions/tools/executors/bash.ts) creates temporary `cline-command-*` directories with `output.log`, `active-command.json` and `completed-at`, normally reaping completed logs after 24 hours. A quarantine inside such a directory would be removed by the native janitor; a quarantine at the OS temp root can disappear during OS cleanup. The current same-root recovery pipeline therefore does not enable this category without a separately reviewed durable destination.

## Why whole-task archive is still blocked

Historical source pin [31e8c85f0a5e038bd02b160fc4cc18c5ba611b00, extension 3.67.0](https://github.com/cline/cline/tree/31e8c85f0a5e038bd02b160fc4cc18c5ba611b00): [task lookup](https://github.com/cline/cline/blob/31e8c85f0a5e038bd02b160fc4cc18c5ba611b00/src/core/controller/index.ts#L785-L836) removes the history row when its API-history file is missing. Merely restoring the folder afterwards cannot restore that row. [Native task deletion](https://github.com/cline/cline/blob/31e8c85f0a5e038bd02b160fc4cc18c5ba611b00/src/core/controller/task/deleteTasksWithIds.ts) can delete the entire shared checkpoint tree when the remaining task history becomes empty. A safe archive must account for both indexes and shared checkpoint dependencies.

Current [SDK deletion](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/sdk/packages/core/src/session/services/persistence-service.ts) updates shared indexes and child-session relationships and deletes workspace Git checkpoint refs. The [public extension API](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/apps/vscode/src/exports/cline.d.ts) does not expose a reversible archive operation. [CLI export](https://github.com/cline/cline/blob/afabc824d88ebd0c779ab06f0cfb14c5483dc50f/apps/cli/src/session/history-export.ts) is a message export, not a complete task/index/checkpoint backup.

A future explicit legacy transaction could preserve exact index bytes, isolate opaque task directories and copy shared checkpoint dependencies, then refuse restore if current index/checkpoint state changed. That design still needs a reviewed concurrent-writer exclusion protocol, crash recovery and native lifecycle acceptance. It is not enabled here, and a historical schema must not be presented as support for the current SDK.

## Verification

`tests/cline-provider.test.ts` uses synthetic temporary storage only. It covers platform discovery, explicit profile/portable/remote-shaped roots, wrong-provider selection, links/hardlinks, protected data and unknown paths, metadata-only scan, age/latest/companion protection, exact-byte telemetry quarantine/restore, post-preview activity, and fail-closed process detection. It does not prove installed Cline integration or native platform durability.

A separate six-case pinned-native-code experiment used the actual AgentVac engine with synthetic canonical SQLite/message fixtures and a synthetic Git repository. Native search regeneration produced equivalent query results without changing canonical database/message bytes. Native checkpoint code rebuilt missing scratch with the same untracked-file tree while preserving the real Git index and retained checkpoint ref. Native scratch reaping could not target the data-root recovery archive, and restoring over regenerated cache was refused. This is source-level lifecycle evidence, not an installed GUI run.

Historical catalog producers were checked at exact Cline 3.67.0 source: [OpenRouter](https://github.com/cline/cline/blob/31e8c85f0a5e038bd02b160fc4cc18c5ba611b00/src/core/controller/models/refreshOpenRouterModels.ts), [Vercel](https://github.com/cline/cline/blob/31e8c85f0a5e038bd02b160fc4cc18c5ba611b00/src/core/controller/models/refreshVercelAiGatewayModels.ts), [Groq](https://github.com/cline/cline/blob/31e8c85f0a5e038bd02b160fc4cc18c5ba611b00/src/core/controller/models/refreshGroqModels.ts), and [recommended models](https://github.com/cline/cline/blob/31e8c85f0a5e038bd02b160fc4cc18c5ba611b00/src/core/controller/models/refreshClineRecommendedModels.ts). Current SDK catalogs and tool-result cache can be bundled/in-memory; no additional guessed disk-cache names are allowed.

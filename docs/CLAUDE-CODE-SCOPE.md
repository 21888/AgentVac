# Claude Code adapter: supported scope and evidence

Research date: **2026-10-05 (UTC)**. The official Claude Code changelog exposed **2.1.289**. Session-unit behavior is pinned to the official **Python Agent SDK v0.2.163**, commit **1ef6d8c71bb0e44a6b33fe61497864f21e17fdb7**, whose release bundles CLI 2.1.286. These are evidence versions, not a claim that AgentVac installed or tested those applications.

## Two supported cleanup scopes

### Standard old debug logs

Only `debug/<lowercase UUID-v4>.txt` is eligible. Files must exceed the selected minimum age, be regular single-link files, and have no linked ancestor. The most recently modified matching log and every newest-mtime tie are retained. Arbitrary names, compressed/rotated logs and unknown subdirectories remain protected.

### Optional coherent local-session archives

With session review explicitly enabled, a supported old local transcript is one review-only unit:

1. `projects/<project>/<UUID-v4>.jsonl`, the required main transcript.
2. The optional sibling `projects/<project>/<UUID-v4>/` containing all its supported related files.

The complete unit is selected, previewed, quarantined and restored together. Members cannot be individually selected. A missing optional sibling is recorded as absent; a newly appearing sibling invalidates the earlier scan. The newest transcript in each project, all newest-mtime ties, duplicate IDs across projects and any recent companion protect the affected units.

This boundary follows the official SDK's `delete_session`: its implementation removes the main transcript and sibling directory without rewriting global history or configuration. Official tests verify sibling cascade and removal from SDK session listing. AgentVac uses reversible archival rather than invoking that irreversible deletion API. [Pinned mutation implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/1ef6d8c71bb0e44a6b33fe61497864f21e17fdb7/src/claude_agent_sdk/_internal/session_mutations.py), [pinned deletion tests](https://github.com/anthropics/claude-agent-sdk-python/blob/1ef6d8c71bb0e44a6b33fe61497864f21e17fdb7/tests/test_session_mutations.py).

## Recognized companion layout

The adapter permits only these documented or source-tested members:

- Legacy direct `<subagent-UUID-v4>.jsonl` under the session sibling directory.
- `subagents/agent-<id>.jsonl` and adjacent `agent-<id>.meta.json`.
- The same subagent filenames under `subagents/workflows/<runId>/`.
- Direct `tool-results/<id>.txt`, `.png`, `.jpg`, `.jpeg`, `.gif` or `.webp` files.

The official SDK describes subagent paths, workflow nesting and metadata sidecars. Claude's MCP documentation describes spilled text and original PNG/JPEG/GIF/WebP images in `tool-results`. File bodies remain opaque; no prompt text or transcript schema is parsed. [Pinned subagent reader](https://github.com/anthropics/claude-agent-sdk-python/blob/1ef6d8c71bb0e44a6b33fe61497864f21e17fdb7/src/claude_agent_sdk/_internal/sessions.py), [MCP output storage](https://code.claude.com/docs/en/mcp#images-in-tool-results).

Unknown descendants, credential-like names, links, hardlinks, special files, cross-device trees, unreadable entries or a tree beyond the common engine's bounded inventory protect the entire unit. There is no partial cleanup of a rejected unit. Orphaned/superseded or unknown UUID-correlated sidecars protect that session. Legacy project indexes or unknown top-level JSONL/flat-subagent layouts protect the project because their relationships cannot be established from filenames alone.

## Discovery and provider identity

Default roots are `~/.claude` on macOS/Linux and `%USERPROFILE%\.claude` on Windows; `CLAUDE_CONFIG_DIR` selects another root. Discovery is pure candidate generation. AgentVac excludes relative paths, filesystem roots, home itself, control characters, Windows alternate streams and UNC shares; it does not scan other users' homes or WSL/network roots automatically. [Directory reference](https://code.claude.com/docs/en/claude-directory), [environment variables](https://code.claude.com/docs/en/env-vars).

Root identity requires a plain `projects` directory and at least one plain, single-link `history.jsonl`, `settings.json` or `.credentials.json`. These markers are never opened. A missing `debug` directory is valid. Symlink ancestors, unsafe markers, project-only `.claude` directories and conflicting Codex/Cline/Cursor identities are rejected. Unrecognized layouts fail closed even when the folder is named `.claude`.

`CLAUDE_CODE_DEBUG_LOGS_DIR` is an arbitrary output **file** override, despite its name. AgentVac neither follows that override nor scans `--debug-file` or `CLAUDE_CODE_TMPDIR` destinations. The documented standard debug target is the only log allowlist. [Environment-variable reference](https://code.claude.com/docs/en/env-vars).

## Activity protection and recovery

Nonempty or unsafe `sessions/` runtime markers and `daemon.lock` protect all debug and session data. Nonempty or unsafe `jobs/` protects session units because background-session dependencies have not been decoded. Old marker timestamps are never taken as proof that a session stopped. Metadata inventories are bounded; an incomplete inventory fails closed. Background services can survive the terminal, so all related services must be stopped. [Runtime/application data](https://code.claude.com/docs/en/claude-directory#application-data), [background-session lifecycle](https://code.claude.com/docs/en/agent-view#the-supervisor-process).

Native Claude, Desktop helpers, official SDK/npm entrypoints and known extension entrypoints block mutation. Missing/incomplete/malformed snapshots and unattributable generic runtimes remain unknown and block mutation. Complete, attributed unrelated runtimes do not blanket-block cleanup. Command matching ignores strings passed as later application arguments. Custom embeddings are not exhaustively identifiable from process command lines; the user must still confirm CLI, IDE, SDK and background work have exited.

The shared engine revalidates root identity, every member, optional absence and the complete tree before moving anything. Quarantine uses a same-volume, signed provider-bound journal. The transcript is removed first; restoration checks every destination and restores companions before exposing the transcript. A two-sibling operation is **not one atomic filesystem rename**. Durable intent and interrupted-operation recovery are required; ordinary failures must roll back safely or remain clearly marked for recovery. Restoration never overwrites a replacement file/directory or merges into an unrelated destination.

## Explicitly preserved and unsupported data

- Global prompt recall (`history.jsonl`), settings, credentials, project memory, plugins, skills and user instructions stay unchanged.
- External checkpoints, task lists, plans, uploads, caches and databases stay unchanged. No SQLite writes, checkpoint commands or VACUUM.
- Archived conversations cannot resume until restored. Prompt recall can still retain their text because global history is intentionally independent of this archive operation.
- This is SDK-compatible **local transcript archival**. It does not claim to remove Desktop/Cowork/cloud session-list records or reproduce those products' retention rules. Those surfaces keep separate lists; origin is not guessed from transcript contents. [CLI session scope](https://code.claude.com/docs/en/sessions).
- Unknown storage versions are not reverse-engineered from arbitrary data. The adapter recognizes the audited path layout and rejects unfamiliar dependencies; it makes no universal installed-version compatibility claim.

Authentication data is never parsed or changed. macOS normally uses Keychain, with a `.credentials.json` fallback; Linux/Windows use that file under the configuration root. [Credential storage](https://code.claude.com/docs/en/authentication#credential-management).

## Verification boundary

Generated Linux fixtures exercise three-platform path discovery, wrong/mixed roots, missing directories, metadata-only scanning, safe log roundtrips, newest/recent/active protection, complete multi-file session roundtrips across engine restart, unchanged global history/memory, optional-absence invalidation, restore conflict preflight, unknown companion rejection, links/hardlinks and runtime false-positive regressions. Fault-injection regressions also cover ordinary companion-move failure.

Native macOS/Windows execution and real installed Claude/SDK resume behavior have not been tested. No real home data, accounts, API keys, paid calls or public v0.1.0 artifacts were touched. Aggregate multi-provider and recovery checks must pass before release. The release record is [SDK v0.2.163](https://github.com/anthropics/claude-agent-sdk-python/releases/tag/v0.2.163); the general CLI release source is the [official changelog](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md).

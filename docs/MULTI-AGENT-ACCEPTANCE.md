# Four-provider implementation and acceptance gates

Development work, not a completed-adapter or release declaration. The public 0.1.0 release is unchanged. Tests in this tree use synthetic data. A directory appearing in discovery does not constitute cleanup support.

## Capability matrix

| Capability                                        | Codex                                                                                    | Claude Code                                                                                       | Cline                                                                                                                                      | Cursor                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Explicit provider selection / root binding        | Implemented                                                                              | Implemented                                                                                       | Implemented                                                                                                                                | Implemented                                                                                     |
| Default/override discovery                        | Existing Codex home + SQLite locations                                                   | Three-OS default; CLAUDE_CONFIG_DIR                                                               | Shared data + supported VS Code extension locations                                                                                        | Three-OS standard IDE app data                                                                  |
| Read-only unknown/config/credential protection    | Retained                                                                                 | Implemented                                                                                       | Implemented                                                                                                                                | Implemented                                                                                     |
| Log scan → preview → quarantine → restart restore | Existing rotation policy retained                                                        | Standard UUID debug logs, latest/active protected                                                 | Older SDK per-session hooks telemetry, latest/activity protected                                                                           | Exact dated main/renderer logs, newest protected                                                |
| Meaningful session/task lifecycle                 | New JSONL moves disabled pending native dependency policy; signedv1/v2 recovery retained | Implemented, acceptance pending: source-pinned transcript + sibling contents as one coherent unit | Blocked pending a safe consistency model: legacy task JSON index and current SDK DB/Git references are not safely removable as raw folders | Chat/state databases protected; no native chat-deletion claim                                   |
| Regenerable cache cleanup                         | Unverified cache candidates remain protected                                             | No unsupported cache claim                                                                        | Implemented, acceptance pending: current derived FTS cache bundle and checkpoint scratch; exact legacy public model catalogs               | Implemented, acceptance pending: whole recognized Cache, Code Cache, GPUCache, CachedData units |
| Read-only diagnostics                             | Existing bounded SQLite/log observations and isolated deep check                         | Metadata totals; no unknown DB parser                                                             | Metadata totals; no index DB mutation                                                                                                      | Metadata totals; chat/state DB content opaque                                                   |
| Provider-bound history and legacy compatibility   | v1 + v2 supported                                                                        | v2 file / v3 unit signed provider                                                                 | v2 file / v3 unit signed provider                                                                                                          | v2 file / v3 unit signed provider                                                               |
| Native target-runtime acceptance                  | Not rerun for expanded branch                                                            | Pending                                                                                           | Pending                                                                                                                                    | Pending                                                                                         |

## Shared acceptance gates

1. Root discovery emits suggestions only. Explicit activation validates layout, all ancestor paths, and filesystem identity; no automatic scan of installations, profiles, projects or credentials.
2. Changing provider/root clears selection, scans, diagnostic results and preview tokens. Old engine handles become invalid. Context changes cannot interleave with an admitted file operation.
3. Preview identifies provider and root, exact item list, underlying file/directory counts and full-unit behavior. Unknown or incomplete process attribution blocks mutation; the user's exit acknowledgement is additionally required.
4. Units contain only source-backed eligible members. No symlinks, hardlinks, special files, cross-volume members, unknown companions or unrecognized schema. Bounds/depth exhaustion never become a complete safe result.
5. A directory is moved as one same-volume unit. Multi-sibling session bundles are a journaled transaction, not a claim of one OS-atomic rename. Recovery exposes and resolves interruption; no silent partial completion.
6. Restore checks every member destination before any move, never overwrites replacements and validates signed policy/provider/root attribution. Restart and conflict-removal retry preserve all bytes.
7. Legacy Codex v1 journals still authenticate and restore using original root/provider. A foreign provider cannot reinterpret those journals. Provider badges and recent-directory activation guide users back to the original root.
8. Trash is optional, explicitly confirmed and uses the system Trash only; no permanent-deletion fallback.
9. Credentials, configuration, active state and unknown databases remain protected. The exact source-proven disposable Cline session-search.db plus its sidecars is an opaque cache unit; canonical sessions.db is untouched. No production SQL writes, VACUUM, arbitrary database deletion or undeclared shared-index rewrite is part of a general file/cache unit.
10. UI keeps Chinese labels, approved light/dark/system themes, compact-window behavior, keyboard/focus and accessibility. Zero eligible items states the supported scope honestly.

## Provider-specific consistency work

### Claude Code

The official Python SDK's pinned delete operation defines a useful session unit: projects/<project>/<UUID>.jsonl plus optional projects/<project>/<UUID>/, leaving unrelated history/configuration untouched. Implementation must follow the pinned supported layout, preserve the latest session and runtime-active records, reject unknown sibling structures, and restore siblings before the root transcript. It is a local SDK-compatible transcript archive, not a claim to clear every Desktop/Cowork surface.

### Cline

A raw task folder is insufficient when Cline lists history from an external JSON index or SQLite DB. The reviewed legacy-index capture/replace plan is **not implemented**: it has a missing-index race against an upstream writer, uncertain applicability to current installations, and would refuse restore after ordinary subsequent use. Research continues into current-version regenerable caches, coherent whole-store backup/archive semantics and vendor-supported cooperative operations. AgentVac does not pretend its own lock controls Cline. Modern SDK SQL/index/checkpoint references remain protected. Exact source-backed public model-catalog caches may be reversible cleanup units with an offline-model-list warning; this does not by itself complete useful task lifecycle adaptation.

### Cursor

Official support identifies four regenerable cache folders. Whole-folder policies must identify supported cache layouts and reject unknown or experimental SQLite-backed variants. Chat/globalStorage/workspaceStorage/state.vscdb remains protected from cleanup; separately consented conversation reading is documented in CONVERSATION-MANAGEMENT.md. Network/auth state stays protected. Cache reset may require recompilation or downloading cached content; show this consequence before quarantine.

## Evidence rules

- Fixture roundtrips establish filesystem behavior and supported shape handling, not vendor-runtime compatibility.
- Record the exact production source revision/snapshot for each aggregate and GUI run. Retest after integrated changes.
- Do not reuse historical cross-platform native passes as evidence for this branch.
- No publication, remote branch/push, paid CI or release is authorized by this development phase.

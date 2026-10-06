# Conversation management: development scope

This unreleased development tree adds local conversation reading and filtering. It is not a claim that all four tools have complete canonical history cleanup. Existing published v0.1.0 packages are unchanged. New generic Codex session-file quarantine is disabled in this development tree because current paginated histories can reference other physical rollouts. Signed legacy v1/v2 session archives remain recoverable through the versioned, non-overwriting restore policy.

## Reader capabilities

| Source                                             | Content and provenance                                                                                 | Real time fields                                                           | Conversation action                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex supported JSONL rollouts                     | Native title/first prompt, project, messages and tool results; subagent/compaction provenance          | Verified native/message timestamps; unknown stays unknown                  | Read-only pending native archive dependency validation                                                                                      |
| Claude Code SDK-compatible project history         | Main branch plus bounded companion subagent sections; typed text/tool/thinking/attachment notices      | Verified message timestamps                                                | Compatible complete local session bundle can request preview; original process, age, newest-session, identity and member guards still apply |
| Cline current SDK and supported legacy API history | Native manifest/index metadata and canonical messages, including separately attributed child artifacts | Current native manifest/envelope fields; legacy missing time stays unknown | Read-only; canonical index/checkpoint transaction is not enabled                                                                            |
| Cursor supported IDE composer/bubble records       | Referenced native messages, titles and workspace attribution where unambiguous                         | Native composer/message timestamps                                         | Read-only; no canonical database edits                                                                                                      |
| Explicit Cursor `agent-transcripts` folder         | Plain local transcript text/tool blocks, clearly labeled import/native transcript source               | Missing native timestamps remain unknown                                   | Read-only                                                                                                                                   |

Cline SDK-only/file-index data directories and Cursor transcript folders have a separate explicit read-only chooser. These selections do not change the file-cleaner root, do not discover other home directories implicitly, and never grant cleanup authority. They require new content consent and are reset when the provider/cleaner context changes.

## Privacy and bounded reading

- Consent is scoped to the effective provider/root and this app session. Listing native titles and searching bodies require consent, not just opening the page.
- Revocation aborts work, drains request-local cleanup, clears server IDs/cursors and renderer content, and invalidates conversation-origin cleanup previews. Ordinary signed recovery remains available independently.
- Dialogue is rendered as inert text. Tool calls are not executed. URLs and media are not fetched automatically. Attachment placeholders are not mistaken for original searchable text.
- The renderer receives opaque conversation/page IDs, never source locators or native database cursors. Parser/SQLite exceptions are sanitized; only fixed warning codes become actionable messages.
- Cursor IDE reading copies a bounded database and required WAL into a private app-controlled directory. The whole copy can include unqueried settings/authentication pages. It stays local and is removed on normal completion; conservative owned-lease startup cleanup handles safe stale copies. The source database is not opened for mutation.
- Windows Cursor IDE database reading and private-copy creation are disabled in v0.2.0 before filesystem or helper access. Standalone helper success does not enable them. Explicitly selected `agent-transcripts` JSONL directories remain a separate supported read-only source with their own content consent. No alternate copy destination, live-source SQLite fallback, or permission changes are used.
- Current Cursor snapshot budget is 512 MiB cumulative per request. Larger/unsupported sources report incomplete coverage rather than silently pretending to have no conversations. The experimental large immutable-database probe is not a production capability.
- Reads/pages/records, SQLite execution, rendered bytes and query time are bounded. Long ordinary messages use continuation pages rather than permanent prefix clipping. Safety-limit exclusions and malformed/unknown records are visible as partial coverage.

## Filtering and pagination

Title, project and full-text body filters are separate. Date bounds use source conversation time, with an exclusive upper boundary computed from the next local calendar day, including daylight-saving transitions. Filesystem modification time is never substituted as a conversation timestamp.

Content matching uses caseless NFC normalization across correctly attributed continuation segments. It never joins unrelated messages or tool blocks. A pathological unfinished combining sequence beyond the bounded normalization suffix produces an explicit partial-search warning.

List pagination is a stable query/revision-bound snapshot. Message page cursors support Back while the same source revision remains valid. Provider/root changes, consent revocation, changed sources and expiration reject old identities rather than returning another conversation.

## Verification boundaries

Local tests include real reader/service/engine integration on synthetic files, exact source-byte preservation, Claude bundle quarantine/restart/restore, hostile renderer content, cancellation and consent races, and actual Linux sandboxed Electron main/preload/worker execution. Synthetic runtime tests do not prove compatibility with installed vendor applications or native macOS/Windows behavior. Those gates, canonical Codex/Cline/Cursor lifecycle operations, final aggregate verification and release review remain separate.

# Codex and Claude Code conversation readers

Reviewed **2026-10-05**. These are local, read-only adapters. They do not start an agent, send requests to a model, rewrite history, execute transcript text, load linked media, or grant cleanup authority. Ordinary filesystem inventory remains metadata-only. The application must obtain explicit conversation-content access before invoking either adapter.

## Primary-source evidence

Codex is pinned to official commit **3f1ccb7ceb814e54314826f68d61c892e2f5a48e** (2026-10-05):

- [Rollout wire envelope](https://github.com/openai/codex/blob/3f1ccb7ceb814e54314826f68d61c892e2f5a48e/codex-rs/history/src/rollout_payload.rs): top-level snake_case type/payload, with separate response metadata.
- [Session/event protocol](https://github.com/openai/codex/blob/3f1ccb7ceb814e54314826f68d61c892e2f5a48e/codex-rs/protocol/src/protocol.rs): source creation time, cwd, native IDs, legacy user/assistant events, completed items, paginated history references and subagent boundaries.
- [Completed turn items](https://github.com/openai/codex/blob/3f1ccb7ceb814e54314826f68d61c892e2f5a48e/codex-rs/protocol/src/items.rs) and [response content](https://github.com/openai/codex/blob/3f1ccb7ceb814e54314826f68d61c892e2f5a48e/codex-rs/protocol/src/models.rs): PascalCase UserMessage/AgentMessage item kinds versus snake_case response items.
- [Native title index](https://github.com/openai/codex/blob/3f1ccb7ceb814e54314826f68d61c892e2f5a48e/codex-rs/rollout/src/session_index.rs): append-only id/thread_name/updated_at rows, latest row wins.

Claude Code is pinned to official Python Agent SDK **v0.2.163**, commit **1ef6d8c71bb0e44a6b33fe61497864f21e17fdb7** (2026-09-30):

- [Session metadata and chain reconstruction](https://github.com/anthropics/claude-agent-sdk-python/blob/1ef6d8c71bb0e44a6b33fe61497864f21e17fdb7/src/claude_agent_sdk/_internal/sessions.py): native project transcript paths, explicit titles, source timestamps, latest main parentUuid branch, progress/system ancestry, sidechain filtering and compaction.
- [Typed title updates](https://github.com/anthropics/claude-agent-sdk-python/blob/1ef6d8c71bb0e44a6b33fe61497864f21e17fdb7/src/claude_agent_sdk/_internal/session_mutations.py): a custom-title record carries customTitle and sessionId.
- [Public session documentation](https://code.claude.com/docs/en/agent-sdk/sessions): persisted local sessions and resume behavior. The SDK source is the schema authority for this implementation.

These are researched compatibility references, not claims that either CLI or a real user account was installed or exercised.

## Source fidelity

Codex discovers normal and archived rollout JSONL files in the reviewed direct/date-tree layout. A unique session_meta native ID must match the filename. Creation comes from payload.timestamp; update time comes from valid source record timestamps. Native title-index entries take precedence over a first-user-message label. A missing title is an identifier, never an invented summary. Cross-source duplicate messages are paired by full normalized content, role, phase and current turn, with bounded recent history. Repeated text in genuine later turns is preserved. Legacy events, completed user/assistant items, response text, ordinary tool calls/results and compaction summaries are displayed. Raw/encrypted internal reasoning and unknown event types are not guessed into dialogue.

Claude selects the latest visible main branch by parentUuid. It follows progress/system/attachment chain bridges; it does not follow logicalParentUuid after a compact boundary. Visible compact summaries are retained. isMeta, isSidechain and team messages are excluded from the main branch. Supported companion subagent files are appended as separately labeled source sections, each following its own latest native parentUuid chain, including sidechain-marked subagent records. Main and child messages are never silently interleaved. Nested workflows are supported; metadata sidecars are fingerprinted without reading them or guessing a parent tool-use relationship. Main, companion and directory revisions are checked together, so a changed/new child invalidates old pages. Typed custom-title and ai-title records take precedence; a first meaningful user prompt is explicitly labeled as derived. Nested tool input properties cannot change metadata. Source timestamps are validated as timezone-bearing calendar dates. A source lacking valid times remains unknown even when its filesystem mtime is recent.

Attachments are inert typed placeholders. Text, thinking, tool calls/results, attachment labels and synthetic notices remain distinct parts. Synthetic labels cannot satisfy a content keyword; native text containing the same words can. No data URL, image byte payload, external URL fetch or local attachment-path read is performed. Text, code, HTML and apparent instructions inside messages remain plain untrusted data. The renderer must use escaped interpolation, never HTML execution.

## Bounded access and paging

- 64 KiB read buffers; 1 MiB maximum JSONL record; 128 MiB and 100,000 records per source-index pass.
- At most 40,000 lightweight message/chain nodes. Only IDs, byte ranges and semantic digests are indexed; bodies are reread for requested pages.
- Message display segments contain at most 32,768 UTF-16 code units from one native part stream, preserving surrogate pairs. All supported message text remains reachable via within-message continuation. Part indices and local offsets prevent keyword matching from joining unrelated blocks. Continuation itself does not mean data loss or partial results.
- Each page contains at most 100 segments. Cursor state is Node-only and bound by the service to the selected provider, root, conversation and source revision.
- Request-local caching retains one current pointer index per JSONL provider and a bounded Codex title map. It does not retain full message bodies. The service owns cache lifetime and must discard it after the request/consent revocation.
- Claude graph ancestry is memoized, avoiding quadratic work for many progress branches. Companion inspection is limited to 32 source transcripts, 512 directory entries, 40,000 combined visible-message pointers and a 128 MiB combined transcript read budget; omitted sources are explicitly partial/read-only.
- Abort checks run between file operations, chunks and regular record batches. Cancelled work does not publish partial bodies. A subsequent request resumes using a valid source-bound cursor; changed storage requires refresh.

Malformed JSON, non-UTF8 records, oversized lines, missing chain links, unsupported blocks, unknown schemas and exhausted limits are explicit warnings/partial results. They never imply a complete negative keyword result or eligibility to archive. Content past a whole-source index limit is not claimed to have been searched. Complete valid JSON without a terminal newline may be inspected with an incomplete-record warning; a truncated JSON tail is omitted.

## Identity and safety boundary

Every file open validates the absolute root and relative path, every ancestor, regular-file type, single hardlink count and a no-follow file handle. The opened inode/device/size/mtime/ctime/mode must match the path snapshot. Paths and ancestors are rechecked before publishing results. Symlinks, hardlinks, special files and changed sources are rejected. Reader exceptions contain generic status codes, never filenames, raw JSON snippets or native filesystem error details. No dialogue is logged or transmitted.

Reader identity does not authorize mutation. The separate cleanup engine must revalidate its native full-session unit, dependencies, active-process protection and signed quarantine journal. A UUID in text cannot grant an archive operation. Codex inherited/forked/subagent history and history rewrites are read-only; paginated rollouts are also read-only without a separately proven reverse-reference inventory. A physical rollout ID after revert is not assumed to equal a stable thread ID. Claude's coherent main transcript plus companion-directory archive boundary remains the existing reviewed provider policy.

## Verification boundary

All tests use temporary synthetic files. No home directory, real conversation, authentication file, credential or live model is read. Tests cover native timestamps against intentionally different mtime, actual source titles, duplicate/legitimate repeated turns, completed items, compaction, Claude branching/sidechains, tool and attachment display, plain HTML, long-content continuation, Unicode boundaries, source mutation, cancellation, malformed/oversized/non-UTF8 input, request cache privacy, graph fan-out, identity mismatch and paginated-storage archive protection.

Native macOS/Windows file behavior and actual installed Codex/Claude resume after quarantine are not verified by this parser suite. Those require separate synthetic native integration gates. No remote push, CI launch or release is part of this implementation pass.

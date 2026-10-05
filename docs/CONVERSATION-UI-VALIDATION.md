# Conversation workspace validation

This document covers the conversation renderer implementation on 2026-10-05. It does not declare complete native mutation support or release readiness.

## Implemented

- Existing AgentVac light/dark style retained; a dedicated conversation navigation destination added.
- Explicit, revocable local-content consent bound to the selected provider and root; Cursor database-copy scope disclosed separately. Backend-unavailable readers cannot obtain misleading consent.
- Separate title, full-message-content, project, native-time, unknown-time, and sort controls. Calendar ranges use local midnight and exclusive next-day boundaries, including DST.
- Bounded virtual result rows, 20-conversation result pages and selection limit, cross-page selection disclosure, and backend-only archive eligibility.
- Twelve-record message pages; complete delivered text remains reachable through bounded text and content-part continuation. Source/continuation labels, actual timestamps and their provenance, code, tools, and inert attachment descriptions are retained.
- No conversation HTML injection, automatic link execution, or external image fetches.
- Existing verified-preview and quarantine/recovery modal workflow reused. Cancelling a preview makes no mutation. Conversation mutations refresh this workspace instead of silently initiating a file scan.
- Cancellation, out-of-scope reply rejection, stale filters, old list rows, failed detail cursor recovery, provider changes, partial results, empty states, backend errors, and fail-closed consent revocation handled explicitly.

## Verified layers

1. `node --import tsx --test tests/conversation-renderer.test.ts`: 11 passing unit checks. Includes hostile text, Unicode chunk boundaries, bounded list/message DOM inputs, DST 23-hour and 25-hour days, and explicit unknown timestamps.
2. `node scripts/conversation-ui-regression.mjs`: 20 passing production-renderer checks using explicitly synthetic API-contract fixtures. Seven selected axe audit states have zero violations: consent plus light/dark at 1200×850, 1024×768, and 900×640. No runtime errors, external requests, or page-wide horizontal overflow. This fixture layer tests renderer behavior, not backend correctness.
3. `node --import tsx scripts/conversation-real-ui-regression.mjs`: 24 passing checks using the production renderer, real ConversationServices, all four real readers, real engine root verification, and synthetic native-format sources. Last-message search and paging, previously visited cursors, refreshing an open detail, native dates despite conflicting file mtimes, and unchanged source hashes are verified. Transport is an explicit Playwright bridge, not Electron IPC.
4. `npm run typecheck`: passed for the current implementation. Native Electron IPC and provider mutation acceptance are separate integration gates owned by the main integration suite.

Machine-readable results and screenshots are in `docs/conversation-ui/`.

## Substantive corrections during review

- Removed permanent UI text/part clipping and replaced it with bounded continuation.
- Replaced end-of-day millisecond boundaries with DST-safe next-local-day exclusive boundaries.
- Preserved surrogate pairs at long-text chunk edges.
- Aligned UUID request IDs and the 20-item selection ceiling with backend contracts.
- Preserved the conversation destination when switching providers.
- Fixed low-contrast small text in the light theme; audited settled theme states after transitions.
- Rejected mismatched scope/consent results and made failed or cancelled results visibly stale.
- Real-reader testing exposed a registered-object cursor identity race. Integration fixed stable source identity; the UI also blocks old-row interaction during pending queries and offers recovery after detail failures.
- Made local revocation immediate and fail-closed even when its IPC acknowledgement fails.

These are behavior changes and review findings, not padded application versions. Formatting and synthetic-fixture corrections are not counted as product iterations.

## Remaining boundaries

- Alternate read-only source chooser UI (Cline SDK/file-index roots and Cursor transcript folders) is a subsequent scoped integration. Current UI still binds to the existing selected provider root.
- Archive buttons reflect backend authority. An unsupported provider or source remains read-only; the renderer never upgrades that authority.
- The synthetic contract test demonstrates confirmation/cancel behavior, not native mutation success. Native process, index coherence, restore, platform ACL, and cross-platform release gates require their separate evidence.
- Automated accessibility checks do not establish full assistive-technology or WCAG conformance.

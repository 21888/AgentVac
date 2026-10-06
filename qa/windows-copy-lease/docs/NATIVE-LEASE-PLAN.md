# Exact-source generated Windows lease probe

Status: planned, changed Win32 helper NOT_RUN. Independent source/protocol/runner review is required before any hosted run. Root owns publication, workflow trigger and manual restoration. No app import or activation.

Use one standard public windows-2022 runner, contents:read, no dependency install, cache, artifact upload, release or permission changes. Compile the exact pinned source with the Microsoft-signed compiler and expected Windows SDK10.0.26100.0. Preserve compiler/source/binary hashes and require source hashes unchanged around every compile. The baseline18-case metadata receipt is separate; it does not validate this lease binary.

## Build and local tests

Run scripts/build-lease-windows.ps1 with explicit absolute Microsoft compiler, x64 architecture, exact SDK and reviewed source-tree pin. Run the generated core, inherited-policy and lease-core executables plus the36 Node lease unit cases. Windows unit fixtures close their own descriptors but are left for runner disposal. No old baseline build script is the lease build.

## Native runner

Run scripts/native-lease.mjs with the exact source-tree pin and SDK. It rechecks all pinned sources, build receipt, binary hashes, ordinary build ancestors and local generated scope. It uses the same separately compiled initial-SD fixture constructor. The helper never writes target content. Node creates new empty destinations exclusively, compares its held descriptor to the read-only lease result and copies only generated sentinels.

The14 named native cases are:
1. Exact held NTFS destination copy: final size/hash/readback and source preservation.
2. Unrelated generated sibling creation/write remains usable while leased.
3–5. Leaf, generated private parent and generated scope renames are refused while handles are retained.
6–8. Broad initial ACL, nonempty file and hardlinked file refuse before sentinel copy.
9. Observed helper exit after READY blocks the first copy write.
10. Cancellation after the first completed native write preserves the partial generated fixture. This is not a kernel-stalled pending-write test.
11–12. Duplicate and stale nonce-bound controls fail; no sentinel bytes are copied.
13. A separate ordinary DELETE-access actor holds the new empty file; the lease must return its exact sharing-conflict witness while that actor is live, then succeed after the actor closes. The actor never deletes, renames, changes ACLs or writes file content.
14. The30-second native watchdog closes its handles; the empty fixture can then be renamed within its generated directory.

No raw paths, SIDs, arguments or source contents enter the report. It emits fixed codes, exact source/build/runtime hashes and per-case status. Successful runner exit is only PARTIAL_GENERATED_LEASE_PASS, with productionAccepted:false and privateCopyActivated:false. Missing native capability is BLOCKED, not a passing negative. Any unconfirmed child teardown halts subsequent admission.

## Explicit outstanding cases

Existing enabled backup/restore privileges, different-user/impersonated peers, reparse creation, parent exit with duplicated endpoint, ACL-change races, real kernel-pending-write stalls, SQLite WAL/SHM behavior, arbitrary app-path containment and full Electron runtime integration are not established by this stage. Existing ACL mutation and privilege/security changes remain unauthorized. Do not use a passing generated-copy probe to enable the application.

The helper retains ancestors without WRITE/DELETE sharing and the final file without DELETE sharing while allowing the existing Node writer. This is a finite OS handle lease; its effects on generated sibling writes are tested explicitly. Liveness checks do not atomically prevent helper death. The host retains pending writes through settlement, records known successful bytes, and preserves an error-uncertain extent rather than claiming nothing was written.

Leave all generated Windows fixtures for the disposable runner. Do not delete paths after releasing the containment handles, repair existing ACLs, or touch provider data.

## Corrections required by independent review

This is the separate AVL2/AVR2/AVC2 revision. It does not use the reviewed-and-rejected7bbc transport/oracles. Process exit revokes liveness immediately, while admission persists to close; a clean exit may drain only valid buffered terminal/refusal diagnostics, never revive READY. Typed shape/sharing reasons and complete nonce-bound refusal evidence are required for negative PASS. Metadata/ACL-query failure is preserved as unavailable. Invalid controls must produce an actual invalid-request refusal; a clean exit or a dead lease alone is insufficient. Exact byte magic rejects high-bit aliases.

The separate DELETE actor uses AVD2 and exposes no containment-ready capability. It shares the same two-child ownership pool with the lease. Its binary is compiled/hashed separately and may target only the same newly generated empty fixture scope.

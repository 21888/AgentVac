# Exact revised Windows fixture plan

Status: revised helper/context/constructor Windows compilation and execution are NOT_RUN. Earlier d999 build/protocol success does not cover this changed helper. Root must review the new source/binary hashes before any probe; root owns remote workflows. App/private-copy enablement remains separately blocked.

## Portable checks already staged

Run `bash scripts/test-inherited-linux.sh`. This includes the unchanged 26,040 ACL comparisons against the exact original TypeScript policy, existing canonical-path/protocol checks, inherited-context positive/negative tests and bounded parser/evidence fuzzing. Already-elevated ordinary-rights and authorized same-user session-zero contexts pass the pure context predicate. Enabled backup or restore in either token, service/virtual identities, system-level integrity, impersonation, ambiguous/changing queries and caller mismatches fail closed. These are portable test observations, not fabricated native token states.

## Source-only reviewed Windows build

The proposed manual workflow is `proposals/windows-inherited-profile.yml`. It uses a preinstalled Microsoft toolchain and Node, no installer/npm/credential setup. The build entry is `scripts/build-inherited-windows.ps1`; the test entry is `scripts/native-inherited.mjs` with the exact source-tree hash from `results/source-manifest.json`. Include `.gitattributes` so checkout preserves source bytes. The root may copy this source-only tree into a separately reviewed repository subdirectory and adapt workflow paths without altering the source pin's inputs.

Build helper and constructor independently using /MT, asInvoker, CFG/NX/ASLR and system-only dependency loading. Record source-tree hash, each executable hash, compiler version/hash, SDK, architecture, Node/libuv and OS. A constructor compilation failure stays unavailable and never runs a stale executable. The ordinary helper malformed-protocol lane can still produce honest evidence.

## Positive and negative generated objects

Only after OS-pipe caller binding succeeds does the constructor create a unique `inherited-fixture-<32hex>` scope beside the reviewed build binaries. Initial protected security descriptors are supplied at exclusive creation. No existing ACL is changed.

The five new objects are:
1. Private scope directory
2. Private child directory
3. Private zero-byte ordinary file
4. Broad-ACL child directory
5. Broad-ACL zero-byte ordinary file

The private DACL contains current user, System and Administrators only, with normalized full-control masks; directory entries have both inheritance bits and no propagation flags. The broad variant additionally grants Everyone normalized read access. All have explicit current-user owner and are checked by the constructor through opened metadata handles. The exact read-only helper must independently approve private fixtures and reject broad fixtures. Initial test permissions never touch a profile, public root, provider store or other preexisting object.

The native runner requires:
- Correct AVH2 handshake while the actual pipe peer remains connected
- Exact revised helper accepts the private directory/file and rejects broad directory/file
- Locality success for the private directory, permitted missing final leaf, rejected missing intermediate
- Supplied wrong PID rejects against actual pipe-server identity, with no PID-only fallback
- Outside scope and prefix lookalike reject before any target filesystem query
- Native identity matches Node's held, zero-byte, one-link file observation
- Malformed version/fields/UTF-8/size/truncation reject; watchdog and cancellation terminate
- Constructor's inherited-elevated diagnostic is explicitly labeled fixtureConstructorInheritedElevated. It describes that constructor token, not a separate observation of the helper's elevation bit. The helper still queries its own token and applies the reviewed inherited-context gate

This creation-only lane performs no automatic pathname deletion after construction. Generated objects are left for disposal of the authorized ephemeral runner. Partial create/verify failure can leave a subset of empty generated fixtures without a disclosed suffix; the runner reports that possibility and never searches/deletes broadly or repairs permissions. The disposable VM can be discarded by its authorized owner. The CreateDirectory-to-open gap is not claimed to resist a hostile same-principal/admin actor.

## Enabled backup/restore and other native negatives

Do not enable a privilege to manufacture a negative case. On this standard smoke host, already-enabled SeBackup/SeRestore, changed caller identity, thread impersonation, service identity, syscall traces and adversarial races may be unavailable. They remain listed as unavailable native cases, even though the pure policy negatives pass.

For a separately authorized environment that **already** has either privilege enabled, run the exact source-built helper through the same authenticated pipe and generated-target contract; expect context-rejected before target I/O and verify that no privilege state was changed. No new token adjustment/impersonation harness is supplied here. If the constructor itself correctly refuses that context, fixture creation must remain blocked; do not bypass its shared gate or substitute another caller PID. A subsequent negative-test harness would need its own narrowly reviewed setup/observation design.

Do not call the full acceptance complete until required native negative/race/tracing gates actually run on the exact helper. `PARTIAL_INHERITED_FIXTURE_PASS` deliberately means only the available generated fixtures passed; it is not ordinary-installation, general service-context or private-copy acceptance.

## Provenance and abnormal process teardown

The build receives the reviewed source-tree hash and SDK version before compilation. It hashes the complete listed source set before the first compiler call, rejects a mismatched pin, and compares every source hash after each compilation. The runner requires the same source pin, expected x64 architecture, exact SDK version and pre/post-match receipt. This detects source drift across the build; it is not an immutable snapshot against a hostile actor who changes and restores bytes between checks.

Every abnormal subprocess path requests termination and waits for close. If closure is not established within the teardown bound, the lane stops with teardown-unconfirmed and makes no further probe or constructor calls. No path-based automatic cleanup is attempted. The native helper treats only ERROR_BROKEN_PIPE as terminal input EOF; a successful zero-byte pipe read keeps waiting. A real native null-write then trailing-data test is an additional required acceptance case, not simulated by assuming Node sends zero-length writes to Windows.

The lifetime of a duplicated named-pipe endpoint after its original creator exits, including PID reuse before OpenProcess acquisition, remains an unproven native race. It must not be described as resolved solely by retaining the later process handle.

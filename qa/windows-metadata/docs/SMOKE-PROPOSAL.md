# Minimal source-only windows-2022 smoke proposal

This lane is separate from the pre-provisioned all-fixture suite. It creates ordinary inherited-permission synthetic directories and one empty file in its own build directory, requests only metadata, then removes only those exact newly generated empty objects. It makes no ACL/owner/reparse/drive/account/UAC changes, installs nothing, reads no provider data, and uploads no artifacts or release. Root owns any remote workflow or source publication.

Files:
- `proposals/windows-metadata-smoke.yml`: manual-only workflow proposal, expected source hash must be filled after final source review.
- `scripts/build-windows.ps1`: static-CRT helper, fixture-only restricted launcher and pure core test build; exact compiler/SDK/source/helper/launcher/generated-binding hashes recorded locally. The optional launcher compile status is recorded separately; a launcher failure never runs a stale binary or discards the helper/protocol evidence.
- `scripts/native-smoke.mjs`: source-pinned direct execution of the newly source-built helper in this disposable research checkout. It does not create a production installation receipt.
- `src/restricted-fixture-launcher.cpp`: fixture-only lower-privilege experiment, subject to its own strict token checks. See `RESTRICTED-LAUNCHER.md`.

The workflow expects this tree copied into the repository under `qa/windows-metadata/`. Include the staged `.gitattributes` file so Windows checkout preserves the reviewed bytes. Use only reviewed source files, scripts, docs and source manifest; do not copy Linux executables, a Windows executable, any actual fixture, raw logs, provider data or production receipt. Pin the exact reviewed repository commit before dispatch. `actions/checkout@v4` follows the existing repository's dependency choice; root may independently pin its reviewed commit. No setup-node step is needed: the proposal uses the image's preinstalled absolute Node executable and records its version/hash. If the installed Microsoft/Node path or SDK differs, stop and review the actual image instead of downloading or discovering arbitrary alternatives.

## Honest scope and outcomes

The direct lane tests malformed magic/mode/flags/UTF-8, oversize/truncated/trailing frames, native watchdog, cancellation with confirmed process exit, fixed-volume ancestor validation through the ordinary synthetic directory, missing final versus intermediate components, the generated directory’s inherited ACL and the Node-held empty-file identity comparison. Standalone volume-root and runner profile/public ACL targets are not inspected and are explicitly marked unavailable in this generated-fixture-only lane. The generated ACL result is an observation, not invented proof that a root is private. A rejected inherited fixture does not get its ACL changed to make the positive case pass. If private identity cannot be established, it remains BLOCKED.

The remaining ACL owner/deny/null/unknown cases, deliberate reparse points, network/SUBST mappings, security races, syscall traces, production installation trust and private-write containment remain explicitly unavailable. No absent fixture counts as passed. A complete smoke lane is still partial native evidence with `productionAccepted:false` and `applicationActivated:false`. The existing all-fixture/native acceptance gates remain unchanged.

## Hosted administrator constraint

GitHub documents hosted Windows machines as administrators with UAC disabled: [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). The unchanged metadata helper rejects an elevated token. Direct metadata cases therefore may report metadata-unavailable on windows-2022 even while build/protocol checks pass. The runner records the actual administrator-role observation separately; it does not falsely label this as a direct TokenElevation query.

A separate source-built launcher investigates a restricted copy of the existing token using documented token APIs, with no elevation and no persistent setting change. It must verify the newly created token and actual suspended child token before execution, including elevation, integrity and privileges. It may only target generated fixture paths and the same-directory hash-bound helper. An unsupported state/API/desktop/privilege requirement stays BLOCKED; no credentials, new users, UAC changes, privilege-enable fallback or helper policy relaxation is allowed. Any restricted-token result is labeled synthetic restricted-token evidence, never ordinary interactive-user installation acceptance.

## Prior snapshot

`snapshots/pre-native-smoke-source-manifest.json` preserves the previous reviewed source-tree digest `01b606a6aac88bdb6a39aa2aa5667b510460789e9225410034748b858b6394e0`. `snapshots/pre-native-smoke-all-files.sha256` preserves hashes of the then-existing non-build files. The helper and policy source are not changed by this smoke-lane addition; the build recipe changes to compile the separate fixture launcher.

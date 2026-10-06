# Proposed pre-write identity contract (requires approval and native proof)

**The staged helper does not authorize private destination writes. No application code has been changed.**

## What this implementation establishes

GetSecurityInfo and both identity queries use the same metadata handle. This prevents the basic mistake of checking the ACL of a path different from the object whose native identity is returned. FILE_ID_INFO's volume serial + 128-bit file ID can compare two open handles on the same computer. The helper also reports the legacy volume serial/file index, file size and hard-link count for research against Node's bigint fstat.

While Node keeps an already-open empty destination descriptor alive, its fstat dev/ino may correspond to the legacy Windows values. The read-only native runner checks that mapping against the actual Node version, never assuming it from JavaScript type names. This can demonstrate that both observations concerned the same live file, but does **not** make path/ACL checks atomic with the later write. Do not truncate 128-bit IDs to force a match, synthesize identity from paths or timestamps, or treat a successful ACL snapshot as an ongoing privacy lease.

## Contract to review before app integration

1. Independently establish trusted local/non-reparse helper packaging, exact reviewed binary/source hashes and target architecture. A hash of an executable opened through an unchecked path is not bootstrap proof.
2. Validate local, private parent directory with required inheritance. The caller owns a previously authorized private destination creation operation; this helper never creates or changes permissions. Create the final file exclusively as empty and keep that exact descriptor open. Do not open source conversation bytes yet.
3. Prefer a small, reviewed in-process native bridge that obtains the actual Windows HANDLE behind the live Node descriptor and queries FILE_ID_INFO + GetSecurityInfo on that same handle. A child alternative must duplicate a constrained metadata handle through a deliberately reviewed handle-transfer mechanism; do not accept a caller-supplied numeric HANDLE or unrestricted process-duplication endpoint. This transfer is deliberately not in version 1.
4. Bind the independently proven native-local path walk to that open handle via the full volume/file identity. Reject reparse, non-file, non-empty, multiple-hard-link, identity-changing, unavailable or malformed observations. Hold necessary ancestor/final guards during the entire write, or otherwise demonstrate a threat-model-appropriate race-free parent binding. Version 1 closes guards before it sends its result, so it does not fulfill this step.
5. Only after the binding, ACL, locality and parent-containment conditions hold may the caller read private source bytes and write through that already-open destination descriptor. Never reopen by pathname after validation. Revalidate on every operation, cancellation and retry; no boolean cache.
6. Recheck after write before publishing/renaming; handle any exception by the existing approved conservative cleanup path. An ACL can be changed by its owner or an administrator despite ordinary file-share restrictions; explicitly document that trust boundary instead of promising an immutable ACL.

## Why a path-only integration is blocked

A post-check path can be replaced after helper exit, parent directories can move after guards close, and ACL permissions can change without ordinary data-write sharing conflicts. A filename equality or file ID snapshot alone cannot prove containment/privacy for an ongoing copy. Final FILE_SHARE_WRITE is necessary to coexist with Node's writable empty descriptor but permits a different writer. Existing open descriptors, directory reparse mutation, and pre/post-creation replacement require actual native adversarial tests.

The minimal useful next stage is native execution of the existing read-only helper and identity comparison. After that, separately review a narrowly scoped descriptor bridge/lease protocol if needed. Do not silently modify the application now or turn off existing protections to obtain a positive test.

References: [FILE_ID_INFO comparison contract](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info), [GetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle), [GetSecurityInfo race limitation](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo).

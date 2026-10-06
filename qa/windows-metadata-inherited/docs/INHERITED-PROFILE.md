# Revised read-only inherited-context profile

## Why this is a policy refinement

An existing elevated token differs from asking Windows for more authority. The original TypeScript private-ACL predicate describes an object's owner/DACL; it does not reject an observation solely because the inspecting process was already an administrator. The previous native helper's blanket elevation refusal was an extra least-privilege gate.

This separately approved profile removes only that blanket refusal, with an explicit authenticated same-caller and capability policy. Elevation is observed as a Boolean diagnostic using the documented nonzero meaning of TOKEN_ELEVATION, never as proof of privacy. Owner/ACE allowlist, exact rights, inheritance, canonicality, fixed-local-drive, no-reparse traversal and same-handle ACL/identity predicates remain unchanged. There is no AccessDenied fallback, permission repair, group expansion or generic-rights normalization.

## Current-user and target authority

A caller-supplied PID alone has no authority. The helper first checks the actual stdin OS pipe with GetNamedPipeServerProcessId, requires equality to the bounded expected caller PID, then opens that exact live process with QUERY_LIMITED_INFORMATION | SYNCHRONIZE. Both primary tokens are queried read-only. Binary user SID, authentication ID, session and integrity must agree. Changing token IDs/ModifiedId, liveness changes, mismatches and ambiguous queries refuse. If the pipe API is unsupported, there is **no supplied-PID fallback**.

The helper's executing thread must have no impersonation token; any uncertain query refuses. A process PID cannot identify the caller thread or prove that every caller thread is free of impersonation. The exact trusted controller and authenticated primary-user relationship remain part of the scope. Handles retain identity; they do not freeze token state indefinitely or defeat a hostile same-user administrator.

Known primary Anonymous/IUSR/System/LocalService/NetworkService identities and the documented NT virtual/service account namespace with first RID 80–111 are excluded. System-or-higher integrity is excluded. Service-group membership, session zero and headless operation alone are not exclusions. This is not a claim that every remaining SID represents a human; it is an authenticated current-caller rule with explicit target authorization. See `INHERITED-CONTEXT.md` for exact classification.

Both tokens' already-enabled SeBackupPrivilege or SeRestorePrivilege cause refusal. They are never disabled or enabled. This addresses FILE_FLAG_BACKUP_SEMANTICS' documented privilege interaction instead of assuming elevation describes the privilege set. Other inherited privileges are not silently rewritten; trusted binaries, generated-only scope and no mutation/private-write authority remain essential.

## Generated-only scope

The helper derives its own module path. The module must be the fixed `agentvac-metadata-research.exe` in a `build/windows-x64` or `build/windows-arm64` directory. The request's scope must be exactly a sibling directory `inherited-fixture-` plus 32 lowercase hexadecimal characters. The target must be that scope or a descendant with a separator boundary. Reparse, drive-alias and missing-component rules still run natively for the actual target.

A matching name is not itself proof of safe bootstrap or constructor provenance. The reviewed research runner invokes the exact source-built hash, creates the scope through the separate constructor, and uses its bounded returned random suffix. A production executable-installation receipt or app scope is not created by this experiment. General app-owned roots need their own subsequent review.

## AVM2 request and AVH2 handshake

A request is a little-endian uint32 body length, then:
- Bytes 0–3: `AVM2`
- Byte 4: mode 0 locality, 1 ACL
- Byte 5: existing directory/missing flags; missing allowed only for directory-locality
- Bytes 6–7: zero
- Bytes 8–11: expected caller PID, nonzero uint32
- Bytes 12–15: UTF-8 byte length of scope
- Remaining bytes: scope followed by target UTF-8

Each path is independently limited to 16,384 UTF-8 bytes and 4,096 UTF-16 units, with the existing canonical-path/component restrictions. Total body limit is 32,784 bytes. PID and scope fields cannot select a different executable or bypass native peer checks.

The parent writes the full frame but **keeps stdin connected**. After successful parsing/scope/context binding, the helper emits exactly `AVH2` and then waits for EOF. The parent closes stdin only after receiving that acknowledgement. Extra input rejects before target metadata is queried. This avoids relying on pipe-owner queries after Node has closed its server endpoint. Any unsupported pipe identity observation remains unavailable. Libuv 1.51.0's source documents the parent server and child client endpoints, but actual Node/Windows compatibility is still a native acceptance gate.

A rejected request/context/scope may return its final failure directly without an acknowledgement. The final helper frame stays exactly 68 bytes, using the existing 64-byte metadata body with magic `AVM2`. Existing outcome codes 0–7 retain their meaning; 8 is context-rejected, 9 caller-rejected, 10 scope-rejected. Failure identity fields remain zero. Full acknowledged exchange is at most 72 stdout bytes. An acknowledgement is not metadata approval.

The constructor uses AVF1/AVC1 plus the same AVH2 handshake; see its separate document. It alone creates the newly authorized dummy objects. The helper has no create/write/delete/ACL-write API path. Its native watchdog and caller timeout/cancellation remain bounded.

## Boundaries that do not change

- Querying private ACL + identity is not authorization to write private content later.
- Parent/target guards are released before a later app write. Handle identity alone does not prove ongoing containment.
- Owner/administrator ACL changes remain possible. No immutable-descriptor promise is made.
- Initial-SD fixtures do not justify modifying an existing user object or broadly accepting inherited ACLs.
- No remote workflow, artifact upload, release, app integration or production acceptance is part of this source task.

Primary sources: [TOKEN_ELEVATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_elevation), [GetNamedPipeServerProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid), [CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew), [GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo), [libuv 1.51.0 pipe implementation](https://github.com/libuv/libuv/blob/v1.51.0/src/win/pipe.c).

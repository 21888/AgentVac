# Inherited current-user context gate

**Windows compilation: NOT_RUN. Windows execution: NOT_RUN.** Portable policy
tests cannot establish native pipe compatibility, Windows token layout or
successful metadata access. There is no CI exception or alternate identity path.
This gate observes the already inherited context. It does not request elevation.

## API and lifetime

`avm_inherited::bindCaller(HANDLE input, DWORD expectedCallerPid, BoundCaller&)`
returns one sanitized `Outcome`: `Verified`, `PeerRejected`, `ContextRejected`
or `Unavailable`. Failure leaves the output object empty. An allocation failure,
unsupported API, access denial, malformed return or ambiguous query fails closed.
No account names, raw SIDs, raw Win32 errors or privilege lists are returned.

`BoundCaller` owns the caller process handle, both primary-token handles and the
current-user SID buffer. Its `userSid()` returns a borrowed binary SID for the
existing ACL check; `elevated` is a diagnostic boolean. Keep the whole object
alive through metadata or generated-fixture observation. Do not retain the SID
after destroying or replacing the object. Stdin is borrowed, not closed or read
by the gate. Opening and retaining handles does not freeze a process or token;
the gate verifies a snapshot, not perpetual authorization.

## Bind the actual pipe peer

1. The bounded request supplies the expected caller PID. Zero and the helper's
   own PID are rejected. The PID in the request alone grants nothing.
2. Stdin must be a pipe, and `GetNamedPipeServerProcessId` must identify that exact
   expected PID. An unavailable native query is `Unavailable`, with no fallback
   to an environment variable, process name, account string or guessed parent.
3. Open that process with exactly
   `PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE`, non-inheritable. No VM,
   duplicate-handle, terminate, create-thread or token-modification access is
   requested. `SYNCHRONIZE` is used only by a zero-time `WaitForSingleObject`.
   `WAIT_TIMEOUT` establishes that it has not terminated at the query point;
   signaled means `PeerRejected`; every other result is `Unavailable`.
4. Open the helper and peer primary tokens using only `TOKEN_QUERY`. Compare the
   binary `TokenUser` SID, both halves of `AuthenticationId`, `TokenSessionId`
   and the mandatory integrity RID. Any mismatch rejects the peer.
5. Recheck the pipe server PID, caller liveness, absence of a helper-thread token
   and each process's primary token after the multi-query snapshots. Token IDs,
   modification IDs, authentication IDs, token types and counts must remain
   consistent. Retain the successfully bound handles until observation ends.

The synchronization check avoids the documented ambiguity of a process that
exits with the value `STILL_ACTIVE` (259). It observes liveness without changing
the process. A process may still exit after the final check. The process handle
retains the acquired process object and prevents subsequent PID reuse while it
is held; it is not a proof of executable provenance or of trusted request scope.

In libuv 1.51.0, `uv__create_stdio_pipe_pair` gives the server pipe to the parent
and the client pipe to the child. Microsoft's pipe-PID API documentation says
the handle is created by `CreateNamedPipe`; libuv's inherited child end is opened
with `CreateFile`. **Successful use of that API on the actual Node/Windows child
stdio handle remains a native acceptance gate.** A failure must remain blocked;
do not substitute a self-reported PID or use an unverified alternative endpoint.

The transport keeps stdin connected during binding: the helper/constructor reads
the bounded request, calls `bindCaller`, and emits the four-byte `AVH2`
acknowledgement only after verification. The parent waits for that acknowledgement
before ending stdin. The helper then requires EOF before any target metadata or
fixture operation. This avoids relying on peer-PID queries after disconnection;
it does not remove the native API compatibility gate. Keep `BoundCaller` alive
through the EOF check and the entire target operation.

## Context policy, without a human-account allowlist

`OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, ...)` is read-only. Any
present helper-thread token is `ContextRejected`. Only `ERROR_NO_TOKEN` proves
absence; anonymous impersonation, access denial and all other errors are
`Unavailable`. The gate queries the peer's primary token; it does not claim to
inspect every thread of the peer or determine which peer thread launched it.

Both tokens must be primary and fully queryable, with valid bounded user and
integrity SIDs and consistent `TOKEN_STATISTICS` snapshots. The mandatory label
must be exactly `S-1-16-RID` with the integrity attribute. RIDs at or above system
integrity (`0x4000`) are rejected. Other valid identical integrity RIDs are not
classified by an invented positive allowlist.

The following are excluded when they are the **primary TokenUser identity**:

- Exact NT authority SIDs `S-1-5-7` (anonymous), `S-1-5-17` (IUSR),
  `S-1-5-18` (LocalSystem), `S-1-5-19` (LocalService), `S-1-5-20` (NetworkService).
- NT authority service/virtual-account SID namespaces whose first subauthority
  is 80 through 111 inclusive. Microsoft's `WinNT.h` reserves base RID range
  `0x50..0x6f` for these types, including `S-1-5-80-*` (NT SERVICE) and
  `S-1-5-82-*` (IIS application pools), plus known Windows virtual host identities.

This is an explicit exclusion of those primary identities, not a claim that all
remaining SIDs identify humans. A domain SID containing 80 or 82 in a later
subauthority is unaffected. There is no requirement for a local/domain account
SID prefix, so a same-user AzureAD identity is not silently excluded.

Session 0, headless/noninteractive operation, lack of an interactive desktop and
service-logon group membership do not by themselves reject an otherwise bound
ordinary current user. Group SIDs are not searched for a service-group refusal.
The same trusted caller and generated-only request scope must still be enforced
by the surrounding transport/helper/fixture contracts.

## Privileges and elevation

`TokenElevation` is queried and retained diagnostically. Being already elevated
does not itself refuse an otherwise verified inherited context. No linked token
is obtained, and there is no elevation request or UAC interaction.

For both primary tokens, local-only `LookupPrivilegeValueW(nullptr, ...)` resolves
`SeBackupPrivilege` and `SeRestorePrivilege`; bounded `TokenPrivileges` queries
inspect existing attributes. If either privilege is currently enabled, the
context is rejected. Absent or disabled privileges are left untouched. Unknown
attribute bits, duplicate privilege entries, invalid size/count information,
inconsistent token snapshots and failed lookups are `Unavailable`. Other existing
privileges are neither enabled nor rewritten by this gate. This is not a sandbox
or a declaration that all of an administrator's ambient powers are harmless.

The implementation contains no privilege adjustments, token writes, logons,
impersonation, account/UAC/ACL changes, environment changes, network requests or
file-content reads. The unchanged metadata/ACL policy still decides whether
requested filesystem access is acceptable; `Verified` alone is not a filesystem
authorization or an accepted native launch receipt.

## Verification

`tests/inherited-policy.test.cpp` tests ordinary and inherited-administrator
success, enabled backup/restore in either token, known service identities,
system integrity, unknown/malformed evidence, impersonation, mismatched peer
identity/logon/session/integrity, headless session-zero compatibility, and
local/domain/AzureAD-shaped SID handling. It exhausts 16,384 boolean combinations
and runs 100,000 deterministic evidence/SID fuzz cases. These tests exercise
policy only; they do not simulate Windows success or alter a real token.

Required native acceptance still includes real pipe endpoint binding, primary
token buffer parsing, same-user standard and inherited-admin positives where
ordinary access is available, safe negative contexts, and observation with the
handles alive. Do not create or enable privileged contexts merely to make a test
pass. Native Windows status remains `NOT_RUN` until those checks actually run.

## Primary sources reviewed

- Microsoft: [GetNamedPipeServerProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid).
- libuv 1.51.0: [stdio pipe parent/server and child/client ownership](https://github.com/libuv/libuv/blob/v1.51.0/src/win/pipe.c#L368-L413).
- Microsoft: [Process access rights](https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights),
  [WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject),
  [GetExitCodeProcess and exit-code ambiguity](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess),
  [process-handle lifetime and PID reuse](https://devblogs.microsoft.com/oldnewthing/20110107-00/?p=11803).
- Microsoft: [OpenThreadToken](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openthreadtoken),
  [GetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation),
  [TOKEN_STATISTICS](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_statistics),
  [TOKEN_PRIVILEGES](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_privileges).
- Microsoft: [Security identifiers](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-identifiers),
  [well-known integrity RIDs](https://learn.microsoft.com/en-us/windows/win32/secauthz/well-known-sids),
  [IIS application-pool identities](https://learn.microsoft.com/en-us/iis/manage/configuring-security/application-pool-identities),
  [official WinNT.h service/virtual base RID definitions](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/winnt.h).
- Microsoft: [LookupPrivilegeValueW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-lookupprivilegevaluew),
  [privilege constants](https://learn.microsoft.com/en-us/windows/win32/secauthz/privilege-constants).

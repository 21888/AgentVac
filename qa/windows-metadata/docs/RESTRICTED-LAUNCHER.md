# Restricted fixture launcher: source-only research

**Windows compilation: NOT_RUN. Windows execution: NOT_RUN.** This source is a
conservative research fixture launcher, not a production sandbox, installation,
or accepted launch receipt. An unavailable safety property is a stable `BLOCKED`
result. Do not weaken a gate to obtain a successful smoke result.

## Permitted input and image binding

`src/restricted-fixture-launcher.cpp` accepts no command-line arguments. Its
stdin and stdout must be pipes. Stdin must contain exactly one bounded AVM1
request followed by EOF. `include/core.hpp` parses the request. The original
decoded path must already equal its canonical form; aliases such as slash
normalization, extended-prefix removal, or trailing-slash removal are rejected.

The launcher derives its directory with `GetModuleFileNameW`. That directory
must end in `build\windows-x64` or `build\windows-arm64`. The request must name a
strict descendant of a direct child directory named
`metadata-smoke-<suffix>`, where the suffix contains 6–32 ASCII letters, digits,
underscores, or hyphens. For example, a runner-generated target is
`build\windows-x64\metadata-smoke-A1b2C3\ordinary\empty.bin`.
The fixture directory itself is not a target. Prefix lookalikes, arbitrary
profile/public paths, device/UNC paths, alternate executables, and target argv
are not accepted. The authorized runner, rather than this launcher, creates a
fresh fixture; the name alone is not proof that a preexisting directory is safe.

Only the same-directory `agentvac-metadata-research.exe` is executable. The build
must generate `reviewed-helper-binding.h`, on the compiler include path, with:

```c
#define AGENTVAC_REVIEWED_HELPER_SHA256 "<exactly 64 lowercase hexadecimal characters>"
```

There is no runtime hash argument, sidecar trust override, executable search,
PATH lookup, shell, or fallback image. The source compares a BCrypt SHA-256 of
the held binary against that compiled binding. Images larger than 8 MiB are
rejected. The helper file is opened for reading with **only FILE_SHARE_READ**;
the handle stays open through child termination. Binary hard links and reparse
points are rejected. Every ancestor is opened and held without write/delete
sharing, and its handle path is verified against a directly mapped fixed local
volume. Process creation uses the internally derived native image path. The
actual suspended process image name must match that path before it can run.

Fixture ancestors receive the same component-by-component non-reparse checks.
The final ordinary-file handle allows FILE_SHARE_WRITE so the runner can retain
its existing `wx+` empty-file handle, matching the metadata helper. It still
denies delete sharing. Directory and binary guards never allow write sharing.
This ordinary-file exception is not a content lease. Successful returned
metadata must exactly match metadata from the launcher's held fixture handle,
including both file identities. A missing-leaf success is permitted only for
the parsed, allowed missing-directory-leaf operation. Observed changes reject.

## New token only; no privilege or account changes

The launcher reads its own process token and declines impersonating-thread
contexts. It creates a **new** primary token using exactly
`DISABLE_MAX_PRIVILEGE | LUA_TOKEN` and explicitly marks the built-in
Administrators SID deny-only. It does not use `SANDBOX_INERT` or
`WRITE_RESTRICTED`. If the new token's integrity exceeds medium, the only token
write is `SetTokenInformation(TokenIntegrityLevel)` on that new token to lower
it to medium. It never raises integrity, alters the caller's token, enables a
privilege, obtains a linked elevated token, or changes an account, UAC, ACL,
owner, reparse point, drive mapping, profile, or machine setting.

Both the candidate token and the actual suspended child's token must establish:

- Primary token, `TokenElevation.TokenIsElevated == 0`.
- `TokenHasRestrictions == 1`.
- Integrity greater than zero and at or below medium; actual-child integrity
  equals candidate integrity. Untrusted integrity (RID zero) is deliberately
  unsupported by this research contract.
- No enabled privilege except `SeChangeNotifyPrivilege` (that privilege need
  not be enabled or present).
- The built-in Administrators group is present and deny-only, with neither
  enabled nor enabled-by-default set. An absent Administrators group is
  deliberately unsupported for this proof.
- No UIAccess; same user SID and same session as the caller.

`TokenHasRestrictions` is intentional. `IsTokenRestricted` only tests for a
restricting-SID list; Microsoft documents that it can return false for a token
restricted through disabled groups or deleted privileges. No restricting-SID
list is synthesized merely to turn that unrelated observation true.

There is an additional conservative **caller** gate. `CreateProcessAsUserW`
can temporarily enable caller privileges internally. This launcher requires
`SeIncreaseQuotaPrivilege` to be already enabled, and rejects either
`SeIncreaseQuotaPrivilege` or `SeAssignPrimaryTokenPrivilege` when present but
disabled. The own-token restriction does not require the latter privilege to
be present. No `AdjustTokenPrivileges`, credentials, logon, impersonation,
elevation, or alternate process-creation fallback is available. A typical
standard or elevated token can therefore return `BLOCKED/token`. That result
is expected research evidence, not permission to enable the missing privilege.

## No UI, inherited profile, or caller environment

An existing non-visible, non-WinSta0 window station is required. The launcher
passes the explicitly observed station/desktop name; it never creates or
switches desktops or rewrites a desktop/window-station DACL. An interactive
host returns `BLOCKED/desktop` if it reaches that gate.

Child creation requires the Win32k-system-call-disable mitigation. The actual
suspended child must report that mitigation before it can run. The new job also
forbids USER handles outside the job, clipboard reads/writes, system/display
changes, global atoms, desktop changes, and exiting Windows. Unsupported
mitigation/desktop/job behavior blocks the launch.

`CreateProcessAsUserW` receives `CREATE_SUSPENDED`, `CREATE_NO_WINDOW`,
`CREATE_UNICODE_ENVIRONMENT`, and `EXTENDED_STARTUPINFO_PRESENT`; the child
inherits the launcher's explicit error-box suppression. The only child environment entry is
`SystemRoot=C:\Windows`. The actual Windows directory must match that fixed
value. The current directory is the guarded native build directory. No caller
environment, shell initialization, profile loading, account lookup, or user
credentials are used. The existing helper separately rejects elevated tokens.

## Containment and lifetime

The launcher creates two private anonymous pipes and passes **only** the
child-side read/write ends in `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. Stdout and
stderr share the bounded child-output pipe; any unexpected output invalidates
the response. No token, job, binary/fixture handle, window-station handle, or
unrelated inherited handle is intentionally inherited. The explicit handle
list is mandatory; `bInheritHandles=TRUE` is used solely as that API requires.

An unnamed, noninheritable kill-on-close job is assigned **atomically at process
creation** using `PROC_THREAD_ATTRIBUTE_JOB_LIST`. There is no suspended-child
gap awaiting a later assignment. The job's active-process limit is one, and
breakaway is not enabled. `IsProcessInJob` is checked before resume. Job-list
support requires Windows 10 / Server 2016 or later; failure has no compatibility
fallback. Nested-job incompatibility also blocks.

After creation, the token, actual image, job membership, mitigation, and drive
mapping are verified while the child remains suspended. Only then is its
initial thread resumed. The exact request is forwarded and the input pipe is
closed immediately. The helper must return exactly its 68-byte AVM1 response,
close the output pipe, and exit zero. Only a validated frame is released.

- Six-second cooperative deadline covers parsing, binding, launch, and I/O.
- A separate seven-second watchdog terminates the launcher if a synchronous
  Windows call or output write stalls. Closing its sole job handle kills any
  child already created, including a suspended child.
- Console cancellation, when delivered, signals cancellation; work checks it
  alongside the deadline. The watchdog remains active during cleanup/output.
- Premature stdin EOF or any byte after the single request blocks before launch.
  EOF after the complete request is required framing, not a later cancellation
  channel. Child-output EOF before a complete frame blocks and cleanup kills
  any still-running member.
- On other failure paths, cleanup terminates a still-running job, briefly waits
  for the child, and closes the job. Parent-side termination also closes the
  noninherited job handle. No independent launched process is left detached.

The outer runner must retain its eight-second timeout. Hard termination, an
unwritable output pipe, or very early initialization failure can yield no
complete diagnostic frame. Missing/truncated output is failure, never success.

## AVR1 output contract

All integers below are unsigned little-endian. A complete output is exactly
32 bytes for BLOCKED, or exactly 100 bytes for OK. No raw path, user SID, native
error number/string, environment value, or console diagnostics are returned.

| Offset | Size | Meaning |
| --- | --- | --- |
| 0 | 4 | ASCII `AVR1` |
| 4 | 1 | Status: `0` OK, `1` BLOCKED |
| 5 | 1 | Stable reason code below; zero only for OK |
| 6 | 2 | Reserved; zero |
| 8 | 4 | Verified candidate integrity RID; zero if unverified |
| 12 | 4 | Verified actual-child integrity RID; zero if unverified |
| 16 | 4 | Evidence flags below |
| 20 | 4 | Reserved; zero |
| 24 | 4 | Trailing frame length: 68 for OK; zero for BLOCKED |
| 28 | 4 | Reserved; zero |
| 32 | 68 or 0 | Exact, unmodified helper response frame, only for OK |

Evidence bits: `0x01` helper hash bound; `0x02` candidate token verified;
`0x04` actual-child token and image verified; `0x08` child in the mandatory job;
`0x10` child exited zero; `0x20` AVM1 response validated. No other bits are valid.
OK requires all six bits (`0x3f`). BLOCKED can retain earlier evidence; it never
contains a helper frame. RID zero means unverified in this contract; a token
with the legitimate untrusted-integrity RID zero is deliberately rejected.

Reason codes: `0` none; `1` request; `2` binding; `3` fixture;
`4` token; `5` desktop; `6` launch; `7` job; `8` child-token;
`9` deadline/cancel; `10` pipe; `11` helper-response.

A completely emitted OK exits zero. BLOCKED normally exits 125 and must still
be parsed as the exact 32-byte diagnostic. The independent hard stop exits
124. Other nonzero/no-frame results are failures. AVR1 OK means that launcher
checks and AVM1 transport succeeded; the embedded AVM1 outcome can still be a
legitimate metadata rejection. Never convert AVR1 OK into a metadata allow.

## Build and acceptance boundary

Compile only from the separately reviewed build recipe using the preinstalled
Microsoft toolchain. The launcher requires C++17, `/MT`, a Windows 10 SDK,
`_WIN32_WINNT=0x0A00`, `WINVER=0x0A00`, `advapi32.lib`, `bcrypt.lib`, and
`user32.lib`. Retain the helper's asInvoker/no-UIAccess manifest and the existing
CFG, NX, ASLR, and system-only dependent-image load settings. Compile the helper
first, hash that exact output, generate the binding header, then compile the
launcher. A generated hash pins bytes; it does not establish that a binary has
been independently reviewed or accepted. Do not run a stale launcher after a
failed optional launcher build.

Native API, loader, desktop, token, pipe, job-nesting, termination, and compiler
behavior remain **NOT_RUN** here. Portable parser tests do not prove those
properties. No claim is made of successful unelevated execution, launchability
on the current host, adversarial isolation, or production acceptance. Fixture
tests must use only generated disposable data. Do not test against provider
stores, real profile/public folders, or by changing ACLs, owners, accounts,
privileges, UAC, desktop security, drive mappings, or reparse state.

The design assumes a trusted reviewed runner and no hostile concurrent
administrator. Drive mappings are read-only checked before/after launch and
response, but this is not a proof against an administrator changing aliases
between observations. Existing-file successful metadata is additionally bound
to held file identity. The launcher does not turn the helper into a general
filesystem, network, or hostile-code sandbox; only the exact reviewed helper
is in scope.

## Official API references

- [CreateRestrictedToken](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-createrestrictedtoken): flags, deny-only groups, and desktop caution.
- [Token information classes](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ne-winnt-token_information_class) and [IsTokenRestricted](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-istokenrestricted): distinct token observations.
- [SetTokenInformation](https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-settokeninformation): access requirements for new-token integrity reduction.
- [CreateProcessAsUserW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessasuserw): caller privilege behavior, explicit image, environment, profile, desktop, and handle semantics.
- [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute): handle list, mandatory mitigation, atomic job list, and OS support.
- [Process connection to a window station](https://learn.microsoft.com/en-us/windows/win32/winstation/process-connection-to-a-window-station) and [GetUserObjectInformationW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getuserobjectinformationw): existing desktop/window-station observations.
- [SetInformationJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-setinformationjobobject), [extended job limits](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information), and [job UI restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_ui_restrictions): child lifetime and no-UI restrictions.
- [BCryptHashData](https://learn.microsoft.com/en-us/windows/win32/api/bcrypt/nf-bcrypt-bcrypthashdata): incremental binary-hash input.

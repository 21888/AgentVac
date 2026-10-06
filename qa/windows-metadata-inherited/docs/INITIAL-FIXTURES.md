# Initial-security fixture constructor

Status: source staging only. Native Windows build, execution, context binding,
initial-owner support and filesystem acceptance are **NOT_RUN**. This document
is not authorization to execute the constructor or to change existing ACLs.

## Purpose and boundary

`src/fixture-constructor.cpp` is a separate fixture-only executable. Build it
with the preinstalled, reviewed Microsoft compiler and Windows SDK, static
`/MT` runtime, the existing `asInvoker` / `uiAccess=false` manifest, and
`advapi32.lib` plus `bcrypt.lib`. Its proposed binary name is
`agentvac-initial-fixture-constructor.exe`. It neither links the read-only
helper source nor launches the helper or another process. The build directory
must end in `build\windows-x64` or `build\windows-arm64`.

The only filesystem mutations are creation of exactly these five new objects,
under the constructor's own executable directory:

```text
inherited-fixture-<32 lowercase hexadecimal characters>\
  private\
    empty.bin
  broad\
    empty.bin
```

The fixture directory is a sibling of the executable. The root is private.
The two files are created empty and never read, written, truncated or mapped.
There is no argument, environment variable or request field accepting a path,
SID, ACL, content, security setting or requested privilege. Existing profile,
public and user-data objects are neither fixture targets nor repaired. The
constructor does not change the security or owner of any existing object.
Ancestors may be inspected for path identity only.

No download, installer, authentication action, UAC elevation, impersonation,
restricted token, privilege enablement, token mutation or helper invocation
belongs to this executable. Inherited administrator rights may be used only
when the read-only bound-context gate accepts the caller. In particular,
enabled backup/restore privileges, service/System contexts and impersonation
are rejected by that gate; they are never disabled and retried.

## Context comes before filesystem access

After accepting a bounded request while stdin remains connected, the constructor calls
`avm_inherited::bindCaller(stdin, expectedCallerPid, caller)` from
`include/inherited-context.hpp`. The gate must bind the actual stdin pipe
server to the expected parent/current SID, session, authentication and
integrity context. Only `Outcome::Verified` permits an `AVH2` acknowledgement. The constructor then
requires EOF with no extra input before subsequent module-path, filesystem-
metadata and creation calls. `PeerRejected`, `ContextRejected` and
`Unavailable` produce separate stable reasons and perform no fixture access.

The verified user's SID supplies the explicit initial owner and primary group.
The inherited elevation boolean is observation only. The constructor cannot
request a context with more authority if creation or owner assignment fails.
If Windows cannot honor that owner/group under the inherited ordinary rights,
creation or verification is blocked. Default-owner behavior on actual elevated
and unelevated Windows tokens remains a native support question, not a reason
to omit the requested owner or to grant additional rights.

## Initial ACLs

Each security descriptor is built entirely in memory before any fixture
creation. `InitializeSecurityDescriptor`, `SetSecurityDescriptorOwner`,
`SetSecurityDescriptorGroup`, `SetSecurityDescriptorDacl` and
`SetSecurityDescriptorControl` operate only on those memory buffers.
`SECURITY_ATTRIBUTES` passes the completed descriptor to `CreateDirectoryW` or
`CreateFileW(..., CREATE_NEW, ...)` at object creation. There is no
`SetSecurityInfo`, `SetNamedSecurityInfo`, ownership takeover, ACL repair or
post-creation security write.

All DACLs are present, non-null, protected (`SE_DACL_PROTECTED`), and contain
ordinary explicit allow ACEs in this exact order:

1. Bound current user: normalized full control `0x001f01ff`
2. Local System: normalized full control `0x001f01ff`
3. Built-in Administrators: normalized full control `0x001f01ff`
4. Broad fixtures only, Everyone: normalized ordinary read `0x00120089`

Directory ACEs use exactly `OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE`.
They have neither no-propagate nor inherit-only flags. File ACEs have no
inheritance/propagation flags. The protected DACL prevents ambient inherited
ACEs from being added. These fixtures intentionally test broad-versus-private
DACL classification; the broad fixtures contain no user information.

Every created object is checked through its retained metadata handle with
read-only `GetSecurityInfo`: owner and primary group must be the verified user;
DACL protection, exact ACE count, SID order, masks and flags must match. A
mismatch is a hard blocked result with no repair. Files must have zero size,
one hard link and no reparse attribute. All created object identities and
security descriptors are checked again before reporting success.

## Locality and collision rules

The executable path is canonicalized with the existing restrictive path
policy. DOS-drive mapping must resolve directly to `\Device\HarddiskVolumeN`,
and that device root must report fixed storage. UNC, network, SUBST/redirected
mappings, other device namespaces, ambiguous/noncanonical paths and reparse
points fail closed. Operations use the verified `\\?\GLOBALROOT` device path;
the DOS mapping is also checked again before every create and before success.

The volume root and every existing ancestor through the build directory are
opened and held with metadata-only `FILE_READ_ATTRIBUTES`,
`FILE_FLAG_OPEN_REPARSE_POINT`, directory semantics and `FILE_SHARE_READ` only.
The executable's own metadata is pinned without content reads. No retained
handle shares write or delete access. Created objects are pinned with only
`FILE_READ_ATTRIBUTES | READ_CONTROL`; each directory is pinned before its
children are created. A handle's opened final NT path, type, non-reparse state
and file identity are checked. The constructor never probes arbitrary file
contents or enumerates directories.

The suffix comes from one 16-byte `BCryptGenRandom` system RNG request. The
constructor makes exactly one root-name attempt. `CreateDirectoryW` and
`CREATE_NEW` both reject existing names. A collision fails without overwrite,
reuse, another random attempt, deletion, permissions adjustment or retry.

`CreateDirectoryW` does not return a handle, so a directory must be opened
immediately after creation. There is an unavoidable create-to-pin gap with
this Win32 API shape. Initial private ACLs exclude unrelated ordinary users,
but do not constitute a hostile same-user/administrator replacement defense.
The checks detect many replacements and mismatches; they do not establish
race-free original ownership of a directory replaced during that gap. Native
acceptance must not claim that stronger property. Handles also close when the
constructor returns; a success receipt is a verified observation, not an
ongoing integrity lease.

## Fixed protocol

No command-line arguments are accepted. Stdin and stdout must be pipes. Stdin
contains exactly 12 request bytes:

- Bytes 0–3: little-endian unsigned body length, exactly `8`
- Bytes 4–7: ASCII `AVF1`
- Bytes 8–11: nonzero little-endian expected caller process ID

The caller must keep stdin connected after writing the request. The constructor
binds the live stdin pipe peer, then sends exactly four ASCII bytes `AVH2` only
if context was verified. The caller closes stdin only after receiving that
acknowledgement. The constructor requires EOF and rejects any additional byte
before filesystem access. Request/context rejection sends its blocked response
directly without acknowledgement. This handshake deliberately avoids querying
pipe-server identity only after the parent has disconnected the writer.

After the optional acknowledgement, the fixed response is exactly 44 bytes,
without an outer length prefix. A fully acknowledged exchange is 48 stdout
bytes; a direct pre-acknowledgement rejection is 44 bytes:

- Bytes 0–3: ASCII `AVC1`
- Byte 4: `0` created; `1` blocked
- Byte 5: stable reason listed below
- Byte 6: observed inherited-elevated boolean; only set after verified context
- Byte 7: zero
- Bytes 8–39: exactly 32 lowercase ASCII hexadecimal suffix bytes on created;
  all zero on blocked
- Bytes 40–43: zero

Reasons are `0 none`, `1 request`, `2 peer`, `3 context`, `4 unavailable`,
`5 locality`, `6 descriptor`, `7 create`, `8 verify`, `9 deadline`,
`10 internal`. Created requires reason zero; all blocked results require a
nonzero reason. No path, SID, raw OS error, log message, token detail or user
content is returned. There is no stderr logging. The caller derives the exact
five names from its independently verified build directory and the success
suffix. An elevation byte of zero in a blocked response is not proof of an
unelevated token: context may never have been verified.

The cooperative deadline is 4.5 seconds from process startup. Console
cancellation stops pending work; the independent hard-stop thread terminates
the process at 5 seconds, including a blocked API or stdout write. Timeout,
truncation, malformed output, unexpected trailing output or nonzero process
exit must never be accepted as success. Successful emission exits `0`;
ordinary blocked outcomes exit `125`; hard deadline termination uses `124`.
Process setup failure can exit without a response.

## Partial results and cleanup

Creation is intentionally non-transactional. Cancellation, access denial,
verification failure, output failure or process termination can leave any
created prefix of the five-object tree. A blocked response has a zero suffix;
missing success output does **not** prove that nothing was created. The
constructor does not retain a cleanup journal, enumerate the build directory,
retry a request or disclose partial paths. This privacy/minimal-protocol
tradeoff means automatic cleanup of every failed attempt is not established.

For a successfully reported suffix, the authorized parent may later delete
only these exact generated files individually, then their two directories,
then the root, after independent identity/emptiness validation. There is no
recursive cleanup command. If a failed attempt lacks independently verified
exact names, stop cleanup rather than globbing, walking a tree, deleting an
unknown object, broadening ACLs or treating an existing name as reusable. The
constructor itself never deletes anything, including fixtures it created.

## Verification status and references

Source review can check the boundary, protocol, imports and fixed masks.
It cannot establish Windows ACL construction, pipe-peer provenance,
MSVC `/W4 /WX` compilation, architecture behavior, default-owner support,
filesystem race behavior or native acceptance. All are **NOT_RUN** until
separately authorized and tested. The constructor must remain separate from
the production metadata helper and must not be presented as a read-only tool.

Microsoft documents initial file/directory security descriptors in
[File Security and Access Rights](https://learn.microsoft.com/en-us/windows/win32/fileio/file-security-and-access-rights)
and create-new semantics in
[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).

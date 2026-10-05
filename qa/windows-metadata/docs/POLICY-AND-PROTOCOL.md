# Policy and wire contract

## Exact ACL predicate

The core C++ predicate is a literal port of `cursorSnapshotAclIsPrivate` in the corrected AgentVac development tree, at the source hash recorded in README. It does not add groups or translate generic access rights.

Owner must be current user, LocalSystem, or Builtin Administrators. Entries number 1–128. Every entry has a valid principal/SID, rights > 0 and <= 0x1fffff, ordinary allow or deny, inheritance 0–3 and propagation 0–3. ACL must be canonical. Any allow for another principal rejects. Denies for current user/System/Administrators reject. **A valid deny for another principal remains allowed**, matching the existing predicate; it is not silently changed to deny-all.

The current user needs one allow entry whose rights contain both low bits (`rights & 3 == 3`) and is not inherit-only (`propagation & 2 == 0`). A directory additionally needs a current-user allow with both object/container inheritance and zero propagation flags. As in the original predicate, those two conditions may come from different entries. This is not a general effective-access solver.

Native extraction accepts ordinary ACCESS_ALLOWED_ACE and ACCESS_DENIED_ACE only, validates SID/ACE sizes and flags, and rejects unknown/object/callback ACEs rather than dropping them. It checks .NET's supported ordinary-ACE canonical categories: explicit deny, explicit allow, inherited in original order. Win32 ObjectInherit/ContainerInherit bits are converted to the opposite .NET numeric ordering. Rights are not expanded, coalesced, or normalized. Zero-mask entries are not dropped. Therefore extraction may conservatively reject unusual raw ACLs that .NET would normalize or omit; the decision predicate itself has exact differential equivalence. Native raw-ACL/.NET extraction equivalence beyond the supported ordinary-entry domain is an outstanding acceptance gate, not a claim of complete equivalence.

Native SID revision must be 1 with 1–14 subauthorities, matching the existing decimal SID regex; this is narrower than Windows' binary SID validity (0–15). .NET formats the full identifier authority in decimal, so no artificial 32-bit authority limit is added. See [Microsoft .NET Framework SID formatting](https://github.com/microsoft/referencesource/blob/main/mscorlib/system/security/principal/sid.cs#L635-L665).

No SIDs are converted to text or sent out. Native current-user SID comes from the helper's primary process token; elevated execution is refused. Token query needs no privilege enable or account/network lookup. SID comparison is local binary equality/well-known-SID recognition.

## Locality

1. Strict UTF-8 decoding rejects overlong encodings, surrogate code points, malformed continuation bytes, truncation, and values above U+10FFFF. At most 16,384 UTF-8 bytes, 4,096 UTF-16 units, 128 components.
2. Canonical drive-path policy retains existing spelling rules: local drive letter, safe components, no UNC/device/ADS/dot/trailing-dot-space/control/device-name ambiguity. The existing extended drive spelling is accepted; the helper does not accept user-supplied GLOBALROOT input.
3. QueryDosDeviceW reads only the first/current mapping. It must be exactly `\Device\HarddiskVolume` plus digits. SUBST and network/device aliases are rejected.
4. Internally derive `\\?\GLOBALROOT` + verified direct mapping + backslash and require GetDriveTypeW to report DRIVE_FIXED. Later filesystem calls use this pinned native-device spelling rather than following mutable DOS drive aliases.
5. Walk one component at a time. Check GetFileAttributesW before opening; open only that component with OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT and FILE_FLAG_BACKUP_SEMANTICS; reject reparse attributes on the opened handle; confirm its opened NT path matches the expected native path. Hold all prior directory handles with no FILE_SHARE_WRITE or FILE_SHARE_DELETE until the observation ends. Do not discover children of a rejected ancestor.
6. The final ordinary file allows FILE_SHARE_WRITE for an existing Node writer, but not FILE_SHARE_DELETE. This is an observation, not an exclusive content/ACL lease. ACL and identity use that same final handle. Identity and attributes are rechecked, and the current drive mapping is checked again.
7. Missing final leaf may succeed only for locality mode + directory request + explicit allowMissingLeaf, after every existing ancestor passes. ERROR_FILE_NOT_FOUND/PATH_NOT_FOUND elsewhere rejects. The result is only a pre-mkdir observation; revalidate after creation. It cannot authorize ACL acceptance or content writes.

## Binary framing, version 1

All integer fields use little endian. One request per process. stdin must be a pipe. Close stdin after the frame. Extra trailing bytes reject. A 4.5-second native watchdog exits 124; the parent kills/cancels after 5 seconds or on AbortSignal. No path is placed in argv/environment. stdout must be a pipe. stderr must be empty.

Request: uint32 body length, followed by an 8-byte header and the UTF-8 path. Body length 11–16,392. Header bytes 0–3 `AVM1`; byte 4 mode (0 locality, 1 ACL); byte 5 flags (bit 0 directory, bit 1 allow missing final leaf); bytes 6–7 zero. Unknown mode/flag/reserved fields reject. Missing flag is permitted only for locality + directory.

Response: uint32 body length exactly 64; fixed 64-byte body, total exactly 68 bytes. Byte offsets below are relative to the body:

- 0–3: `AVM1`
- 4: stable code: 0 verified-local, 1 verified-private, 2 invalid-request, 3 locality-rejected, 4 acl-rejected, 5 metadata-unavailable, 6 timeout (reserved structured code; watchdog normally exits 124), 7 identity-unavailable
- 5: flags: bit 0 exists, bit 1 directory, bit 2 identity present. Only 0, 5, 7 are valid
- 6–7: zero
- 8–15: legacy volume serial (uint64 container for uint32)
- 16–23: legacy 64-bit file index
- 24–31: file size uint64
- 32–35: hard-link count uint32
- 36–39: file attributes uint32
- 40–47: FILE_ID_INFO volume serial uint64
- 48–63: FILE_ID_INFO opaque 128-bit file ID, native byte order

Failure codes have flags and all metadata zero. Success without metadata is legal only for the permitted missing final leaf. Successful existing metadata cannot be used when its mode/directory shape differs from the request. Parent returns only stable outcomes and requested bounded identity data, no paths/SIDs/native errors/stderr. Identity is not persisted in logs.

## Build and bootstrap trust

Only the source-built exact executable `agentvac-metadata-research.exe` can be selected by the caller's trusted review binding. The transport snapshots that binding before async work, verifies SHA-256 and stable file metadata, keeps the read handle open through the child lifetime, and passes an empty-profile environment with a trusted Windows root. This is defense in depth, **not an atomic executable-handle launch**: a path-based spawn still needs trusted installer-established directory/binary integrity. The metadata helper cannot safely use itself to establish its own bootstrap trust. There is no automatically accepted manifest or arbitrary helper discovery.

## Primary references

- [GetSecurityInfo: READ_CONTROL and handle-bound descriptor](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo)
- [Microsoft path namespaces, including GLOBALROOT](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)
- [QueryDosDeviceW current mapping semantics](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-querydosdevicew)
- [GetDriveTypeW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdrivetypew)
- [CreateFileW access/share/open-reparse behavior](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
- [GetFinalPathNameByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)
- [.NET CommonAcl source, CanonicalCheck](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Security.AccessControl/src/System/Security/AccessControl/ACL.cs)

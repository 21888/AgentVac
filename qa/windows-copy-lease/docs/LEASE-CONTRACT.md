# Detached Windows copy-lease research contract

Status: design/implementation staging only. No app wiring or production/private-copy acceptance. The baseline receipt refers only to the earlier18-case inherited-context metadata probe, not this changed helper.

## First bounded scope

The first lease is for one exclusively created, empty, single-link regular file under the fixed generated inherited-fixture-<32hex> subtree adjacent to the reviewed research executable. Its containing generated directories must have verified inheritable private ACLs. This is a generated sentinel-copy experiment. It does not initially authorize arbitrary app paths, folders, multiple databases, SQLite WAL/SHM reconstruction, or existing destination files.

The read-only helper retains verified no-reparse ancestor and destination handles without FILE_SHARE_DELETE. Node owns the already-open destination handle, obtained by exclusive creation (not exclusive Windows sharing). Before writing any generated source bytes, Node must match native volume/file identity and its held descriptor, observe a valid ready frame with the request nonce, and confirm that the helper is still live. Path equality or a prior ACL success is insufficient.

Keep the exact reviewed OS-pipe caller identity and current-user/authentication/session/integrity checks. Inherited administration is not requested elevation. Thread impersonation, enabled backup/restore, privileged service identities, remote/mapped/ambiguous paths and unknown ACLs remain refusals. No privileges, accounts, UAC, existing ACLs or permissions change.

## Protocol/lifetime

A separately versioned binary request carries a16-byte random nonce, expected caller PID, fixed generated scope and canonical target. Length and UTF-8/path/component limits reuse the reviewed core. Modes/flags are fixed to ACL-checked existing regular file, with no missing-leaf allowance.

The helper emits a fixed-size READY frame only after all handles and private-ACL/identity checks succeed. The request pipe stays connected. It then accepts exactly one nonce-bound RELEASE or CANCEL control frame followed by actual EOF. Revalidate caller and held identities/ACLs before a terminal response. A malformed/truncated/extra frame, parent exit or watchdog is failure, never successful release. The first research lease is bounded to30seconds and16MiB copied bytes. No automatic renewal.

The host retains child ownership until verified exit and pipe closure, aborts copying on error/exit/cancellation, and never returns success merely upon READY. A partially written generated fixture is preserved for disposable-runner inspection. No path-based automatic cleanup.

## Immediate native cases

- Private empty target identity; generated sentinel copy + exact byte readback; source unchanged.
- Broad initial ACL, nonempty or hardlinked destination and wrong identity refuse before copying.
- Rename/replacement attempts on each held ancestor and leaf must fail while leased; pre-existing incompatible DELETE handles refuse acquisition.
- Reparse/link cases only if ordinary fixture creation is available; do not enable privileges or developer mode.
- Parent/helper exit, timeout, cancellation, malformed controls, null-read vs EOF and leaked-handle checks.
- Caller/token/ACL mutation cases requiring existing security-setting changes stay untested unless separately authorized.

SQLite family behavior and a production destination containment policy are later gates. A leaf lease may intentionally prevent SQLite deleting WAL; that is a known design question, not permission to relax delete sharing. No universal defense against privileged/same-user malicious changes or power-loss immunity is claimed.

## Host-copy gates added after review

The host enforces the expected byte count and the16MiB ceiling immediately before every write, including repeated partial writes. It keeps the original destination descriptor; it never reopens the path for readback. Both streamed-source and held-destination hashes must equal the expected generated-source hash. Final native identity/link count/private ACL and exact size must match, and transport success additionally requires terminal EOF and actual child close.

A pending write retains ownership through settlement when cancellation or helper death is observed. Its last successful byte count is a known lower bound, not a claim that an errored write changed nothing. No physical hard timeout is claimed for a FileHandle write. Production would need an isolated copy lifetime and verified reaping before relying on that bound.

Helper liveness is checked at observed fences. Death can race a subsequent syscall; a live check is not an atomic lock against death. Tests explicitly cover child exit after READY, duplicate/stale nonce/control/READY, incorrect/replaced descriptor identity, partial writes and cancellation while a write promise remains pending.

Current detached local evidence:111 portable C++ checks and36 Node host/protocol tests. The changed Win32 helper is not yet compiled or run natively. The earlier18-case receipt applies only to the preserved baseline source.

## Identity filesystem profile

The first copy lease is explicitly local NTFS only. GetVolumeInformationByHandleW must establish that filesystem on the retained native volume-root handle, with matching volume metadata. Microsoft documents the legacy volume-serial plus64-bit file-index pair for comparing two open file handles, but specifically warns that the64-bit identifier is not guaranteed unique on ReFS. Node/native held-descriptor parity was observed in the previous generated NTFS fixture; the changed lease requires fresh native verification and eventual exact Electron/libuv runtime acceptance. Do not claim ReFS/FAT/network support or truncate a128-bit identity to manufacture it.

Sources: https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information and https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle .

## Corrected protocol/lifecycle boundary

The original7bbc checkpoint is preserved separately. The corrected lease wire uses AVL2/AVR2/AVC2 with strict typed refusal details. The shared transport revokes write eligibility on process exit, retains child ownership until close, and allows bounded late terminal/refusal draining after clean exit without accepting late READY. A negative fixture passes only on the intended complete nonce-bound refusal plus clean exit/EOF/close.

The generated DELETE-access actor has its own AVD2 wire and cannot be passed as a copy lease. It requests an ordinary existing DELETE right solely to exercise Windows sharing conflicts, and never invokes deletion/rename/ACL/content-write APIs. It retains the same private initial identity and releases on a nonce control or finite watchdog.

## Share-participating handle rights

The b5a056 native probe passed12 of14 cases but failed leaf-rename denial and the pre-existing DELETE-handle refusal. Its metadata-only access mask did not establish those barriers. It is retained as failed containment evidence, not reclassified as a pass.

This corrected design requests FILE_READ_DATA for the final ordinary file and FILE_TRAVERSE for retained directories, in addition to existing FILE_READ_ATTRIBUTES and required READ_CONTROL. FILE_TRAVERSE is the directory meaning of0x20, the same bit named FILE_EXECUTE in the sharing predicate; it does not request directory-list rights. The file retains READ/WRITE sharing for the existing Node writer and omits DELETE sharing. Directories retain READ sharing and omit WRITE/DELETE sharing. The SDK constants are compile-time checked against the portable policy that supplies the actual CreateFileW arguments.

Only metadata and security descriptors are queried on these handles. No target ReadFile, directory enumeration, file execution, target write, rename/delete, ACL change or privilege adjustment is added to the helper. A requested-access refusal remains unavailable; the helper never retries with weaker metadata-only rights. This distinction matters: metadata-only **observations** do not mean a metadata-only **access mask** is sufficient for sharing checks.

Microsoft's file/stream sharing algorithms gate conflicts on granted data-read/execute/write/append/delete bits. Attribute/READ_CONTROL-only handles are outside that predicate. The directory traverse and file read masks above are source-supported, but their actual NTFS barriers and sibling-write compatibility still require fresh exact-binary native tests. Privileged/same-user ACL changes and other deferred threats are not solved by requesting these rights.

Sources: [file access/deletion checks](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/82b364ce-6d7b-422f-8d88-4db32eea809a), [stream/directory sharing checks](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/8c0e3f4f-0729-49f4-a14d-7f7add593819), [documented access-bit meanings](https://learn.microsoft.com/en-us/windows/win32/fileio/file-access-rights-constants).

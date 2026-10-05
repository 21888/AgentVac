# Coherent cleanup units and recovery

AgentVac's provider policy can identify an explicitly allowlisted whole directory or an ordered bundle of files/directories. The ordinary metadata scan never reads the payload. A selected row identifies the entire unit, with its member paths, exact regular-file count, directory count and summed logical bytes. The newest file **or directory** modification time controls its age. Failed or incomplete inspection never produces a partially selectable unit.

## Scope and bounds

- The provider must name a fixed policy, every member, each member's type, and any optional members. The first member is mandatory and acts as the bundle anchor.
- Every descendant must independently match the provider's allowlist. Providers can additionally require an exact coherent directory layout.
- Each unit is limited to 5,000 nodes and 12 descendant levels. Those visits also consume the scan's overall entry budget. Hitting a bound reports partial coverage and excludes that unit's unverified bytes.
- Symlinks, hardlinked files, special filesystem objects, other-device descendants, unknown companion names and changes to optional-member presence reject the entire unit. Directories must have usable write/execute access; on POSIX, owner write and execute permission are required. Read-only directory units are protected before quarantine rather than stranded during link-based restoration.
- Root and parent-directory identity, full metadata fingerprints and optional absence are captured. Preview and quarantine revalidate the complete snapshot. Processes must be confirmed closed and positively detected as stopped; unknown state blocks mutation. State is rechecked at member/restore phase boundaries, but this is not an operating-system lock on another application.

## Quarantine

A whole directory is quarantined by one same-filesystem rename. A bundle moves in its declared order, so a transcript/database anchor moves before its dependent files. Multi-member movement is not a single filesystem transaction.

The signed version-3 journal records provider, selected root, immutable unit policy, all paths/types/fingerprints, exact counts, directory identities and durable operation intent. A private, identity-pinned unit container stores numbered members. Pending renames reconcile after interruption. An ordinary move failure attempts immediate verified rollback; if rollback cannot complete, all surviving payloads remain available for authenticated recovery. Legacy version-1 Codex and version-2 file journals continue through their existing recovery path.

## Nonoverwriting restore

Portable Node.js rename cannot guarantee `NOREPLACE` for directories. AgentVac therefore reserves each new destination directory with exclusive `mkdir`, pins its identity, and reconstructs the known tree using exclusive hard links for ordinary files. It restores bundles in reverse order, exposing the anchor after its companion data. Existing destination files or directories are never merged or overwritten.

Every destination and source ancestor is rechecked around link/cleanup phases. Known target names and owned-link identities are checked before removing preserved source links. Empty stored directories are removed only with `rmdir`. Restored directories retain ordinary permissions and modification times; their directory inode and creation metadata necessarily differ because they are newly constructed. This does not claim preservation of all platform-specific directory ACLs or extended attributes. File data and file inode metadata remain on the same filesystem through link/unlink.

Creation identities, linked-file fingerprints and completed members are checkpointed in the signed journal. A resumed operation may exempt a recent/newest protection that was caused by its own created target, but only after an exact read-only check of already-owned signed directories/links and absence of unknown targets. Broad runtime/ancestor protection and recreated or changed data remain blocking. Interrupted source unlink and source-directory removal can resume. The unavoidable interruption between creating a directory/link and durably recording its identity is deliberately conservative: an unrecorded destination is an explicit conflict, and all preserved payloads remain in place. Recovery does not adopt an unknown file/link merely because its name matches. The error states that manual inspection is needed rather than silently deleting either copy.

The journal authenticates metadata; it is not a cryptographic digest of file contents. Fingerprint and ancestry checks defend against observed changes and tested race conditions, but do not constitute a claim of complete immunity to arbitrary hostile concurrent filesystem writers. Users must keep the relevant application closed until an operation finishes.

## Rescue and disposal

Keyless rescue inspection counts regular files and bytes actually present in unit containers without reading their contents or trusting their journal. It is bounded and never follows links; irregular entries and truncation are reported. Authentication and current provider policy are still mandatory for restore. Imported trusted keys preserve the original batch's signing identity.

System-trash disposal validates the complete retained unit and rejects unknown container contents, altered payloads, partial bundles and unfinished restores. Rebuilt data at the original path blocks restoration but does not block disposal of independently validated retained payloads. Empty wrappers left by restored units are accepted in a mixed batch only after exact signed identity and emptiness checks; regenerated source data is untouched. This remains an explicit whole-batch system-trash operation; there is no permanent-deletion path.

## Synthetic verification

`tests/cleanup-units.test.ts` covers exact counts, whole-unit roundtrips, optional-member changes, age bounds, unknown entries, links, depth limits, process uncertainty, provider/key mismatches, imported keys, read-only rescue, nonoverwriting conflicts, ordinary rollback and interrupted rename/link/unlink/rmdir recovery. Provider suites add source-backed layout and rebuild cases. The Cursor suite includes injected real-directory replacement and signed stored-layout substitution regressions. All fixtures are temporary synthetic data.

## Exact filesystem identity and journal compatibility

New cleanup-unit snapshots record device and inode/file IDs as canonical unsigned
64-bit decimal strings from one `BigIntStats` observation. This avoids rounding
large NTFS identifiers. The current authenticated v3 decoder also accepts safe
nonnegative numeric legacy IDs (inode must be positive), comparing their exact
values without rewriting signed journal bytes. Unsafe numeric identities,
noncanonical strings, out-of-range IDs and zero inodes fail closed.

Older app builds may reject new string-ID v3 unit journals. Keep a compatible
AgentVac build and the recovery key when retaining those archives; do not edit
signed journals or downgrade expecting new unit archives to be readable. File
bytes, no-overwrite behavior and legacy v1/v2 file recovery remain separate and
unchanged. Native Windows verification of this correction is a required gate.

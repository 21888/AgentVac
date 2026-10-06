# Exact identities and journal version 4

This development checkpoint rebuilds exact file-identity validation and signed journal version 4 on source commit `da565af18cc4940777cafb2483247dd9647a6b56`. It is not a release.

New file and root identities use canonical decimal strings sampled through Node's BigInt filesystem APIs. Authenticated legacy safe-integer identities remain readable without rewriting their signed representation. Rounded, malformed or unsupported identities are rejected and retained for manual recovery; importing a key cannot repair an already rounded identifier.

New quarantine batches use storage version 4 and recovery policy 4. A state transition on a valid legacy batch preserves its authenticated recovery policy and signing key while writing version 4. Merely viewing history does not migrate it. The preserved policy allows older Codex session archives to be restored without enabling new session-file cleanup.

Pinned historical readers reject version 4 before reconciliation or writes. Tests check completed and interrupted file/unit batches, exact payload and manifest preservation, rotated signing keys, receipt faults, and non-overwriting recovery. Historical source fixtures include their licenses and exact Git provenance.

The preceding identity/journal checkpoint passed 771 local tests and 81 focused independent checks after correcting ancestry-only validation. The subsequent mutation correction passes 832 fresh local tests, TypeScript checking and a production build. Earlier lost checkpoint counts are not carried forward. The mutation correction's independent final assessment and native Windows/macOS validation remain pending.

See [Cancellation and retained recovery records](MUTATION-CANCELLATION.md) for the implemented cancellation fences and remaining review limits. Fresh Trash closure acknowledgment is now integrated: its engine/TypeScript logic passed 864 owner-run cases and eight browser/real-engine/mock-Trash groups. A later one-property action-text color correction has a fresh build and bounded keyboard/manual color review; its raw automated contrast gate remains indeterminate and nonpassing. These are distinct from the preceding 832-case core result and are not completed independent or native acceptance. See [Fresh Trash confirmation](TRASH-CONFIRMATION.md). Later platform-specific private-copy integration remains a separate gate. The optional Linux ownership-scope implementation and Windows private-copy bridge are not activated by this checkpoint. No binary release or remote workflow change is included.

# Detached Windows private-copy lease research, corrected v2

This research is inactive. Start with docs/LEASE-CONTRACT.md, docs/REVIEW-FIXES.md and docs/NATIVE-LEASE-PLAN.md. No app code imports these modules. The original7bbc checkpoint is preserved separately.

The corrected AVL2/AVR2/AVC2 lease has strict typed refusal evidence, immediate exit revocation and verified-close ownership. A separate AVD2 actor holds ordinary DELETE access on a newly generated empty fixture and exposes no containment-ready capability. Both share a two-child transport pool.

The baseline native receipt applies only to the earlier18-case inherited-context metadata helper, not these changed executables. Current verification is36 Node tests,111 portable C++ checks and independent portable regression checks. The changed Windows helper/actor are NOT_RUN until independently reviewed and tested on exact compiled binaries.

Build only with scripts/build-lease-windows.ps1 and the reviewed SOURCE-INPUTS.json source pin. Run scripts/native-lease.mjs only under the generated14-case native plan. Earlier copied baseline files are provenance material, not an alternative lease runner.

The helper is read-only. Node copies only bounded generated sentinels after held-descriptor validation. The DELETE actor requests an existing ordinary right but never deletes, renames, alters ACLs or writes content. No privileges/accounts/UAC/settings change. Leave generated Windows fixtures for disposable-runner inspection. SQLite reconstruction, arbitrary app paths and actual app activation remain later gates.

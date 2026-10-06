# Detached Windows private-copy lease research, corrected v2

This research is inactive. Start with docs/LEASE-CONTRACT.md, docs/REVIEW-FIXES.md and docs/NATIVE-LEASE-PLAN.md. No app code imports these modules. The original7bbc checkpoint is preserved separately.

The corrected AVL2/AVR2/AVC2 lease has strict typed refusal evidence, immediate exit revocation and verified-close ownership. A separate AVD2 actor holds ordinary DELETE access on a newly generated empty fixture and exposes no containment-ready capability. Both share a two-child transport pool.

The baseline native receipt applies only to the earlier18-case inherited-context metadata helper, not these changed executables. Current verification is36 Node tests,111 portable C++ checks and independent portable regression checks. The changed Windows helper/actor are NOT_RUN until independently reviewed and tested on exact compiled binaries.

Build only with scripts/build-lease-windows.ps1 and the reviewed SOURCE-INPUTS.json source pin. Run scripts/native-lease.mjs only under the generated14-case native plan. Earlier copied baseline files are provenance material, not an alternative lease runner.

The helper is read-only. Node copies only bounded generated sentinels after held-descriptor validation. The DELETE actor requests an existing ordinary right but never deletes, renames, alters ACLs or writes content. No privileges/accounts/UAC/settings change. Leave generated Windows fixtures for disposable-runner inspection. SQLite reconstruction, arbitrary app paths and actual app activation remain later gates.

## PowerShell build compatibility correction

The preceding fce source was refused before compilation in Windows PowerShell5.1 because collecting ConvertFrom-Json output with @() nested its top-level array. This separate variant uses direct assignment, validates actual array/string elements and canonical unique paths, and runs native PowerShell parser regressions before compiling. No lease/helper/holder/transport behavior changed. Actual PowerShell5.1 and new-binary native validation remain NOT_RUN locally; no PowerShell executable is installed here.

## Native fixture ordering correction

The5f667 retry passed69 Windows PowerShell5.1 parser checks and Microsoft helper/holder/fixture compilation plus the portable C++ suites. The14 native lease cases did not run because two Node fixture assumptions failed first. This variant changes only the real-exit and fake-child lifecycle tests: a parent-triggered actual exit is sampled synchronously before close, and bounded fake children keep the event loop referenced until teardown. The native helper, holder, protocol, transport and copy logic are byte-identical. This is not a relaxation of exit revocation or close-based admission.

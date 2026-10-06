# Same-caller inherited-context Windows metadata profile

**Separate approved source staging. No application activation, publication or native run was performed here.** Published d999 and diagnostic f0f647 trees are preserved unchanged. This is a read-only metadata helper plus a separate, explicitly authorized creation-only dummy-fixture constructor.

The refinement removes the blanket inherited-elevation refusal. It does not request elevation or disable any other protection. It accepts an inherited current-user context only after live-pipe caller authentication, binary same-user/authentication/session/integrity checks, stable primary-token snapshots, absence of helper-thread impersonation, explicit service/system-context exclusions and rejection of already-enabled SeBackupPrivilege/SeRestorePrivilege. Privilege states are never changed.

Read:
- `docs/INHERITED-CONTEXT.md`: precise identity/service/capability rules and limitations
- `docs/INHERITED-PROFILE.md`: read-only scope and protocol design
- `docs/INITIAL-FIXTURES.md`: initial-SD creation boundaries and partial-failure risks
- `docs/INHERITED-NATIVE-PLAN.md`: exact new Windows proof and unavailable negative gates
- `results/inherited-linux-tests.log`: actual portable evidence

## Entry points

- `scripts/build-inherited-windows.ps1`: build only with preinstalled, signature-checked MSVC/SDK and static CRT
- `scripts/native-inherited.mjs`: fixed-source/fixed-binary generated-fixture research probe
- `proposals/windows-inherited-profile.yml`: manual-only proposed workflow, root owns all remote actions
- `scripts/test-inherited-linux.sh`: portable regression, fuzz, policy and protocol checks

The first helper version is **generated-target-only**, confined to a nonce-named child of its reviewed build directory and descendants. It does not enable general app paths. No production trusted-installation receipt exists. Metadata snapshots still do not establish a race-free private-write/containment lease; app copying stays disabled until separately reviewed and natively proven.

Historical baseline helper/protocol/launcher files retained in this copied source tree are not entry points for this profile. The new build and source manifest explicitly list the revised helper, context policy, protocol and fixture constructor. Do not substitute the old transport or the restricted launcher to bypass a refusal.

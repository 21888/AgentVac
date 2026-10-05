# Native Windows standard-account acceptance

**Current result: NOT_RUN. Linux tests are not native Windows evidence.** Do not claim the helper or ACL alternative solves the native bootstrap until these gates actually run. No script here creates junctions, changes ACLs/owners, maps drives, installs software, elevates, or reads conversation data.

## 1. Review and build only in the staged development tree

Use an already provisioned Windows 11 x64 standard-account runner and a separately supported arm64 runner if arm64 is shipped. Do not request elevation. Microsoft C++ Build Tools + Windows SDK + Node must be preinstalled from approved official sources. Use the Microsoft Native Tools environment for the desired architecture. Confirm the standard user is not running an elevated token.

From the copied staged tree run:

```
& .\scripts\build-windows.ps1 -CompilerPath '<absolute verified Microsoft cl.exe path>' -Architecture x64 -ExpectedSdkVersion '<actual selected Windows SDK version>'
```

The script validates the Microsoft compiler signature and exact target environment, writes only `build/windows-x64` (or arm64), builds with `/MT`, and generates `build-provenance.json`. It never runs the executable. Record compiler/SDK/architecture and helper/source hashes. Build failure is a blocker; never soften `/WX`, access bits, principal allowlist, locality checks or generic-rights rejection to make it green.

A reviewer must separately inspect the import table with that approved toolchain's absolute `dumpbin.exe /DEPENDENTS` and confirm no dynamic CRT, profile/module bootstrap, application-local import or unreviewed dependency. Confirm the embedded manifest is asInvoker and loader mitigation flags are present. The build enables `/DEPENDENTLOADFLAG:0x800` (system DLL search), ASLR, NX and CFG. Execute the compiled pure `core-tests.exe` only after source/build review. None of this has happened here.

## 2. Exact reviewed launch receipt

Have the reviewer establish that the helper executable and all of its directory ancestors are on a directly mapped fixed local drive, non-reparse and protected against untrusted replacement. This trust must be independent of this helper. Bind its exact absolute path and binary hash to the reviewed source build. Do not infer this from lstat/realpath, a passing hash alone, environment variables, build completion or an executable found on PATH.

The **reviewer-supplied** JSON receipt has exactly these required concepts:

```
{
  "schema": 1,
  "systemRoot": "C:\\Windows",
  "helperPath": "C:\\<reviewed-development-root>\\build\\windows-x64\\agentvac-metadata-research.exe",
  "helperSha256": "<reviewed 64 lower-case hex hash>",
  "sourceTreeSha256": "<reviewed 64 lower-case hex hash>",
  "reviewId": "<review identifier>",
  "bootstrap": "trusted-local-nonreparse-installation"
}
```

Those are placeholders, not an existing receipt. Do not auto-create an accepted receipt from the build provenance file. Keep it in the development test area, never install into or edit app/frozen/published trees.

## 3. Pre-provisioned disposable fixtures

A fixture owner must provide a bounded JSON manifest of **synthetic, non-user-data fixtures**. Provisioning ACLs, owners, reparse objects, drive mappings or tracing permissions is a separate explicitly authorized setup task, not something these scripts do. Use a prebuilt trusted test image if setup is not permitted. Never alter real user directories to satisfy a case.

Manifest shape:

```
{"schema":1,"fixtures":[
  {"id":"private-directory","path":"<confirmed synthetic absolute path>","mode":"acl","directory":true},
  {"id":"missing-leaf","path":"<confirmed absent final leaf in existing synthetic parent>","mode":"locality","directory":true,"allowMissingLeaf":true}
]}
```

Provide every ID below exactly once. The runner requires the full set and refuses unknown/missing IDs. The following ACL cases use `mode: acl, directory: true`, except `private-empty-file` uses false:

- `private-directory`: current user owner (or System/Admin), ordinary current-user allow with rights 3 or supported full control, OI+CI and no propagation. Expect verified-private.
- `private-empty-file`: current-user-private zero-byte ordinary file with one hard link. Expect verified-private. The runner also holds an existing Node r+ descriptor, performs no read/write/create/truncate, and compares bigint fstat with native metadata.
- `public-directory`: add Everyone allow. Expect acl-rejected.
- `broad-inherited-directory`: inherited Users/Authenticated Users/Everyone allow. Expect acl-rejected.
- `unrelated-owner-directory`: owner not current/System/Admin despite otherwise private allowlist. Expect acl-rejected. This may require a fixture pre-provisioned by its owner.
- `deny-current-directory`, `deny-system-directory`, `deny-admin-directory`: canonical explicit deny for the named allowed principal before current-user allow. Expect acl-rejected.
- `deny-other-directory`: canonical ordinary deny for another **valid SID in the existing SID-regex domain** before the current-user private allow. Expect verified-private, preserving the policy nuance.
- `noncanonical-directory`: explicit deny after explicit allow. Expect acl-rejected, not metadata-unavailable.
- `inherit-only-directory`: no current-object read/write allow; only inherit-only user allow. Expect acl-rejected.
- `no-safe-inheritance-directory`: current access but no user OI+CI entry with zero propagation. Expect acl-rejected.
- `generic-rights-directory`: an unexpanded high-bit generic access mask. Expect acl-rejected. Do not normalize it to full control.
- `null-dacl-directory`, `empty-dacl-directory`: null or empty DACL. Expect acl-rejected; ensure the inspecting standard owner can obtain READ_CONTROL on the synthetic object.
- `unknown-ace-directory`: unsupported callback/object/other ACE type. Expect acl-rejected, never silently skip it.
- `unicode-directory`: private safe-inheriting directory with non-ASCII and supplementary Unicode components. Expect verified-private.

Locality cases use `mode: locality, directory: true`:

- `junction-ancestor`: child under pre-provisioned junction. Expect locality-rejected before traversing the junction.
- `reparse-leaf`: a reparse target itself. Expect locality-rejected.
- `missing-leaf`: only final component absent; allowMissingLeaf true. Expect verified-local with exists false.
- `missing-intermediate`: intermediate component absent; allowMissingLeaf true. Expect locality-rejected.
- `unc-spelling`: UNC input. Expect invalid-request without spawn or network I/O.
- `subst-drive`, `mapped-drive`: pre-provisioned DOS substitution/network mappings. Expect locality-rejected during mapping inspection, before filesystem traversal.
- `fixed-volume-root`: confirmed fixed direct native drive root. Expect verified-local. This explicitly tests GLOBALROOT root and GetDriveTypeW compatibility.
- `file-as-directory`: ordinary synthetic file requested as directory. Expect locality-rejected.

Run using the explicitly selected preinstalled Node executable:

```
& '<absolute Node executable>' .\scripts\native-windows.mjs '<reviewed receipt JSON>' '<fixture manifest JSON>'
```

The script emits only fixture IDs, stable expected/actual codes, pass flags, Node/architecture and source/helper hashes. It never emits target paths, SIDs, identities or native error text. Any missing fixture/access/native API failure remains BLOCKED/FAIL. `FIXTURES_PASS` still has `productionAccepted:false`.

## 4. Additional mandatory native safety/protocol gates

A reviewer-controlled runner must test the exact same helper hash with synthetic pipes. These are not implemented by changing the helper or supplied as a fake pass:

1. Partial header, partial body, malformed UTF-8, over-limit length, unknown mode/flag/reserved bytes, second frame/trailing byte and non-pipe stdin. Assert bounded invalid-request or refusal; no stderr, path/SID/native text, crash or unbounded output.
2. Hold stdin open after an incomplete frame. Native watchdog must terminate with 124 at about 4.5 seconds; caller returns timeout by 5 seconds. Abort during input and metadata, confirm process termination and no leaked live children. Repeat rapidly.
3. Use an externally pre-authorized trace already available on the runner: no network activity, no target content ReadFile access, no writes outside pipe/build evidence, no profile/module/cache bootstrapping, and no child processes beyond the one helper. Do not install a tracer, elevate, change permissions or enable tracing as an unrequested workaround. Document a blocked trace gate if unavailable.
4. Adversarially swap a synthetic ancestor or introduce a junction between checks. Confirm either sharing prevents the change or the helper refuses before looking into the replacement. The runner must identify operation order, not merely see a final false result.
5. Change DOS mapping during the walk: native device binding must never traverse the replacement mapping. Expect a stable refusal or original-device-only observation. No network enumeration may occur.
6. Try an already-open ancestor handle with each right that could set reparse data or rename/delete. Validate the ordinary share-lock assumption against actual Windows behavior. If it can be bypassed, the helper stays blocked until a reviewed handle-relative/no-reparse traversal primitive or equivalent proof exists.
7. Replace the final path/parent after helper exit while Node retains the empty descriptor. This should demonstrate why snapshot identity is insufficient for production containment, not be treated as a success. Implement/approve the separate identity/lease contract first.
8. For every shipping Electron/Node/libuv version, verify Node dev/ino versus legacy native identity and, preferably, a reviewed bridge to full FILE_ID_INFO. Hard links, nonempty files, ReFS/full 128-bit IDs, wrong volume, reused IDs after handle close, cancellation, concurrent mutation and pathname reopening must fail closed.
9. Test hostile environment/profile locations with the static helper. The transport must not inherit profile/temp/module paths or lookup any executable using PATH. A wrong helper hash/architecture/source receipt, mutable receipt object, unexpected stderr and any response length other than 68 must refuse.

## 5. Acceptance artifact

Record exact source/helper hashes, compiler version/hash, SDK version, architecture, Windows build, token elevation=false, runner image provenance, Electron/Node/libuv version, fixture IDs and outcomes, protocol/race/trace gates, and unrun/blocked gates. Include the unchanged original-policy hash. Do not include private paths/SIDs/raw ACLs. Only after all required native gates are reviewed may a separate app integration be proposed. No production acceptance, native success, replacement ACL policy or executable binding has been asserted in this Linux staging task.

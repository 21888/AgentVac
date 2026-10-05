# Linux native baseline verification — 2026-10-04

## Scope and result

The baseline's **unpacked Linux x64 Electron application** successfully launched on the real graphical Linux desktop. Native main/preload/renderer communication, generated-fixture scanning, quarantine, restore, theme persistence, native folder chooser cancellation, and opening the quarantine directory were exercised.

A second, sandbox-enabled packaged-app test passed this complete data round-trip:

1. Generate only demo data on the project's persistent test volume.
2. Quarantine three log fixtures (23,200,000 bytes total).
3. Use the application's real `shell.trashItem`, with official GIO, to move the whole batch into standard XDG Trash.
4. Verify its original quarantine directory is absent and its history is `trashed`.
5. Use official Debian `trash-cli`'s `trash-restore` to restore precisely that batch to the original quarantine directory.
6. Use AgentVac's real UI/IPC to restore all three files to their original paths.
7. Verify every restored file's SHA-256 matches the bytes preserved before the Trash round-trip.

**This was standard XDG Trash command-line restoration, not Thunar's graphical Restore action.** The desktop lacked the GVfs virtual Trash backend; that GUI acceptance item remains open.

## Primary evidence

- `manual-packaged-results.json`: observations from direct, no-switch packaged executable launch.
- `source-sandboxed-linux-results.json`, `source-sandboxed-run.log`, `source-sandboxed-linux.png`: successful native source runtime smoke test, with `chromiumSandbox: true` and launch-argument assertion.
- `persistent-trash-gio/package-trash-results.json`: successful packaged-app round-trip, runtime preferences, arguments, file sizes, and SHA-256 values.
- `persistent-trash-gio/run.log`: full launch arguments without `--no-sandbox`, passed result, and process exit code 0.
- `persistent-trash-gio/trash-inventory.log`: actual XDG `.trashinfo` original path and batch presence in the system Trash.
- `persistent-trash-gio/standard-trash-restore.log`: official `trash-restore` selected exactly one controlled batch.
- `persistent-trash-gio/package-system-trash-roundtrip-restored.png`: final native application history, all three entries restored and zero pending. The image was visually reviewed.
- `baseline-test-input-sha256.txt`: original test script and built main/preload/HTML remained unchanged throughout verification.

The final successful packaged run completed at **2026-10-04T20:16:53.846Z**.

## Verified baseline identity

- Electron: 44.5.1.
- Linux executable SHA-256: `9155dd17c16f0edeaadb74db4fd91e2730511cca83e8b130d59bab57aa4d4e4b`.
- `app.asar` SHA-256: `36caa3446eef1a7c8baeee13535dcf2309c3ac294aa4b47a8bb00f54fd085d78`.
- Packaged runtime reported `app.isPackaged = true`, `sandbox = true`, `contextIsolation = true`, `nodeIntegration = false`; its launch command did not disable the Chromium sandbox.

## Dependency findings and corrections

- The AppImage launcher reported missing `libfuse.so.2`. It was not accepted as an installed/launchable AppImage; these runtime checks use the unpacked binary.
- The graphical desktop was available even though the ordinary command executor had no `DISPLAY`. They share the project filesystem, but not the same temporary-directory/process view. Native tests ran from the normal graphical desktop terminal.
- The desktop initially lacked `gio` and other native Trash helpers. The real operation failed clearly and kept the files quarantined. The same failure was reproduced using a persistent project fixture, so it was not attributed solely to `/dev/shm`.
- Official Debian `libglib2.0-bin` 2.84.4-3~deb13u5 was downloaded, checked against Debian's published SHA-256, and extracted **only** into the project test-tools directory. Its dynamic dependencies resolved against the existing libraries, and GIO reported 2.84.4. Only the test process's PATH was changed.
- Official Debian `trash-cli` 0.24.5.26-0.3 was similarly verified and locally extracted. It used the existing Python 3.12.14 and psutil 7.2.2, with a test-process-only PYTHONPATH. Neither system services nor OS/security settings were changed.
- Package provenance, checksums, dependencies, and versions are in `debian-tools/verification.log` and `debian-tools/trash-cli-verification.log`.
- An initial persistent TMPDIR was too long for the Unix socket pathname limit. A shorter project-owned `.qa` directory resolved that test setup issue. No security restriction was disabled.

## Historical attempts must not be overclaimed

Read `AUTOMATION-CAVEAT.md`. Playwright's default Electron launch silently supplied `--no-sandbox` in the first automatic runs. Those outputs are retained for traceability and do **not** count as full-sandbox acceptance. Later source and packaged runs explicitly enabled Chromium sandboxing and passed. The original manual launch used no such switch.

## Remaining acceptance gaps

- macOS and Windows native execution: not established by this Linux report.
- AppImage/FUSE installation and launcher behavior.
- Thunar graphical system-Trash restore, which requires a working GVfs backend.
- Native running-Codex process detection under controlled real processes, closing during a long-running mutation, full OS permission-denial matrix, dynamic OS-theme changes, and host clipboard verification were not completed here.
- This is fixture-based functional verification, not a complete security audit or a guarantee against power failure or malicious concurrent filesystem changes.

## Reusing the checks

Keep the fixture-only guards. Run from the project root on a normal graphical desktop. `source-sandboxed-e2e.mjs` exercises the existing source build; `package-trash-qa.mjs` accepts `AGENTVAC_QA_EXECUTABLE` and `AGENTVAC_QA_OUT` for a different reviewed package and a fresh evidence directory. Both must retain `chromiumSandbox: true`. Use a short, dedicated, persistent TMPDIR for the packaged fixture test.

The packaged test waits for the **same** generated batch to return from system Trash, then resumes app-level restoration and hash checking. The current `restore-standard-trash.sh` targets this completed baseline's exact batch; a future run must resolve and verify its own batch identity rather than blindly reuse that path. Never use `--overwrite`, empty the system Trash, or operate on unrelated entries.

Exclude `.qa`, downloaded `.deb` archives, and extracted `debian-tools` binaries from product/source releases. The textual provenance logs, test source, reports, and evidence screenshots may be retained. None of the added QA files modifies production application source or the baseline package.

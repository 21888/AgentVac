# Native automation evidence caveat

The initial `run.log`, `source-electron-results.json`, and `source-electron-restored.png` show real Electron functionality but are **not full Chromium sandbox acceptance**. The original unmodified desktop test used Playwright's default Electron launch setting, which silently adds `--no-sandbox`. The `sandbox: true` BrowserWindow preference alone does not establish the process sandbox state.

The initial `package-trash-results.json` and `persistent-trash/` attempt had the same default automation setting. Keep those outputs as historical failure evidence, not sandbox-qualified acceptance. The persistent attempt also exposed a too-long Unix socket path from its test TMPDIR.

Subsequent `source-sandboxed-*` and `persistent-trash-sandboxed/` tests explicitly request `chromiumSandbox: true` and assert that Electron process arguments do not contain `--no-sandbox`. They must actually pass before being counted.

The separate manual packaged-app test used the direct `linux-unpacked/agentvac` executable with no command-line switches. Its successful native window and demo quarantine/restore observations remain valid.

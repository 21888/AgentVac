# Instrumented process-observation QA copy

This package creates a separate, source-pinned instrumented project for native Mac diagnosis. Production `electron/`, `shared/`, `src/`, guards, and ordinary build scripts stay byte-for-byte unchanged. This is diagnostic instrumentation, not native production acceptance. Do not submit its receipts to the ordinary production-acceptance summary.

The builder always creates `.qa/agentvac-process-observed` below this project and refuses any existing target. It copies only the pinned `electron`, `shared`, `src`, `scripts`, `tests`, fixed root configuration/license files, the already-built frontend `dist`, `build/icon.png`, and this QA package. Dependencies are not copied or linked into the generated project; normal Node resolution uses the ancestor project's existing `node_modules`.

All copied inputs must be bounded regular single-link files below canonical non-link directories. The builder verifies the exact original source inventory, the pinned observer overlay, and the package before creating the target. It applies the overlay only while writing the new copy. It builds the six Electron entries and plain compiled provider driver in that copy, then verifies source, asset, package, copy, and output inventories again. The receipt includes before/after source and production hashes, every source/overlay/copy/output record, and explicit instrumented labels. Read and copy size limits are enforced; no arbitrary source/output flags, external fallback, existing-target cleanup, native launch, install, or policy override is provided.

The original reviewed guard/main instrumentation is also retained as `core-observer.patch`. `observer-overlay.patch` shows the complete combined overlay against the pinned diagnostic source, including bounded mutation diagnostics already present in that source. The generated original source hash is separate from the copied, instrumented source hash. Source and build provenance are integrity checks for these local artifacts, not signatures or a claim about an untrusted machine.

## Prepare and verify

Run from the original project root with supported Node and the already-installed project dependencies:

```sh
npm run build
node --test qa/process-observation/tests/*.test.mjs
node qa/process-observation/prepare.mjs
node qa/process-observation/verify.mjs
```

Keep `.qa/agentvac-process-observed/process-observer-build.json` with the QA evidence. Preparation prints `AGENTVAC_INSTRUMENTED_BUILD` and verification prints `AGENTVAC_INSTRUMENTED_VERIFY`, including the pin, original/copy-source, and built-output digests. A failed build retains its generated directory with `BUILD-FAILED.json`; inspect that directory and intentionally remove your own failed generated copy before a new attempt. The builder never removes it for you.

## Later authorized native Mac run

Both commands must run with the generated project as their working directory. Keep the normal Chromium sandbox enabled. Use only the existing native harness options for the evidence directory, expected architecture, and ordinary-disk synthetic fixture base. No real provider homes are required.

```sh
cd .qa/agentvac-process-observed
node scripts/desktop-e2e.mjs
node "$PWD/.qa/native-harness/native-provider-driver.mjs"
```

The copied harnesses verify provenance before creating fixtures or launching Electron. Their receipts contain `instrumented: true`, `productionAcceptance: false`, and the exact build provenance. The compiled provider driver additionally reports `unchangedProductionGuards: false` and `originalProductionFilesUnchanged: true`; its instrumented guard files must never be described as the production guard bytes. Native execution is a separate step and is not performed by preparation, verification, or the package tests.

After a native run, verify from the original project root again:

```sh
node qa/process-observation/verify.mjs
```

The process sink retains only whitelisted codes, flags, and bounded aggregate counts from actual guard calls. It does not enumerate again when read, emit process names/argv/environment/stderr, change retries/timeouts/classification, or allow guard failures through. This does not establish the cause of a prior Mac failure until an explicitly authorized instrumented native run produces the missing evidence.

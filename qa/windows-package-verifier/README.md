# Windows package verification follow-up

This is a QA-only correction for the ASAR verifier used by the AgentVac 0.2.0 release candidate. It does not change application code or the release source.

The original source is commit `4a523b95c1098eeb3e220cc58d290819ef97a01f`. Its Windows job `112519594642` in run `37536722747` passed 1,026 unit tests with zero failures and 44 explicitly recorded skips. Source build, native committed-unit recovery, desktop integration, supported readers and distribution generation passed. Three provider mutations remained blocked by a complete unknown-process inventory, with the generated source and protected bytes preserved through restart. Those limitations remain recorded as failures; the full unit suite is not rerun here.

The package verifier then failed to resolve a nested renderer file. The installed `@electron/asar` implementation splits header traversal by the host path separator. Passing POSIX paths on Windows breaks nested lookups. The corrected verifier uses native paths for the ASAR API and converts returned listing paths separately for the existing strict allowlist. All byte comparisons and unpacked-helper checks remain mandatory.

## Reproducible boundary

The separate Windows workflow checks out the exact original source and verifies its pinned source manifest. Only the corrected verifier, path helper, unchanged package-target definitions and generated tests are copied into an untracked `.qa` directory. No indexed shipping file is edited. The build and package commands execute from the original source checkout.

The receipt records the original release-source SHA and the actual QA workflow SHA separately, with every QA input hash. A child-local `GITHUB_SHA` value supplies the original release-source identity only to the unchanged receipt/upload helpers. It is not described as the workflow revision. Source hashes are checked again before and after package receipt preparation and upload.

The new native gates require exact package bytes, actual portable launch and generated recovery, supported packaged readers, and real per-user NSIS install → installed executable launch → uninstall. A successful follow-up does not turn prior provider refusals, skipped cases, signing/notarization limitations or OS recovery UI gaps into passes.

## Draft preservation

Upload is confined to the existing unpublished draft `405138314`, tag `v0.2.0`, target `4a523b95c1098eeb3e220cc58d290819ef97a01f`. All eleven existing Linux/macOS assets must be present and no Windows asset may exist. The unchanged upload helper checks each new file and server digest without clobbering. A final check requires all existing asset IDs, names, sizes and digests to be preserved and exactly four Windows assets to be added. There is no create, retarget, delete or publication action.

All fixtures are generated on a standard public Windows runner. No real provider data, credentials beyond the ephemeral workflow token, Actions cache/artifact upload, OS permission changes or source-database fallback are used.

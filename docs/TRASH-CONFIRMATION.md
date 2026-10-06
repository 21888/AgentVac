# Fresh Trash confirmation

This development integration adds explicit, fresh consent before a retained quarantine batch is passed to the system Trash adapter. It is not a release and does not enable a Linux ownership-scope backend, foreign-user process exclusions or a Windows private-copy bridge.

## Consent contract

`prepareTrash(batchId)` reads the existing authenticated batch and issues a five-minute, single-attempt token. The main process binds it to the exact batch, provider, canonical root, demo/real mode, cancellation revision, authenticated journal and origin signing key. Exact root/batch identity and the authenticated manifest fingerprint are retained privately. The token itself is not filesystem ownership evidence.

`trash(batchId, confirmed, confirmedClosed, confirmationToken)` requires primitive `true` for both independent acknowledgments and the matching live token. It consumes the token before its asynchronous engine work. Missing, false, nonboolean, cancelled, expired, replaced, cross-batch or reused consent cannot reach the Trash callback. Main-process refusal paths also revoke pending consent after busy, malformed or pre-handler drain failures. A later operation resetting cancellation does not revive an earlier token.

The renderer separately requires acknowledgment of recovery consequences, the typed phrase “回收站”, and closure of related programs/background services, including administrator and other-user instances. Cancel, Escape, another batch, provider/root changes and retries clear consent. A quick reopen waits for the preceding cancellation request. Pending preparation and active operations disable confirmation. Demo wording explicitly limits the operation to generated demo data; it does not claim that real tools were inspected or closed.

All existing conservative process guards remain required in real mode. User acknowledgment does not prove that every process is closed or establish a writer lock.

## Authentication and recovery

Preparation is read-only. Admission does not recreate missing quarantine storage. Changed authenticated content, a different trusted origin signer, or replacement root/batch/manifest identity invalidates consent. Legacy authenticated policies and signing keys remain bound to their journals; a rotated primary key does not re-sign imported archives merely to authorize Trash. Signed legacy Codex restoration remains separate from eligibility for new cleanup.

Before the callback, the engine retains the corrected mutation, process, parent, manifest and payload checks. Once a callback has already been admitted, cancellation or expiry does not erase its completed work. Owned version-4 receipt checkpointing remains available for the original operation. Receipts use no-replace publication, and uncertain replacement temporary paths are preserved. See [Cancellation and retained recovery records](MUTATION-CANCELLATION.md) for those checks and their non-atomic limitations.

## Validation status

- The preceding corrected mutation/identity/journal core passed 832 local owner-run cases. Its final independent assessment is incomplete.
- The combined engine and TypeScript confirmation logic passed **864/864 owner-run aggregate cases**, with no failures or skips. Eight sandboxed browser/real-engine/mock-Trash workflow groups also passed on generated demo and real-mode fixtures. No real provider data or native OS Trash was used.
- A later contrast audit found an actual dark enabled-action text failure: `#fce1d5` on `#965b48`, 4.34031:1. The sole production correction changes that foreground to `#fff8ef`, retaining the background, border and approved layout. Engine/TypeScript logic is unchanged; the 864-case aggregate was not repeated for this one-property CSS correction. A fresh typecheck and production build passed.
- The corrected renderer passed four mode/theme keyboard groups: accessible names/labels, Tab/Shift-Tab containment, Space checkbox toggling and consent gating, and Escape focus return. Twelve enabled-action measurements across idle, hover and keyboard focus retain at least 5:1: **5.12640:1 dark** and **5.12557:1 light**. Revised real-mode focus captures were visually approved.
- **The automatic accessibility command remains nonpassing.** Its eight axe states report zero violations but sixteen indeterminate wrapped-text nodes. No rule was disabled, and incomplete results were not converted to automated passes. Renderer errors, external requests and CSP violations were absent.

### Separate, bounded manual contrast review

The sixteen indeterminate instances are the warning paragraph and closure acknowledgment in each combination of demo/real mode, light/dark theme, and unchecked-disabled/confirmed-enabled state. After fonts, finite animations and layout settled, each captured block was checked using computed foreground colors, adjacent background pixels, line bounds, native hit stacks and screenshots. All were fully visible without clipping or occlusion. Independent calculations agreed.

| Text and theme               | Foreground RGB | Rendered background RGB | Ratio (display rounded) |
| ---------------------------- | -------------- | ----------------------- | ----------------------- |
| Light warning                | 137, 96, 58    | 247, 238, 227           | 4.81681:1               |
| Light closure acknowledgment | 104, 103, 101  | 254, 253, 251           | 5.55807:1               |
| Dark warning                 | 181, 158, 136  | 39, 39, 39              | 5.84093:1               |
| Dark closure acknowledgment  | 192, 183, 196  | 34, 35, 37              | 8.09785:1               |

The dark warning includes its translucent notice layer: rgba(188,141,93,0.04) over RGB(34,35,37), rather than treating the modal alone as the background. Line-adjacent pixels were uniformly RGB(39,39,39). A conservative lighter rounding bound of RGB(42,41,41) still gives 5.67199:1. The other backgrounds are opaque. Values were compared before rounding using the [WCAG relative-luminance method](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and the 4.5:1 threshold for normal 12px text.

This verifies the narrow manual color criterion for those recorded instances. Raw axe contrast remains indeterminate and its overall gate remains failed. It does not establish whole-application WCAG compliance, screen-reader/OS assistive-technology usability, native Electron IPC, native OS Trash acceptance, or completion of the independent mutation review. Broader platform acceptance remains outstanding.

## Cloud native observation

A later source-launched Electron 44.5.1 Linux run verified the real sandbox/preload/main path, generated demo quarantine and restore, signed history across restart, and single-instance behavior. This was generated data, not an installed vendor session.

The actual system Trash call failed in the cloud desktop. The generated batch manifest remained intact after refusal, with no permanent-deletion fallback. A separate desktop-side observation found Xfce with no Trash override and no `gio` or alternate Trash command. The [pinned Electron implementation](https://github.com/electron/electron/blob/v44.5.1/shell/common/platform_util_linux.cc) invokes `gio trash` in this configuration. Its generated positive control therefore remained unrun; no packages or Trash settings were changed. The standard Linux validation workflow already installs the normal distribution dependency.

The same run observed a real `CODEX_RUNNING` process guard. Non-demo mutations and native diagnostic parser/cancel/window-close positive paths remained blocked; the diagnostic refusal launched no helper and left its generated SQLite source unchanged. The native folder-picker check was unrun because its test utility was absent. The overall native result remains failed, and OS Trash restoration remains untested. These observations do not establish a product regression or cross-platform acceptance. The fixture harness preserves a Trash failure and nonzero overall exit while allowing later independent diagnostic checks to report their own result.

## Reproduction

Run `npm run build`, then `node --import tsx --test --test-concurrency=2 tests/*.test.ts` for owner checks. The generated workflow fixture is `scripts/trash-confirmation-regression.mjs`; the separate contrast/keyboard audit is `scripts/trash-accessibility-regression.mjs`. Use a sandbox-capable Chromium executable, for example `AGENTVAC_BROWSER=/usr/bin/chromium node --import tsx scripts/trash-accessibility-regression.mjs`. Never disable its sandbox. The accessibility command intentionally exits nonzero while its raw contrast items remain unresolved automatically, even when independent keyboard checks and the bounded manual color review succeed.
